'use strict';

/**
 * Cliente "directo" contra la API REST de OneSignal. A diferencia de
 * oneSignalNotificationService (que envia por PnsHandle leido de SQL Server),
 * este servicio:
 *
 *   1. Lista las subscriptions directamente de OneSignal:
 *        GET {baseUrl}/players?app_id=...&limit=300&offset=N   (View devices)
 *      Paginado hasta traer total_count (con tope de paginas configurable).
 *
 *   2. Construye el body de Create Notification para envio:
 *        - MASIVO   -> included_segments: ["Subscribed Users"]  (default)
 *        - PUNTUAL  -> include_subscription_ids / include_player_ids /
 *                      include_aliases {onesignal_id|external_id} (+ target_channel)
 *
 *   3. Throttling / delivery configurables:
 *        throttle_rate_per_minute, ttl, priority, send_after,
 *        delayed_option, delivery_time_of_day.
 *        Ver https://documentation.onesignal.com/docs/en/throttling
 *
 *   4. PREVIEW antes de enviar: devuelve { url, body, curl, target } para que
 *      la UI muestre exactamente que se va a mandar. El curl enmascara la
 *      REST API key (nunca se expone al renderer; el contrato de
 *      oneSignalConfigService es no filtrar apiRestKey).
 *
 * Todo el envio real pasa por el main process; el renderer solo ve el preview
 * con la key enmascarada.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const oneSignalConfig = require('./oneSignalConfigService');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SEND_KEY_PLACEHOLDER = 'YOUR_ONESIGNAL_REST_API_KEY';

// device_type de OneSignal -> etiqueta legible.
const DEVICE_TYPES = {
  0: 'iOS', 1: 'Android', 2: 'Amazon', 3: 'WindowsPhone', 4: 'ChromeApp',
  5: 'ChromeWeb', 6: 'Windows', 7: 'Safari', 8: 'Firefox', 9: 'macOS',
  10: 'Alexa', 11: 'Email', 13: 'Huawei', 14: 'SMS'
};

function isHttpUrl(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) { return false; }
}

function baseUrlFrom(cfg) {
  return (cfg.oneSignal.baseUrl || 'https://onesignal.com/api/v1').replace(/\/+$/, '');
}

/* ============================================================
 * 1) Listado de subscriptions (View devices, paginado)
 * ============================================================ */

// canReceive: puede recibir push = suscripto (notification_types>0) + token valido + con identifier.
// notification_types: >0 suscripto, -2 desuscripto, null/ausente => se asume desconocido (no descarta).
function computeCanReceive(notifTypes, invalid, identifier) {
  const subscribed = notifTypes == null ? true : Number(notifTypes) > 0;
  return subscribed && !invalid && !!String(identifier || '').trim();
}

function normalizeSubscription(p) {
  const nt = typeof p.notification_types === 'number' ? p.notification_types : null;
  const invalid = !!p.invalid_identifier;
  return {
    id:             p.id || '',                          // subscription / player id
    identifier:     p.identifier || '',                  // push token
    externalUserId: p.external_user_id || '',
    deviceType:     typeof p.device_type === 'number' ? p.device_type : null,
    platform:       DEVICE_TYPES[p.device_type] || (p.device_type == null ? '' : String(p.device_type)),
    deviceModel:    p.device_model || '',
    deviceOs:       p.device_os || '',
    language:       p.language || '',
    lastActive:     p.last_active ? new Date(p.last_active * 1000).toISOString() : '',
    createdAt:      p.created_at ? new Date(p.created_at * 1000).toISOString() : '',
    invalid:        invalid,
    notificationTypes: nt,
    canReceive:     computeCanReceive(nt, invalid, p.identifier),
    sessionCount:   typeof p.session_count === 'number' ? p.session_count : null
  };
}

/**
 * Lista subscriptions de la app. Intenta primero View devices (GET /players);
 * si OneSignal lo tiene deshabilitado (apps con +80k usuarios devuelven
 * HTTP 400 pidiendo csv_export), cae automaticamente al CSV export API.
 * @param {Object} [opts]
 * @param {number} [opts.limitPerPage]  filas por pagina en /players (max 300)
 * @param {number} [opts.maxPages]      tope de paginas en /players
 * @param {boolean} [opts.forceCsv]     saltea /players y usa CSV directamente
 * @param {Function} [log]  log(kind, message)
 */
async function listSubscriptions(opts, log) {
  opts = opts || {};
  const cfg = oneSignalConfig.assertReady();

  if (opts.forceCsv) return listViaCsvExport(cfg, opts, log);

  try {
    return await listViaPlayers(cfg, opts, log);
  } catch (e) {
    // App grande: View devices deshabilitado -> CSV export.
    if (e.code === 'ONESIGNAL_HTTP_ERROR' && /csv_export|over\s*80,?000|disabled for apps/i.test(e.message || '')) {
      log && log('warn', 'View devices (/players) deshabilitado para esta app (probablemente +80k usuarios). Cambiando a CSV export...');
      return listViaCsvExport(cfg, opts, log);
    }
    throw e;
  }
}

