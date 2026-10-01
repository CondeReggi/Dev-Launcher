'use strict';

/**
 * Gastos fijos mensuales ("Deudas mias"): a diferencia de deudasService (terceros
 * que me deben), esto son gastos que YO tengo que pagar todos los meses (luz, agua,
 * internet...). El usuario define una vez cada gasto fijo (item / plantilla) y cada
 * mes se genera automaticamente una instancia pendiente para ese mes (al llamar
 * getState(), que corre en cada apertura de la solapa). Las instancias no pagadas
 * de meses anteriores quedan visibles como "atrasadas" indefinidamente hasta que se
 * marquen pagadas.
 *
 * Persistencia: JSON plano en `userData/misGastos.json`.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const filePath = () => path.join(app.getPath('userData'), 'misGastos.json');

const MAX_HISTORY = 500;
const DEFAULT_DUE_DAY = 20;

function emptyState() {
  return { version: 1, items: [], months: {}, history: [] };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function clampDay(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > 31) return DEFAULT_DUE_DAY;
  return n;
}

function cleanLink(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) throw new Error('El link debe empezar con http:// o https://');
  return s;
}

function load() {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return emptyState();
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return emptyState();
    const data = JSON.parse(raw);
    if (!Array.isArray(data.items)) data.items = [];
    if (!data.months || typeof data.months !== 'object') data.months = {};
    if (!Array.isArray(data.history)) data.history = [];
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

function logHistory(state, entry) {
  state.history.unshift({ id: uid(), ts: Date.now(), ...entry });
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
}

function monthKey(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Dia de vencimiento clampeado al ultimo dia real del mes (ej: dia 31 en febrero -> 28/29).
function dueDateFor(month, day) {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const d = Math.min(day || DEFAULT_DUE_DAY, lastDay);
  return `${month}-${String(d).padStart(2, '0')}`;
}

/**
 * Garantiza que el mes actual tenga una instancia pendiente por cada item activo.
 * Se corre en cada getState() y tras cada mutacion, asi cubre tanto el cambio de
 * mes calendario (al abrir la app en un mes nuevo) como un item recien agregado
 * a mitad de mes.
 */
function ensureCurrentMonth(state) {
  const cm = monthKey();
  if (!state.months[cm]) state.months[cm] = { instances: [] };
  const bucket = state.months[cm];
  const now = Date.now();
  let created = 0;
  state.items.forEach(item => {
    if (bucket.instances.some(i => i.itemId === item.id)) return;
    bucket.instances.push({
      id: uid(),
      itemId: item.id,
      name: item.name,
      description: item.description || '',
      link: item.link || null,
      amount: item.amount != null ? item.amount : null,
      dueDate: dueDateFor(cm, item.dueDay),
      paid: false,
      paidAt: null,
      paidAmount: null,
      createdAt: now,
      month: cm
    });
    created++;
  });
  if (created) {
    logHistory(state, { action: 'generated', detail: `Generados ${created} gasto(s) fijo(s) para ${cm}`, month: cm });
  }
  return cm;
}

function findItem(state, id) {
  return state.items.find(i => i.id === id);
}

function findInstance(state, instanceId) {
  for (const month of Object.keys(state.months)) {
    const inst = state.months[month].instances.find(i => i.id === instanceId);
    if (inst) return { inst, month };
  }
  return null;
}

/* ---------- Vista computada ---------- */

function computeView(state) {
  const cm = monthKey();
  const currentBucket = state.months[cm] || { instances: [] };
  const instances = currentBucket.instances.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const overdue = [];
  Object.keys(state.months).forEach(month => {
    if (month === cm) return;
    state.months[month].instances.forEach(i => {
      if (!i.paid) overdue.push(i);
    });
  });
  overdue.sort((a, b) => a.month.localeCompare(b.month) || a.dueDate.localeCompare(b.dueDate));

  let total = 0, paid = 0, pendingCount = 0, paidCount = 0;
  instances.forEach(i => {
    const a = i.amount || 0;
    total += a;
    if (i.paid) { paid += i.paidAmount != null ? i.paidAmount : a; paidCount++; }
    else pendingCount++;
  });
  const overdueAmount = overdue.reduce((s, i) => s + (i.amount || 0), 0);

  return {
    version: state.version || 1,
    items: state.items.slice().sort((a, b) => a.name.localeCompare(b.name)),
    currentMonth: cm,
    instances,
    overdue,
    history: state.history || [],
    totals: {
      total, paid, pending: total - paid, pendingCount, paidCount,
      overdueCount: overdue.length, overdueAmount
    }
  };
}

