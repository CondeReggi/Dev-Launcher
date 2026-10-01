'use strict';

/**
 * Generacion de Facturas.
 *
 * Port 1:1 del proyecto de consola C:\Users\YOUR_USER\source\repos\DistMayoristaGlp
 * (DistMayoristaGlp/Services/PedidoProcessor.cs + Helpers/CalculoHelper.cs).
 *
 * Dado un PedidoId, lee el pedido (con su Cliente y sus ItemPedidos) y todos los
 * Productos de la base SQL Server `DistMayoristaGlp`, calcula para cada item
 * (con Cantidad > 0) los mismos importes que el helper C# y genera:
 *   - un UPDATE por ItemPedido,
 *   - un INSERT en [dbo].[Facturas] con los totales acumulados,
 *   - (si el pedido esta "Anulado") un UPDATE del Estado del pedido a 'Facturado'.
 *
 * La logica de calculo, los redondeos (incluido el redondeo bancario de
 * Math.Round(x, 0) de .NET, que usa MidpointRounding.ToEven) y los formatos de
 * cada columna (F6/F9/F10/F11/F13/F15) se replican EXACTAMENTE. No cambiar el
 * orden de las columnas ni las precisiones: son load-bearing para que el SQL
 * generado coincida byte a byte con el de la app original.
 *
 * Config (connection string + prefijo de factura) vive en la seccion `factura`
 * de la config efectiva (sendQr.config.js + overrides), editable desde el modal
 * de Configuracion (pestaña "Factura"), igual que el resto de la app.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const configService = require('./configService');
const logger = require('../utils/logger');

/* ------------------------------ Constantes del helper C# ------------------------------ */

const IVA_PORCENTAJE = 0.22;
const PERCEPCION_IVA = 0.35;
const URSEA = 0.002;

/* ------------------------------ Redondeo bancario (.NET Math.Round ToEven) ------------------------------ */

/**
 * Replica `Math.Round(x, 0)` de .NET, que por defecto usa MidpointRounding.ToEven
 * (redondeo bancario). NO es lo mismo que `Math.round` de JS, que redondea el .5
 * hacia +infinito. Solo difieren en el caso exacto de .5, pero se replica para ser
 * fiel al comportamiento original (positivos y negativos por igual).
 */
function roundHalfToEven(x) {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac < 0.5) return floor;
  if (frac > 0.5) return floor + 1;
  // Exactamente .5 -> al par mas cercano.
  return (floor % 2 === 0) ? floor : floor + 1;
}

/* ------------------------------ Calculo por item (CalculoHelper.CalcularTodo) ------------------------------ */

function calcularTodo(precioProducto, cantidad, bonificacionBase, descuentoCliente) {
  const importeAux = precioProducto * cantidad;
  // Mismo orden de evaluacion que el C# (izquierda a derecha, * y / con igual
  // precedencia): ((bonificacionBase * descuento) / 100) * cantidad. Agrupar
  // distinto puede diferir en el ultimo bit de punto flotante.
  const bonificacion = bonificacionBase * descuentoCliente / 100 * cantidad;
  const importeNeto = importeAux - bonificacion;
  const iva = importeNeto * IVA_PORCENTAJE;
  const percepcionIVA = IVA_PORCENTAJE * (PERCEPCION_IVA * bonificacion);
  const percepcionUrsea = URSEA * bonificacion;
  const totalSinRedondeo = importeNeto + iva + percepcionIVA + percepcionUrsea;
  const suma = importeNeto + iva + percepcionIVA + percepcionUrsea; // CalcularRedondeo recalcula la suma
  const redondeo = suma - roundHalfToEven(suma);
  const total = importeNeto + iva + percepcionIVA + percepcionUrsea - redondeo;

  return {
    importeAuxiliar: importeAux,
    bonificacion,
    importeNeto,
    iva,
    percepcionIVA,
    percepcionURSEA: percepcionUrsea,
    redondeo,
    totalSinRedondeo,
    total
  };
}

/* ------------------------------ Formateo (ToString("FN") con separador ".") ------------------------------ */