// --- Camino 1: View devices paginado ---
async function listViaPlayers(cfg, opts, log) {
  const direct = cfg.direct || {};
  const baseUrl = baseUrlFrom(cfg);

  let limit = Number(opts.limitPerPage || direct.listLimitPerPage || 300);
  if (!Number.isFinite(limit) || limit <= 0) limit = 300;
  limit = Math.min(limit, 300);

  let maxPages = Number(opts.maxPages != null ? opts.maxPages : (direct.maxPages != null ? direct.maxPages : 20));
  if (!Number.isFinite(maxPages) || maxPages <= 0) maxPages = 20;

  const headers = {
    'Accept': 'application/json',
    'Authorization': `Basic ${cfg.oneSignal.apiRestKey}`
  };

  const all = [];
  let offset = 0;
  let totalCount = null;
  let page = 0;
  let capped = false;

  log && log('info', `Listando subscriptions via /players (appId=${cfg.oneSignal.appId}, limit=${limit}/pagina)...`);

  while (true) {
    if (page >= maxPages) { capped = true; break; }
    const url = `${baseUrl}/players?app_id=${encodeURIComponent(cfg.oneSignal.appId)}&limit=${limit}&offset=${offset}`;

    let res;
    try {
      res = await fetch(url, { method: 'GET', headers });
    } catch (e) {
      logger.error('[oneSignalDirect] network error listing players:', e && e.message);
      const err = new Error('Error de red al listar subscriptions: ' + e.message);
      err.code = 'NETWORK_ERROR';
      throw err;
    }

    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      const desc = (raw && raw.errors && JSON.stringify(raw.errors)) || `HTTP ${res.status}`;
      const err = new Error(`OneSignal HTTP ${res.status}: ${desc}`);
      err.code = 'ONESIGNAL_HTTP_ERROR';
      err.status = res.status;
      throw err;
    }

    if (totalCount == null && typeof raw.total_count === 'number') totalCount = raw.total_count;
    const players = Array.isArray(raw.players) ? raw.players : [];
    for (const p of players) all.push(normalizeSubscription(p));
    page++;
    offset += players.length;

    log && log('info', `Pagina ${page}: +${players.length} (acumulado ${all.length}${totalCount != null ? ' / ' + totalCount : ''}).`);

    if (players.length < limit) break;                 // ultima pagina
    if (totalCount != null && offset >= totalCount) break;
  }

  if (capped && totalCount != null && all.length < totalCount) {
    log && log('warn', `Tope de ${maxPages} paginas alcanzado: traidas ${all.length} de ${totalCount}. Subi direct.maxPages para traer mas.`);
  }
  const deliverable = all.reduce((n, s) => n + (s.canReceive ? 1 : 0), 0);
  log && log('success', `Subscriptions traidas: ${all.length}${totalCount != null ? ' de ' + totalCount : ''}. Pueden recibir push: ${deliverable}.`);

  return { subscriptions: all, totalCount: totalCount == null ? all.length : totalCount, fetched: all.length, deliverable, capped, source: 'players' };
}

