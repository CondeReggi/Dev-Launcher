'use strict';

/**
 * Estadisticas de Gastos: importa extractos bancarios mensuales (.xlsx/.xls,
 * un archivo por mes, formato "AccountMovementsExtended") y categoriza cada
 * movimiento por reglas de palabra clave (editables) para poder ver gastos e
 * ingresos por categoria, comparar entre meses y rankear comercios.
 *
 * Distinto de "Mis Gastos" (misGastosService.js), que son gastos fijos
 * mensuales recurrentes cargados a mano (alquiler, etc). Esto son movimientos
 * reales importados desde el banco.
 *
 * Persistencia: JSON plano en `userData/gastosStats.json`. Sin secretos.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const filePath = () => path.join(app.getPath('userData'), 'gastosStats.json');

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseMoney(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const cleaned = s.replace(/[^0-9.,-]/g, '');
  if (!cleaned) return 0;
  const n = parseFloat(cleaned.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/* ---------- Reglas de categorizacion por defecto ---------- */
// Orden = prioridad: la primera regla cuyo keyword aparece en la descripcion
// (case-insensitive) gana. EXTORNO/COMISION van primero porque son señales de
// reverso/comision que pueden coincidir tambien con el nombre de un comercio.

function defaultCategories() {
  return [
    'Reembolsos', 'Comisiones', 'Ingresos', 'Transferencias enviadas',
    'Ahorro/Inversion', 'Tarjeta de credito', 'Servicios', 'Impuestos',
    'Salud', 'Supermercado', 'Comida/Delivery', 'Transporte',
    'Suscripciones/Online', 'Otros'
  ];
}

function defaultRules() {
  const R = (keyword, category) => ({ id: uid(), keyword, category });
  return [
    R('EXTORNO', 'Reembolsos'),
    R('COMISION', 'Comisiones'),
    R('TRANSF INSTANTANEA RECIBIDA', 'Ingresos'),
    R('TRANSFERENCIA RECIBIDA', 'Ingresos'),
    R('CR. PAGO SUELDOS', 'Ingresos'),
    R('TRANSF INSTANTANEA ENVIADA', 'Transferencias enviadas'),
    R('TRANSFERENCIA ENVIADA', 'Transferencias enviadas'),
    R('TRF. PLAZ', 'Ahorro/Inversion'),
    R('PAGO ELECTRONICO TARJETA CREDITO', 'Tarjeta de credito'),
    R('PAGO DE SERVICIO POR BANRED', 'Servicios'),
    R('ANTEL', 'Servicios'),
    R('DGI', 'Impuestos'),
    R('FARMASHOP', 'Salud'),
    R('FARMACIA', 'Salud'),
    R('SUPER LIRO', 'Supermercado'),
    R('OLI MARKET', 'Supermercado'),
    R('DISA', 'Supermercado'),
    R('ABAST', 'Supermercado'),
    R('MINI MARKET', 'Supermercado'),
    R('TATA ', 'Supermercado'),
    R('AUTOSERVICE', 'Supermercado'),
    R('LA VERDE', 'Supermercado'),
    R('LA GUINDA', 'Supermercado'),
    R('MAXIEXPRESS', 'Supermercado'),
    R('PEDIDOSYA', 'Comida/Delivery'),
    R('BURGER KING', 'Comida/Delivery'),
    R('MC DONALD', 'Comida/Delivery'),
    R('PIZZERIA', 'Comida/Delivery'),
    R('STARBUCKS', 'Comida/Delivery'),
    R('RADICHETTA', 'Comida/Delivery'),
    R('LUCCIANO', 'Comida/Delivery'),
    R('SAN FREI', 'Comida/Delivery'),
    R('NEGRONI', 'Comida/Delivery'),
    R('LUNA AZUL', 'Comida/Delivery'),
    R('UBER', 'Transporte'),
    R('CABIFY', 'Transporte'),
    R('STM', 'Transporte'),
    R('APPLE.COM', 'Suscripciones/Online'),
    R('ULTISELF', 'Suscripciones/Online'),
    R('PARAMOUNT', 'Suscripciones/Online'),
    R('MERCADOLIBRE', 'Suscripciones/Online')
  ];
}

function categorize(rules, description, amount) {
  const upper = String(description || '').toUpperCase();
  for (const r of rules) {
    if (r.keyword && upper.includes(String(r.keyword).toUpperCase())) return r.category;
  }
  return amount >= 0 ? 'Ingresos' : 'Otros';
}

const MERCHANT_PREFIXES = [
  'COMPRA CON TARJETA DEBITO EXT. ',
  'COMPRA CON TARJETA DEBITO ',
  'COMISION COMPRA INTERNACIONAL ',
  'COMISION TRANSF INSTANTANEA ',
  'TRANSF INSTANTANEA RECIBIDA ',
  'TRANSF INSTANTANEA ENVIADA ',
  'TRANSFERENCIA RECIBIDA ',
  'TRANSFERENCIA ENVIADA ',
  'DEBITO OPERACION EN BANCA DIGITAL '
];