// `culturaDecimalConComa` en el original: InvariantCulture con separador decimal "."
// y sin separador de miles. toFixed() cumple ambas cosas (siempre "." y sin grupos).
function f(value, decimals) {
  return Number(value).toFixed(decimals);
}

// `{totalFinal}` se escribe sin formato: default double.ToString(). En .NET Core y
// en V8 el default es la representacion "shortest round-trippable", que coincide.
function raw(value) {
  return String(value);
}

/* ------------------------------ Opciones de redondeo (SolicitarRedondeo) ------------------------------ */

// Variantes de redondeo aplicables al totalRedondeo acumulado (todas las combinaciones
// de +/- sobre (1 +/- redondeo) y sobre el propio redondeo). `t` = totalRedondeo.
const REDONDEO_OPTIONS = [
  { id: '1', label: '1 - redondeo',           apply: (t) => 1 - t },
  { id: '2', label: '-(1 - redondeo)',        apply: (t) => -(1 - t) },
  { id: '3', label: '1 + redondeo',           apply: (t) => 1 + t },
  { id: '4', label: '-(1 + redondeo)',        apply: (t) => -(1 + t) },
  { id: '5', label: 'redondeo (sin cambios)', apply: (t) => t },
  { id: '6', label: '-redondeo',              apply: (t) => -t }
];

function applyRedondeoOption(totalRedondeo, opcion) {
  const found = REDONDEO_OPTIONS.find((o) => o.id === String(opcion));
  // Opcion invalida -> mantiene el valor original (identidad), como el default del C#.
  return found ? found.apply(totalRedondeo) : totalRedondeo;
}

/* ------------------------------ SQL Server (base DistMayoristaGlp) ------------------------------ */

// `mssql` se carga lazy (dep pesado: arrastra tedious), igual que en el resto de los
// servicios que pegan a SQL Server (mediosPagoService, plexoRefundService).
let sql = null;
function loadSqlModule() {
  if (!sql) sql = require('mssql');
  return sql;
}

let pool = null;
let poolKey = null;

function getFacturaConfig() {
  let cfg = {};
  try { cfg = configService.getEffective() || {}; } catch (_) { cfg = {}; }
  return cfg.factura || {};
}

async function getPool() {
  const cfg = getFacturaConfig();
  const cs = cfg.connectionString;
  if (!cs) {
    throw new Error(
      'No hay connection string configurada para Facturas (Configuracion -> pestaña "Factura" -> connectionString).'
    );
  }
  if (pool && poolKey === cs) return pool;
  if (pool) {
    try { await pool.close(); } catch (_) { /* ignore */ }
    pool = null;
  }
  const m = loadSqlModule();
  pool = await new m.ConnectionPool(cs).connect();
  pool.on('error', (e) => logger.error('mssql (factura) pool error:', e && e.message));
  poolKey = cs;
  return pool;
}

// Cabecera del pedido + cliente. Formatea la fecha en SQL (CONVERT 121 = "yyyy-mm-dd
// hh:mi:ss.mmm") para que coincida con el "yyyy-MM-dd HH:mm:ss.fff" del C# sin depender
// de como el driver interprete la zona horaria del datetime.
const QUERY_PEDIDO = `
  SELECT
    p.Id                                        AS Id,
    p.NumeroPedidoSap                           AS NumeroPedidoSap,
    p.PosicionSap                               AS PosicionSap,
    p.Circuito                                  AS Circuito,
    p.ClienteId                                 AS ClienteId,
    p.Estado                                    AS Estado,
    CONVERT(varchar(23), p.FechaFinalizado, 121) AS FechaFinalizadoStr,
    c.Nombre                                    AS ClienteNombre,
    c.Descuento                                 AS Descuento
  FROM Pedidos p
  INNER JOIN Clientes c ON c.Id = p.ClienteId
  WHERE p.Id = @id;
`;

