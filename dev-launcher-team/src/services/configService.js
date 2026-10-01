'use strict';

/**
 * Layered config for sendQr:
 *   defaults  <-  src/config/sendQr.config.js       (baseline EMBEDDED en el .exe,
 *                 credenciales compartidas por todo el equipo, gitignored)
 *   overrides <-  userData/sendQr.overrides.json     (por-persona, editado desde el
 *                 modal de Configuracion)
 *
 * A diferencia del Dev Launcher original (donde overrides vive en el propio repo,
 * junto al baseline), esta build se distribuye como .exe empaquetado: el asar es
 * de solo lectura, asi que los overrides de CADA persona (por ejemplo su propio
 * token de Jira — nunca embebido) tienen que vivir fuera del paquete, en userData.
 *
 * `getEffective()` re-lee ambos en cada llamada, asi los cambios aplican al toque
 * sin reiniciar la app.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const { resolveConfigPath } = require('../utils/localConfig');
const OVERRIDES_PATH = path.join(app.getPath('userData'), 'sendQr.overrides.json');

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

// Asegura claves de preferencias generales que no viven en sendQr.config.js
// (ej: CUENTA_A_TRANSFERIR mostrado en la pestaña "App" del modal de Configuracion).
function ensureAppDefaults(cfg) {
  if (!cfg.app || typeof cfg.app !== 'object') cfg.app = {};
  if (typeof cfg.app.CUENTA_A_TRANSFERIR !== 'string') cfg.app.CUENTA_A_TRANSFERIR = '';
  ensureJiraDefaults(cfg);
  ensureOutlookDefaults(cfg);
  ensureFacturaDefaults(cfg);
  ensurePlexoDefaults(cfg);
  ensureReportesDefaults(cfg);
  return cfg;
}

// Seccion "reportesRecurrentes" para la solapa "Reportes recurrentes". Cada reporte
// futuro cuelga de su propia subclave (hoy solo "identityServer", usado por el
// reporte "usuarios internos DUCSA"); cada una tiene connection string por ambiente
// (mismo patron que "plexo"), asi el selector de ambiente global tambien aplica aca.
function ensureReportesDefaults(cfg) {
  if (!cfg.reportesRecurrentes || typeof cfg.reportesRecurrentes !== 'object') cfg.reportesRecurrentes = {};
  const r = cfg.reportesRecurrentes;
  if (!r.identityServer || typeof r.identityServer !== 'object') r.identityServer = {};
  const ident = r.identityServer;
  if (typeof ident.defaultEnv !== 'string' || !ident.defaultEnv) ident.defaultEnv = 'Produccion';
  if (typeof ident.requestTimeoutMs !== 'number') ident.requestTimeoutMs = 30000;
  for (const envKey of ['Testing', 'Produccion']) {
    if (!ident[envKey] || typeof ident[envKey] !== 'object') ident[envKey] = {};
    if (typeof ident[envKey].connectionString !== 'string') ident[envKey].connectionString = '';
  }
  return cfg;
}

// Seccion "plexo": garantiza el shape { defaultEnv, Testing, Produccion } (mismo patron que
// b2bCredentials/graphUsers) aunque el baseline de otra maquina todavia tenga la forma plana
// vieja o no declare la seccion. Asi el selector de ambiente global y la tab "Plexo" del
// modal de Configuracion siempre tienen los 4 campos por ambiente para editar.
function ensurePlexoDefaults(cfg) {
  if (!cfg.plexo || typeof cfg.plexo !== 'object') cfg.plexo = {};
  const p = cfg.plexo;
  if (typeof p.defaultEnv !== 'string' || !p.defaultEnv) p.defaultEnv = 'Produccion';
  for (const envKey of ['Testing', 'Produccion']) {
    if (!p[envKey] || typeof p[envKey] !== 'object') p[envKey] = {};
    const e = p[envKey];
    if (typeof e.certificateThumbprint !== 'string') e.certificateThumbprint = '';
    if (typeof e.netId !== 'string') e.netId = '';
    if (typeof e.baseUrl !== 'string') e.baseUrl = '';
    if (e.commerceId === undefined) e.commerceId = '';
  }
  return cfg;
}

// Seccion "factura" para la solapa "Generacion de Facturas" (port del proyecto
// DistMayoristaGlp). Mantiene siempre presentes la connection string a la base
// SQL Server `DistMayoristaGlp` y el prefijo de factura (equivalentes al
// appsettings.json del proyecto original), editables en la pestaña "Factura"
// del modal de Configuracion. La connection string real (con credenciales) vive
// en el baseline gitignored sendQr.config.js.
function ensureFacturaDefaults(cfg) {
  if (!cfg.factura || typeof cfg.factura !== 'object') cfg.factura = {};
  const fa = cfg.factura;
  if (typeof fa.connectionString !== 'string') fa.connectionString = '';
  if (typeof fa.prefijoFactura !== 'string' || !fa.prefijoFactura) fa.prefijoFactura = '211 A ';
  if (typeof fa.requestTimeoutMs !== 'number') fa.requestTimeoutMs = 30000;
  return cfg;
}

// Seccion "outlook" para la solapa "Correos TuPase". El baseline puede no
// declararla; la dejamos siempre presente para que aparezca editable en la
// pestaña "Outlook" del modal (clientId de la app de Azure, remitente, patron
// de codigo, etc). No hay secretos: el device-code flow usa un public client.
function ensureOutlookDefaults(cfg) {
  if (!cfg.outlook || typeof cfg.outlook !== 'object') cfg.outlook = {};
  const o = cfg.outlook;
  if (typeof o.clientId !== 'string') o.clientId = '';
  if (typeof o.tenantId !== 'string' || !o.tenantId) o.tenantId = 'common';
  if (typeof o.senderTuPase !== 'string') o.senderTuPase = '';
  if (typeof o.codePattern !== 'string' || !o.codePattern) {
    o.codePattern = '(?:c[oó]digo|code|pin)[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{2,15})';
  }
  if (typeof o.scopes !== 'string' || !o.scopes) o.scopes = 'Mail.Read offline_access User.Read';
  if (typeof o.maxEmails !== 'number') o.maxEmails = 200;
  return cfg;
}

// Seccion "jira" para la solapa Tareas. El baseline (sendQr.config.js) puede no
// declararla; la dejamos siempre presente con strings vacios para que aparezca
// editable en la pestaña "Jira" del modal. Los valores reales (incluido el token)
// se guardan via Settings en sendQr.overrides.json (gitignored).
function ensureJiraDefaults(cfg) {
  if (!cfg.jira || typeof cfg.jira !== 'object') cfg.jira = {};
  const j = cfg.jira;
  if (typeof j.baseUrl !== 'string') j.baseUrl = '';
  if (typeof j.email !== 'string') j.email = '';
  if (typeof j.apiToken !== 'string') j.apiToken = '';
  if (typeof j.jql !== 'string' || !j.jql) j.jql = 'assignee = currentUser() AND statusCategory in (2, 4) ORDER BY priority DESC, created ASC';
  if (typeof j.maxResults !== 'number') j.maxResults = 50;
  return cfg;
}

function loadDefaults() {
  // Bust cache so manual edits to sendQr.config.js are picked up
  // Sin sendQr.config.js (clon nuevo) cae a sendQr.config.example.js
  const defaultsPath = resolveConfigPath('sendQr');
  delete require.cache[require.resolve(defaultsPath)];
  return ensureAppDefaults(require(defaultsPath));
}

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  try {
    const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function getEffective() {
  return ensureAppDefaults(deepMerge(loadDefaults(), loadOverrides()));
}

function saveOverrides(overrides) {
  if (!isPlainObject(overrides)) {
    throw new Error('Overrides debe ser un objeto.');
  }
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
}

function overridesPath() { return OVERRIDES_PATH; }

module.exports = {
  loadDefaults,
  loadOverrides,
  getEffective,
  saveOverrides,
  overridesPath
};
