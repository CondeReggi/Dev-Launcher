'use strict';

/**
 * Lookup de MediosPago habilitados para ENRIQUECER la grilla de tarjetas Plexo.
 *
 * Resuelve, en memoria y con UNA sola consulta, si un instrumento de Plexo
 * (issuer + tipo crédito/débito/prepaga) corresponde a un MedioPago habilitado
 * en el sistema. Espejo conceptual de:
 *
 *   SELECT *
 *   FROM MediosPago mp
 *   JOIN TipoMedioPago tmp   ON tmp.TipoMedioPagoId = mp.TipoMedioPagoId
 *   JOIN PlexoMediosPago pmp ON pmp.Id              = mp.PlexoMediosPagoId
 *   WHERE pmp.Codigo = @issuer
 *     AND tmp.Nombre <-> (crédito | débito | prepaga)
 *     AND mp.Habilitado = 1
 *
 * Schema real (base APP en `SQL_SERVER`, verificado):
 *   - PlexoMediosPago(Id, Codigo, Descripcion)  -> Codigo == issuer de Plexo (ej. Visa = "11").
 *   - TipoMedioPago(TipoMedioPagoId, Nombre, Habilitado)
 *       1 = Banco · 2 = Tarjeta de Crédito · 3 = Tarjeta Prepaga · 4 = Tarjeta de Débito.
 *   - MediosPago(..., Codigo, Habilitado bit, TipoMedioPagoId, PlexoMediosPagoId).
 *
 * Nota: un mismo (PlexoCodigo, Tipo) puede tener VARIAS filas en MediosPago con
 * `Habilitado` mixto (ej. Visa débito). Regla: el medio de pago se considera
 * habilitado si AL MENOS UNA fila coincidente lo está (OR lógico).
 *
 * Reutiliza la connection string "AppCS" ya configurada para OneSignal
 * (`src/config/oneSignal.config.js` -> `sql.connectionString`): es la MISMA base
 * `APP` donde viven estas tablas, así no duplicamos credenciales ni agregamos
 * una pestaña de Settings nueva.
 */

// `mssql` se carga lazy (dep pesado: arrastra tedious). Igual que en
// oneSignalDevicesService, no lo requerimos hasta que el usuario dispara una
// consulta, para no penalizar el arranque de la app.
let sql = null;
function loadSqlModule() {
  if (!sql) sql = require('mssql');
  return sql;
}

const oneSignalConfig = require('./oneSignalConfigService');
const logger = require('../utils/logger');

let pool = null;
let poolKey = null;

function getSqlConfig() {
  let cfg = {};
  try { cfg = oneSignalConfig.getEffective() || {}; } catch (_) { cfg = {}; }
  return cfg.sql || {};
}

async function getPool() {
  const sqlCfg = getSqlConfig();
  const cs = sqlCfg.connectionString;
  if (!cs) {
    throw new Error(
      'No hay connection string AppCS configurada (src/config/oneSignal.config.js -> sql.connectionString).'
    );
  }
  if (pool && poolKey === cs) return pool;
  if (pool) {
    try { await pool.close(); } catch (_) { /* ignore */ }
    pool = null;
  }
  const m = loadSqlModule();
  pool = await new m.ConnectionPool(cs).connect();
  pool.on('error', (e) => logger.error('mssql (mediosPago) pool error:', e && e.message));
  poolKey = cs;
  return pool;
}

/* --------------------------- Normalización de tipo --------------------------- */

function stripAccentsLower(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Mapea el `Nombre` de TipoMedioPago a un tipo canónico: 'credito' | 'debito' |
 * 'prepaga'. Devuelve null para "Banco" u otros que no son tarjetas.
 */
function tipoFromDbName(name) {
  const s = stripAccentsLower(name);
  if (s.includes('credito')) return 'credito';
  if (s.includes('debito'))  return 'debito';
  if (s.includes('prepag'))  return 'prepaga';
  return null;
}

/* ------------------------------- Query ------------------------------- */

const QUERY_ENABLED = `
  SELECT pmp.Codigo AS PlexoCodigo, tmp.Nombre AS TipoNombre, mp.Habilitado
  FROM MediosPago mp
  INNER JOIN TipoMedioPago tmp   ON tmp.TipoMedioPagoId = mp.TipoMedioPagoId
  INNER JOIN PlexoMediosPago pmp ON pmp.Id              = mp.PlexoMediosPagoId;
`;

/**
 * Trae todos los medios de pago de tarjeta y construye un Map para resolver el
 * match en memoria (una sola consulta para toda la grilla).
 *
 * @returns {Promise<Map<string, boolean>>} key `${plexoCodigo}|${tipo}` -> habilitado
 *   (true si AL MENOS UNA fila coincidente está habilitada). `map.has(key)` indica
 *   si el medio de pago existe; `map.get(key)` si está habilitado.
 */
async function getEnabledMap(log) {
  const sqlCfg = getSqlConfig();
  const p = await getPool();
  const req = p.request();
  req.timeout = sqlCfg.requestTimeoutMs || 30000;

  let result;
  try {
    result = await req.query(QUERY_ENABLED);
  } catch (e) {
    logger.error('SQL getEnabledMap fallo:', e && e.message);
    throw new Error('Consulta de medios de pago a SQL Server fallo: ' + (e && e.message ? e.message : String(e)));
  }

  const rows = (result && result.recordset) || [];
  const map = new Map();
  let cardRows = 0;
  for (const row of rows) {
    const tipo = tipoFromDbName(row.TipoNombre);
    if (!tipo) continue; // Banco u otros: no son tarjetas, se ignoran.
    if (row.PlexoCodigo == null) continue;
    const key = `${String(row.PlexoCodigo)}|${tipo}`;
    const enabled = !!row.Habilitado;
    map.set(key, (map.get(key) || false) || enabled);
    cardRows++;
  }
  log && log('info', `MediosPago: ${cardRows} fila(s) de tarjeta leídas, ${map.size} combinación(es) issuer×tipo únicas.`);
  return map;
}

async function shutdown() {
  if (pool) {
    try { await pool.close(); } catch (_) { /* ignore */ }
    pool = null;
    poolKey = null;
  }
}

module.exports = { getEnabledMap, tipoFromDbName, shutdown };