// Items del pedido con Cantidad > 0, con LEFT JOIN a Productos: si el producto no
// existe (Precio null) se reporta y se saltea, igual que el foreach del C#.
const QUERY_ITEMS = `
  SELECT
    ip.Id             AS ItemId,
    ip.Cantidad       AS Cantidad,
    ip.ProductoId     AS ProductoId,
    ip.PosicionSap    AS PosicionSap,
    pr.Id             AS ProductoEncontrado,
    pr.Material       AS Material,
    pr.Descripcion    AS Descripcion,
    pr.Precio         AS Precio,
    pr.BonificacionBase AS BonificacionBase
  FROM ItemPedidos ip
  LEFT JOIN Productos pr ON pr.Id = ip.ProductoId
  WHERE ip.PedidoId = @id AND ip.Cantidad > 0
  ORDER BY ip.Id;
`;

// Grilla inicial: busca pedidos por DireccionEntrega (LIKE). Replica la query pedida
// por el usuario: SELECT id, DireccionEntrega, Estado, FechaFinalizado FROM Pedidos
// WHERE DireccionEntrega LIKE '%<term>%' ORDER BY id DESC. Se limita a TOP para no
// traer sets enormes; el termino va parametrizado (sin riesgo de inyeccion).
// Opciones de limite (TOP) elegibles desde la UI antes de buscar; default 50.
const SEARCH_TOP_OPTIONS = [10, 50, 100, 200];
const SEARCH_TOP_DEFAULT = 50;
const QUERY_SEARCH = `
  SELECT TOP (@top)
    p.Id                                         AS Id,
    p.DireccionEntrega                           AS DireccionEntrega,
    p.Estado                                     AS Estado,
    CONVERT(varchar(23), p.FechaFinalizado, 121) AS FechaFinalizadoStr
  FROM Pedidos p
  WHERE p.DireccionEntrega LIKE @term
  ORDER BY p.Id DESC;
`;

async function searchPedidos(termRaw, topRaw, log) {
  const term = String(termRaw == null ? '' : termRaw).trim();
  if (!term) {
    throw new Error('Ingresa un texto para buscar por Direccion de entrega.');
  }

  let top = parseInt(topRaw, 10);
  if (!SEARCH_TOP_OPTIONS.includes(top)) top = SEARCH_TOP_DEFAULT;

  const cfg = getFacturaConfig();
  const timeout = cfg.requestTimeoutMs || 30000;

  log && log('info', `Buscando pedidos (TOP ${top}) con DireccionEntrega LIKE '%${term}%'...`);

  const p = await getPool();
  const m = loadSqlModule();
  const req = p.request();
  req.timeout = timeout;
  req.input('top', m.Int, top);
  req.input('term', m.NVarChar, '%' + term + '%');

  let result;
  try {
    result = await req.query(QUERY_SEARCH);
  } catch (e) {
    logger.error('SQL factura searchPedidos fallo:', e && e.message);
    throw new Error('Consulta de pedidos a SQL Server fallo: ' + (e && e.message ? e.message : String(e)));
  }

  const rows = (result && result.recordset) || [];
  const pedidos = rows.map((r) => ({
    id: r.Id,
    direccionEntrega: r.DireccionEntrega,
    estado: r.Estado,
    fechaFinalizadoStr: r.FechaFinalizadoStr
  }));

  const truncated = pedidos.length === top;
  log && log(pedidos.length ? 'success' : 'warn',
    `${pedidos.length} pedido(s) encontrados${truncated ? ` (limitado a ${top}, subi el limite o refina la busqueda)` : ''}.`);

  return { term, top, truncated, pedidos };
}

function parsePedidoId(pedidoIdRaw) {
  const pedidoId = parseInt(String(pedidoIdRaw == null ? '' : pedidoIdRaw).trim(), 10);
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    throw new Error('El PedidoId debe ser un numero entero positivo.');
  }
  return pedidoId;
}

/**
 * Lee el pedido y calcula todos los importes por item + los totales acumulados.
 * Espejo del cuerpo de `ProcesarPedidoAsync` (sin la parte interactiva/consola).
 */
