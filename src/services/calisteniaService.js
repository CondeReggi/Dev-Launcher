'use strict';

/**
 * Entrenamiento (calistenia). Persistencia JSON en `userData/calistenia.json`
 * (sin secretos, no va al repo). Mismo contrato que deudasService: cada mutacion
 * devuelve el estado completo y computado (`computeState`) para que el renderer
 * re-renderice de una sola fuente de verdad.
 *
 * A diferencia de la v1, los EJERCICIOS ahora se persisten (se siembran desde
 * `config/calistenia.catalog.js`) y se gestionan desde la UI: crear/editar/
 * activar, variantes (baseId) y dificultad ordenable. Las sesiones guardan
 * inicio/fin, estado (completada/incompleta/cancelada), ejercicios realizados,
 * esfuerzo y notas; el historial y el calendario se calculan desde ahi.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const catalog = require('../config/calistenia.catalog');

const {
  SEED_EXERCISES, QUICK_TEMPLATES, WEEKLY_TEMPLATE, MUSCLE_GROUPS, LEVELS, TYPES, FOCUS_LIST,
  SESSION_KINDS, SESSION_STATUS, CONDITIONS, DISCOMFORT_ZONES, ZONE_MUSCLES, LEVEL_DIFFICULTY,
  REP_SECONDS, MAX_SESSION_SEC, WARMUP_BLOCK, COOLDOWN_BLOCK, TEMPLATE_LIBRARY, GROUP_STYLE_OPTIONS,
  QUICK_FOCUS_POOLS, QUICK_DURATIONS, LOW_IMPACT_ALT
} = catalog;

const CONDITION_KEYS = CONDITIONS.map(c => c.key);
const SUGGESTION_TTL = 14 * 24 * 3600 * 1000; // ocultar sugerencia decidida hace < 14 dias

const filePath = () => path.join(app.getPath('userData'), 'calistenia.json');
const MAX_SESSIONS = 2000;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function num(v, def = 0) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : def;
}
function clampInt(v, min, max, def) {
  let n = Math.round(num(v, def));
  if (n < min) n = min;
  if (max != null && n > max) n = max;
  return n;
}

function seedExercises() {
  return SEED_EXERCISES.map(e => ({ ...e }));
}

function emptyState() {
  return { version: 2, exercises: seedExercises(), routines: [], videoRoutines: [], sessions: [], weeklyPlan: null, suggestionDecisions: {} };
}

/* ---------- Carga + migracion ---------- */

function migrate(data) {
  if (!data || typeof data !== 'object') return emptyState();
  if (!Array.isArray(data.routines)) data.routines = [];
  if (!Array.isArray(data.videoRoutines)) data.videoRoutines = [];
  if (!Array.isArray(data.sessions)) data.sessions = [];

  data.videoRoutines.forEach(v => {
    if (typeof v.title !== 'string') v.title = String(v.title || '');
    if (typeof v.url !== 'string') v.url = String(v.url || '');
    if (typeof v.note !== 'string') v.note = String(v.note || '');
  });

  // v1 -> v2: no habia coleccion de ejercicios; sembrarla.
  if (!Array.isArray(data.exercises) || !data.exercises.length) {
    data.exercises = seedExercises();
  } else {
    // Asegurar campos nuevos en ejercicios existentes.
    data.exercises.forEach((e, i) => {
      if (e.baseId === undefined) e.baseId = null;
      if (typeof e.difficulty !== 'number') e.difficulty = LEVEL_DIFFICULTY[e.level] || 3;
      if (typeof e.active !== 'boolean') e.active = true;
      if (typeof e.favorite !== 'boolean') e.favorite = false;
      if (typeof e.custom !== 'boolean') e.custom = false;
      if (typeof e.order !== 'number') e.order = i;
      if (typeof e.lowImpact !== 'boolean') e.lowImpact = false;
    });
    // Merge: agregar ejercicios nuevos del SEED que falten (ej: bajo impacto,
    // soporte de plantillas) sin pisar los del usuario.
    const have = new Set(data.exercises.map(e => e.id));
    let order = data.exercises.reduce((m, e) => Math.max(m, e.order || 0), 0);
    SEED_EXERCISES.forEach(se => {
      if (!have.has(se.id)) data.exercises.push({ ...se, order: ++order });
    });
  }

  if (!data.suggestionDecisions || typeof data.suggestionDecisions !== 'object') data.suggestionDecisions = {};

  data.routines.forEach(r => {
    if (typeof r.favorite !== 'boolean') r.favorite = false;
    if (!Array.isArray(r.items)) r.items = [];
  });

  // Sesiones: mapear `completed` (bool) -> `status`; completar campos nuevos.
  data.sessions.forEach(s => {
    if (!s.status) s.status = s.completed ? 'completada' : 'incompleta';
    if (typeof s.completed !== 'boolean') s.completed = s.status === 'completada';
    if (!s.startedAt) s.startedAt = s.ts ? (s.ts - (s.actualSec || 0) * 1000) : null;
    if (!s.endedAt) s.endedAt = s.ts || null;
    if (!Array.isArray(s.results)) s.results = [];
    if (s.effort === undefined) s.effort = null;
    if (s.feeling === undefined) s.feeling = '';
    if (s.kind === undefined) s.kind = 'standard';
    if (s.condition === undefined) s.condition = null;
    if (!Array.isArray(s.discomforts)) s.discomforts = [];
    if (!s.blocks || typeof s.blocks !== 'object') s.blocks = { warmup: false, cooldown: false };
  });

  data.version = 2;
  return data;
}

