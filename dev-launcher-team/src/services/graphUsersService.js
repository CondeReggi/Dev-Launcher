'use strict';

/**
 * Microsoft Graph - usuarios del tenant B2C (DUCSA: appcnvtst / appcnvprd).
 *
 * Flujo:
 *   1) client_credentials a https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token
 *      con scope https://graph.microsoft.com/.default => access_token.
 *   2) GET https://graph.microsoft.com/v1.0/users?$top=999&$select=<campos> (incluye
 *      las extension properties: extension_<extensionAppId>_<Prop>).
 *   3) GET https://graph.microsoft.com/v1.0/users/{id}?$select=... para detalle.
 *   4) PATCH https://graph.microsoft.com/v1.0/users/{id} con un body con SOLO los
 *      campos a modificar (Graph PATCH es partial-update por defecto).
 *
 * Tokens se cachean en memoria por ambiente hasta 60s antes del expires_in.
 */

const configService = require('./configService');

const tokenCache = new Map();

// Propiedades base de Graph que vamos a traer en listado y detalle. Pedimos un
// $select explicito para incluir las extensiones, sino Graph devuelve solo el
// "default set" y oculta las extension_ properties.
const BASE_FIELDS = [
  'id',
  'displayName',
  'userPrincipalName',
  'mailNickname',
  'userType',
  'identities',
  'accountEnabled',
  'givenName',
  'surname',
  'mail',
  'mobilePhone',
  'businessPhones',
  'createdDateTime',
  'externalUserState',
  'externalUserStateChangeDateTime'
];

// Nombres "logicos" de las extension properties que usa el dominio. El nombre real
// que viaja por Graph es `extension_<extensionAppId>_<Prop>`. Tenerlo asi nos deja
// renderizar la UI sin hardcodear el GUID por todos lados.
const EXTENSION_PROPS = [
  { logical: 'Roles',         graph: 'Roles',         kind: 'json'   },
  { logical: 'Documento',     graph: 'Documento',     kind: 'string' },
  { logical: 'TenantId',      graph: 'TenantId',      kind: 'number' },
  { logical: 'TipoDocumento', graph: 'TipoDocumento', kind: 'string' },
  { logical: 'Phone',         graph: 'Phone',         kind: 'string' }
];

function extName(extensionAppId, prop) {
  if (!extensionAppId) return null;
  return `extension_${extensionAppId}_${prop}`;
}

function getEnvCfg(env) {
  const all = configService.getEffective().graphUsers;
  if (!all) throw new Error('Falta sendQr.config.js -> graphUsers.');
  const cfg = all[env];
  if (!cfg) throw new Error(`Ambiente desconocido: ${env}. Esperado 'Testing' o 'Produccion'.`);
  return cfg;
}

function listEnvs() {
  const all = configService.getEffective().graphUsers || {};
  const envs = Object.keys(all).filter(k => k !== 'defaultEnv');
  return {
    envs,
    defaultEnv: all.defaultEnv || envs[0] || 'Produccion',
    extensionProps: EXTENSION_PROPS,
    summaries: envs.reduce((acc, e) => {
      const c = all[e] || {};
      acc[e] = {
        tenantId: c.tenantId || '',
        clientId: c.clientId || '',
        scope: c.scope || '',
        extensionAppId: c.extensionAppId || '',
        configured: Boolean(c.tenantId && c.clientId && c.clientSecret)
      };
      return acc;
    }, {})
  };
}

function selectFields(cfg) {
  const exts = (cfg.extensionAppId
    ? EXTENSION_PROPS.map(p => extName(cfg.extensionAppId, p.graph))
    : []).filter(Boolean);
  return [...BASE_FIELDS, ...exts];
}