function getState() {
  const state = load();
  ensureCurrentMonth(state);
  persist(state);
  return computeView(state);
}

/* ---------- Mutaciones de items (plantillas) ---------- */

function addItem(item) {
  const state = load();
  const name = String(item && item.name || '').trim();
  if (!name) throw new Error('El nombre del gasto es obligatorio.');
  const link = cleanLink(item && item.link);
  const it = {
    id: uid(),
    name,
    description: String(item && item.description || '').trim(),
    amount: num(item && item.amount),
    dueDay: clampDay(item && item.dueDay),
    link,
    createdAt: Date.now()
  };
  state.items.push(it);
  logHistory(state, { action: 'item_added', detail: name });
  ensureCurrentMonth(state);
  persist(state);
  return computeView(state);
}

// Los cambios de la plantilla se reflejan tambien en la instancia del mes actual,
// siempre que todavia no este pagada (una vez pagada queda como historial inmutable).
function updateItem(id, patch) {
  const state = load();
  const it = findItem(state, id);
  if (!it) throw new Error('Gasto fijo no encontrado.');
  patch = patch || {};
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('El nombre del gasto es obligatorio.');
    it.name = name;
  }
  if (patch.description != null) it.description = String(patch.description).trim();
  if (patch.amount !== undefined) it.amount = num(patch.amount);
  if (patch.dueDay != null) it.dueDay = clampDay(patch.dueDay);
  if (patch.link !== undefined) it.link = cleanLink(patch.link);

  const cm = monthKey();
  const bucket = state.months[cm];
  if (bucket) {
    const inst = bucket.instances.find(i => i.itemId === id);
    if (inst && !inst.paid) {
      inst.name = it.name;
      inst.description = it.description;
      inst.amount = it.amount;
      inst.link = it.link;
      inst.dueDate = dueDateFor(cm, it.dueDay);
    }
  }

  logHistory(state, { action: 'item_edited', detail: it.name });
  persist(state);
  return computeView(state);
}

// Elimina la plantilla y, si existe, la instancia pendiente del mes actual (las
// instancias ya pagadas o de meses anteriores quedan intactas como historial).
function removeItem(id) {
  const state = load();
  const it = findItem(state, id);
  if (!it) throw new Error('Gasto fijo no encontrado.');
  state.items = state.items.filter(i => i.id !== id);
  const cm = monthKey();
  const bucket = state.months[cm];
  if (bucket) bucket.instances = bucket.instances.filter(i => i.itemId !== id || i.paid);
  logHistory(state, { action: 'item_removed', detail: it.name });
  persist(state);
  return computeView(state);
}

/* ---------- Pagos de instancias ---------- */

function setPaid(instanceId, paid) {
  const state = load();
  const found = findInstance(state, instanceId);
  if (!found) throw new Error('Gasto no encontrado.');
  const { inst, month } = found;
  inst.paid = !!paid;
  if (inst.paid) {
    inst.paidAt = Date.now();
    inst.paidAmount = inst.amount;
  } else {
    inst.paidAt = null;
    inst.paidAmount = null;
  }
  logHistory(state, {
    action: inst.paid ? 'instance_paid' : 'instance_unpaid',
    detail: `${inst.name} (${month})`,
    amount: inst.amount
  });
  persist(state);
  return computeView(state);
}

module.exports = {
  getState,
  addItem,
  updateItem,
  removeItem,
  setPaid
};