function load() {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return emptyState();
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return emptyState();
    return migrate(JSON.parse(raw));
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

function exMap(state) {
  return state.exercises.reduce((m, e) => { m[e.id] = e; return m; }, {});
}
function familyRoot(ex) { return ex.baseId || ex.id; }

/* ---------- Duracion estimada ---------- */
function setSeconds(it) { return it.timeSec > 0 ? it.timeSec : it.reps * REP_SECONDS; }
function standardDuration(items) {
  let total = 0;
  items.forEach((it, idx) => {
    total += it.sets * setSeconds(it) + it.restSetSec * Math.max(0, it.sets - 1);
    if (idx < items.length - 1) total += it.restExerciseSec;
  });
  return total;
}
function routineDuration(routine) {
  if (routine.kind === 'emom') return (routine.emom ? routine.emom.totalMinutes : 0) * 60;
  return standardDuration(routine.items || []);
}

/* ---------- Vista computada ---------- */

function computeExercises(state, lastUsedById) {
  const list = state.exercises.slice().sort((a, b) => {
    const ra = familyRoot(a), rb = familyRoot(b);
    if (ra === rb) return (a.baseId ? a.difficulty : -1) - (b.baseId ? b.difficulty : -1);
    // ordenar familias por order del base
    const baseA = state.exercises.find(x => x.id === ra);
    const baseB = state.exercises.find(x => x.id === rb);
    const ma = (baseA ? baseA.muscle : a.muscle), mb = (baseB ? baseB.muscle : b.muscle);
    if (ma !== mb) return MUSCLE_GROUPS.indexOf(ma) - MUSCLE_GROUPS.indexOf(mb);
    return ((baseA ? baseA.order : 0) - (baseB ? baseB.order : 0));
  });
  const byId = exMap(state);
  lastUsedById = lastUsedById || {};
  return list.map(e => ({
    ...e,
    familyRoot: familyRoot(e),
    isBase: !e.baseId,
    baseName: e.baseId && byId[e.baseId] ? byId[e.baseId].name : null,
    lastUsedAt: lastUsedById[e.id] || null
  }));
}

function resolveStandardItem(state, byId, it) {
  const ex = byId[it.exerciseId] || { name: it.exerciseId, muscle: '', type: 'reps' };
  return { ...it, exerciseName: ex.name, muscle: ex.muscle, exerciseType: ex.type, exerciseActive: !!ex.active };
}

// Grupo muscular dominante de una rutina (para mostrar el "tipo/foco").
function dominantMuscle(items, byId) {
  const tally = {};
  (items || []).forEach(it => {
    const ex = byId[it.exerciseId];
    if (ex && ex.muscle) tally[ex.muscle] = (tally[ex.muscle] || 0) + 1;
  });
  let best = null, n = 0;
  Object.keys(tally).forEach(k => { if (tally[k] > n) { n = tally[k]; best = k; } });
  return best;
}

function computeRoutine(state, byId, routine, lastInfo, agg) {
  const estimatedSec = routineDuration(routine);
  const srcItems = routine.kind === 'emom' ? (routine.emom ? routine.emom.items : []) : (routine.items || []);
  const times = agg ? agg.times : 0;
  const completed = agg ? agg.completed : 0;
  const base = {
    id: routine.id, name: routine.name, kind: routine.kind,
    createdAt: routine.createdAt, updatedAt: routine.updatedAt,
    weeklyGenerated: !!routine.weeklyGenerated, favorite: !!routine.favorite,
    estimatedSec, estimatedMin: Math.round(estimatedSec / 60),
    over40: estimatedSec > MAX_SESSION_SEC,
    focus: dominantMuscle(srcItems, byId),
    lastDoneAt: lastInfo ? lastInfo.ts : null,
    lastStatus: lastInfo ? lastInfo.status : null,
    timesDone: times,
    completedTimes: completed,
    completion: times ? Math.round((completed / times) * 100) : null
  };
  if (routine.kind === 'emom') {
    const items = (routine.emom ? routine.emom.items : []).map(i => {
      const ex = byId[i.exerciseId] || { name: i.exerciseId, muscle: '' };
      return { ...i, exerciseName: ex.name, muscle: ex.muscle };
    });
    base.emom = { totalMinutes: routine.emom ? routine.emom.totalMinutes : 0, items };
    base.items = []; base.exerciseCount = items.length;
  } else {
    base.items = (routine.items || []).map(it => resolveStandardItem(state, byId, it));
    base.emom = null; base.exerciseCount = base.items.length;
  }
  return base;
}

/* ----- fechas locales ----- */
function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayISO() { return isoDate(new Date()); }
function weekStart(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function computeWeekly(sessions) {
  const now = new Date();
  const start = weekStart(now);
  const endExclusive = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  const daysThisWeek = new Set();
  const trainedDays = new Set();
  let sessionsThisWeek = 0, minutesThisWeek = 0, completedThisWeek = 0;

  sessions.forEach(s => {
    const date = s.date || (s.ts ? isoDate(new Date(s.ts)) : null);
    if (!date) return;
    if (s.status === 'completada') trainedDays.add(date);
    const sd = new Date(date + 'T00:00:00');
    if (sd >= start && sd < endExclusive) {
      daysThisWeek.add(date);
      sessionsThisWeek++;
      minutesThisWeek += (s.actualSec || 0) / 60;
      if (s.status === 'completada') completedThisWeek++;
    }
  });

  let streak = 0;
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!trainedDays.has(isoDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (trainedDays.has(isoDate(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }

  return {
    weekStartISO: isoDate(start),
    daysTrainedThisWeek: daysThisWeek.size,
    sessionsThisWeek,
    minutesThisWeek: Math.round(minutesThisWeek),
    completedThisWeek,
    streak,
    totalSessions: sessions.length
  };
}

// Mapa fecha -> { completed, partial, total } para el calendario.
function computeCalendar(sessions) {
  const map = {};
  sessions.forEach(s => {
    const date = s.date || (s.ts ? isoDate(new Date(s.ts)) : null);
    if (!date) return;
    if (!map[date]) map[date] = { date, total: 0, completed: 0, cancelled: 0 };
    map[date].total++;
    if (s.status === 'completada') map[date].completed++;
    else if (s.status === 'cancelada') map[date].cancelled++;
  });
  return map;
}

// Desglose de la semana actual por dia (lun->dom) para el grafico de barras.
function computeWeekDays(sessions) {
  const now = new Date();
  const start = weekStart(now);
  const labels = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom'];
  const days = labels.map((label, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { label, iso: isoDate(d), sessions: 0, minutes: 0, completed: 0, isToday: isoDate(d) === isoDate(now) };
  });
  const byIso = days.reduce((m, d) => { m[d.iso] = d; return m; }, {});
  sessions.forEach(s => {
    const date = s.date || (s.ts ? isoDate(new Date(s.ts)) : null);
    const day = date && byIso[date];
    if (!day) return;
    day.sessions++;
    day.minutes += Math.round((s.actualSec || 0) / 60);
    if (s.status === 'completada') day.completed++;
  });
  return days;
}

// Estadisticas simples + progresion por ejercicio.
function computeStats(sessions, byId) {
  const exTally = {};       // nombre -> veces realizado
  const progression = {};   // exerciseId -> { name, type, maxReps, maxTimeSec, sessions }
  sessions.forEach(s => {
    (s.results || []).forEach(r => {
      const key = r.exerciseName || r.exerciseId || 'Ejercicio';
      exTally[key] = (exTally[key] || 0) + 1;
      const id = r.exerciseId || key;
      if (!progression[id]) progression[id] = { exerciseId: r.exerciseId || null, name: r.exerciseName || key, type: r.type || 'reps', maxReps: 0, maxTimeSec: 0, sessions: 0 };
      const p = progression[id];
      p.sessions++;
      if (num(r.bestReps) > p.maxReps) p.maxReps = Math.round(num(r.bestReps));
      if (num(r.bestTimeSec) > p.maxTimeSec) p.maxTimeSec = Math.round(num(r.bestTimeSec));
    });
  });
  let mostDone = null, mostN = 0;
  Object.keys(exTally).forEach(k => { if (exTally[k] > mostN) { mostN = exTally[k]; mostDone = k; } });
  const progList = Object.values(progression)
    .filter(p => p.maxReps > 0 || p.maxTimeSec > 0)
    .sort((a, b) => b.sessions - a.sessions);
  return {
    completedTotal: sessions.filter(s => s.status === 'completada').length,
    mostDoneExercise: mostDone,
    mostDoneCount: mostN,
    progression: progList
  };
}

/* ---------- Plantillas (biblioteca resuelta) ---------- */

function siblingsOf(state, ex) {
  const root = familyRoot(ex);
  return state.exercises.filter(x => familyRoot(x) === root);
}
function harderVariant(state, ex) {
  const c = siblingsOf(state, ex).filter(x => x.difficulty > ex.difficulty).sort((a, b) => a.difficulty - b.difficulty);
  return c[0] || null;
}
function easierVariant(state, ex) {
  const c = siblingsOf(state, ex).filter(x => x.difficulty < ex.difficulty).sort((a, b) => b.difficulty - a.difficulty);
  return c[0] || null;
}

function resolveTemplate(state, byId, tpl) {
  const isEmom = tpl.kind === 'emom';
  const rawItems = isEmom ? [] : (tpl.items || []).filter(it => byId[it.exerciseId]);
  const emomItems = isEmom ? (tpl.emom.items || []).filter(it => byId[it.exerciseId]) : [];
  const routineLike = isEmom
    ? { kind: 'emom', emom: { totalMinutes: tpl.emom.totalMinutes, items: emomItems } }
    : { kind: 'standard', items: rawItems };
  const estimatedSec = routineDuration(routineLike);
  return {
    id: tpl.id, name: tpl.name, goal: tpl.goal || '', level: tpl.level,
    levelLabel: tpl.levelLabel || tpl.level, style: tpl.style || null, styleLabel: tpl.styleLabel || null,
    focus: tpl.focus, kind: tpl.kind,
    warmup: !!tpl.warmup, cooldown: !!tpl.cooldown, notes: tpl.notes || '',
    estimatedSec, estimatedMin: Math.round(estimatedSec / 60), over40: estimatedSec > MAX_SESSION_SEC,
    exerciseCount: isEmom ? emomItems.length : rawItems.length,
    emom: isEmom ? { totalMinutes: tpl.emom.totalMinutes, items: emomItems.map(i => ({ ...i, exerciseName: (byId[i.exerciseId] || {}).name })) } : null,
    items: isEmom ? [] : rawItems.map(it => {
      const ex = byId[it.exerciseId] || { name: it.exerciseId, muscle: '', type: 'reps' };
      const easier = easierVariant(state, ex);
      const lowAltId = LOW_IMPACT_ALT[it.exerciseId];
      const lowAlt = lowAltId && byId[lowAltId] ? byId[lowAltId] : null;
      return {
        ...it, exerciseName: ex.name, muscle: ex.muscle, exerciseType: ex.type,
        altEasier: easier ? easier.name : null,
        altLowImpact: lowAlt && !ex.lowImpact ? lowAlt.name : null
      };
    })
  };
}

function computeLibrary(state, byId) {
  return TEMPLATE_LIBRARY
    .map(t => resolveTemplate(state, byId, t))
    .filter(t => t.exerciseCount > 0);
}

/* ---------- Sugerencias de progresion ---------- */

// Clasifica como le fue al usuario en esa sesion (para ese ejercicio/global).
function sessionSignal(s) {
  const completed = s.status === 'completada';
  const hard = !completed || (s.effort != null && s.effort >= 8) || s.condition === 'pesado' || s.condition === 'limite';
  const easy = completed && ((s.effort != null && s.effort <= 4) || s.condition === 'facil');
  if (hard) return 'hard';
  if (easy) return 'easy';
  return completed ? 'normal' : 'hard';
}

function computeSuggestions(state, sessions, byId) {
  const decisions = state.suggestionDecisions || {};
  const now = Date.now();
  const out = [];

  // 1) Molestias recientes por zona (ultimas ~8 sesiones).
  const recent = sessions.slice(0, 8);
  const zoneHits = {};
  recent.forEach(s => (s.discomforts || []).forEach(d => {
    if (d.intensity >= 4) zoneHits[d.zone] = (zoneHits[d.zone] || 0) + 1;
  }));
  const cautionMuscles = new Set();
  Object.keys(zoneHits).forEach(zone => {
    if (zoneHits[zone] >= 2) (ZONE_MUSCLES[zone] || []).forEach(m => cautionMuscles.add(m));
  });

  // Ejercicios que el usuario realmente entrena (aparecen en results).
  const trained = {};   // exerciseId -> [signals, mas reciente primero]
  sessions.forEach(s => {
    const sig = sessionSignal(s);
    (s.results || []).forEach(r => {
      if (!r.exerciseId) return;
      (trained[r.exerciseId] || (trained[r.exerciseId] = [])).push(sig);
    });
  });

  Object.keys(trained).forEach(exId => {
    const ex = byId[exId];
    if (!ex) return;
    const sigs = trained[exId];
    const lead = (val) => { let n = 0; for (const x of sigs) { if (x === val) n++; else break; } return n; };
    const easyStreak = lead('easy');
    const hardStreak = lead('hard');
    const normalStreak = lead('normal');
    const caution = cautionMuscles.has(ex.muscle);

    let sug = null;
    if (caution) {
      const easier = easierVariant(state, ex);
      const lowAlt = LOW_IMPACT_ALT[exId] && byId[LOW_IMPACT_ALT[exId]] ? byId[LOW_IMPACT_ALT[exId]] : null;
      sug = { type: 'deload', severity: 'warn',
        title: `Cuidado con "${ex.name}"`,
        message: `Registraste molestias en una zona relacionada. Baja el volumen, suma descanso${easier ? ` o usa una variante mas suave (${easier.name})` : ''}${lowAlt ? ` o de bajo impacto (${lowAlt.name})` : ''}.`,
        detail: 'No es un diagnostico. Si el dolor persiste o es agudo, consulta a un profesional.' };
    } else if (hardStreak >= 2) {
      const easier = easierVariant(state, ex);
      sug = { type: 'reduce', severity: 'warn',
        title: `"${ex.name}" te viene costando`,
        message: `Te costo varias veces. Baja repeticiones, aumenta el descanso${easier ? ` o pasa a "${easier.name}"` : ''} hasta consolidar la tecnica.`,
        detail: 'Regla: si fallas o el esfuerzo es 8-10 repetidas veces, conviene retroceder un escalon.' };
    } else if (easyStreak >= 3) {
      const harder = harderVariant(state, ex);
      sug = { type: 'increase', severity: 'ok',
        title: `Venis completando bien "${ex.name}"`,
        message: harder
          ? `3 sesiones faciles seguidas. ¿Subis a una variante mas dificil (${harder.name})?`
          : `3 sesiones faciles seguidas. Subi repeticiones o tiempo, o agrega una serie.`,
        detail: 'Regla: 3 sesiones completas con esfuerzo <=4 o estado "Facil" => progresar.' };
    } else if (normalStreak >= 3) {
      sug = { type: 'maintain', severity: 'info',
        title: `"${ex.name}" en buen punto`,
        message: '3 sesiones en estado "Normal". Mantene la dificultad o suma una progresion leve (1-2 reps).',
        detail: 'Carga adecuada: progresa de a poco cuando se sienta facil.' };
    }
    if (!sug) return;
    const key = `${exId}:${sug.type}`;
    const dec = decisions[key];
    if (dec && (now - (dec.ts || 0) < SUGGESTION_TTL)) return; // decidida hace poco
    out.push({ key, exerciseId: exId, exerciseName: ex.name, ...sug });
  });

  const rank = { deload: 0, reduce: 1, increase: 2, maintain: 3 };
  out.sort((a, b) => (rank[a.type] - rank[b.type]));
  return out.slice(0, 8);
}

function computeState(state) {
  const byId = exMap(state);
  const sessions = (state.sessions || []).slice().sort((a, b) => (b.endedAt || b.ts || 0) - (a.endedAt || a.ts || 0));

  // Agregados derivados de sesiones (sessions ya viene ordenado desc, asi que la
  // primera ocurrencia de cada id es la mas reciente).
  const lastUsedById = {};       // exerciseId -> ts ultimo uso
  const routineLast = {};        // routineId -> { ts, status } ultima vez
  const routineAgg = {};         // routineId -> { times, completed }
  const videoLast = {};          // videoRoutineId -> ts ultima vez
  const videoTimes = {};         // videoRoutineId -> veces hecha
  sessions.forEach(s => {
    (s.results || []).forEach(r => { if (r.exerciseId && !lastUsedById[r.exerciseId]) lastUsedById[r.exerciseId] = s.endedAt || s.ts; });
    if (s.routineId) {
      if (!routineLast[s.routineId]) routineLast[s.routineId] = { ts: s.endedAt || s.ts, status: s.status };
      const a = routineAgg[s.routineId] || (routineAgg[s.routineId] = { times: 0, completed: 0 });
      a.times++; if (s.status === 'completada') a.completed++;
    }
    if (s.videoRoutineId) {
      if (!videoLast[s.videoRoutineId]) videoLast[s.videoRoutineId] = s.endedAt || s.ts;
      videoTimes[s.videoRoutineId] = (videoTimes[s.videoRoutineId] || 0) + 1;
    }
  });

  const videoRoutines = (state.videoRoutines || []).map(v => ({
    id: v.id, title: v.title, url: v.url, note: v.note || '',
    createdAt: v.createdAt || null, updatedAt: v.updatedAt || null,
    timesDone: videoTimes[v.id] || 0,
    lastDoneAt: videoLast[v.id] || null
  })).sort((a, b) => (b.lastDoneAt || b.createdAt || 0) - (a.lastDoneAt || a.createdAt || 0));

  const exComputed = computeExercises(state, lastUsedById);
  const routines = state.routines.map(r => computeRoutine(state, byId, r, routineLast[r.id], routineAgg[r.id]));
  routines.sort((a, b) => (b.favorite - a.favorite) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
  const routinesById = state.routines.reduce((m, r) => { m[r.id] = r; return m; }, {});
  const weekly = computeWeekly(sessions);
  const stats = computeStats(sessions, byId);

  return {
    version: state.version || 2,
    meta: {
      muscleGroups: MUSCLE_GROUPS, levels: LEVELS, types: TYPES, focusList: FOCUS_LIST,
      sessionKinds: SESSION_KINDS, sessionStatus: SESSION_STATUS, conditions: CONDITIONS,
      discomfortZones: DISCOMFORT_ZONES, maxSessionSec: MAX_SESSION_SEC, repSeconds: REP_SECONDS,
      templates: QUICK_TEMPLATES.map(t => ({ key: t.key, name: t.name, focus: t.focus })),
      templateStyles: GROUP_STYLE_OPTIONS,
      warmupBlock: WARMUP_BLOCK, cooldownBlock: COOLDOWN_BLOCK,
      quickPools: QUICK_FOCUS_POOLS, quickDurations: QUICK_DURATIONS, lowImpactAlt: LOW_IMPACT_ALT
    },
    exercises: exComputed,
    activeExercises: exComputed.filter(e => e.active),
    routines,
    videoRoutines,
    library: computeLibrary(state, byId),
    sessions,
    weekly,
    weekDays: computeWeekDays(sessions),
    stats: { ...weekly, completedTotal: stats.completedTotal, mostDoneExercise: stats.mostDoneExercise, mostDoneCount: stats.mostDoneCount },
    progression: stats.progression,
    suggestions: computeSuggestions(state, sessions, byId),
    calendar: computeCalendar(sessions),
    weeklyPlan: computeWeeklyPlan(state.weeklyPlan, routinesById)
  };
}

function computeWeeklyPlan(plan, routinesById) {
  if (!plan) return null;
  return {
    id: plan.id, name: plan.name, createdAt: plan.createdAt,
    days: (plan.days || []).map(d => {
      const r = d.routineId ? routinesById[d.routineId] : null;
      return {
        day: d.day, focus: d.focus, rest: !!d.rest,
        routineId: r ? d.routineId : null,
        routineName: r ? r.name : null,
        estimatedMin: r ? Math.round(routineDuration(r) / 60) : 0
      };
    })
  };
}

function getState() { return computeState(load()); }

/* ====================================================================== */
/*  EJERCICIOS                                                             */
/* ====================================================================== */

function slugify(name) {
  return String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'ej';
}

function saveExercise(input) {
  const state = load();
  const name = String(input && input.name || '').trim();
  if (!name) throw new Error('El nombre del ejercicio es obligatorio.');
  const muscle = MUSCLE_GROUPS.includes(input.muscle) ? input.muscle : MUSCLE_GROUPS[0];
  const type = TYPES.includes(input.type) ? input.type : 'reps';
  const level = LEVELS.includes(input.level) ? input.level : 'principiante';
  const baseId = input.baseId && state.exercises.some(e => e.id === input.baseId && e.id !== input.id) ? input.baseId : null;
  const difficulty = clampInt(input.difficulty, 1, 99, LEVEL_DIFFICULTY[level] || 3);
  const description = String(input.description || '').trim();

  if (input.id) {
    const e = state.exercises.find(x => x.id === input.id);
    if (!e) throw new Error('Ejercicio no encontrado.');
    if (baseId === e.id) throw new Error('Un ejercicio no puede ser variante de si mismo.');
    Object.assign(e, { name, muscle, type, level, baseId, difficulty, description });
    if (typeof input.active === 'boolean') e.active = input.active;
    persist(state);
    return { state: computeState(state), exerciseId: e.id };
  }

  let id = slugify(name);
  while (state.exercises.some(e => e.id === id)) id += '-' + Math.random().toString(36).slice(2, 5);
  const order = state.exercises.reduce((m, e) => Math.max(m, e.order), 0) + 1;
  state.exercises.push({ id, name, muscle, type, level, description, baseId, difficulty, active: true, favorite: false, custom: true, order });
  persist(state);
  return { state: computeState(state), exerciseId: id };
}

function removeExercise(id) {
  const state = load();
  const e = state.exercises.find(x => x.id === id);
  if (!e) throw new Error('Ejercicio no encontrado.');
  // Si es base de variantes, desvincular las variantes (pasan a base).
  state.exercises.forEach(x => { if (x.baseId === id) x.baseId = null; });
  state.exercises = state.exercises.filter(x => x.id !== id);
  persist(state);
  return { state: computeState(state), exerciseId: null };
}

function setExerciseActive(id, active) {
  const state = load();
  const e = state.exercises.find(x => x.id === id);
  if (!e) throw new Error('Ejercicio no encontrado.');
  e.active = !!active;
  persist(state);
  return { state: computeState(state), exerciseId: id };
}

function toggleExerciseFavorite(id) {
  const state = load();
  const e = state.exercises.find(x => x.id === id);
  if (!e) throw new Error('Ejercicio no encontrado.');
  e.favorite = !e.favorite;
  persist(state);
  return { state: computeState(state), exerciseId: id };
}

// Mueve un ejercicio en la progresion de su familia (intercambia difficulty con
// el vecino mas cercano hacia arriba/abajo). dir: 'up' = menos dificil.
function reorderExerciseDifficulty(id, dir) {
  const state = load();
  const e = state.exercises.find(x => x.id === id);
  if (!e) throw new Error('Ejercicio no encontrado.');
  const root = familyRoot(e);
  const fam = state.exercises.filter(x => familyRoot(x) === root).sort((a, b) => a.difficulty - b.difficulty);
  const i = fam.findIndex(x => x.id === id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= fam.length) return { state: computeState(state), exerciseId: id };
  const a = fam[i], b = fam[j];
  const tmp = a.difficulty; a.difficulty = b.difficulty; b.difficulty = tmp;
  if (a.difficulty === b.difficulty) { if (dir === 'up') a.difficulty -= 1; else a.difficulty += 1; }
  persist(state);
  return { state: computeState(state), exerciseId: id };
}

/* ====================================================================== */
/*  RUTINAS                                                                */
/* ====================================================================== */

function normalizeStandardItem(state, raw) {
  const ex = state.exercises.find(e => e.id === (raw && raw.exerciseId));
  if (!ex) throw new Error('Ejercicio desconocido: ' + (raw && raw.exerciseId));
  const sets = clampInt(raw.sets, 1, 99, 1);
  const reps = clampInt(raw.reps, 0, 9999, 0);
  const timeSec = clampInt(raw.timeSec, 0, 99999, 0);
  if (reps <= 0 && timeSec <= 0) throw new Error(`"${ex.name}": indica repeticiones o tiempo de ejecucion.`);
  return { exerciseId: ex.id, sets, reps, timeSec, restSetSec: clampInt(raw.restSetSec, 0, 9999, 0), restExerciseSec: clampInt(raw.restExerciseSec, 0, 9999, 0) };
}
function normalizeEmomItem(state, raw) {
  const ex = state.exercises.find(e => e.id === (raw && raw.exerciseId));
  if (!ex) throw new Error('Ejercicio desconocido: ' + (raw && raw.exerciseId));
  return { exerciseId: ex.id, reps: clampInt(raw.reps, 1, 9999, 1) };
}

function normalizeRoutine(state, input) {
  const name = String(input && input.name || '').trim();
  if (!name) throw new Error('El nombre de la rutina es obligatorio.');
  const kind = input && input.kind === 'emom' ? 'emom' : 'standard';
  const routine = { name, kind };
  if (kind === 'emom') {
    const src = input.emom || {};
    const items = (Array.isArray(src.items) ? src.items : []).map(i => normalizeEmomItem(state, i));
    if (!items.length) throw new Error('El EMOM necesita al menos un ejercicio por minuto.');
    routine.emom = { totalMinutes: clampInt(src.totalMinutes, 1, 60, 10), items };
    routine.items = [];
  } else {
    const items = (Array.isArray(input.items) ? input.items : []).map(i => normalizeStandardItem(state, i));
    if (!items.length) throw new Error('La rutina necesita al menos un ejercicio.');
    routine.items = items;
    routine.emom = null;
  }
  return routine;
}

function saveRoutine(input) {
  const state = load();
  const normalized = normalizeRoutine(state, input || {});
  const now = Date.now();
  if (input && input.id) {
    const r = state.routines.find(x => x.id === input.id);
    if (!r) throw new Error('Rutina no encontrada.');
    Object.assign(r, normalized, { updatedAt: now });
    persist(state);
    return { state: computeState(state), routineId: r.id };
  }
  const routine = { id: uid(), createdAt: now, updatedAt: now, weeklyGenerated: false, favorite: false, ...normalized };
  state.routines.push(routine);
  persist(state);
  return { state: computeState(state), routineId: routine.id };
}

function removeRoutine(id) {
  const state = load();
  if (!state.routines.some(x => x.id === id)) throw new Error('Rutina no encontrada.');
  state.routines = state.routines.filter(x => x.id !== id);
  if (state.weeklyPlan && Array.isArray(state.weeklyPlan.days)) {
    state.weeklyPlan.days.forEach(d => { if (d.routineId === id) { d.routineId = null; d.rest = true; } });
  }
  persist(state);
  return { state: computeState(state), routineId: null };
}

function duplicateRoutine(id) {
  const state = load();
  const r = state.routines.find(x => x.id === id);
  if (!r) throw new Error('Rutina no encontrada.');
  const now = Date.now();
  const copy = JSON.parse(JSON.stringify(r));
  copy.id = uid(); copy.name = r.name + ' (copia)';
  copy.createdAt = now; copy.updatedAt = now; copy.weeklyGenerated = false; copy.favorite = false;
  state.routines.push(copy);
  persist(state);
  return { state: computeState(state), routineId: copy.id };
}

function toggleRoutineFavorite(id) {
  const state = load();
  const r = state.routines.find(x => x.id === id);
  if (!r) throw new Error('Rutina no encontrada.');
  r.favorite = !r.favorite;
  persist(state);
  return { state: computeState(state), routineId: id };
}

function createFromTemplate(key) {
  const state = load();
  const tpl = QUICK_TEMPLATES.find(t => t.key === key);
  if (!tpl) throw new Error('Plantilla no encontrada.');
  const items = tpl.items
    .filter(it => state.exercises.some(e => e.id === it.exerciseId))
    .map(it => normalizeStandardItem(state, it));
  if (!items.length) throw new Error('La plantilla no tiene ejercicios disponibles.');
  const now = Date.now();
  const routine = { id: uid(), name: tpl.name, kind: 'standard', items, emom: null, createdAt: now, updatedAt: now, weeklyGenerated: false, favorite: false };
  state.routines.push(routine);
  persist(state);
  return { state: computeState(state), routineId: routine.id };
}

/* ====================================================================== */
/*  RUTINAS EN VIDEO (link de YouTube + "hice la rutina")                  */
/* ====================================================================== */

function saveVideoRoutine(input) {
  const state = load();
  const title = String(input && input.title || '').trim();
  if (!title) throw new Error('El titulo de la rutina es obligatorio.');
  const url = String(input && input.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Ingresa un link valido (http/https).');
  const note = String(input && input.note || '').trim();
  const now = Date.now();

  if (input && input.id) {
    const v = state.videoRoutines.find(x => x.id === input.id);
    if (!v) throw new Error('Rutina de video no encontrada.');
    Object.assign(v, { title, url, note, updatedAt: now });
    persist(state);
    return { state: computeState(state), videoRoutineId: v.id };
  }
  const video = { id: uid(), title, url, note, createdAt: now, updatedAt: now };
  state.videoRoutines.unshift(video);
  persist(state);
  return { state: computeState(state), videoRoutineId: video.id };
}

function removeVideoRoutine(id) {
  const state = load();
  if (!state.videoRoutines.some(x => x.id === id)) throw new Error('Rutina de video no encontrada.');
  state.videoRoutines = state.videoRoutines.filter(x => x.id !== id);
  persist(state);
  return { state: computeState(state), videoRoutineId: null };
}

// "Hice la rutina": registra una sesion completada (cuenta en calendario, racha,
// historial y KPIs) asociada a la rutina de video.
function markVideoRoutineDone(id, date) {
  const state = load();
  const v = state.videoRoutines.find(x => x.id === id);
  if (!v) throw new Error('Rutina de video no encontrada.');
  return recordSession({
    kind: 'video',
    status: 'completada',
    routineName: v.title,
    videoRoutineId: v.id,
    date: date || undefined,
    exercisesTotal: 1,
    exercisesCompleted: 1
  });
}

/* ====================================================================== */
/*  SESIONES                                                               */
/* ====================================================================== */

function sanitizeResults(results, state) {
  if (!Array.isArray(results)) return [];
  const byId = exMap(state);
  return results.map(r => {
    const ex = r.exerciseId ? byId[r.exerciseId] : null;
    return {
      exerciseId: r.exerciseId || null,
      exerciseName: String(r.exerciseName || (ex ? ex.name : 'Ejercicio')).trim(),
      type: r.type || (ex ? ex.type : 'reps'),
      setsPlanned: clampInt(r.setsPlanned, 0, 999, 0),
      setsCompleted: clampInt(r.setsCompleted, 0, 999, 0),
      reps: clampInt(r.reps, 0, 99999, 0),
      timeSec: clampInt(r.timeSec, 0, 99999, 0),
      bestReps: clampInt(r.bestReps, 0, 99999, 0),
      bestTimeSec: clampInt(r.bestTimeSec, 0, 99999, 0)
    };
  });
}

function sanitizeDiscomforts(list, state) {
  if (!Array.isArray(list)) return [];
  const byId = exMap(state);
  return list
    .filter(d => d && DISCOMFORT_ZONES.includes(d.zone))
    .map(d => ({
      zone: d.zone,
      intensity: clampInt(d.intensity, 1, 10, 5),
      exerciseId: d.exerciseId && byId[d.exerciseId] ? d.exerciseId : null,
      note: String(d.note || '').trim()
    }));
}

function recordSession(input) {
  const state = load();
  const s = input || {};
  const routine = s.routineId ? state.routines.find(x => x.id === s.routineId) : null;
  const status = SESSION_STATUS.includes(s.status) ? s.status : (s.completed ? 'completada' : 'incompleta');
  const endedAt = s.endedAt || Date.now();
  const actualSec = Math.max(0, Math.round(num(s.actualSec, 0)));
  const session = {
    id: uid(),
    ts: endedAt,
    startedAt: s.startedAt || (endedAt - actualSec * 1000),
    endedAt,
    date: s.date ? String(s.date) : isoDate(new Date(endedAt)),
    routineId: s.routineId || null,
    videoRoutineId: s.videoRoutineId || null,
    routineName: String(s.routineName || (routine ? routine.name : (SESSION_KINDS[s.kind] || 'Sesion'))).trim() || 'Sesion',
    kind: SESSION_KINDS[s.kind] ? s.kind : 'standard',
    status,
    completed: status === 'completada',
    plannedSec: Math.max(0, Math.round(num(s.plannedSec, 0))),
    actualSec,
    exercisesCompleted: clampInt(s.exercisesCompleted, 0, 99999, 0),
    exercisesTotal: clampInt(s.exercisesTotal, 0, 99999, 0),
    results: sanitizeResults(s.results, state),
    effort: s.effort == null ? null : clampInt(s.effort, 1, 10, 5),
    condition: CONDITION_KEYS.includes(s.condition) ? s.condition : null,
    discomforts: sanitizeDiscomforts(s.discomforts, state),
    blocks: { warmup: !!(s.blocks && s.blocks.warmup), cooldown: !!(s.blocks && s.blocks.cooldown) },
    feeling: String(s.feeling || '').trim(),
    note: String(s.note || '').trim()
  };
  state.sessions.unshift(session);
  if (state.sessions.length > MAX_SESSIONS) state.sessions.length = MAX_SESSIONS;
  persist(state);
  return { state: computeState(state), sessionId: session.id };
}

function removeSession(id) {
  const state = load();
  if (!(state.sessions || []).some(s => s.id === id)) throw new Error('Sesion no encontrada.');
  state.sessions = state.sessions.filter(s => s.id !== id);
  persist(state);
  return { state: computeState(state), sessionId: null };
}

function clearSessions() {
  const state = load();
  state.sessions = [];
  persist(state);
  return { state: computeState(state), sessionId: null };
}

/* ====================================================================== */
/*  PLAN SEMANAL                                                           */
/* ====================================================================== */

function templateItems(state, key) {
  const tpl = QUICK_TEMPLATES.find(t => t.key === key);
  if (!tpl) return [];
  return tpl.items
    .filter(it => state.exercises.some(e => e.id === it.exerciseId))
    .map(it => normalizeStandardItem(state, it));
}

function generateWeeklyPlan() {
  const state = load();
  state.routines = state.routines.filter(r => !r.weeklyGenerated);
  const now = Date.now();
  const planId = uid();
  const days = WEEKLY_TEMPLATE.map((tpl, i) => {
    if (tpl.rest || !tpl.templateKey) return { day: tpl.day, focus: tpl.focus, rest: true, routineId: null };
    const items = templateItems(state, tpl.templateKey);
    if (!items.length) return { day: tpl.day, focus: tpl.focus, rest: true, routineId: null };
    const routine = { id: uid(), name: `${tpl.day} — ${tpl.focus}`, kind: 'standard', items, emom: null, createdAt: now + i, updatedAt: now + i, weeklyGenerated: true, favorite: false };
    state.routines.push(routine);
    return { day: tpl.day, focus: tpl.focus, rest: false, routineId: routine.id };
  });
  state.weeklyPlan = { id: planId, name: 'Plan semanal de calistenia', createdAt: now, days };
  persist(state);
  return { state: computeState(state), planId };
}

function setWeeklyPlanDay(dayIndex, routineId) {
  const state = load();
  if (!state.weeklyPlan || !Array.isArray(state.weeklyPlan.days)) throw new Error('No hay un plan semanal todavia.');
  const day = state.weeklyPlan.days[dayIndex];
  if (!day) throw new Error('Dia del plan no valido.');
  if (routineId && !state.routines.some(r => r.id === routineId)) throw new Error('Rutina no encontrada.');
  day.routineId = routineId || null;
  day.rest = !routineId;
  persist(state);
  return { state: computeState(state) };
}

function removeWeeklyPlan() {
  const state = load();
  state.weeklyPlan = null;
  persist(state);
  return { state: computeState(state) };
}

/* ---------- Sugerencias de progresion (aceptar/ignorar) ---------- */

function setSuggestionDecision(key, decision) {
  const state = load();
  if (!key) throw new Error('Falta la clave de la sugerencia.');
  const d = decision === 'accepted' ? 'accepted' : 'rejected';
  if (!state.suggestionDecisions || typeof state.suggestionDecisions !== 'object') state.suggestionDecisions = {};
  state.suggestionDecisions[key] = { decision: d, ts: Date.now() };
  persist(state);
  return { state: computeState(state), key, decision: d };
}

module.exports = {
  getState,
  // ejercicios
  saveExercise, removeExercise, setExerciseActive, toggleExerciseFavorite, reorderExerciseDifficulty,
  // rutinas
  saveRoutine, removeRoutine, duplicateRoutine, toggleRoutineFavorite, createFromTemplate,
  // rutinas en video
  saveVideoRoutine, removeVideoRoutine, markVideoRoutineDone,
  // sesiones
  recordSession, removeSession, clearSessions,
  // plan semanal
  generateWeeklyPlan, setWeeklyPlanDay, removeWeeklyPlan,
  // sugerencias
  setSuggestionDecision,
  // expuesto para tests
  routineDuration
};
