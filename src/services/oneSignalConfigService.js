'use strict';

/**
 * Layered config for OneSignal (espejo del patron sendQr):
 *   defaults   <-  src/config/oneSignal.config.js         (gitignored, baseline)
 *   overrides  <-  src/config/oneSignal.overrides.json    (gitignored, editable)
 *   env vars   <-  DEVL_APP_CS / DEVL_ONESIGNAL_APP_ID / DEVL_ONESIGNAL_API_KEY
 *                  pisan a defaults+overrides si estan definidas.
 *
 * Todo se re-lee en cada `getEffective()` — sin restart de la app.
 *
 * Nunca exponer apiRestKey al renderer. Para eso existe `getPublicEffective()`
 * que enmascara los secretos antes de devolverlos por IPC.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS_PATH  = path.resolve(__dirname, '..', 'config', 'oneSignal.config.js');
const OVERRIDES_PATH = path.resolve(__dirname, '..', 'config', 'oneSignal.overrides.json');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = deepMerge(base[k], over[k]);
  }
  return out;
}

function loadDefaults() {
  if (!fs.existsSync(DEFAULTS_PATH)) {
    throw new Error(
      'Falta src/config/oneSignal.config.js. Copia oneSignal.config.example.js a oneSignal.config.js y completa los valores.'
    );
  }
  delete require.cache[require.resolve(DEFAULTS_PATH)];
  return require(DEFAULTS_PATH);
}

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  try {
    const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function applyEnvOverrides(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (process.env.DEVL_APP_CS) {
    out.sql = out.sql || {};
    out.sql.connectionString = process.env.DEVL_APP_CS;
  }
  if (process.env.DEVL_ONESIGNAL_APP_ID) {
    out.oneSignal = out.oneSignal || {};
    out.oneSignal.appId = process.env.DEVL_ONESIGNAL_APP_ID;
  }
  if (process.env.DEVL_ONESIGNAL_API_KEY) {
    out.oneSignal = out.oneSignal || {};
    out.oneSignal.apiRestKey = process.env.DEVL_ONESIGNAL_API_KEY;
  }
  return out;
}

// Garantiza la seccion `direct` (config del envio directo a la API de OneSignal)
// con defaults razonables, aunque el oneSignal.config.js del usuario no la declare.
function ensureDirectDefaults(cfg) {
  const d = cfg.direct && typeof cfg.direct === 'object' ? cfg.direct : {};
  cfg.direct = {
    listLimitPerPage: Number.isFinite(Number(d.listLimitPerPage)) ? Number(d.listLimitPerPage) : 300,
    maxPages:         Number.isFinite(Number(d.maxPages)) ? Number(d.maxPages) : 20,
    // Throttling por defecto para el envio masivo (msg/min). 0 = sin throttling.
    // Ver https://documentation.onesignal.com/docs/en/throttling
    defaultThrottleRatePerMinute: Number.isFinite(Number(d.defaultThrottleRatePerMinute)) ? Number(d.defaultThrottleRatePerMinute) : 0,
    defaultSegment:   typeof d.defaultSegment === 'string' && d.defaultSegment.trim() ? d.defaultSegment : 'Subscribed Users',
    // Fallback CSV export (apps con +80k usuarios, /players deshabilitado):
    csvMaxRows:         Number.isFinite(Number(d.csvMaxRows)) ? Number(d.csvMaxRows) : 0,      // 0 = sin tope
    csvPollMs:          Number.isFinite(Number(d.csvPollMs)) ? Number(d.csvPollMs) : 4000,
    csvMaxPollAttempts: Number.isFinite(Number(d.csvMaxPollAttempts)) ? Number(d.csvMaxPollAttempts) : 45
  };
  return cfg;
}

function getEffective() {
  return ensureDirectDefaults(applyEnvOverrides(deepMerge(loadDefaults(), loadOverrides())));
}

function isPlaceholder(value, placeholderHints) {
  if (typeof value !== 'string' || !value) return true;
  return placeholderHints.some(h => value.includes(h));
}

// Throws con mensaje claro si la config no esta lista para usar.
function assertReady() {
  const cfg = getEffective();
  const errors = [];
  if (!cfg.sql || isPlaceholder(cfg.sql.connectionString, ['YOUR_SQL_SERVER', 'YOUR_DB'])) {
    errors.push('sql.connectionString no esta configurada (placeholder detectado).');
  }
  if (!cfg.oneSignal || isPlaceholder(cfg.oneSignal.appId, ['YOUR_ONESIGNAL_APP_ID'])) {
    errors.push('oneSignal.appId no esta configurado.');
  }
  if (!cfg.oneSignal || isPlaceholder(cfg.oneSignal.apiRestKey, ['YOUR_ONESIGNAL_REST_API_KEY'])) {
    errors.push('oneSignal.apiRestKey no esta configurada.');
  }
  if (errors.length) {
    throw new Error('Config OneSignal incompleta: ' + errors.join(' | '));
  }
  return cfg;
}

// Para enviar al renderer: enmascara secretos.
function getPublicEffective() {
  const cfg = getEffective();
  return {
    sql: {
      connectionString: cfg.sql && cfg.sql.connectionString
        ? maskConnString(cfg.sql.connectionString)
        : ''
    },
    oneSignal: {
      appId: cfg.oneSignal && cfg.oneSignal.appId ? cfg.oneSignal.appId : '',
      apiRestKey: cfg.oneSignal && cfg.oneSignal.apiRestKey
        ? '***' + String(cfg.oneSignal.apiRestKey).slice(-4)
        : '',
      baseUrl: cfg.oneSignal && cfg.oneSignal.baseUrl ? cfg.oneSignal.baseUrl : ''
    },
    targeting: cfg.targeting || { pnsHandleAs: 'external_user_id' },
    direct: cfg.direct || {}
  };
}

function maskConnString(s) {
  return String(s).replace(/(Password|Pwd)\s*=\s*[^;]+/gi, '$1=***');
}

module.exports = {
  loadDefaults,
  loadOverrides,
  getEffective,
  getPublicEffective,
  assertReady
};