async function getToken(env, log) {
  const cached = tokenCache.get(env);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    log && log('info', `Token cacheado reutilizado (env=${env}, vence en ${Math.round((cached.expiresAt - Date.now()) / 1000)}s).`);
    return cached.token;
  }

  const cfg = getEnvCfg(env);
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) {
    throw new Error(`Credenciales incompletas para "${env}". Configura tenantId, clientId y clientSecret en Configuracion (tab "Graph Users").`);
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: cfg.scope || 'https://graph.microsoft.com/.default'
  });

  log && log('info', `POST ${tokenUrl} (client_credentials, env=${env})`);

  let res;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
  } catch (e) {
    throw new Error(`Token network error: ${e.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const desc = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`Token fallo: ${desc}`);
  }
  const expiresIn = Number(json.expires_in || 3600);
  tokenCache.set(env, {
    token: json.access_token,
    expiresAt: Date.now() + expiresIn * 1000
  });
  log && log('success', `access_token recibido (expira en ${expiresIn}s).`);
  return json.access_token;
}

async function graphFetch(method, url, token, body, log) {
  log && log('info', `${method} ${url}`);
  const headers = { 'Authorization': `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`Graph network error: ${e.message}`);
  }
  // PATCH suele responder 204 No Content.
  if (res.status === 204) return { status: 204, body: null };
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!res.ok) {
    const msg = (parsed && parsed.error && parsed.error.message) || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new Error(`Graph ${res.status}: ${msg}`);
  }
  return { status: res.status, body: parsed };
}

async function listUsers(opts, log) {
  const env = (opts && opts.env) || listEnvs().defaultEnv;
  const cfg = getEnvCfg(env);
  const token = await getToken(env, log);

  const fields = selectFields(cfg).join(',');
  let url = `https://graph.microsoft.com/v1.0/users?$top=999&$select=${encodeURIComponent(fields)}`;

  const all = [];
  const maxPages = 20; // ~20k usuarios como techo, sobra para B2C de DUCSA
  let page = 0;
  while (url && page < maxPages) {
    page++;
    log && log('info', `Pagina ${page}: GET users...`);
    const { body } = await graphFetch('GET', url, token, undefined, null);
    const values = Array.isArray(body && body.value) ? body.value : [];
    all.push(...values);
    url = (body && body['@odata.nextLink']) || null;
  }

  log && log('success', `Usuarios recuperados: ${all.length} (paginas=${page}).`);

  return {
    env,
    total: all.length,
    users: all,
    extensionAppId: cfg.extensionAppId || '',
    extensionProps: EXTENSION_PROPS
  };
}

async function getUser(opts, log) {
  const env = opts && opts.env;
  const id  = opts && opts.id;
  if (!env) throw new Error('env requerido.');
  if (!id)  throw new Error('id requerido.');

  const cfg = getEnvCfg(env);
  const token = await getToken(env, log);

  const fields = selectFields(cfg).join(',');
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(id)}?$select=${encodeURIComponent(fields)}`;

  const { body } = await graphFetch('GET', url, token, undefined, log);
  log && log('success', `Usuario ${id} OK.`);
  return {
    env,
    user: body,
    extensionAppId: cfg.extensionAppId || '',
    extensionProps: EXTENSION_PROPS
  };
}

async function patchUser(opts, log) {
  const env = opts && opts.env;
  const id  = opts && opts.id;
  const updates = (opts && opts.updates) || null;
  if (!env) throw new Error('env requerido.');
  if (!id)  throw new Error('id requerido.');
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('updates debe ser un objeto con los campos a modificar.');
  }
  const keys = Object.keys(updates);
  if (!keys.length) throw new Error('Sin cambios para enviar.');

  const token = await getToken(env, log);
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(id)}`;

  log && log('info', `PATCH usuario ${id}. Campos: ${keys.join(', ')}`);
  const { status } = await graphFetch('PATCH', url, token, updates, log);
  log && log('success', `PATCH OK (HTTP ${status}).`);
  return { env, id, status, updatedKeys: keys };
}

module.exports = {
  listEnvs,
  listUsers,
  getUser,
  patchUser,
  getToken,
  EXTENSION_PROPS,
  extName
};
