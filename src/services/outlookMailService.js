'use strict';

/**
 * Outlook / Microsoft Graph - lectura de correos de TuPase y extraccion de codigos.
 *
 * Autenticacion: OAuth2 delegado con **Device Code Flow** (Microsoft identity
 * platform). El usuario se loguea en SU navegador (microsoft.com/devicelogin) y
 * la app nunca ve la contrasena. Scope delegado `Mail.Read offline_access
 * User.Read`. Soporta cuentas personales (outlook.com) y de organizacion via
 * tenant `common`.
 *
 * Flujo:
 *   1) POST {authority}/oauth2/v2.0/devicecode  -> { user_code, device_code, verification_uri, interval, expires_in }
 *   2) Poll POST {authority}/oauth2/v2.0/token (grant device_code) hasta que el
 *      usuario complete el login -> access_token + refresh_token.
 *   3) GET /me/messages con $filter por remitente + receivedDateTime -> se
 *      extraen los codigos del cuerpo (HTML -> texto) sin repetir por correo.
 *
 * Sesion recordada: el refresh_token se guarda cifrado con `safeStorage` de
 * Electron en `userData/outlook.session.enc`. NUNCA se guarda la contrasena, y
 * el access_token vive solo en memoria. Config (clientId, tenantId, remitente,
 * patron de codigo) via configService -> tab "Outlook" del modal Configuracion.
 *
 * Todo el HTTP corre en el proceso MAIN (el renderer tiene CSP connect-src
 * 'none'). Mismo patron que graphUsersService / jiraService.
 */

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const configService = require('./configService');

/* ---------------- Config ---------------- */

function getConfig() {
  const cfg = (configService.getEffective() || {}).outlook || {};
  return {
    clientId:     String(cfg.clientId || '').trim(),
    tenantId:     String(cfg.tenantId || '').trim() || 'common',
    senderTuPase: String(cfg.senderTuPase || '').trim(),
    codePattern:  String(cfg.codePattern || '').trim() || DEFAULT_CODE_PATTERN,
    scopes:       String(cfg.scopes || '').trim() || DEFAULT_SCOPES,
    maxEmails:    Number(cfg.maxEmails) > 0 ? Number(cfg.maxEmails) : 200
  };
}

const DEFAULT_SCOPES = 'Mail.Read offline_access User.Read';
// Patron por defecto: captura codigos etiquetados ("Codigo: ABC-123", "code 483920",
// "PIN 9921"). El grupo 1 es el codigo. Editable en Configuracion -> tab "Outlook".
const DEFAULT_CODE_PATTERN = '(?:c[oó]digo|code|pin)[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{2,15})';

function authorityFor(cfg) {
  return `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId || 'common')}`;
}

// Lo que puede ver el renderer (el clientId de un public client no es secreto).
function getPublicConfig() {
  const c = getConfig();
  return {
    clientId:     c.clientId,
    hasClientId:  Boolean(c.clientId),
    tenantId:     c.tenantId,
    senderTuPase: c.senderTuPase,
    codePattern:  c.codePattern,
    scopes:       c.scopes,
    maxEmails:    c.maxEmails,
    configured:   Boolean(c.clientId)
  };
}

/* ---------------- Sesion (refresh token cifrado) ---------------- */

let session = { accessToken: null, expiresAt: 0, refreshToken: null, account: null };
let sessionLoaded = false;
let authInFlight = false;

function sessionFile() {
  return path.join(app.getPath('userData'), 'outlook.session.enc');
}

function encAvailable() {
  try { return safeStorage && safeStorage.isEncryptionAvailable(); }
  catch (_) { return false; }
}

function persistSession() {
  try {
    if (!session.refreshToken || !encAvailable()) return;
    const payload = JSON.stringify({ refreshToken: session.refreshToken, account: session.account });
    fs.writeFileSync(sessionFile(), safeStorage.encryptString(payload));
  } catch (_) { /* best-effort */ }
}

function loadSessionFromDisk() {
  sessionLoaded = true;
  try {
    const f = sessionFile();
    if (!fs.existsSync(f) || !encAvailable()) return;
    const obj = JSON.parse(safeStorage.decryptString(fs.readFileSync(f)));
    if (obj && obj.refreshToken) {
      session.refreshToken = obj.refreshToken;
      session.account = obj.account || null;
    }
  } catch (_) { /* archivo corrupto o clave distinta: se ignora */ }
}

function ensureLoaded() {
  if (!sessionLoaded) loadSessionFromDisk();
}

function clearSession() {
  session = { accessToken: null, expiresAt: 0, refreshToken: null, account: null };
  try { if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile()); }
  catch (_) { /* ignore */ }
}

