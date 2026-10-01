'use strict';

/**
 * Config de OneSignal (directo) para esta app standalone.
 *
 * A diferencia del intento inicial (JSON editable en userData, uno por
 * persona), esta version usa credenciales EMBEBIDAS: `oneSignal.config.js`
 * (gitignored) se empaqueta dentro del .exe al correr `npm run dist`, asi que
 * todo el equipo comparte el mismo App ID / REST API Key sin configurar nada
 * al abrir la app.
 *
 * `oneSignal.config.js` nunca se commitea (ver .gitignore). El template
 * committeado es `oneSignal.config.example.js`.
 *
 * Nunca se expone apiRestKey al renderer: getPublicEffective() la enmascara.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS_PATH = path.resolve(__dirname, '..', 'config', 'oneSignal.config.js');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
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

// Garantiza la seccion `direct` con defaults razonables aunque el config.js
// del equipo no la declare.
function ensureDirectDefaults(cfg) {
  const d = cfg.direct && typeof cfg.direct === 'object' ? cfg.direct : {};
  cfg.direct = {
    listLimitPerPage: Number.isFinite(Number(d.listLimitPerPage)) ? Number(d.listLimitPerPage) : 300,
    maxPages:         Number.isFinite(Number(d.maxPages)) ? Number(d.maxPages) : 20,
    defaultThrottleRatePerMinute: Number.isFinite(Number(d.defaultThrottleRatePerMinute)) ? Number(d.defaultThrottleRatePerMinute) : 0,
    defaultSegment:   typeof d.defaultSegment === 'string' && d.defaultSegment.trim() ? d.defaultSegment : 'Subscribed Users',
    csvMaxRows:         Number.isFinite(Number(d.csvMaxRows)) ? Number(d.csvMaxRows) : 0,
    csvPollMs:          Number.isFinite(Number(d.csvPollMs)) ? Number(d.csvPollMs) : 4000,
    csvMaxPollAttempts: Number.isFinite(Number(d.csvMaxPollAttempts)) ? Number(d.csvMaxPollAttempts) : 45
  };
  return cfg;
}

function getEffective() {
  return ensureDirectDefaults(deepMerge({}, loadDefaults()));
}

function isPlaceholder(value, hints) {
  if (typeof value !== 'string' || !value) return true;
  return hints.some(h => value.includes(h));
}

// Throws con mensaje claro si la config embebida no esta lista para usar
// (solo pasaria en desarrollo, si falta oneSignal.config.js).
function assertReady() {
  const cfg = getEffective();
  const errors = [];
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
    oneSignal: {
      appId: cfg.oneSignal && cfg.oneSignal.appId ? cfg.oneSignal.appId : '',
      apiRestKey: cfg.oneSignal && cfg.oneSignal.apiRestKey
        ? '***' + String(cfg.oneSignal.apiRestKey).slice(-4)
        : '',
      baseUrl: cfg.oneSignal && cfg.oneSignal.baseUrl ? cfg.oneSignal.baseUrl : ''
    },
    direct: cfg.direct || {}
  };
}

module.exports = {
  loadDefaults,
  getEffective,
  getPublicEffective,
  assertReady
};
