'use strict';

/**
 * Lee dispositivos registrados desde SQL Server (AppCS) y los devuelve como
 * DTOs listos para el renderer. JOIN RegistroDispositivo + Usuario, filtra
 * PnsHandle no vacio.
 *
 * Query base:
 *   SELECT rd.RegistroDispositivoId, rd.UsuarioId, rd.PnsHandle,
 *          rd.FechaCreacion, rd.Activo, u.*
 *   FROM RegistroDispositivo rd
 *   INNER JOIN Usuario u ON u.UsuarioId = rd.UsuarioId
 *   WHERE rd.PnsHandle IS NOT NULL
 *     AND LTRIM(RTRIM(rd.PnsHandle)) <> '';
 *
 * No asumimos un schema fijo de `Usuario` (puede variar entre ambientes). En
 * vez de mapear columnas a fuego, devolvemos:
 *   - los 5 campos conocidos de RegistroDispositivo (con prefijo)
 *   - un objeto `usuario` con TODO lo que venga de la tabla Usuario, mas
 *     un par de aliases convenientes (`displayName`, `documento`, `email`)
 *     resueltos por heuristica sobre nombres comunes de columnas.
 *
 * Asi el frontend muestra lo que exista sin romper si falta una columna.
 *
 * Performance: pooling cacheado en modulo. Se invalida si cambia la connection
 * string (lazy reconnect).
 */
// `mssql` se carga lazy (es un dep pesado: arrastra tedious + crypto-bindings).
// Mantener este require fuera del top-level baja el tiempo de arranque de la
// app porque main.js -> ipcHandlers.js requiere este modulo, pero hasta que el
// usuario no abre la seccion OneSignal y dispara una query, no necesitamos sql.
let sql = null;
function loadSqlModule() {
  if (!sql) sql = require('mssql');
  return sql;
}

const oneSignalConfig = require('./oneSignalConfigService');
const logger = require('../utils/logger');

let pool = null;
let poolKey = null;

async function getPool() {
  const cfg = oneSignalConfig.assertReady();
  const cs = cfg.sql.connectionString;
  if (pool && poolKey === cs) return pool;
  if (pool) {
    try { await pool.close(); } catch (_) { /* ignore */ }
    pool = null;
  }
  const m = loadSqlModule();
  // mssql acepta un objeto, o el connection-string ADO.NET, o la URL mssql://
  pool = await new m.ConnectionPool(cs).connect();
  pool.on('error', (e) => logger.error('mssql pool error:', e && e.message));
  poolKey = cs;
  return pool;
}

const KNOWN_NAME_KEYS    = ['NombreUsuario', 'Nombre', 'NombreCompleto', 'FirstName', 'PrimerNombre'];
const KNOWN_SURNAME_KEYS = ['Apellido', 'Apellidos', 'LastName', 'SegundoNombre'];
const KNOWN_DOC_KEYS     = ['Documento', 'NumeroDocumento', 'Cedula', 'DocumentoIdentidad', 'CI', 'NroDocumento'];
const KNOWN_EMAIL_KEYS   = ['Email', 'Correo', 'CorreoElectronico', 'Mail'];

function pickFirstString(row, candidates) {
  for (const k of candidates) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return null;
}

// Mapeo del TipoPlataformaId (rd) a una etiqueta legible. Si en el futuro hay
// mas plataformas, agregar acá. Si el valor no esta mapeado, mostramos el ID.
const PLATAFORMA_LABELS = { 1: 'iOS', 2: 'Android', 3: 'Web' };