// --- Camino 2: CSV export API (async) ---
// POST /players/csv_export -> {csv_file_url}; el archivo .csv.gz se genera
// en background, hay que pollear la URL de S3 hasta que este listo, bajarlo,
// descomprimir y parsear.
async function listViaCsvExport(cfg, opts, log) {
  const direct = cfg.direct || {};
  const baseUrl = baseUrlFrom(cfg);
  const exportUrl = `${baseUrl}/players/csv_export?app_id=${encodeURIComponent(cfg.oneSignal.appId)}`;

  log && log('info', 'Solicitando CSV export a OneSignal (POST /players/csv_export)...');

  let res;
  try {
    res = await fetch(exportUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
        'Authorization': `Basic ${cfg.oneSignal.apiRestKey}`
      },
      body: JSON.stringify({ extra_fields: ['external_user_id'] })
    });
  } catch (e) {
    const err = new Error('Error de red solicitando CSV export: ' + e.message);
    err.code = 'NETWORK_ERROR';
    throw err;
  }

  const raw = await res.json().catch(() => ({}));
  if (!res.ok || !raw.csv_file_url) {
    const desc = (raw && raw.errors && JSON.stringify(raw.errors)) || `HTTP ${res.status}`;
    const err = new Error(`OneSignal CSV export fallo: ${desc}`);
    err.code = 'ONESIGNAL_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }

  const fileUrl = raw.csv_file_url;
  log && log('info', `CSV en preparacion. Esperando que OneSignal genere el archivo...`);

  // Polling de la URL de S3 (devuelve 403/404 hasta que el archivo existe).
  const maxAttempts = Number(direct.csvMaxPollAttempts) > 0 ? Number(direct.csvMaxPollAttempts) : 45;
  const pollMs = Number(direct.csvPollMs) > 0 ? Number(direct.csvPollMs) : 4000;
  let buffer = null;

  await sleep(3000);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let fr;
    try {
      fr = await fetch(fileUrl, { method: 'GET' });
    } catch (e) {
      // Reintentar ante error de red transitorio.
      fr = null;
    }
    if (fr && fr.ok) {
      buffer = Buffer.from(await fr.arrayBuffer());
      break;
    }
    if (attempt % 5 === 0) {
      log && log('info', `Esperando CSV... intento ${attempt}/${maxAttempts}.`);
    }
    await sleep(pollMs);
  }

  if (!buffer) {
    const err = new Error(`Timeout esperando el CSV export (${maxAttempts} intentos). Reintenta en unos minutos.`);
    err.code = 'CSV_TIMEOUT';
    throw err;
  }

  // Descomprimir (.csv.gz). Si no es gzip, usar el buffer crudo.
  let csvText;
  try {
    csvText = zlib.gunzipSync(buffer).toString('utf8');
  } catch (_) {
    csvText = buffer.toString('utf8');
  }

  log && log('info', 'CSV descargado. Parseando...');

  const rows = parseCsv(csvText);
  if (!rows.length) {
    log && log('warn', 'El CSV vino vacio.');
    return { subscriptions: [], totalCount: 0, fetched: 0, capped: false, source: 'csv' };
  }

  const header = rows[0].map(h => String(h || '').trim());
  const idx = {};
  ['id', 'identifier', 'external_user_id', 'device_type', 'device_model', 'device_os',
   'language', 'last_active', 'created_at', 'invalid_identifier', 'session_count', 'notification_types']
    .forEach(col => { idx[col] = header.indexOf(col); });

  const maxRows = Number(direct.csvMaxRows) > 0 ? Number(direct.csvMaxRows) : 0;
  const subs = [];
  let capped = false;

  for (let i = 1; i < rows.length; i++) {
    if (maxRows && subs.length >= maxRows) { capped = true; break; }
    const r = rows[i];
    if (!r || (r.length === 1 && r[0] === '')) continue; // linea vacia
    subs.push(normalizeCsvRow(r, idx));
  }

  const total = rows.length - 1;
  const deliverable = subs.reduce((n, s) => n + (s.canReceive ? 1 : 0), 0);
  if (capped) {
    log && log('warn', `CSV truncado a ${subs.length} de ~${total} filas (direct.csvMaxRows). Subilo o filtra en OneSignal.`);
  }
  log && log('success', `Subscriptions traidas via CSV: ${subs.length}${!capped ? ' de ' + total : ''}. Pueden recibir push: ${deliverable} (el resto esta desuscripto o con token invalido).`);

  return { subscriptions: subs, totalCount: total, fetched: subs.length, deliverable, capped, source: 'csv' };
}

function cell(row, i) { return i >= 0 && i < row.length ? row[i] : ''; }

function normalizeCsvRow(r, idx) {
  const dtRaw = cell(r, idx.device_type);
  const dt = dtRaw === '' ? null : Number(dtRaw);
  const sc = cell(r, idx.session_count);
  const ntRaw = cell(r, idx.notification_types);
  const nt = ntRaw === '' ? null : Number(ntRaw);
  const identifier = cell(r, idx.identifier);
  const invalid = String(cell(r, idx.invalid_identifier)).toLowerCase() === 'true';
  return {
    id:             cell(r, idx.id),
    identifier:     identifier,
    externalUserId: cell(r, idx.external_user_id),
    deviceType:     Number.isFinite(dt) ? dt : null,
    platform:       DEVICE_TYPES[dt] || (dtRaw === '' ? '' : String(dtRaw)),
    deviceModel:    cell(r, idx.device_model),
    deviceOs:       cell(r, idx.device_os),
    language:       cell(r, idx.language),
    lastActive:     cell(r, idx.last_active),
    createdAt:      cell(r, idx.created_at),
    invalid:        invalid,
    notificationTypes: Number.isFinite(nt) ? nt : null,
    canReceive:     computeCanReceive(Number.isFinite(nt) ? nt : null, invalid, identifier),
    sessionCount:   sc === '' ? null : Number(sc)
  };
}

// Parser CSV que respeta comillas, comillas escapadas ("") y saltos de linea
// dentro de campos entrecomillados (la columna tags trae JSON con comas).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ============================================================
 * 2) Construccion del request de envio
 * ============================================================ */

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Valida y normaliza las opciones de envio. Devuelve un objeto de opciones
 * limpio (sin tocar la red). Lanza Error con .code si algo es invalido.
 */