function applyToken(tok) {
  session.accessToken = tok.access_token;
  session.expiresAt = Date.now() + (Number(tok.expires_in) || 3600) * 1000;
  if (tok.refresh_token) session.refreshToken = tok.refresh_token;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- Device code login ---------------- */

async function startAuth(_opts, log) {
  ensureLoaded();
  if (authInFlight) throw new Error('Ya hay un login en curso. Completa el codigo pendiente o espera.');
  const cfg = getConfig();
  if (!cfg.clientId) {
    throw new Error('Falta el clientId de Azure. Configuralo en Configuracion -> tab "Outlook".');
  }
  const authority = authorityFor(cfg);

  authInFlight = true;
  try {
    /* Paso 1: device code */
    let dcRes;
    try {
      dcRes = await fetch(`${authority}/oauth2/v2.0/devicecode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scopes })
      });
    } catch (e) {
      throw new Error(`Error de conexion iniciando el login: ${e.message}`);
    }
    const dc = await dcRes.json().catch(() => ({}));
    if (!dcRes.ok || !dc.device_code) {
      const desc = dc.error_description || dc.error || `HTTP ${dcRes.status}`;
      throw new Error(`No se pudo iniciar el login: ${desc}`);
    }

    // Evento 'code' para que la UI muestre el codigo y el link de verificacion.
    log && log('code', JSON.stringify({
      userCode: dc.user_code,
      verificationUri: dc.verification_uri || 'https://microsoft.com/devicelogin',
      message: dc.message || ''
    }));
    log && log('info', `Abri ${dc.verification_uri} e ingresa el codigo: ${dc.user_code}`);

    /* Paso 2: polling del token */
    const tok = await pollForToken(authority, cfg, dc, log);
    applyToken(tok);
    await loadAccount(log);
    persistSession();
    log && log('success', `Cuenta conectada: ${session.account || '(desconocida)'}`);
    return { connected: true, account: session.account };
  } finally {
    authInFlight = false;
  }
}

async function pollForToken(authority, cfg, dc, log) {
  const start = Date.now();
  let interval = (Number(dc.interval) || 5) * 1000;
  const expiresMs = (Number(dc.expires_in) || 900) * 1000;

  while (Date.now() - start < expiresMs) {
    await sleep(interval);
    let res;
    try {
      res = await fetch(`${authority}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: cfg.clientId,
          device_code: dc.device_code
        })
      });
    } catch (e) {
      throw new Error(`Error de conexion durante el login: ${e.message}`);
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) return json;

    switch (json.error) {
      case 'authorization_pending':
        log && log('info', 'Esperando que completes el login en el navegador...');
        continue;
      case 'slow_down':
        interval += 5000;
        continue;
      case 'authorization_declined':
        throw new Error('Login cancelado: rechazaste el acceso en el navegador.');
      case 'access_denied':
        throw new Error('Acceso denegado por el usuario o por el administrador del tenant.');
      case 'expired_token':
        throw new Error('El codigo expiro. Volve a iniciar la conexion.');
      default:
        throw new Error(`Login fallo: ${json.error_description || json.error || ('HTTP ' + res.status)}`);
    }
  }
  throw new Error('El codigo expiro antes de completar el login. Volve a intentar.');
}