function buildDeviceDto(row) {
  // SELECT aliasa los campos de RegistroDispositivo con prefijo rd_* para
  // evitar colision con u.* (sobre todo en UsuarioId).
  const registroDispositivoId = row.rd_RegistroDispositivoId;
  const usuarioId             = row.rd_UsuarioId;
  const pnsHandle             = row.rd_PnsHandle;
  const tipoPlataformaId      = row.rd_TipoPlataformaId;
  const azureNotificationHubId = row.rd_AzureNotificationHubId;

  // Todo lo demas es del Usuario.
  const usuarioRaw = { ...row };
  delete usuarioRaw.rd_RegistroDispositivoId;
  delete usuarioRaw.rd_UsuarioId;
  delete usuarioRaw.rd_PnsHandle;
  delete usuarioRaw.rd_TipoPlataformaId;
  delete usuarioRaw.rd_AzureNotificationHubId;

  // displayName heuristico (no se asume Nombre/Apellido — en el schema actual
  // de DUCSA no existen). Si no hay nada usable, queda null.
  const nombre   = pickFirstString(usuarioRaw, KNOWN_NAME_KEYS);
  const apellido = pickFirstString(usuarioRaw, KNOWN_SURNAME_KEYS);
  const displayName = [nombre, apellido].filter(Boolean).join(' ').trim()
    || pickFirstString(usuarioRaw, ['NombreUsuario'])
    || null;

  // Fecha de registro / Activo: el schema actual no tiene esos campos en rd,
  // pero los buscamos por heuristica por si en otro ambiente existen.
  const fechaRegistro = usuarioRaw.FechaRegistro || usuarioRaw.FechaCreacion || null;
  const activoRaw = ['Activo', 'IsActive', 'Enabled']
    .map(k => usuarioRaw[k])
    .find(v => v !== undefined);

  return {
    registroDispositivoId,
    usuarioId,
    pnsHandle,
    tipoPlataformaId,
    plataforma: tipoPlataformaId == null
      ? null
      : (PLATAFORMA_LABELS[tipoPlataformaId] || String(tipoPlataformaId)),
    azureNotificationHubId,
    fechaRegistro,
    activo: activoRaw == null ? null : Boolean(activoRaw),

    // Atajos derivados (mostrados directo en la tabla del UI):
    displayName,
    documento: pickFirstString(usuarioRaw, KNOWN_DOC_KEYS),
    email:     pickFirstString(usuarioRaw, KNOWN_EMAIL_KEYS),

    // Bag completo del Usuario, por si el UI quiere mostrar mas campos.
    usuario: usuarioRaw
  };
}

const QUERY_DEVICES = `
  SELECT
    rd.RegistroDispositivoId   AS rd_RegistroDispositivoId,
    rd.UsuarioId               AS rd_UsuarioId,
    rd.PnsHandle               AS rd_PnsHandle,
    rd.TipoPlataformaId        AS rd_TipoPlataformaId,
    rd.AzureNotificationHubId  AS rd_AzureNotificationHubId,
    u.*
  FROM RegistroDispositivo rd
  INNER JOIN Usuario u
    ON u.UsuarioId = rd.UsuarioId
  WHERE rd.PnsHandle IS NOT NULL
    AND LTRIM(RTRIM(rd.PnsHandle)) <> ''
  ORDER BY rd.RegistroDispositivoId DESC;
`;

async function listDevices(log) {
  const cfg = oneSignalConfig.assertReady();
  log && log('info', 'Consultando RegistroDispositivo JOIN Usuario (PnsHandle no vacio).');

  const p = await getPool();
  const req = p.request();
  req.timeout = (cfg.sql && cfg.sql.requestTimeoutMs) || 30000;

  let result;
  try {
    result = await req.query(QUERY_DEVICES);
  } catch (e) {
    logger.error('SQL listDevices fallo:', e && e.message);
    throw new Error('Consulta a SQL Server fallo: ' + (e && e.message ? e.message : String(e)));
  }
  const rows = (result && result.recordset) || [];
  const devices = rows.map(buildDeviceDto);
  log && log('success', `Dispositivos encontrados: ${devices.length}.`);
  return devices;
}

async function shutdown() {
  if (pool) {
    try { await pool.close(); } catch (_) { /* ignore */ }
    pool = null;
    poolKey = null;
  }
}

module.exports = { listDevices, shutdown };