async function computeModel(pedidoIdRaw, log) {
  const pedidoId = parsePedidoId(pedidoIdRaw);
  const cfg = getFacturaConfig();
  const timeout = cfg.requestTimeoutMs || 30000;

  log && log('info', `Buscando el pedido ${pedidoId} en la base DistMayoristaGlp...`);

  const p = await getPool();
  const m = loadSqlModule();

  const reqPedido = p.request();
  reqPedido.timeout = timeout;
  reqPedido.input('id', m.Int, pedidoId);

  let pedidoRes;
  try {
    pedidoRes = await reqPedido.query(QUERY_PEDIDO);
  } catch (e) {
    logger.error('SQL factura getPedido fallo:', e && e.message);
    throw new Error('Consulta del pedido a SQL Server fallo: ' + (e && e.message ? e.message : String(e)));
  }

  const pedidoRow = pedidoRes && pedidoRes.recordset && pedidoRes.recordset[0];
  if (!pedidoRow) {
    throw new Error(`Pedido no encontrado (Id = ${pedidoId}).`);
  }

  const reqItems = p.request();
  reqItems.timeout = timeout;
  reqItems.input('id', m.Int, pedidoId);

  let itemsRes;
  try {
    itemsRes = await reqItems.query(QUERY_ITEMS);
  } catch (e) {
    logger.error('SQL factura getItems fallo:', e && e.message);
    throw new Error('Consulta de items a SQL Server fallo: ' + (e && e.message ? e.message : String(e)));
  }

  const descuento = Number(pedidoRow.Descuento);
  const pedido = {
    id: pedidoRow.Id,
    numeroPedidoSap: pedidoRow.NumeroPedidoSap,
    posicionSap: pedidoRow.PosicionSap,
    circuito: pedidoRow.Circuito,
    clienteId: pedidoRow.ClienteId,
    clienteNombre: pedidoRow.ClienteNombre,
    descuento,
    estado: pedidoRow.Estado,
    fechaFinalizadoStr: pedidoRow.FechaFinalizadoStr
  };

  log && log('info', `Pedido ${pedido.id} | Cliente ${pedido.clienteId} | Descuento: ${descuento}%`);

  const rows = (itemsRes && itemsRes.recordset) || [];
  const items = [];
  const skipped = [];

  const totals = {
    totalIva: 0,
    totalPercepcionIva: 0,
    totalPercepcionUrsea: 0,
    totalBonificacion: 0,
    totalImporteNeto: 0,
    totalImporteAuxiliar: 0,
    totalRedondeo: 0,
    totalFinal: 0,
    totalSinRedondeo: 0
  };

  for (const row of rows) {
    if (row.ProductoEncontrado == null) {
      log && log('warn', `Producto ${row.ProductoId} no encontrado en la base.`);
      skipped.push({ itemId: row.ItemId, productoId: row.ProductoId });
      continue;
    }

    const precio = Number(row.Precio);
    const cantidad = Number(row.Cantidad);
    const bonifBase = Number(row.BonificacionBase);

    const c = calcularTodo(precio, cantidad, bonifBase, descuento);

    items.push({
      itemId: row.ItemId,
      productoId: row.ProductoId,
      material: row.Material,
      descripcion: row.Descripcion,
      cantidad,
      precio,
      bonificacionBase: bonifBase,
      ...c
    });

    totals.totalIva += c.iva;
    totals.totalPercepcionIva += c.percepcionIVA;
    totals.totalPercepcionUrsea += c.percepcionURSEA;
    totals.totalBonificacion += c.bonificacion;
    totals.totalImporteNeto += c.importeNeto;
    totals.totalImporteAuxiliar += c.importeAuxiliar;
    totals.totalRedondeo += c.redondeo;
    totals.totalFinal += c.total;
    totals.totalSinRedondeo += c.totalSinRedondeo;
  }

  if (!items.length) {
    log && log('warn', 'El pedido no tiene items facturables (Cantidad > 0 con producto valido).');
  } else {
    log && log('success', `${items.length} item(s) calculados. Total final: ${raw(totals.totalFinal)}.`);
  }

  return { pedido, items, skipped, totals };
}

/* ------------------------------ Generacion del SQL ------------------------------ */