function normalizeSendOptions(options) {
  options = options || {};
  const out = {};

  // --- Target ---
  const mode = options.targetMode === 'single' || options.targetMode === 'subscriptions'
    ? options.targetMode
    : 'segment';
  out.targetMode = mode;

  if (mode === 'segment') {
    const seg = (options.segment && String(options.segment).trim()) || 'Subscribed Users';
    out.segment = seg;
  } else if (mode === 'subscriptions') {
    const ids = (Array.isArray(options.ids) ? options.ids : [])
      .map(s => String(s || '').trim()).filter(Boolean);
    if (!ids.length) throw err('NO_TARGET', 'No hay subscription IDs seleccionados para el envio puntual/por lista.');
    out.ids = ids;
    out.idField = options.idField === 'player_id' ? 'player_id' : 'subscription_id';
  } else { // single
    const idType = ['subscription_id', 'player_id', 'onesignal_id', 'external_id'].includes(options.idType)
      ? options.idType : 'subscription_id';
    const value = String(options.idValue || '').trim();
    if (!value) throw err('NO_TARGET', 'Falta el identificador del destinatario puntual.');
    out.idType = idType;
    out.idValue = value;
  }

  return applyContent(options, out);
}

// Normaliza contenido + throttling/delivery (compartido por single y bulk).
function applyContent(options, out) {
  const title = String(options.title || '').trim();
  const message = String(options.message || '').trim();
  const templateId = String(options.templateId || '').trim();
  if (!templateId) {
    if (!title) throw err('TITLE_REQUIRED', 'El titulo es requerido (salvo que uses templateId).');
    if (!message) throw err('MESSAGE_REQUIRED', 'El mensaje es requerido (salvo que uses templateId).');
  }
  out.title = title;
  out.message = message;
  if (templateId) out.templateId = templateId;

  const subtitle = String(options.subtitle || '').trim();
  if (subtitle) out.subtitle = subtitle;

  for (const [k, label] of [['url', 'URL al tocar'], ['largeIcon', 'Icono grande'], ['bigPicture', 'Imagen grande']]) {
    const v = String(options[k] || '').trim();
    if (v) {
      if (!isHttpUrl(v)) throw err('INVALID_URL', `Campo "${label}" debe ser una URL http(s) valida.`);
      out[k] = v;
    }
  }

  if (options.data !== undefined && options.data !== null && options.data !== '') {
    if (typeof options.data !== 'object' || Array.isArray(options.data)) {
      throw err('INVALID_DATA', 'El payload "data" debe ser un objeto JSON plano.');
    }
    if (Object.keys(options.data).length) out.data = options.data;
  }

  // --- Throttling / delivery ---
  if (options.throttleRatePerMinute !== undefined && options.throttleRatePerMinute !== null && options.throttleRatePerMinute !== '') {
    const t = Number(options.throttleRatePerMinute);
    if (!Number.isFinite(t) || t < 0) throw err('INVALID_THROTTLE', 'throttle_rate_per_minute debe ser un numero >= 0 (0 = sin throttling).');
    // 0 = NO enviar el campo. throttle_rate_per_minute es feature de pago: si la
    // app no esta "entitled", OneSignal rechaza el request aunque el valor sea 0.
    if (t > 0) out.throttleRatePerMinute = Math.floor(t);
  }
  if (options.ttl !== undefined && options.ttl !== null && options.ttl !== '') {
    const t = Number(options.ttl);
    if (!Number.isFinite(t) || t < 0) throw err('INVALID_TTL', 'ttl debe ser un numero de segundos >= 0.');
    out.ttl = Math.floor(t);
  }
  if (options.priority !== undefined && options.priority !== null && options.priority !== '') {
    const p = Number(options.priority);
    if (!Number.isFinite(p)) throw err('INVALID_PRIORITY', 'priority debe ser numerico (Android: 5 normal, 10 alta).');
    out.priority = Math.floor(p);
  }

  const sendAfter = String(options.sendAfter || '').trim();
  if (sendAfter) out.sendAfter = sendAfter;
  const delayed = String(options.delayedOption || '').trim();
  if (delayed && delayed !== 'immediate') {
    if (!['timezone', 'last-active'].includes(delayed)) throw err('INVALID_DELAYED', 'delayed_option debe ser "timezone" o "last-active".');
    out.delayedOption = delayed;
  }
  const tod = String(options.deliveryTimeOfDay || '').trim();
  if (tod) out.deliveryTimeOfDay = tod;

  return out;
}

const MAX_IDS_PER_REQUEST = 2000; // limite de OneSignal para include_subscription_ids

// Normaliza opciones del envio POR BLOQUES (throttle propio).
function normalizeBulkOptions(options) {
  options = options || {};
  const ids = (Array.isArray(options.ids) ? options.ids : [])
    .map(s => String(s || '').trim()).filter(Boolean);
  // dedup preservando orden
  const seen = new Set();
  const uniq = [];
  for (const id of ids) { if (!seen.has(id)) { seen.add(id); uniq.push(id); } }
  if (!uniq.length) throw err('NO_TARGET', 'No hay subscription IDs para el envio por bloques.');

  let batchSize = Number(options.batchSize);
  if (!Number.isFinite(batchSize) || batchSize <= 0) batchSize = 1000;
  batchSize = Math.min(Math.floor(batchSize), MAX_IDS_PER_REQUEST);

  let ratePerMinute = Number(options.ratePerMinute);
  if (!Number.isFinite(ratePerMinute) || ratePerMinute < 0) ratePerMinute = 0;
  ratePerMinute = Math.floor(ratePerMinute);

  const out = {
    targetMode: 'subscriptions',
    ids: uniq,
    idField: options.idField === 'player_id' ? 'player_id' : 'subscription_id',
    batchSize,
    ratePerMinute
  };
  // El bulk NUNCA manda throttle_rate_per_minute de OneSignal (el throttle lo
  // hacemos nosotros espaciando bloques). Forzamos a vacio.
  return applyContent({ ...options, throttleRatePerMinute: '' }, out);
}

