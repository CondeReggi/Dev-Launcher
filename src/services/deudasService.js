'use strict';

/**
 * Deudas (control de deudores / montos / pagos).
 *
 * Inspirado en el Excel "Deudas_new.xlsx": deudores con lineas de deuda
 * (descripcion, monto, fecha, marca de pagado) + un total por persona y un
 * total general. Aca se modela de forma relacional y se le suma un historial
 * (audit log) de cada movimiento.
 *
 * Persistencia: JSON plano en `userData/deudas.json`. Sin secretos, no va al
 * repo. Cada mutacion devuelve el estado completo y computado (`computeTotals`)
 * para que el renderer re-renderice de una sola fuente de verdad.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const filePath = () => path.join(app.getPath('userData'), 'deudas.json');

const MAX_HISTORY = 500;

function emptyState() {
  return { version: 1, debtors: [], history: [] };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function load() {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return emptyState();
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return emptyState();
    const data = JSON.parse(raw);
    if (!Array.isArray(data.debtors)) data.debtors = [];
    if (!Array.isArray(data.history)) data.history = [];
    data.debtors.forEach(d => {
      if (!Array.isArray(d.debts)) d.debts = [];
      if (!Array.isArray(d.payments)) d.payments = [];
      if (typeof d.credit !== 'number') d.credit = 0;
      d.debts.forEach(x => {
        if (typeof x.creditApplied !== 'number') x.creditApplied = 0;
        if (typeof x.autoPaidByCredit !== 'boolean') x.autoPaidByCredit = false;
      });
    });
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

function findDebtor(state, id) {
  return state.debtors.find(d => d.id === id);
}

function logHistory(state, entry) {
  state.history.unshift({ id: uid(), ts: Date.now(), ...entry });
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
}

/**
 * Aplica el saldo a favor ocioso (`d.credit`) contra la deuda pendiente MAS
 * GRANDE del deudor, permitiendo cobertura parcial (queda "tachada" en la
 * vista con el restante actualizado). Si alcanza para saldarla del todo, la
 * marca `paid` (con `autoPaidByCredit` para poder revertirlo despues) y sigue
 * con la siguiente mas grande mientras quede pool. Corre automaticamente
 * despues de cualquier mutacion que pueda cambiar el credito o las deudas.
 */
function autoApplyCredit(state, d) {
  if (!d) return;
  if (typeof d.credit !== 'number') d.credit = 0;
  let pool = Math.round(d.credit * 100) / 100;
  while (pool > 1e-9) {
    const unpaid = (d.debts || []).filter(x => !x.paid && (num(x.amount) - num(x.creditApplied || 0)) > 1e-9);
    if (!unpaid.length) break;
    unpaid.sort((a, b) => (num(b.amount) - num(b.creditApplied || 0)) - (num(a.amount) - num(a.creditApplied || 0)));
    const target = unpaid[0];
    const remaining = num(target.amount) - num(target.creditApplied || 0);
    const apply = Math.min(pool, remaining);
    target.creditApplied = Math.round((num(target.creditApplied || 0) + apply) * 100) / 100;
    pool = Math.round((pool - apply) * 100) / 100;
    if (num(target.amount) - target.creditApplied <= 1e-9) {
      target.paid = true;
      target.paidAt = Date.now();
      target.autoPaidByCredit = true;
    }
  }
  d.credit = Math.max(0, pool);
}

/**
 * Libera el credito ya aplicado a una deuda (por edicion, borrado o al
 * destildar una deuda que se habia saldado sola via credito) de vuelta al
 * saldo a favor del deudor, para que `autoApplyCredit` lo reparta de nuevo.
 */
function releaseCreditFromDebt(d, it) {
  const applied = num(it.creditApplied || 0);
  if (applied > 1e-9) {
    d.credit = Math.round(((d.credit || 0) + applied) * 100) / 100;
  }
  it.creditApplied = 0;
  if (it.autoPaidByCredit) {
    it.paid = false;
    it.paidAt = null;
    it.autoPaidByCredit = false;
  }
}

/* ---------- Vista computada ---------- */