// UPDATE por ItemPedido (ObtenerUpdate). InvariantCulture (separador "."), todo F10.
// ImporteNeto en el update = ImporteNeto + Bonificacion (== importe auxiliar), igual que el C#.
function buildUpdate(item, pedidoId) {
  return (
    'UPDATE ItemPedidos SET ' +
    `Total = ${f(item.totalSinRedondeo, 10)}, ` +
    `Bonificacion = ${f(item.bonificacion, 10)}, ` +
    `ImporteNeto = ${f(item.importeNeto + item.bonificacion, 10)}, ` +
    `Iva = ${f(item.iva, 10)}, ` +
    `PercepcionIva = ${f(item.percepcionIVA, 10)}, ` +
    `PercepcionUrsea = ${f(item.percepcionURSEA, 10)}, ` +
    `Redondeo = ${f(item.redondeo, 10)} ` +
    `WHERE Id = ${item.itemId} AND PedidoId = ${pedidoId};`
  );
}

// INSERT en [dbo].[Facturas] (GenerarInsertFacturaFormateado). El orden de columnas,
// el mapeo (OJO: [ImporteNeto] recibe totalImporteAuxiliar; [CantidadFacturada] recibe
// totalSinRedondeo) y las precisiones son EXACTAS respecto del C#. No tocar.
function buildInsert(pedido, numeroCompleto, totals, redondeoAplicado) {
  return (
    'INSERT INTO [dbo].[Facturas] \n' +
    '([PedidoSap], [PosicionSap], [Iva], [PercepcionIva], [PercepcionUrsea], [Redondeo], [CantidadFacturada], [Bonificacion], [ImporteNeto], [Total], [Numero], [Fecha], [Estado], [Circuito], [ClienteId], [PedidoId]) VALUES \n' +
    '(\n' +
    `\t${pedido.numeroPedidoSap},\n` +
    `\t${pedido.posicionSap},\n` +
    `\t${f(totals.totalIva, 10)},\n` +
    `\t${f(totals.totalPercepcionIva, 11)},\n` +
    `\t${f(totals.totalPercepcionUrsea, 13)},\n` +
    `\t${f(redondeoAplicado, 15)},\n` +
    `\t${f(totals.totalSinRedondeo, 9)},\n` +
    `\t${f(totals.totalBonificacion, 10)},\n` +
    `\t${f(totals.totalImporteAuxiliar, 6)},\n` +
    `\t${raw(totals.totalFinal)},\n` +
    `\t'${numeroCompleto}',\n` +
    `\t'${pedido.fechaFinalizadoStr}',\n` +
    "\t'0',\n" +
    `\t'${pedido.circuito}',\n` +
    `\t${pedido.clienteId},\n` +
    `\t${pedido.id}\n);`
  );
}

/**
 * Genera todo el SQL para la factura del pedido: recomputa desde la base (lectura
 * fresca, como cada corrida de la consola), aplica la opcion de redondeo elegida y
 * arma UPDATES + INSERT (+ UPDATE de estado si el pedido esta "Anulado").
 *
 * @param {{pedidoId: number|string, numeroFactura: string, redondeoOption: string}} opts
 */
async function buildFactura(opts, log) {
  opts = opts || {};
  const numeroInput = String(opts.numeroFactura == null ? '' : opts.numeroFactura).trim();
  if (!numeroInput) {
    throw new Error('Ingresa el numero de la factura.');
  }
  const redondeoOption = String(opts.redondeoOption || '5');

  const model = await computeModel(opts.pedidoId, log);
  const { pedido, items, totals } = model;

  if (!items.length) {
    throw new Error('El pedido no tiene items facturables: no hay nada para generar.');
  }

  const cfg = getFacturaConfig();
  const prefijo = typeof cfg.prefijoFactura === 'string' && cfg.prefijoFactura ? cfg.prefijoFactura : '211 A ';
  const numeroCompleto = prefijo + numeroInput;

  const redondeoAplicado = applyRedondeoOption(totals.totalRedondeo, redondeoOption);
  log && log('info',
    `Redondeo: opcion ${redondeoOption} · totalRedondeo=${totals.totalRedondeo} -> aplicado=${redondeoAplicado}.`);

  const updates = items.map((it) => buildUpdate(it, pedido.id));
  const insertFactura = buildInsert(pedido, numeroCompleto, totals, redondeoAplicado);

  let updateEstadoPedido = null;
  if (pedido.estado === 'Anulado') {
    updateEstadoPedido = `UPDATE Pedidos SET Estado = 'Facturado' WHERE Id = ${pedido.id};`;
    log && log('info', 'El pedido esta "Anulado": se incluye el UPDATE de Estado a "Facturado".');
  }

  log && log('success', `SQL generado para la factura "${numeroCompleto}".`);

  return {
    ...model,
    prefijoFactura: prefijo,
    numeroCompleto,
    redondeoOption,
    redondeoAplicado,
    updates,
    insertFactura,
    updateEstadoPedido
  };
}