// Parte un array en chunks de tamano n.
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * A partir de opciones YA normalizadas, arma el body de Create Notification.
 */
function buildBody(cfg, o) {
  const body = { app_id: cfg.oneSignal.appId };

  // Target
  if (o.targetMode === 'segment') {
    body.included_segments = [o.segment];
  } else if (o.targetMode === 'subscriptions') {
    if (o.idField === 'player_id') body.include_player_ids = o.ids;
    else body.include_subscription_ids = o.ids;
  } else { // single
    if (o.idType === 'subscription_id') {
      body.include_subscription_ids = [o.idValue];
    } else if (o.idType === 'player_id') {
      body.include_player_ids = [o.idValue];
    } else if (o.idType === 'onesignal_id') {
      body.include_aliases = { onesignal_id: [o.idValue] };
      body.target_channel = 'push';
    } else if (o.idType === 'external_id') {
      body.include_aliases = { external_id: [o.idValue] };
      body.target_channel = 'push';
    }
  }

  // Contenido
  if (o.title) body.headings = { en: o.title, es: o.title };
  if (o.message) body.contents = { en: o.message, es: o.message };
  if (o.subtitle) body.subtitle = { en: o.subtitle, es: o.subtitle };
  if (o.url) body.url = o.url;
  if (o.largeIcon) body.large_icon = o.largeIcon;
  if (o.bigPicture) body.big_picture = o.bigPicture;
  if (o.data) body.data = o.data;
  if (o.templateId) body.template_id = o.templateId;

  // Throttling / delivery
  if (o.throttleRatePerMinute !== undefined) body.throttle_rate_per_minute = o.throttleRatePerMinute;
  if (o.ttl !== undefined) body.ttl = o.ttl;
  if (o.priority !== undefined) body.priority = o.priority;
  if (o.sendAfter) body.send_after = o.sendAfter;
  if (o.delayedOption) body.delayed_option = o.delayedOption;
  if (o.deliveryTimeOfDay) body.delivery_time_of_day = o.deliveryTimeOfDay;

  return body;
}

// Descripcion human-readable de a quien apunta el envio.
function describeTarget(o) {
  if (o.targetMode === 'segment') {
    return { kind: 'segment', text: `MASIVO — segmento "${o.segment}" (todos los suscriptos del segmento).`, count: null };
  }
  if (o.targetMode === 'subscriptions') {
    return { kind: 'subscriptions', text: `LISTA — ${o.ids.length} subscription IDs (${o.idField}).`, count: o.ids.length };
  }
  return { kind: 'single', text: `PUNTUAL — ${o.idType} = ${o.idValue}.`, count: 1 };
}

// Arma un curl listo para copiar. La REST key se reemplaza por un placeholder
// (nunca se expone). bodyForCurl se serializa pretty para que sea legible.
function toCurl(url, body) {
  const json = JSON.stringify(body, null, 2)
    .replace(/'/g, `'\\''`); // escape de comilla simple para -d '...'
  return [
    `curl --request POST \\`,
    `  --url ${url} \\`,
    `  --header 'Authorization: Basic ${SEND_KEY_PLACEHOLDER}' \\`,
    `  --header 'Content-Type: application/json; charset=utf-8' \\`,
    `  --data '${json}'`
  ].join('\n');
}

/**
 * PREVIEW: arma todo lo necesario para mostrar QUE se va a enviar, sin enviar.
 * Devuelve un objeto seguro para el renderer (key enmascarada).
 */
function preview(options) {
  const cfg = oneSignalConfig.assertReady();
  const o = normalizeSendOptions(options);
  const url = `${baseUrlFrom(cfg)}/notifications`;
  const body = buildBody(cfg, o);
  const target = describeTarget(o);
  return {
    url,
    method: 'POST',
    target,
    appId: cfg.oneSignal.appId,
    headers: {
      'Authorization': `Basic ***${String(cfg.oneSignal.apiRestKey).slice(-4)}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body,
    bodyJson: JSON.stringify(body, null, 2),
    curl: toCurl(url, body),
    throttleRatePerMinute: o.throttleRatePerMinute != null ? o.throttleRatePerMinute : null
  };
}

/* ============================================================
 * 3) Envio real
 * ============================================================ */

