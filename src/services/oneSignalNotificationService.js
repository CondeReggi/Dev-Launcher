'use strict';

/**
 * Cliente HTTP minimal para OneSignal:
 *   POST {baseUrl}/notifications
 *   Authorization: Basic {apiRestKey}
 *
 * El PnsHandle se manda como:
 *   - include_external_user_ids: [pnsHandle]   (default)
 *   - include_player_ids:        [pnsHandle]   (si targeting.pnsHandleAs === 'player_id')
 *
 * Decision tomada en el config, asi el frontend nunca se entera del modo.
 *
 * Esta funcion nunca loguea la api key. Loguea: que esta enviando, a quien
 * (PnsHandle truncado), titulo, longitud del body, response status, response
 * id, errores en formato controlado.
 */
const logger = require('../utils/logger');
const oneSignalConfig = require('./oneSignalConfigService');

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length <= n ? s : s.slice(0, n) + '...';
}

function maskHandle(h) {
  if (typeof h !== 'string' || h.length <= 8) return h || '';
  return h.slice(0, 4) + '...' + h.slice(-4);
}

function isHttpUrl(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) { return false; }
}

/**
 * Envia una push a OneSignal.
 *
 * @param {Object} args
 * @param {string}  args.pnsHandle  PnsHandle del registro (external_user_id o playerId segun config)
 * @param {string} [args.title]    Requerido salvo que se use templateId
 * @param {string} [args.message]  Requerido salvo que se use templateId
 *
 * Campos opcionales (modo Custom). Si vienen vacios, no se mandan a OneSignal:
 * @param {string} [args.subtitle]    Subtitulo iOS
 * @param {string} [args.url]         URL a abrir al tocar (http/https)
 * @param {string} [args.largeIcon]   URL del icono grande (Android)
 * @param {string} [args.bigPicture]  URL de la imagen grande (Android, vista expandida)
 * @param {Object} [args.data]        Payload custom key/value (objeto plano)
 * @param {string} [args.templateId]  Si esta seteado, OneSignal usa esa template
 *                                    del dashboard. Title/message la overridean.
 *
 * @param {Function} [log]  log(kind, text) — opcional, para stream a UI
 */
async function sendToDevice(args, log) {
  args = args || {};
  const { pnsHandle, title, message } = args;

  if (!pnsHandle || typeof pnsHandle !== 'string' || pnsHandle.trim() === '') {
    log && log('error', 'PnsHandle invalido (vacio o nulo). Aborto envio.');
    const err = new Error('PnsHandle invalido: vacio o nulo.');
    err.code = 'INVALID_PNS_HANDLE';
    throw err;
  }

  const hasTemplate = args.templateId && String(args.templateId).trim();

  if (!hasTemplate) {
    if (!title || !String(title).trim()) {
      const err = new Error('El titulo es requerido (salvo que uses templateId).');
      err.code = 'TITLE_REQUIRED';
      throw err;
    }
    if (!message || !String(message).trim()) {
      const err = new Error('El mensaje es requerido (salvo que uses templateId).');
      err.code = 'MESSAGE_REQUIRED';
      throw err;
    }
  }

  // Validacion de URLs opcionales: si vienen no-vacias, deben ser http/https.
  for (const [k, v] of [['url', args.url], ['largeIcon', args.largeIcon], ['bigPicture', args.bigPicture]]) {
    if (v && String(v).trim() && !isHttpUrl(v)) {
      const err = new Error(`Campo "${k}" debe ser una URL http(s) valida.`);
      err.code = 'INVALID_URL';
      throw err;
    }
  }
  if (args.data !== undefined && args.data !== null) {
    if (typeof args.data !== 'object' || Array.isArray(args.data)) {
      const err = new Error('El payload "data" debe ser un objeto JSON plano.');
      err.code = 'INVALID_DATA';
      throw err;
    }
  }

  const cfg = oneSignalConfig.assertReady();
  const baseUrl = (cfg.oneSignal.baseUrl || 'https://onesignal.com/api/v1').replace(/\/+$/, '');
  const url = `${baseUrl}/notifications`;
  const mode = (cfg.targeting && cfg.targeting.pnsHandleAs) || 'external_user_id';

  const body = { app_id: cfg.oneSignal.appId };

  if (title && String(title).trim()) {
    body.headings = { en: String(title), es: String(title) };
  }
  if (message && String(message).trim()) {
    body.contents = { en: String(message), es: String(message) };
  }
  if (args.subtitle && String(args.subtitle).trim()) {
    body.subtitle = { en: String(args.subtitle), es: String(args.subtitle) };
  }
  if (args.url && String(args.url).trim())          body.url = String(args.url).trim();
  if (args.largeIcon && String(args.largeIcon).trim())   body.large_icon = String(args.largeIcon).trim();
  if (args.bigPicture && String(args.bigPicture).trim()) body.big_picture = String(args.bigPicture).trim();
  if (args.data && Object.keys(args.data).length)   body.data = args.data;
  if (hasTemplate)                                  body.template_id = String(args.templateId).trim();

  if (mode === 'player_id') {
    body.include_player_ids = [pnsHandle.trim()];
  } else {
    body.include_external_user_ids = [pnsHandle.trim()];
  }

  const extras = Object.keys(body).filter(k => !['app_id', 'headings', 'contents', 'include_external_user_ids', 'include_player_ids'].includes(k));
  log && log('info', `Intento de envio a PnsHandle=${maskHandle(pnsHandle)} mode=${mode} title="${truncate(title || '', 60)}" msgLen=${String(message || '').length}${extras.length ? ' extras=[' + extras.join(',') + ']' : ''}`);
  logger.info(`[oneSignal] Sending to ${maskHandle(pnsHandle)} mode=${mode} extras=${JSON.stringify(extras)}`);

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
    logger.error('[oneSignal] network error:', e && e.message);
    log && log('error', `Error de red llamando a OneSignal: ${e.message}`);
    const err = new Error('Error de red al contactar OneSignal: ' + e.message);
    err.code = 'NETWORK_ERROR';
    throw err;
  }

  const raw = await res.json().catch(() => ({}));

  if (!res.ok) {
    const desc = (raw && raw.errors && JSON.stringify(raw.errors)) || `HTTP ${res.status}`;
    logger.error(`[oneSignal] HTTP ${res.status}:`, desc);
    log && log('error', `OneSignal devolvio HTTP ${res.status}: ${desc}`);
    const err = new Error(`OneSignal HTTP ${res.status}: ${desc}`);
    err.code = 'ONESIGNAL_HTTP_ERROR';
    err.status = res.status;
    err.raw = raw;
    throw err;
  }

  // OneSignal devuelve recipients=0 cuando el handle no matchea ningun device.
  const recipients = typeof raw.recipients === 'number' ? raw.recipients : null;
  if (recipients === 0) {
    log && log('warn', `OneSignal acepto el request pero recipients=0 (PnsHandle no encontrado en esa app).`);
  } else {
    log && log('success', `OneSignal acepto el envio. id=${raw.id || '?'} recipients=${recipients == null ? '?' : recipients}.`);
  }
  logger.info(`[oneSignal] sent ok. id=${raw.id} recipients=${recipients}`);

  return {
    ok: true,
    id: raw.id || null,
    recipients,
    raw
  };
}

module.exports = { sendToDevice };