/* ------------------------------ Historial local de scripts generados ------------------------------ */

/**
 * Trazabilidad puramente local de los scripts YA generados por buildFactura: esta
 * seccion nunca ejecuta nada contra la base, solo guarda un registro de que se generó
 * tal script para tal pedido (util para reconstruir "que se corrio y cuando" ya que el
 * tool en si mismo no modifica produccion). Persistencia: JSON plano en
 * `userData/factura-historial.json`, mismo patron que deudasService.
 */
const MAX_HISTORY = 200;

const historyFilePath = () => path.join(app.getPath('userData'), 'factura-historial.json');

function loadHistory() {
  try {
    const p = historyFilePath();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function persistHistory(list) {
  const p = historyFilePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function getHistory() {
  return loadHistory();
}

function recordHistory(entry) {
  const list = loadHistory();
  list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ts: Date.now(), ...entry });
  if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
  persistHistory(list);
  return list;
}

function clearHistory() {
  persistHistory([]);
  return [];
}

// Concatena UPDATES + INSERT + (opcional) UPDATE de estado en un solo bloque de texto,
// igual al "Copiar todo el SQL" del wizard. Se usa tanto para guardar en el historial
// como para el boton "Guardar .sql".
function formatFullSql(result) {
  const parts = [];
  if (result.updates && result.updates.length) parts.push('-- UPDATES:\n' + result.updates.join('\n'));
  if (result.insertFactura) parts.push('-- INSERT FACTURA:\n' + result.insertFactura);
  if (result.updateEstadoPedido) parts.push('-- UPDATE ESTADO PEDIDO:\n' + result.updateEstadoPedido);
  return parts.join('\n\n');
}

/* ------------------------------ Config publica (para el resumen de la vista) ------------------------------ */

function maskConnectionString(cs) {
  if (!cs) return '';
  return String(cs).replace(/(Password|Pwd)\s*=\s*[^;]*/gi, '$1=****');
}

function parseCsField(cs, keys) {
  const s = String(cs || '');
  for (const k of keys) {
    const rx = new RegExp(`(?:^|;)\\s*${k}\\s*=\\s*([^;]*)`, 'i');
    const mm = s.match(rx);
    if (mm) return mm[1].trim();
  }
  return '';
}

function getInfo() {
  const cfg = getFacturaConfig();
  const cs = cfg.connectionString || '';
  return {
    configured: !!cs,
    server: parseCsField(cs, ['Server', 'Data Source']),
    database: parseCsField(cs, ['Database', 'Initial Catalog']),
    prefijoFactura: typeof cfg.prefijoFactura === 'string' && cfg.prefijoFactura ? cfg.prefijoFactura : '211 A ',
    connectionMasked: maskConnectionString(cs),
    requestTimeoutMs: cfg.requestTimeoutMs || 30000
  };
}

async function shutdown() {
  if (pool) {
    try { await pool.close(); } catch (_) { /* ignore */ }
    pool = null;
    poolKey = null;
  }
}

module.exports = {
  // API principal
  getInfo,
  searchPedidos,
  getPedido: computeModel,
  buildFactura,
  shutdown,
  // Historial local de scripts generados (no toca la base)
  getHistory,
  recordHistory,
  clearHistory,
  formatFullSql,
  // Exportados para tests / reutilizacion
  calcularTodo,
  roundHalfToEven,
  applyRedondeoOption,
  REDONDEO_OPTIONS
};