// POST de un body ya armado. Devuelve {id, recipients, raw} o lanza Error.
async function postNotification(cfg, body) {
  const url = `${baseUrlFrom(cfg)}/notifications`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
        'Authorization': `Basic ${cfg.oneSignal.apiRestKey}`
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    logger.error('[oneSignalDirect] network error:', e && e.message);
    throw err('NETWORK_ERROR', 'Error de red al contactar OneSignal: ' + e.message);
  }

  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    let desc = (raw && raw.errors && JSON.stringify(raw.errors)) || `HTTP ${res.status}`;
    if (/not entitled to use throttling/i.test(desc)) {
      desc += ' — Tu plan de OneSignal no incluye throttling. Deja "throttle_rate_per_minute" en 0/vacio (o usa el envio por bloques con throttle propio).';
    }
    const e = err('ONESIGNAL_HTTP_ERROR', `OneSignal HTTP ${res.status}: ${desc}`);
    e.status = res.status; e.raw = raw;
    throw e;
  }

  return {
    id: raw.id || null,
    recipients: typeof raw.recipients === 'number' ? raw.recipients : null,
    raw
  };
}

async function send(options, log) {
  const cfg = oneSignalConfig.assertReady();
  const o = normalizeSendOptions(options);
  const body = buildBody(cfg, o);
  const target = describeTarget(o);

  log && log('info', `Enviando notificacion. ${target.text}`);
  if (o.throttleRatePerMinute != null) {
    log && log('info', `Throttling OneSignal: ${o.throttleRatePerMinute} msg/min.`);
  }
  logger.info(`[oneSignalDirect] sending mode=${o.targetMode} throttle=${o.throttleRatePerMinute}`);

  const r = await postNotification(cfg, body).catch(e => {
    log && log('error', e.message);
    throw e;
  });

  if (r.raw.errors && (Array.isArray(r.raw.errors) ? r.raw.errors.length : Object.keys(r.raw.errors).length)) {
    log && log('warn', `OneSignal acepto el request con advertencias: ${JSON.stringify(r.raw.errors)}`);
  }
  if (r.recipients === 0) {
    log && log('warn', `Request aceptado pero recipients=0 (target no encontrado / sin suscriptos).`);
  } else {
    log && log('success', `Enviado. id=${r.id || '?'} recipients=${r.recipients == null ? '?' : r.recipients}.`);
  }
  logger.info(`[oneSignalDirect] sent ok id=${r.id} recipients=${r.recipients}`);

  return { ok: true, id: r.id, recipients: r.recipients, target, raw: r.raw };
}

/* ============================================================
 * 4) Envio POR BLOQUES con throttle propio (sin feature de pago)
 * ============================================================ */

// Plan del envio por bloques: cuantos bloques, tiempo estimado, etc.
function planBulk(o) {
  const batches = Math.ceil(o.ids.length / o.batchSize);
  // Con ritmo R msg/min, el tiempo total ~= totalIds / R minutos.
  const estMinutes = o.ratePerMinute > 0 ? o.ids.length / o.ratePerMinute : 0;
  return { totalIds: o.ids.length, batchSize: o.batchSize, batches, ratePerMinute: o.ratePerMinute, estMinutes };
}