// Descripcion completa -> nombre de comercio corto, para el ranking de "top
// comercios". Recorta prefijos comunes del extracto y todo lo que sigue a la
// primera coma (sucursal/tarjeta). No fusiona variantes con numero de local
// distinto (ej. "SUPER LIRO 1" vs "SUPER LIRO 3" quedan separados).
function normalizeMerchant(description) {
  let s = String(description || '').trim();
  const upper = s.toUpperCase();
  for (const p of MERCHANT_PREFIXES) {
    if (upper.startsWith(p)) { s = s.slice(p.length); break; }
  }
  const commaIdx = s.indexOf(',');
  if (commaIdx > 0) s = s.slice(0, commaIdx);
  s = s.trim();
  return s || 'Otros';
}

function emptyState() {
  return { version: 1, months: {}, categoryRules: defaultRules(), categories: defaultCategories() };
}

function ensureDefaults(state) {
  if (!state.months || typeof state.months !== 'object') state.months = {};
  if (!Array.isArray(state.categoryRules) || !state.categoryRules.length) state.categoryRules = defaultRules();
  if (!Array.isArray(state.categories) || !state.categories.length) state.categories = defaultCategories();
  Object.values(state.months).forEach(m => {
    if (!Array.isArray(m.movements)) m.movements = [];
  });
}

function load() {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return emptyState();
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return emptyState();
    const data = JSON.parse(raw);
    ensureDefaults(data);
    return data;
  } catch (_) {
    return emptyState();
  }
}

