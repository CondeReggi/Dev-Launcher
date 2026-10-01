'use strict';

/**
 * Devolucion (refund) de un pago Plexo a partir del OrderId.
 *
 * Port del flujo C# `App.Orquestador.PedidoGLP.EventHandlers.DevolucionDeDineroHandler`
 * -> `App.Payments.Plexo.PlexoExportedServices.RefundAsync`, usado por el backoffice
 * para devolver el dinero de un pedido GLP / combustible pagado con Plexo:
 *
 *   POST {baseUrl}/Operation/Refund
 *   RefundRequest {
 *     Client,                       // netId (Ducsa)
 *     Request: {
 *       Amount,                     // monto a devolver (decimal)
 *       ClientReferenceId,          // OrdenId (referencia del comercio)
 *       MetaReference,              // CodigoAutorizacionPasarela (PlexoTransactionId)
 *       Type = 0                    // RefundReferenceType.PlexoTransactionId
 *     }
 *   }
 *
 * Replica RefundAsync(referenceType: 0, clientReferenceId: OrdenId, metaReference: CodigoAutorizacion, amount).
 * Con Type = PlexoTransactionId (0) el C# setea MetaReference = metaReference (el codigo de
 * autorizacion de Plexo) y ClientReferenceId = OrdenId. La firma (RSA-SHA512 cuerpo +
 * Digital-Sign RSA-SHA1) se reutiliza de plexoCardsService (mismo certificado / canonicalizacion).
 *
 * El monto y el CodigoAutorizacion se resuelven con el OrderId contra la base APP:
 *   - GLP:         OrdenGlp.ImporteServicio / OrdenGlp.CodigoAutorizacionPasarela
 *   - Combustible: OrdenPago.Importe        / OrdenPago.CodigoAutorizacionPasarela
 * (espejo de DevolucionDeDineroHandler: amount = OrdenGlp.ImporteServicio; metaReference =
 * CodigoAutorizacion persistido en CodigoAutorizacionPasarela). Reutiliza la connection string
 * AppCS de OneSignal, misma base donde viven estas tablas (igual que mediosPagoService).
 */

const plexoCards = require('./plexoCardsService');
const configService = require('./configService');
const oneSignalConfig = require('./oneSignalConfigService');
const logger = require('../utils/logger');

// RefundReferenceType.PlexoTransactionId del backoffice (App.Payments.Plexo.Constants.Enums).
const REFUND_REFERENCE_TYPE_PLEXO = 0;

/* ------------------------------ SQL (lookup orden) ------------------------------ */

// `mssql` se carga lazy (dep pesado: arrastra tedious), igual que mediosPagoService.
let sql = null;
function loadSqlModule() {
  if (!sql) sql = require('mssql');
  return sql;
}

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
  pool.on('error', (e) => logger.error('mssql (plexoRefund) pool error:', e && e.message));
  poolKey = cs;
  return pool;
}

// Trae los datos de la orden necesarios para la devolucion. Una sola fila: el LEFT JOIN
// desde un derived-table garantiza una fila aunque la orden no exista en alguna de las tablas.
const QUERY_ORDER = `
  SELECT
    og.OrdenId                    AS GlpOrdenId,
    og.ImporteServicio            AS ImporteServicio,
    og.CodigoAutorizacionPasarela AS GlpCodigoAutorizacion,
    op.OrdenId                    AS PagoOrdenId,
    op.Importe                    AS Importe,
    op.CodigoAutorizacionPasarela AS PagoCodigoAutorizacion
  FROM (SELECT @id AS OrdenId) q
  LEFT JOIN OrdenGlp  og ON og.OrdenId = q.OrdenId
  LEFT JOIN OrdenPago op ON op.OrdenId = q.OrdenId;
`;

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resuelve, a partir del OrderId, el monto y el CodigoAutorizacion (MetaReference)
 * para precargar el formulario de devolucion.
 * @param {number|string} ordenIdRaw
 * @returns {Promise<{ordenId, found, isGlp, amount, metaReference, importeServicio, importePago, glpCodigoAutorizacion, pagoCodigoAutorizacion}>}
 */