// Preview del envio por bloques: resumen + body+curl del PRIMER bloque.
function previewBulk(options) {
  const cfg = oneSignalConfig.assertReady();
  const o = normalizeBulkOptions(options);
  const plan = planBulk(o);
  const firstBatch = o.ids.slice(0, o.batchSize);
  const body = buildBody(cfg, { ...o, ids: firstBatch });
  const url = `${baseUrlFrom(cfg)}/notifications`;

  const estTxt = plan.estMinutes > 0
    ? ` · ritmo ${o.ratePerMinute} msg/min → ~${plan.estMinutes < 1 ? Math.ceil(plan.estMinutes * 60) + ' s' : plan.estMinutes.toFixed(1) + ' min'}`
    : ' · sin pausa (lo mas rapido posible)';

  return {
    bulk: true,
    url,
    method: 'POST',
    plan,
    target: {
      kind: 'bulk',
      text: `POR BLOQUES — ${plan.totalIds} ids en ${plan.batches} bloque(s) de hasta ${o.batchSize}${estTxt}.`,
      count: plan.totalIds
    },
    headers: {
      'Authorization': `Basic ***${String(cfg.oneSignal.apiRestKey).slice(-4)}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body,
    bodyJson: JSON.stringify(body, null, 2),
    curl: toCurl(url, body),
    note: `Se haran ${plan.batches} requests como este (un bloque de ids cada uno). El throttle lo aplica la app esperando entre bloques; OneSignal no ve ningun throttle_rate_per_minute.`
  };
}

/* ---------- Persistencia del job (checkpoint en disco) ---------- */
// Un solo job activo por vez. Se guarda en userData para sobrevivir a cierres,
// fallos y pausas. Cada bloque enviado deja checkpoint (cursor + resultado).

let JOB_PATH_CACHE = null;
function jobPath() {
  if (JOB_PATH_CACHE) return JOB_PATH_CACHE;
  let dir;
  try { dir = require('electron').app.getPath('userData'); }
  catch (_) { dir = process.cwd(); } // fallback (tests fuera de electron)
  JOB_PATH_CACHE = path.join(dir, 'onesignal-bulk-job.json');
  return JOB_PATH_CACHE;
}

function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(jobPath(), JSON.stringify(job), 'utf8'); }
  catch (e) { logger.error('[oneSignalDirect] no se pudo guardar el job:', e && e.message); }
}

function loadJob() {
  try {
    if (!fs.existsSync(jobPath())) return null;
    const raw = fs.readFileSync(jobPath(), 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function clearBulkJob() {
  try { if (fs.existsSync(jobPath())) fs.unlinkSync(jobPath()); } catch (_) { /* ignore */ }
  return { cleared: true };
}

// Vista liviana del job para el renderer (sin el array completo de ids).
function jobSummary(job) {
  if (!job) return null;
  const failed = (job.results || []).filter(r => r && r.status === 'failed')
    .map(r => ({ index: r.index, error: r.error }));
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    totalIds: (job.ids || []).length,
    batchSize: job.batchSize,
    ratePerMinute: job.ratePerMinute,
    totalBatches: job.totalBatches,
    cursor: job.cursor,               // proximo bloque a enviar (= bloques ya procesados)
    okBatches: job.okBatches,
    failedBatches: job.failedBatches,
    sentMsgs: job.sentMsgs,
    recipients: job.recipients,
    waitingUntil: job.status === 'running' ? (job.waitingUntil || null) : null,
    title: job.opts && job.opts.title,
    failed,
    resumable: job.status === 'paused' || job.status === 'failed'
  };
}

function getBulkJob() { return jobSummary(loadJob()); }

/* ---------- Runner con pausa/reanudacion ---------- */

let pauseRequested = false;
function pauseBulk() { pauseRequested = true; }

// Sleep que corta rapido si piden pausa.
async function pausableSleep(ms) {
  const step = 500;
  let left = ms;
  while (left > 0) {
    if (pauseRequested) return;
    await sleep(Math.min(step, left));
    left -= step;
  }
}

function finalize(job, log) {
  job.waitingUntil = null;          // no quedar mostrando cuenta regresiva al terminar/pausar
  saveJob(job);
  const verb = job.status === 'done' ? 'Completado'
    : job.status === 'paused' ? 'Pausado'
    : job.status === 'failed' ? 'Abortado (fatal)'
    : 'Detenido';
  log && log(job.status === 'done' ? 'success' : 'warn',
    `${verb}. Bloques OK=${job.okBatches}/${job.totalBatches}, fallidos=${job.failedBatches}, cursor=${job.cursor}. Mensajes≈${job.sentMsgs}, recipients≈${job.recipients}.`);
  return {
    ok: true, bulk: true,
    jobId: job.id, status: job.status,
    batches: job.totalBatches, okBatches: job.okBatches, failedBatches: job.failedBatches,
    sentMsgs: job.sentMsgs, recipients: job.recipients,
    cursor: job.cursor,
    resumable: job.status === 'paused' || job.status === 'failed',
    cancelled: job.status === 'paused'
  };
}

// Loop principal: arranca en job.cursor, checkpointea tras cada bloque.
async function runJob(job, log) {
  pauseRequested = false;
  const cfg = oneSignalConfig.assertReady();
  const batches = chunk(job.ids, job.batchSize);
  job.totalBatches = batches.length;
  job.status = 'running';
  saveJob(job);

  const perBatchMs = job.ratePerMinute > 0 ? (job.batchSize / job.ratePerMinute) * 60000 : 0;

  for (let i = job.cursor; i < batches.length; i++) {
    if (pauseRequested) {
      job.cursor = i;
      job.status = 'paused';
      log && log('warn', `Pausa pedida. Quedo en el bloque ${i + 1}/${batches.length}. Podes reanudar desde aca.`);
      return finalize(job, log);
    }

    const batch = batches[i];
    const body = buildBody(cfg, { ...job.opts, ids: batch });
    const t0 = Date.now();

    try {
      const r = await postNotification(cfg, body);
      job.results[i] = { index: i, status: 'ok', count: batch.length, notifId: r.id, recipients: r.recipients, ts: new Date().toISOString() };
      job.okBatches++;
      job.sentMsgs += batch.length;
      if (typeof r.recipients === 'number') job.recipients += r.recipients;
      log && log('success', `Bloque ${i + 1}/${batches.length}: ${batch.length} ids · id=${r.id || '?'} · recipients=${r.recipients == null ? '?' : r.recipients}.`);
    } catch (e) {
      job.results[i] = { index: i, status: 'failed', count: batch.length, error: e.message, ts: new Date().toISOString() };
      job.failedBatches++;
      log && log('error', `Bloque ${i + 1}/${batches.length} fallo: ${e.message}`);
      // Errores de auth/permiso/plan: abortar (fallarian todos), pero dejando checkpoint.
      if (e.status === 401 || e.status === 403 || e.status === 400) {
        job.cursor = i + 1;
        job.status = 'failed';
        log && log('error', 'Error fatal (auth/permiso/plan): aborto. El progreso quedo guardado, podes reanudar luego.');
        return finalize(job, log);
      }
    }

    job.cursor = i + 1;       // checkpoint: este bloque ya fue procesado
    saveJob(job);

    if (i < batches.length - 1 && perBatchMs > 0 && !pauseRequested) {
      const wait = Math.max(0, perBatchMs - (Date.now() - t0));
      if (wait > 0) {
        // Persiste cuando sale el proximo bloque para que el renderer muestre
        // una cuenta regresiva en vivo durante la espera (el banner no se "congela").
        job.waitingUntil = new Date(Date.now() + wait).toISOString();
        saveJob(job);
        log && log('info', `Esperando ${(wait / 1000).toFixed(1)}s antes del bloque ${i + 2}/${batches.length} (ritmo ${job.ratePerMinute} msg/min)...`);
        await pausableSleep(wait);
        job.waitingUntil = null;
        saveJob(job);
      }
    }
  }

  job.status = 'done';
  job.waitingUntil = null;
  return finalize(job, log);
}

// Inicia un envio por bloques NUEVO (descarta job previo sin terminar).
async function sendBulk(options, log) {
  oneSignalConfig.assertReady();
  const o = normalizeBulkOptions(options);
  const opts = { ...o };
  delete opts.ids;            // los ids se guardan aparte (job.ids)

  const job = {
    id: 'bulk-' + Date.now(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    ids: o.ids,
    opts,                     // targetMode/idField/contenido/delivery (sin ids)
    batchSize: o.batchSize,
    ratePerMinute: o.ratePerMinute,
    idField: o.idField,
    totalBatches: Math.ceil(o.ids.length / o.batchSize),
    cursor: 0,
    okBatches: 0, failedBatches: 0, sentMsgs: 0, recipients: 0,
    results: []
  };

  log && log('info', `Envio por bloques [${job.id}]: ${o.ids.length} ids → ${job.totalBatches} bloque(s) de hasta ${o.batchSize}.`);
  log && log('info', o.ratePerMinute > 0
    ? `Throttle propio: ${o.ratePerMinute} msg/min (espera entre bloques).`
    : 'Sin throttle: bloques uno tras otro lo mas rapido posible.');
  saveJob(job);
  return runJob(job, log);
}

// Reanuda el job guardado desde donde quedo.
async function resumeBulk(log) {
  const job = loadJob();
  if (!job) throw err('NO_JOB', 'No hay un envio guardado para reanudar.');
  if (job.status === 'done') throw err('JOB_DONE', 'El envio guardado ya estaba completo.');
  if (!Array.isArray(job.ids) || !job.ids.length) throw err('JOB_EMPTY', 'El envio guardado no tiene ids.');
  log && log('info', `Reanudando [${job.id}] desde el bloque ${job.cursor + 1}/${job.totalBatches} (${job.okBatches} OK, ${job.failedBatches} fallidos hasta ahora).`);
  return runJob(job, log);
}

// Reintenta SOLO los bloques que fallaron: junta sus ids y arma un job nuevo.
// (Los exitos previos ya se entregaron; este job nuevo reemplaza al guardado.)
async function retryFailed(log) {
  oneSignalConfig.assertReady();
  const prev = loadJob();
  if (!prev) throw err('NO_JOB', 'No hay un envio guardado.');
  const failedIdx = (prev.results || []).filter(r => r && r.status === 'failed').map(r => r.index);
  if (!failedIdx.length) throw err('NO_FAILED', 'No hay bloques fallidos para reintentar.');

  const batches = chunk(prev.ids || [], prev.batchSize);
  const ids = [];
  for (const i of failedIdx) { if (batches[i]) ids.push(...batches[i]); }
  if (!ids.length) throw err('NO_FAILED', 'Los bloques fallidos no tienen ids para reintentar.');

  const job = {
    id: 'bulk-' + Date.now(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    retryOf: prev.id,
    ids,
    opts: prev.opts,
    batchSize: prev.batchSize,
    ratePerMinute: prev.ratePerMinute,
    idField: prev.idField,
    totalBatches: Math.ceil(ids.length / prev.batchSize),
    cursor: 0,
    okBatches: 0, failedBatches: 0, sentMsgs: 0, recipients: 0,
    results: []
  };
  log && log('info', `Reintento [${job.id}]: ${failedIdx.length} bloque(s) fallido(s) de [${prev.id}] → ${ids.length} ids en ${job.totalBatches} bloque(s).`);
  saveJob(job);
  return runJob(job, log);
}

module.exports = {
  listSubscriptions,
  preview,
  send,
  previewBulk,
  sendBulk,
  resumeBulk,
  retryFailed,
  pauseBulk,
  getBulkJob,
  clearBulkJob,
  // exportados para test/uso interno
  normalizeSendOptions,
  normalizeBulkOptions,
  buildBody,
  parseCsv,
  normalizeCsvRow
};