function persist(state) {
  const p = filePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/* ---------- Parseo del extracto ---------- */

function normHeader(s) {
  return String(s == null ? '' : s).trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function findHeaderRow(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cols = {};
    (rows[i] || []).forEach((cell, idx) => { cols[normHeader(cell)] = idx; });
    if (cols.fecha !== undefined && cols.referencia !== undefined) return { rowIndex: i, cols };
  }
  return null;
}

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// Devuelve [{date, reference, description, amount, balance}] a partir de las
// filas crudas (sheet_to_json con header:1). `amount` viene con signo:
// negativo = debito/gasto, positivo = credito/ingreso.
function parseMovementRows(rows) {
  const header = findHeaderRow(rows);
  if (!header) throw new Error('No se pudo reconocer el formato del extracto (falta encabezado Fecha/Referencia).');
  const { rowIndex, cols } = header;
  const dateCol = cols.fecha;
  const refCol = cols.referencia;
  const typeCol = cols['tipo movimiento'];
  const descCol = cols['descripcion'];
  const debitCol = cols['debito'];
  const creditCol = cols['credito'];
  const balanceCol = cols.saldo;

  const movements = [];
  for (let i = rowIndex + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const rawDate = String(r[dateCol] == null ? '' : r[dateCol]).trim();
    const m = rawDate.match(DATE_RE);
    if (!m) break;
    const [, d, mo, y] = m;
    const date = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const description = String(
      (typeCol !== undefined && r[typeCol]) || (descCol !== undefined && r[descCol]) || ''
    ).trim();
    const debito = debitCol !== undefined ? parseMoney(r[debitCol]) : 0;
    const credito = creditCol !== undefined ? parseMoney(r[creditCol]) : 0;
    movements.push({
      date,
      reference: String(r[refCol] == null ? '' : r[refCol]).trim(),
      description,
      amount: debito !== 0 ? debito : credito,
      balance: balanceCol !== undefined ? parseMoney(r[balanceCol]) : null
    });
  }
  return movements;
}

/* ---------- Estadisticas ---------- */

function computeMonthStats(monthData) {
  let totalGastos = 0, totalIngresos = 0;
  const byCategoryMap = new Map();
  const merchantMap = new Map();

  (monthData.movements || []).forEach(mv => {
    if (mv.amount < 0) totalGastos += -mv.amount; else totalIngresos += mv.amount;

    const cat = byCategoryMap.get(mv.category) || { category: mv.category, total: 0, count: 0 };
    cat.total += Math.abs(mv.amount);
    cat.count += 1;
    byCategoryMap.set(mv.category, cat);

    if (mv.amount < 0) {
      const merchant = normalizeMerchant(mv.description);
      const rec = merchantMap.get(merchant) || { merchant, total: 0, count: 0 };
      rec.total += -mv.amount;
      rec.count += 1;
      merchantMap.set(merchant, rec);
    }
  });

  const grandTotal = totalGastos + totalIngresos;
  const byCategory = Array.from(byCategoryMap.values())
    .sort((a, b) => b.total - a.total)
    .map(c => ({ category: c.category, count: c.count, total: round2(c.total), pct: grandTotal > 0 ? Math.round((c.total / grandTotal) * 1000) / 10 : 0 }));
  const topMerchants = Array.from(merchantMap.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 15)
    .map(m => ({ merchant: m.merchant, count: m.count, total: round2(m.total) }));

  return {
    totalGastos: round2(totalGastos),
    totalIngresos: round2(totalIngresos),
    balance: round2(totalIngresos - totalGastos),
    count: (monthData.movements || []).length,
    byCategory,
    topMerchants
  };
}

function getState() {
  const state = load();
  const monthKeys = Object.keys(state.months).sort();
  const months = {};
  const monthsSummary = [];
  monthKeys.forEach(mk => {
    const stats = computeMonthStats(state.months[mk]);
    months[mk] = {
      sourceFileName: state.months[mk].sourceFileName || '',
      importedAt: state.months[mk].importedAt || null,
      movements: state.months[mk].movements || [],
      stats
    };
    monthsSummary.push({ monthKey: mk, sourceFileName: months[mk].sourceFileName, ...stats });
  });
  return {
    version: state.version || 1,
    months,
    monthsSummary,
    categoryRules: state.categoryRules,
    categories: state.categories
  };
}

/* ---------- Import ---------- */

function importFromXlsx(srcPath) {
  const XLSX = require('xlsx');
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error('No se encontro el archivo Excel.');
  const wb = XLSX.readFile(srcPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('El archivo no tiene hojas.');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const parsed = parseMovementRows(rows);
  if (!parsed.length) throw new Error('No se encontraron movimientos en el archivo (revisa el formato).');

  const state = load();

  // El mes del extracto = el que tiene mas movimientos entre las fechas
  // parseadas (robusto a filas de dias limite de mes adyacente).
  const counts = {};
  parsed.forEach(m => { counts[m.date.slice(0, 7)] = (counts[m.date.slice(0, 7)] || 0) + 1; });
  const monthKey = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];

  const prevMonth = state.months[monthKey];
  const prevById = new Map();
  if (prevMonth) (prevMonth.movements || []).forEach(mv => prevById.set(mv.id, mv));

  // Id estable = fecha|referencia|monto + un contador de ocurrencia para
  // desambiguar filas idénticas (misma referencia/monto el mismo dia). Al
  // reimportar el mismo mes, un movimiento con el mismo id que ya tenia un
  // ajuste manual conserva la categoria manual en vez de recalcularla.
  const occurrence = {};
  const movements = parsed.map(m => {
    const baseKey = `${m.date}|${m.reference}|${m.amount.toFixed(2)}`;
    const idx = occurrence[baseKey] || 0;
    occurrence[baseKey] = idx + 1;
    const id = `${baseKey}|${idx}`;
    const prev = prevById.get(id);
    const manual = prev && prev.categorySource === 'manual';
    return {
      id,
      date: m.date,
      reference: m.reference,
      description: m.description,
      amount: m.amount,
      balance: m.balance,
      category: manual ? prev.category : categorize(state.categoryRules, m.description, m.amount),
      categorySource: manual ? 'manual' : 'auto'
    };
  });

  state.months[monthKey] = {
    sourceFileName: path.basename(srcPath),
    importedAt: Date.now(),
    movements
  };
  persist(state);
  return { state: getState(), monthKey, count: movements.length };
}

/* ---------- Mutaciones ---------- */

function setMovementCategory(monthKey, movementId, category) {
  const state = load();
  const month = state.months[monthKey];
  if (!month) throw new Error('Mes no encontrado.');
  const mv = (month.movements || []).find(m => m.id === movementId);
  if (!mv) throw new Error('Movimiento no encontrado.');
  const clean = String(category || '').trim();
  if (!clean) throw new Error('La categoria es obligatoria.');
  if (!state.categories.includes(clean)) state.categories.push(clean);
  mv.category = clean;
  mv.categorySource = 'manual';
  persist(state);
  return getState();
}

function addCategoryRule(rule) {
  const state = load();
  const keyword = String(rule && rule.keyword || '').trim();
  const category = String(rule && rule.category || '').trim();
  if (!keyword) throw new Error('La palabra clave es obligatoria.');
  if (!category) throw new Error('La categoria es obligatoria.');
  if (!state.categories.includes(category)) state.categories.push(category);
  state.categoryRules.push({ id: uid(), keyword, category });
  persist(state);
  return getState();
}

function removeCategoryRule(id) {
  const state = load();
  state.categoryRules = state.categoryRules.filter(r => r.id !== id);
  persist(state);
  return getState();
}

function addCategory(name) {
  const state = load();
  const clean = String(name || '').trim();
  if (!clean) throw new Error('El nombre de la categoria es obligatorio.');
  if (!state.categories.includes(clean)) state.categories.push(clean);
  persist(state);
  return getState();
}

function removeMonth(monthKey) {
  const state = load();
  if (!state.months[monthKey]) throw new Error('Mes no encontrado.');
  delete state.months[monthKey];
  persist(state);
  return getState();
}

module.exports = {
  getState,
  importFromXlsx,
  setMovementCategory,
  addCategoryRule,
  removeCategoryRule,
  addCategory,
  removeMonth
};