async function getOrderData(ordenIdRaw, log) {
  const ordenId = parseInt(String(ordenIdRaw == null ? '' : ordenIdRaw).trim(), 10);
  if (!Number.isInteger(ordenId) || ordenId <= 0) {
    throw new Error('El OrderId debe ser un numero entero positivo.');
  }

  log && log('info', `Buscando datos de la orden ${ordenId} en la base APP...`);

  const sqlCfg = getSqlConfig();
  const p = await getPool();
  const m = loadSqlModule();
  const req = p.request();
  req.timeout = sqlCfg.requestTimeoutMs || 30000;
  req.input('id', m.Int, ordenId);

  let result;
  try {
    result = await req.query(QUERY_ORDER);
  } catch (e) {
    logger.error('SQL getOrderData fallo:', e && e.message);
    throw new Error('Consulta de la orden a SQL Server fallo: ' + (e && e.message ? e.message : String(e)));
  }

  const row = (result && result.recordset && result.recordset[0]) || {};
  const isGlp  = row.GlpOrdenId != null;
  const isPago = row.PagoOrdenId != null;
  const found  = isGlp || isPago;

  const importeServicio = toNumberOrNull(row.ImporteServicio);
  const importePago     = toNumberOrNull(row.Importe);

  // Igual que DevolucionDeDineroHandler: para GLP el monto es ImporteServicio; si no,
  // se cae al Importe de OrdenPago (flujo combustible).
  const amount = importeServicio != null ? importeServicio : importePago;

  const glpCodigo  = row.GlpCodigoAutorizacion ? String(row.GlpCodigoAutorizacion).trim() : '';
  const pagoCodigo = row.PagoCodigoAutorizacion ? String(row.PagoCodigoAutorizacion).trim() : '';
  // MetaReference = CodigoAutorizacionPasarela (PlexoTransactionId). Prioriza el de GLP.
  const metaReference = glpCodigo || pagoCodigo;

  if (!found) {
    log && log('warn', `No se encontro ninguna orden con OrderId ${ordenId} (ni en OrdenGlp ni en OrdenPago).`);
  } else {
    log && log('success',
      `Orden ${ordenId} encontrada (${isGlp ? 'GLP' : 'combustible'}). ` +
      `Monto=${amount != null ? amount : '∅'}, MetaReference=${metaReference || '∅'}.`);
    if (amount == null) log && log('warn', 'La orden no tiene monto (ImporteServicio/Importe) cargado.');
    if (!metaReference) log && log('warn', 'La orden no tiene CodigoAutorizacionPasarela (MetaReference) cargado.');
  }

  return {
    ordenId,
    found,
    isGlp,
    amount,
    metaReference,
    importeServicio,
    importePago,
    glpCodigoAutorizacion: glpCodigo,
    pagoCodigoAutorizacion: pagoCodigo
  };
}

/* ------------------------------ Refund (gateway Plexo) ------------------------------ */

/**
 * Ejecuta la devolucion total/parcial contra Plexo.
 * @param {{ordenId: number|string, amount: number|string, metaReference: string}} opts
 */
async function refund(opts, log) {
  opts = opts || {};
  const ordenId = String(opts.ordenId == null ? '' : opts.ordenId).trim();
  const amount = toNumberOrNull(opts.amount);
  const metaReference = String(opts.metaReference == null ? '' : opts.metaReference).trim();

  if (!ordenId) throw new Error('El OrderId (ClientReferenceId) es requerido.');
  if (amount == null || amount <= 0) throw new Error('El monto a devolver debe ser un numero mayor a 0.');
  if (!metaReference) throw new Error('El MetaReference (codigo de autorizacion de Plexo) es requerido.');

  const env = opts.env || configService.getEffective().plexo.defaultEnv;
  const cfg = plexoCards.getConfig(env);

  // Replica RefundAsync con referenceType = PlexoTransactionId (0):
  //   ClientReferenceId = OrdenId, MetaReference = codigo de autorizacion, Amount, Type = 0.
  const requestObject = {
    Client: cfg.netId,
    Request: {
      // Amount es `decimal` en C#: hay que firmarlo con formato Newtonsoft (entero -> "1440.0"),
      // por eso se marca con plexoCards.decimal (ver canonicalStringify en plexoCardsService).
      Amount: plexoCards.decimal(amount),
      ClientReferenceId: ordenId,
      MetaReference: metaReference,
      Type: REFUND_REFERENCE_TYPE_PLEXO
    }
  };

  log && log('info',
    `Enviando devolucion a Plexo: OrdenId=${ordenId}, Amount=${amount}, MetaReference=${metaReference}, Type=${REFUND_REFERENCE_TYPE_PLEXO}.`);

  const json = await plexoCards.post('/Operation/Refund', requestObject, cfg, log);

  if (plexoCards.hasError(json)) {
    throw new Error(plexoCards.errorFrom(json));
  }

  const transaction = plexoCards.inner(json).Response;
  log && log('success', `Devolucion aceptada por Plexo para la orden ${ordenId}.`);

  return { ordenId, amount, metaReference, transaction };
}

async function shutdown() {
  if (pool) {
    try { await pool.close(); } catch (_) { /* ignore */ }
    pool = null;
    poolKey = null;
  }
}

module.exports = { getOrderData, refund, shutdown };