async function forceRefresh(log) {
  ensureLoaded();
  if (!session.refreshToken) throw new Error('No hay sesion para renovar. Conecta la cuenta de Outlook.');
  const cfg = getConfig();
  const authority = authorityFor(cfg);
  log && log('info', 'Renovando token de acceso...');
  let res;
  try {
    res = await fetch(`${authority}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: cfg.clientId,
        scope: cfg.scopes,
        refresh_token: session.refreshToken
      })
    });
  } catch (e) {
    throw new Error(`Error de conexion renovando el token: ${e.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    clearSession();
    const desc = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`La sesion expiro (${desc}). Volve a conectar la cuenta.`);
  }
  applyToken(json);
  persistSession();
  return session.accessToken;
}

async function getAccessToken(log) {
  ensureLoaded();
  if (session.accessToken && session.expiresAt > Date.now() + 60_000) return session.accessToken;
  if (session.refreshToken) return forceRefresh(log);
  throw new Error('No hay una cuenta de Outlook conectada. Conecta la cuenta primero.');
}

async function loadAccount(log) {
  try {
    const res = await graphGet('https://graph.microsoft.com/v1.0/me?$select=displayName,userPrincipalName,mail', session.accessToken, log);
    if (res.status < 300 && res.body) {
      session.account = res.body.mail || res.body.userPrincipalName || res.body.displayName || null;
    }
  } catch (_) { /* el account es solo cosmetico */ }
}

function signOut() {
  clearSession();
  return { connected: false };
}

function getStatus() {
  ensureLoaded();
  return {
    connected: Boolean((session.accessToken && session.expiresAt > Date.now()) || session.refreshToken),
    account: session.account,
    ...getPublicConfig()
  };
}

/* ---------------- Graph helpers ---------------- */

async function graphGet(url, token, log) {
  log && log('info', `GET ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    throw new Error(`Error de conexion con Microsoft Graph: ${e.message}`);
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

function assertGraphOk(res) {
  if (res.status >= 200 && res.status < 300) return;
  const msg = (res.body && res.body.error && res.body.error.message) || (res.text || '').slice(0, 300) || `HTTP ${res.status}`;
  if (res.status === 401) throw new Error('Sesion expirada o token invalido. Volve a conectar la cuenta.');
  if (res.status === 403) throw new Error(`Permisos insuficientes: falta consentir el scope Mail.Read para esta cuenta. Detalle: ${msg}`);
  throw new Error(`Microsoft Graph ${res.status}: ${msg}`);
}

/* ---------------- Extraccion de codigos ---------------- */

// Entidades HTML con nombre mas comunes en correos (incluye acentos del espanol,
// que aparecen a menudo como &oacute; &ntilde; etc y romperian el matcheo del
// patron de codigo si se dejaran literales).
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü',
  iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', deg: '°',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»'
};

function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|td)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch { return m; } })
       .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
       .replace(/&([a-zA-Z]+);/g, (m, name) => (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m));
  return s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
}

// Devuelve los codigos unicos (dedupe case-insensitive) de un texto. Si el patron
// define un grupo de captura, usa el grupo 1; sino, el match completo.
function extractCodes(text, pattern) {
  let re;
  try { re = new RegExp(pattern, 'gi'); }
  catch (e) { throw new Error(`Patron de codigo invalido (regex): ${e.message}`); }

  const out = [];
  const seen = new Set();
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard < 5000) {
    guard++;
    if (m.index === re.lastIndex) re.lastIndex++; // evita loop en matches de ancho cero
    const raw = (m[1] !== undefined ? m[1] : m[0]);
    const code = String(raw || '').trim();
    if (!code) continue;
    const key = code.toUpperCase();
    if (seen.has(key)) continue; // no repetir codigos del mismo correo
    seen.add(key);
    out.push(code);
  }
  return out;
}

function toIsoStart(v) {
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) d = new Date(`${v}T00:00:00`);
  else d = new Date(v);
  if (isNaN(d.getTime())) throw new Error(`Fecha invalida: ${v}`);
  return d.toISOString();
}

/* ---------------- Fetch de correos + codigos ---------------- */

async function fetchCodes(opts, log) {
  const cfg = getConfig();
  if (!cfg.clientId) throw new Error('Falta el clientId de Azure. Configuralo en Configuracion -> tab "Outlook".');

  const sender = String((opts && opts.sender) || cfg.senderTuPase || '').trim();
  if (!sender) {
    throw new Error('Falta el remitente de TuPase. Configuralo en Configuracion -> tab "Outlook" o en el campo Remitente.');
  }
  if (!opts || !opts.sinceDate) throw new Error('Indica la fecha desde la cual buscar.');
  const sinceIso = toIsoStart(opts.sinceDate);
  const pattern = String((opts && opts.codePattern) || cfg.codePattern).trim() || DEFAULT_CODE_PATTERN;

  let token = await getAccessToken(log);

  const filter = `receivedDateTime ge ${sinceIso} and from/emailAddress/address eq '${sender.replace(/'/g, "''")}'`;
  const select = 'id,subject,receivedDateTime,from,webLink,bodyPreview,body';
  let url = `https://graph.microsoft.com/v1.0/me/messages?$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(select)}&$top=50`;

  log && log('info', `Buscando correos de ${sender} desde ${sinceIso}...`);

  const messages = [];
  let page = 0;
  let refreshed = false;
  while (url && messages.length < cfg.maxEmails && page < 50) {
    page++;
    let res = await graphGet(url, token, log);
    if (res.status === 401 && !refreshed) {
      // Token vencido a mitad de camino: refrescamos una vez y reintentamos.
      refreshed = true;
      token = await forceRefresh(log);
      res = await graphGet(url, token, log);
    }
    assertGraphOk(res);
    const values = Array.isArray(res.body && res.body.value) ? res.body.value : [];
    messages.push(...values);
    url = (res.body && res.body['@odata.nextLink']) || null;
    log && log('info', `Correos acumulados: ${messages.length}...`);
  }

  // Orden cronologico descendente (mas nuevo primero), client-side.
  messages.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));

  const results = [];
  let emailsSinCodigo = 0;
  for (const msg of messages) {
    const bodyRaw = msg.body && msg.body.content ? msg.body.content : '';
    const isHtml = msg.body && /html/i.test(msg.body.contentType || '');
    const text = `${isHtml ? htmlToText(bodyRaw) : bodyRaw}\n${msg.subject || ''}`;
    const codes = extractCodes(text, pattern);
    const from = (msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || '';
    if (!codes.length) { emailsSinCodigo++; continue; }
    for (const code of codes) {
      results.push({
        codigo: code,
        fecha: msg.receivedDateTime,
        asunto: msg.subject || '(sin asunto)',
        remitente: from,
        referencia: msg.id,
        webLink: msg.webLink || ''
      });
    }
  }

  log && log('success', `Correos: ${messages.length}. Con codigo: ${messages.length - emailsSinCodigo}. Codigos extraidos: ${results.length}.`);

  return {
    sinceDate: sinceIso,
    sender,
    account: session.account || null,
    totalEmails: messages.length,
    totalCodes: results.length,
    emailsSinCodigo,
    results
  };
}

module.exports = {
  startAuth,
  signOut,
  getStatus,
  getPublicConfig,
  fetchCodes,
  // exportados para pruebas puntuales
  htmlToText,
  extractCodes
};