function computeTotals(state) {
  let allTotal = 0, allPaid = 0, allCredit = 0;
  const debtors = state.debtors.map(d => {
    let total = 0, paid = 0;
    (d.debts || []).forEach(x => {
      const a = num(x.amount);
      const ca = num(x.creditApplied || 0);
      total += a;
      // Cobertura parcial via credito cuenta como "pagado" aunque la deuda
      // siga pendiente (paid=false), asi el saldo neto no la duplica.
      paid += x.paid ? a : Math.min(ca, a);
    });
    const credit = num(d.credit);
    const outstanding = total - paid;
    allTotal += total;
    allPaid += paid;
    allCredit += credit;
    return {
      id: d.id,
      name: d.name,
      note: d.note || '',
      createdAt: d.createdAt,
      credit,
      debts: (d.debts || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(x => {
        const a = num(x.amount);
        const ca = num(x.creditApplied || 0);
        return { ...x, creditApplied: ca, remaining: x.paid ? 0 : Math.max(0, Math.round((a - ca) * 100) / 100) };
      }),
      payments: (d.payments || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      totals: {
        total,
        paid,
        outstanding,
        credit,
        // Saldo neto: >0 todavia debe ("en contra"); <0 saldo a favor del deudor.
        netBalance: outstanding - credit,
        count: (d.debts || []).length
      }
    };
  });
  debtors.sort((a, b) => b.totals.netBalance - a.totals.netBalance || a.name.localeCompare(b.name));
  return {
    version: state.version || 1,
    debtors,
    history: state.history || [],
    totals: {
      total: allTotal,
      paid: allPaid,
      outstanding: allTotal - allPaid,
      credit: allCredit,
      debtorCount: state.debtors.length
    }
  };
}

/**
 * Se llama al abrir la solapa Deudas (lazy-load). Reconcilia el credito
 * ocioso de TODOS los deudores contra sus deudas antes de mostrar nada, para
 * que el saldo a favor quede aplicado aunque el deudor no haya tenido ninguna
 * mutacion nueva (ej. datos viejos de antes de esta funcionalidad).
 */
function getState() {
  const state = load();
  let dirty = false;
  state.debtors.forEach(d => {
    const before = JSON.stringify([d.credit, (d.debts || []).map(x => [x.paid, x.creditApplied])]);
    autoApplyCredit(state, d);
    const after = JSON.stringify([d.credit, (d.debts || []).map(x => [x.paid, x.creditApplied])]);
    if (before !== after) dirty = true;
  });
  if (dirty) persist(state);
  return computeTotals(state);
}

/* ---------- Mutaciones de deudores ---------- */

function addDebtor(name, note) {
  const state = load();
  const clean = String(name || '').trim();
  if (!clean) throw new Error('El nombre del deudor es obligatorio.');
  if (state.debtors.some(d => d.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`Ya existe un deudor llamado "${clean}".`);
  }
  const debtor = { id: uid(), name: clean, note: String(note || '').trim(), createdAt: Date.now(), debts: [], payments: [], credit: 0 };
  state.debtors.push(debtor);
  logHistory(state, { debtorId: debtor.id, debtorName: debtor.name, action: 'debtor_added', detail: 'Deudor creado' });
  persist(state);
  return { state: computeTotals(state), debtorId: debtor.id };
}

function updateDebtor(id, patch) {
  const state = load();
  const d = findDebtor(state, id);
  if (!d) throw new Error('Deudor no encontrado.');
  patch = patch || {};
  if (patch.name != null) {
    const clean = String(patch.name).trim();
    if (!clean) throw new Error('El nombre del deudor es obligatorio.');
    if (state.debtors.some(o => o.id !== id && o.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`Ya existe un deudor llamado "${clean}".`);
    }
    d.name = clean;
  }
  if (patch.note != null) d.note = String(patch.note).trim();
  logHistory(state, { debtorId: d.id, debtorName: d.name, action: 'debtor_edited', detail: 'Datos actualizados' });
  persist(state);
  return { state: computeTotals(state), debtorId: d.id };
}

function removeDebtor(id) {
  const state = load();
  const d = findDebtor(state, id);
  if (!d) throw new Error('Deudor no encontrado.');
  state.debtors = state.debtors.filter(o => o.id !== id);
  logHistory(state, { debtorId: d.id, debtorName: d.name, action: 'debtor_removed', detail: 'Deudor eliminado' });
  persist(state);
  return { state: computeTotals(state), debtorId: null };
}

/* ---------- Mutaciones de deudas ---------- */

function addDebt(debtorId, debt) {
  const state = load();
  const d = findDebtor(state, debtorId);
  if (!d) throw new Error('Deudor no encontrado.');
  const description = String(debt && debt.description || '').trim();
  const amount = num(debt && debt.amount);
  if (!description) throw new Error('La descripcion de la deuda es obligatoria.');
  if (amount <= 0) throw new Error('El monto debe ser mayor a 0.');
  const item = {
    id: uid(),
    description,
    amount,
    date: debt && debt.date ? String(debt.date) : null,
    paid: false,
    createdAt: Date.now(),
    paidAt: null,
    creditApplied: 0,
    autoPaidByCredit: false
  };
  d.debts.push(item);
  logHistory(state, { debtorId: d.id, debtorName: d.name, action: 'debt_added', detail: description, amount });
  autoApplyCredit(state, d);
  persist(state);
  return { state: computeTotals(state), debtorId: d.id };
}

function updateDebt(debtorId, debtId, patch) {
  const state = load();
  const d = findDebtor(state, debtorId);
  if (!d) throw new Error('Deudor no encontrado.');
  const it = (d.debts || []).find(x => x.id === debtId);
  if (!it) throw new Error('Deuda no encontrada.');
  patch = patch || {};
  if (patch.description != null) {
    const desc = String(patch.description).trim();
    if (!desc) throw new Error('La descripcion de la deuda es obligatoria.');
    it.description = desc;
  }
  if (patch.amount != null) {
    const a = num(patch.amount);
    if (a <= 0) throw new Error('El monto debe ser mayor a 0.');
    // El credito ya aplicado se libera y se reparte de nuevo contra el nuevo monto.
    releaseCreditFromDebt(d, it);
    it.amount = a;
  }
  if (patch.date !== undefined) it.date = patch.date ? String(patch.date) : null;
  logHistory(state, { debtorId: d.id, debtorName: d.name, action: 'debt_edited', detail: it.description, amount: num(it.amount) });
  autoApplyCredit(state, d);
  persist(state);
  return { state: computeTotals(state), debtorId: d.id };
}

function removeDebt(debtorId, debtId) {
  const state = load();
  const d = findDebtor(state, debtorId);
  if (!d) throw new Error('Deudor no encontrado.');
  const it = (d.debts || []).find(x => x.id === debtId);
  if (!it) throw new Error('Deuda no encontrada.');
  releaseCreditFromDebt(d, it);
  d.debts = d.debts.filter(x => x.id !== debtId);
  logHistory(state, { debtorId: d.id, debtorName: d.name, action: 'debt_removed', detail: it.description, amount: num(it.amount) });
  autoApplyCredit(state, d);
  persist(state);
  return { state: computeTotals(state), debtorId: d.id };
}

function setPaid(debtorId, debtId, paid) {
  const state = load();
  const d = findDebtor(state, debtorId);
  if (!d) throw new Error('Deudor no encontrado.');
  const it = (d.debts || []).find(x => x.id === debtId);
  if (!it) throw new Error('Deuda no encontrada.');
  if (!paid) {
    // Al destildar (haya sido manual o saldada sola via credito) se libera
    // cualquier credito aplicado antes de dejarla pendiente de nuevo.
    releaseCreditFromDebt(d, it);
  }
  it.paid = !!paid;
  it.paidAt = it.paid ? Date.now() : null;
  logHistory(state, {
    debtorId: d.id, debtorName: d.name,
    action: it.paid ? 'debt_paid' : 'debt_unpaid',
    detail: it.description, amount: num(it.amount)
  });
  autoApplyCredit(state, d);
  persist(state);
  return { state: computeTotals(state), debtorId: d.id };
}

/* ---------- Gasto compartido (split entre varios deudores) ---------- */

/**
 * Agrega la MISMA deuda a varios deudores en una sola pasada. El monto total se
 * divide en partes iguales (redondeo a 2 decimales) y la fecha por defecto es hoy.
 *
 * Si `includeMe` es true, el gasto se divide entre los deudores + yo (N+1 partes):
 * cada deudor recibe su parte como deuda y MI parte no genera ninguna deuda (la
 * absorbo yo, que pague el total). Asi el sobrante de redondeo queda en mi parte
 * y la suma (deudas + mi parte) es exactamente el total. Si `includeMe` es false,
 * se divide entre N y el ultimo deudor absorbe el resto.
 */
function addSharedDebt(opts) {
  const state = load();
  const desc = String(opts && opts.description || '').trim();
  const total = num(opts && opts.totalAmount);
  const date = opts && opts.date ? String(opts.date) : new Date().toISOString().slice(0, 10);
  const ids = Array.isArray(opts && opts.debtorIds) ? opts.debtorIds : [];
  const includeMe = !!(opts && opts.includeMe);

  if (!desc) throw new Error('La descripcion es obligatoria.');
  if (total <= 0) throw new Error('El monto total debe ser mayor a 0.');
  if (!ids.length) throw new Error('Selecciona al menos un deudor.');

  const debtors = ids.map(id => {
    const d = findDebtor(state, id);
    if (!d) throw new Error('Deudor no encontrado: ' + id);
    return d;
  });

  const N = debtors.length;
  const shares = includeMe ? N + 1 : N;          // cantidad de partes (incluyendome o no)
  const perPerson = Math.round((total / shares) * 100) / 100;
  const now = Date.now();
  const sharedNote = includeMe
    ? `${desc} (gasto compartido entre ${shares}, incluyendote)`
    : `${desc} (gasto compartido entre ${shares})`;
  let assigned = 0;

  debtors.forEach((d, i) => {
    // Cuando me incluyo, cada deudor recibe exactamente su parte y yo absorbo el
    // resto. Cuando no, el ultimo deudor absorbe el resto (comportamiento previo).
    const isLast = i === N - 1;
    const amt = (!includeMe && isLast)
      ? Math.round((total - assigned) * 100) / 100
      : perPerson;
    assigned += amt;
    d.debts.push({
      id: uid(),
      description: desc,
      amount: amt,
      date,
      paid: false,
      createdAt: now,
      paidAt: null,
      creditApplied: 0,
      autoPaidByCredit: false
    });
    logHistory(state, {
      debtorId: d.id, debtorName: d.name, action: 'shared',
      detail: sharedNote,
      amount: amt
    });
    autoApplyCredit(state, d);
  });

  // Mi parte: lo que queda del total tras repartir las deudas (solo si me incluyo).
  const myShare = includeMe ? Math.round((total - assigned) * 100) / 100 : 0;

  persist(state);
  return {
    state: computeTotals(state),
    debtorId: null,
    summary: { perPerson, count: N, shares, total, date, description: desc, includeMe, myShare }
  };
}

/* ---------- Pagos (abonos) ---------- */

/**
 * Registra un pago y lo aplica para marcar la MAXIMA cantidad de deudas posible:
 * paga primero las mas baratas (maximiza el conteo de items saldados). El sobrante
 * queda como `credit` (saldo a favor del deudor); si no alcanza para todo, las
 * deudas no cubiertas quedan pendientes ("en contra").
 */
function registerPayment(debtorId, amount, note, date) {
  const state = load();
  const d = findDebtor(state, debtorId);
  if (!d) throw new Error('Deudor no encontrado.');
  const amt = num(amount);
  if (amt <= 0) throw new Error('El monto del pago debe ser mayor a 0.');
  if (!Array.isArray(d.payments)) d.payments = [];
  if (typeof d.credit !== 'number') d.credit = 0;

  let pool = d.credit + amt;
  // Restante real de cada deuda (descuenta lo que ya tuviera de credito aplicado).
  const unpaid = (d.debts || [])
    .filter(x => !x.paid)
    .sort((a, b) => (num(a.amount) - num(a.creditApplied || 0)) - (num(b.amount) - num(b.creditApplied || 0)));
  let covered = 0;
  for (const it of unpaid) {
    const remaining = num(it.amount) - num(it.creditApplied || 0);
    if (pool + 1e-9 >= remaining) {
      // No se toca creditApplied: solo debe reflejar saldo a favor (reversible),
      // no el pago en efectivo que acaba de cubrir el resto.
      it.paid = true; it.paidAt = Date.now();
      pool -= remaining; covered++;
    } else break;
  }
  d.credit = Math.max(0, Math.round(pool * 100) / 100); // sobrante a favor
  const payment = {
    id: uid(),
    amount: amt,
    note: String(note || '').trim(),
    date: date ? String(date) : null,
    createdAt: Date.now()
  };
  d.payments.push(payment);

  // El sobrante que no alcanzo para saldar otra deuda entera se aplica solo,
  // parcialmente, contra la deuda pendiente mas grande.
  autoApplyCredit(state, d);

  const bits = [`cubrio ${covered} deuda(s)`];
  if (d.credit > 0) bits.push(`saldo a favor`);
  logHistory(state, {
    debtorId: d.id, debtorName: d.name, action: 'payment',
    detail: (payment.note ? payment.note + ' — ' : '') + bits.join(', '),
    amount: amt
  });
  persist(state);
  return { state: computeTotals(state), debtorId: d.id, summary: { covered, credit: d.credit } };
}

/* ---------- Import / Export Excel ---------- */

// Excel serial (base 1899-12-30) -> ISO yyyy-mm-dd. Solo seriales plausibles.
function excelSerialToISO(serial) {
  if (typeof serial !== 'number' || !isFinite(serial)) return null;
  if (serial < 20000 || serial > 80000) return null;
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

/**
 * Parser de las hojas tipo "Deudas de los pibes" / "Deudas trabajo":
 * bloques de 5 columnas por deudor. La fila de cabecera tiene
 * [nombre, '', total, '', ''] y las filas siguientes [desc, monto, fecha, 'X'?, ''].
 */
function parseDebtSheet(rows) {
  let nameRow = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (typeof r[0] === 'string' && r[0].trim() &&
        (r[1] === '' || r[1] == null) && typeof r[2] === 'number') {
      nameRow = i; break;
    }
  }
  if (nameRow === -1) return [];
  const header = rows[nameRow];
  const debtors = [];
  for (let base = 0; base < header.length; base += 5) {
    const name = typeof header[base] === 'string' ? header[base].trim() : '';
    if (!name) continue;
    const debts = [];
    for (let i = nameRow + 1; i < rows.length; i++) {
      const r = rows[i];
      const desc = r[base];
      const amount = r[base + 1];
      if (typeof desc === 'string' && desc.trim() && typeof amount === 'number' && amount > 0) {
        debts.push({
          description: desc.trim(),
          amount,
          date: excelSerialToISO(r[base + 2]),
          paid: String(r[base + 3] == null ? '' : r[base + 3]).trim().toUpperCase() === 'X'
        });
      }
    }
    debtors.push({ name, debts });
  }
  return debtors;
}

function importFromXlsx(filePath) {
  const XLSX = require('xlsx');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('No se encontro el archivo Excel.');
  const wb = XLSX.readFile(filePath);
  const SHEETS = ['Deudas de los pibes', 'Deudas trabajo'];
  const state = load();
  const existing = new Set(state.debtors.map(d => d.name.toLowerCase()));
  let imported = 0, skipped = 0, debtsImported = 0;
  const now = Date.now();

  SHEETS.forEach(sheetName => {
    const ws = wb.Sheets[sheetName];
    if (!ws) return;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    parseDebtSheet(rows).forEach(p => {
      if (existing.has(p.name.toLowerCase())) { skipped++; return; }
      const debtor = {
        id: uid(), name: p.name, note: '', createdAt: now,
        payments: [], credit: 0,
        debts: p.debts.map(x => ({
          id: uid(), description: x.description, amount: x.amount, date: x.date,
          paid: !!x.paid, createdAt: now, paidAt: x.paid ? now : null,
          creditApplied: 0, autoPaidByCredit: false
        }))
      };
      state.debtors.push(debtor);
      existing.add(p.name.toLowerCase());
      imported++;
      debtsImported += debtor.debts.length;
    });
  });

  logHistory(state, {
    debtorId: null, debtorName: '', action: 'import',
    detail: `Importados ${imported} deudores (${debtsImported} deudas) desde Excel`
  });
  persist(state);
  return { state: computeTotals(state), debtorId: null, imported, skipped, debtsImported };
}

function exportDebtor(debtorId, filePath) {
  const XLSX = require('xlsx');
  const computed = computeTotals(load());
  const d = computed.debtors.find(x => x.id === debtorId);
  if (!d) throw new Error('Deudor no encontrado.');
  const t = d.totals;
  const today = new Date().toLocaleDateString('es-UY');

  const wsResumen = XLSX.utils.aoa_to_sheet([
    ['Estado de cuenta'],
    ['Deudor', d.name],
    ['Nota', d.note || ''],
    ['Emitido', today],
    [],
    ['Total de deudas', t.total],
    ['Cobrado', t.paid],
    ['Pendiente', t.outstanding],
    ['Saldo a favor', t.credit],
    ['Saldo neto (lo que debe)', t.netBalance]
  ]);
  wsResumen['!cols'] = [{ wch: 24 }, { wch: 30 }];

  const deudasAoa = [['Descripcion', 'Monto', 'Fecha', 'Estado']];
  d.debts.forEach(x => deudasAoa.push([x.description, x.amount, x.date || '', x.paid ? 'Cobrada' : 'Pendiente']));
  deudasAoa.push([], ['TOTAL', t.total, '', '']);
  const wsDeudas = XLSX.utils.aoa_to_sheet(deudasAoa);
  wsDeudas['!cols'] = [{ wch: 42 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];

  const pagosAoa = [['Fecha', 'Monto', 'Nota']];
  const payments = (d.payments || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  payments.forEach(p => pagosAoa.push([
    p.date || new Date(p.createdAt).toLocaleDateString('es-UY'),
    p.amount,
    p.note || ''
  ]));
  if (payments.length) {
    pagosAoa.push([], ['TOTAL PAGADO', payments.reduce((s, p) => s + num(p.amount), 0), '']);
  }
  const wsPagos = XLSX.utils.aoa_to_sheet(pagosAoa);
  wsPagos['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 34 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');
  XLSX.utils.book_append_sheet(wb, wsDeudas, 'Deudas');
  XLSX.utils.book_append_sheet(wb, wsPagos, 'Pagos');
  XLSX.writeFile(wb, filePath);
  return { path: filePath, debtor: d.name };
}

// Nombre de hoja valido para Excel: <=31 chars, sin []:*?/\ y unico dentro del
// libro (se desambigua con un sufijo numerico).
function sheetName(raw, used) {
  let base = String(raw || 'Deudor').replace(/[\\/:*?[\]]/g, ' ').trim().slice(0, 31) || 'Deudor';
  let name = base, i = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${i++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

// Exporta N deudores a un unico .xlsx: una hoja "Resumen" con una fila por
// deudor mas el total general, y luego una hoja de detalle por deudor.
// `onlyPending` filtra las deudas ya cobradas del detalle (los totales del
// resumen siempre reflejan el estado completo).
function exportDebtors(debtorIds, filePath, opts) {
  const XLSX = require('xlsx');
  const ids = Array.isArray(debtorIds) ? debtorIds : [];
  if (!ids.length) throw new Error('Selecciona al menos un deudor para exportar.');
  const onlyPending = !!(opts && opts.onlyPending);

  const computed = computeTotals(load());
  const selected = ids
    .map(id => computed.debtors.find(x => x.id === id))
    .filter(Boolean);
  if (!selected.length) throw new Error('No se encontraron los deudores seleccionados.');

  const today = new Date().toLocaleDateString('es-UY');
  const sum = (fn) => selected.reduce((s, d) => s + num(fn(d)), 0);

  const resumenAoa = [
    ['Estado de cuentas'],
    ['Emitido', today],
    ['Deudores incluidos', selected.length],
    [],
    ['Deudor', 'Total', 'Cobrado', 'Pendiente', 'Saldo a favor', 'Saldo neto', 'Nota']
  ];
  selected.forEach(d => {
    const t = d.totals;
    resumenAoa.push([d.name, t.total, t.paid, t.outstanding, t.credit, t.netBalance, d.note || '']);
  });
  resumenAoa.push([], [
    'TOTAL',
    sum(d => d.totals.total),
    sum(d => d.totals.paid),
    sum(d => d.totals.outstanding),
    sum(d => d.totals.credit),
    sum(d => d.totals.netBalance),
    ''
  ]);
  const wsResumen = XLSX.utils.aoa_to_sheet(resumenAoa);
  wsResumen['!cols'] = [{ wch: 26 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 14 }, { wch: 13 }, { wch: 30 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

  const used = new Set(['resumen']);
  selected.forEach(d => {
    const t = d.totals;
    const debts = onlyPending ? d.debts.filter(x => !x.paid) : d.debts;

    const aoa = [
      [d.name],
      ['Total de deudas', t.total],
      ['Cobrado', t.paid],
      ['Pendiente', t.outstanding],
      ['Saldo a favor', t.credit],
      ['Saldo neto (lo que debe)', t.netBalance],
      [],
      [onlyPending ? 'Deudas pendientes' : 'Deudas'],
      ['Descripcion', 'Monto', 'Fecha', 'Estado']
    ];
    debts.forEach(x => aoa.push([x.description, x.amount, x.date || '', x.paid ? 'Cobrada' : 'Pendiente']));
    if (!debts.length) aoa.push(['(sin deudas)', '', '', '']);
    aoa.push(['TOTAL', debts.reduce((s, x) => s + num(x.amount), 0), '', '']);

    const payments = (d.payments || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (payments.length) {
      aoa.push([], ['Pagos'], ['Fecha', 'Monto', 'Nota']);
      payments.forEach(p => aoa.push([
        p.date || new Date(p.createdAt).toLocaleDateString('es-UY'),
        p.amount,
        p.note || ''
      ]));
      aoa.push(['TOTAL PAGADO', payments.reduce((s, p) => s + num(p.amount), 0), '']);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 42 }, { wch: 13 }, { wch: 13 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws, sheetName(d.name, used));
  });

  XLSX.writeFile(wb, filePath);
  return { path: filePath, debtors: selected.length, names: selected.map(d => d.name) };
}

function clearHistory() {
  const state = load();
  state.history = [];
  persist(state);
  return { state: computeTotals(state), debtorId: null };
}

/* ---------- Respaldo / restauracion (todo el deudas.json) ---------- */

// Vuelca el estado crudo completo a un .json elegido por el usuario.
function exportBackup(destPath) {
  const state = load();
  fs.writeFileSync(destPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return { path: destPath, debtors: state.debtors.length };
}

// Reemplaza TODO el estado con el contenido de un respaldo previo. Antes de
// pisar deja una copia de seguridad del estado actual en `deudas.json.bak`.
function importBackup(srcPath) {
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error('No se encontro el archivo de respaldo.');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(srcPath, 'utf8')); }
  catch (_) { throw new Error('El archivo no es un JSON valido.'); }
  if (!parsed || !Array.isArray(parsed.debtors)) {
    throw new Error('El respaldo no tiene el formato esperado (falta la lista "debtors").');
  }

  const state = {
    version: parsed.version || 1,
    debtors: parsed.debtors.map(d => ({
      id: d && d.id ? d.id : uid(),
      name: String(d && d.name || '').trim() || 'Sin nombre',
      note: d && d.note ? String(d.note) : '',
      createdAt: d && d.createdAt ? d.createdAt : Date.now(),
      credit: d && typeof d.credit === 'number' ? d.credit : 0,
      payments: d && Array.isArray(d.payments) ? d.payments : [],
      debts: d && Array.isArray(d.debts) ? d.debts : []
    })),
    history: Array.isArray(parsed.history) ? parsed.history : []
  };

  const dataPath = filePath();
  try { if (fs.existsSync(dataPath)) fs.copyFileSync(dataPath, dataPath + '.bak'); }
  catch (_) { /* la copia de seguridad es best-effort */ }

  logHistory(state, {
    debtorId: null, debtorName: '', action: 'restore',
    detail: `Datos restaurados desde respaldo (${state.debtors.length} deudores)`
  });
  persist(state);
  return { state: computeTotals(state), debtorId: null, debtors: state.debtors.length };
}

module.exports = {
  getState,
  addDebtor,
  updateDebtor,
  removeDebtor,
  addDebt,
  updateDebt,
  removeDebt,
  setPaid,
  addSharedDebt,
  registerPayment,
  importFromXlsx,
  exportDebtor,
  exportDebtors,
  exportBackup,
  importBackup,
  clearHistory
};
