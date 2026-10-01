'use strict';

/**
 * SEED del modulo Entrenamiento (calistenia). Ya NO es la fuente de verdad en
 * runtime: el servicio copia estos ejercicios a `userData/calistenia.json` la
 * primera vez (o mergea los que falten) y a partir de ahi el usuario los
 * gestiona desde la UI. Editar este archivo cambia el set inicial / agrega
 * ejercicios nuevos a instalaciones existentes (ver migrate()).
 *
 * Ejercicio: { id, name, muscle, type:'reps'|'time'|'both', level, description,
 *   baseId, difficulty, lowImpact? }. Variantes = baseId apuntando al base.
 */

const MUSCLE_GROUPS = ['Empuje', 'Tiron', 'Piernas', 'Core', 'Full body', 'Cardio'];
const LEVELS = ['principiante', 'intermedio', 'avanzado'];
const TYPES = ['reps', 'time', 'both'];

// Focos para entreno rapido / plantillas / rutinas por grupo.
const FOCUS_LIST = ['Full body', 'Empuje', 'Tiron', 'Piernas', 'Core', 'Movilidad'];

const SESSION_KINDS = {
  standard: 'Rutina',
  emom: 'EMOM',
  'emom-random': 'EMOM abierto',
  free: 'Ejercicio libre',
  quick: 'Entreno rapido',
  template: 'Plantilla',
  video: 'Rutina en video'
};

const SESSION_STATUS = ['completada', 'incompleta', 'cancelada'];

// Estado general percibido al cerrar la sesion (ademas del esfuerzo 1-10).
const CONDITIONS = [
  { key: 'facil',  label: 'Facil' },
  { key: 'normal', label: 'Normal' },
  { key: 'pesado', label: 'Pesado' },
  { key: 'limite', label: 'Al limite' }
];

// Zonas de molestia y a que grupos musculares se asocian (para sugerencias).
const DISCOMFORT_ZONES = ['Rodilla', 'Hombro', 'Muñeca', 'Espalda', 'Codo', 'Otra'];
const ZONE_MUSCLES = {
  'Rodilla': ['Piernas'],
  'Hombro': ['Empuje', 'Tiron'],
  'Muñeca': ['Empuje'],
  'Espalda': ['Core', 'Tiron'],
  'Codo': ['Empuje', 'Tiron']
};

const LEVEL_DIFFICULTY = { principiante: 1, intermedio: 3, avanzado: 5 };

/* ---------- Ejercicios base ---------- */
const BASE_EXERCISES = [
  { id: 'pushups',           name: 'Lagartijas / Push ups',  muscle: 'Empuje',    type: 'reps', level: 'principiante', difficulty: 2, description: 'Flexiones de brazos en el piso. Cuerpo recto, codos a ~45°.' },
  { id: 'pullups',           name: 'Pull ups / Dominadas',   muscle: 'Tiron',     type: 'reps', level: 'avanzado',     difficulty: 4, description: 'Traccion en barra con agarre prono (palmas al frente).' },
  { id: 'chinups',           name: 'Chin ups',               muscle: 'Tiron',     type: 'reps', level: 'intermedio',   difficulty: 3, description: 'Traccion en barra con agarre supino (palmas hacia vos).' },
  { id: 'dips',              name: 'Dips / Fondos',          muscle: 'Empuje',    type: 'reps', level: 'intermedio',   difficulty: 3, description: 'Fondos en paralelas o entre dos apoyos. Baja controlado.' },
  { id: 'squats',            name: 'Sentadillas',            muscle: 'Piernas',   type: 'reps', level: 'principiante', difficulty: 2, description: 'Sentadilla con peso corporal. Rodillas siguiendo la punta del pie.' },
  { id: 'lunges',            name: 'Zancadas',               muscle: 'Piernas',   type: 'reps', level: 'principiante', difficulty: 2, description: 'Estocadas alternando piernas. Rodilla trasera cerca del piso.' },
  { id: 'plank',             name: 'Plancha',                muscle: 'Core',      type: 'time', level: 'principiante', difficulty: 2, description: 'Isometrico en antebrazos. Abdomen y gluteos firmes, cadera neutra.' },
  { id: 'hollow',            name: 'Hollow hold',            muscle: 'Core',      type: 'time', level: 'intermedio',   difficulty: 3, description: 'Boca arriba, lumbar pegada al piso, hombros y piernas elevados.' },
  { id: 'mountain-climbers', name: 'Mountain climbers',      muscle: 'Cardio',    type: 'both', level: 'principiante', difficulty: 2, description: 'En plancha alta, llevar rodillas al pecho alternando rapido.' },
  { id: 'burpees',           name: 'Burpees',                muscle: 'Full body', type: 'reps', level: 'intermedio',   difficulty: 3, description: 'Sentadilla + plancha + flexion + salto. Movimiento completo.' },
  { id: 'leg-raises',        name: 'Elevaciones de piernas', muscle: 'Core',      type: 'reps', level: 'principiante', difficulty: 2, description: 'Boca arriba, subir piernas rectas sin despegar la lumbar.' },
  { id: 'inverted-row',      name: 'Remo invertido',         muscle: 'Tiron',     type: 'reps', level: 'principiante', difficulty: 2, description: 'Traccion horizontal bajo una barra baja o mesa firme.' },
  { id: 'pike-pushups',      name: 'Pike push ups',          muscle: 'Empuje',    type: 'reps', level: 'intermedio',   difficulty: 3, description: 'Flexion en V invertida, empuja la cabeza hacia el piso (hombros).' },
  { id: 'wall-sit',          name: 'Wall sit',               muscle: 'Piernas',   type: 'time', level: 'principiante', difficulty: 1, description: 'Sentadilla isometrica contra la pared, muslos paralelos al piso.', lowImpact: true },
  // --- bajo impacto / soporte (apto rodilla/espalda, calentamiento) ---
  { id: 'glute-bridge',      name: 'Puente de gluteos',      muscle: 'Piernas',   type: 'reps', level: 'principiante', difficulty: 1, description: 'Boca arriba, elevar la cadera apretando gluteos. Bajo impacto, apto rodilla.', lowImpact: true },
  { id: 'calf-raise',        name: 'Elevacion de gemelos',   muscle: 'Piernas',   type: 'reps', level: 'principiante', difficulty: 1, description: 'Elevar talones de pie. Bajo impacto.', lowImpact: true },
  { id: 'bird-dog',          name: 'Bird dog',               muscle: 'Core',      type: 'reps', level: 'principiante', difficulty: 1, description: 'Cuadrupedia: extender brazo y pierna opuestos. Cuida la espalda.', lowImpact: true },
  { id: 'superman',          name: 'Superman',               muscle: 'Core',      type: 'time', level: 'principiante', difficulty: 1, description: 'Boca abajo, elevar brazos y piernas. Cadena posterior, bajo impacto.', lowImpact: true },
  { id: 'jumping-jacks',     name: 'Jumping jacks / marcha', muscle: 'Cardio',    type: 'time', level: 'principiante', difficulty: 1, description: 'Saltos de tijera (o marcha en el lugar si querés bajo impacto).' }
];

/* ---------- Variantes / progresiones ---------- */
const VARIANT_EXERCISES = [
  { id: 'pushups-incline',        name: 'Lagartijas inclinadas',     baseId: 'pushups', muscle: 'Empuje', type: 'reps', level: 'principiante', difficulty: 1, description: 'Manos elevadas (banco/pared). Menos carga, ideal para empezar.' },
  { id: 'pushups-diamond',        name: 'Lagartijas diamante',       baseId: 'pushups', muscle: 'Empuje', type: 'reps', level: 'intermedio',   difficulty: 3, description: 'Manos juntas formando un diamante. Enfasis en triceps.' },
  { id: 'pushups-decline',        name: 'Lagartijas declinadas',     baseId: 'pushups', muscle: 'Empuje', type: 'reps', level: 'intermedio',   difficulty: 3, description: 'Pies elevados. Mas carga en porcion superior del pecho/hombros.' },
  { id: 'pushups-archer',         name: 'Archer push ups',           baseId: 'pushups', muscle: 'Empuje', type: 'reps', level: 'avanzado',     difficulty: 4, description: 'Carga sobre un brazo mientras el otro se extiende lateral.' },
  { id: 'pushups-pseudo-planche', name: 'Pseudo planche push ups',   baseId: 'pushups', muscle: 'Empuje', type: 'reps', level: 'avanzado',     difficulty: 5, description: 'Manos a la altura de la cadera, inclinado al frente. Hacia planche.' },
  { id: 'scapular-pulls',         name: 'Retraccion escapular (barra)', baseId: 'pullups', muscle: 'Tiron', type: 'reps', level: 'principiante', difficulty: 1, description: 'Colgado de la barra, juntar escapulas sin doblar codos. Base del tiron.' },
  { id: 'pullups-negative',       name: 'Dominadas negativas',       baseId: 'pullups', muscle: 'Tiron',  type: 'reps', level: 'principiante', difficulty: 2, description: 'Saltas arriba y bajas lento (excentrica). Progresion a la dominada.' },
  { id: 'pullups-wide',           name: 'Dominadas agarre ancho',    baseId: 'pullups', muscle: 'Tiron',  type: 'reps', level: 'avanzado',     difficulty: 5, description: 'Agarre mas ancho, mayor enfasis en dorsal.' },
  { id: 'pullups-archer',         name: 'Archer pull ups',           baseId: 'pullups', muscle: 'Tiron',  type: 'reps', level: 'avanzado',     difficulty: 6, description: 'Traccion cargando un brazo, el otro asiste extendido.' },
  { id: 'squats-bulgarian',       name: 'Bulgarian split squat',     baseId: 'squats',  muscle: 'Piernas',type: 'reps', level: 'intermedio',   difficulty: 3, description: 'Pie trasero elevado, trabajo unilateral de cuadriceps/gluteo.' },
  { id: 'squats-pistol-assisted', name: 'Pistol squat asistida',     baseId: 'squats',  muscle: 'Piernas',type: 'reps', level: 'intermedio',   difficulty: 4, description: 'Sentadilla a una pierna con apoyo/sosten. Progresion al pistol.' },
  { id: 'squats-pistol',          name: 'Pistol squat',              baseId: 'squats',  muscle: 'Piernas',type: 'reps', level: 'avanzado',     difficulty: 5, description: 'Sentadilla completa a una sola pierna sin apoyo.' },
  { id: 'glute-bridge-single',    name: 'Puente a una pierna',       baseId: 'glute-bridge', muscle: 'Piernas', type: 'reps', level: 'intermedio', difficulty: 3, description: 'Puente de gluteos apoyando una sola pierna. Bajo impacto.', lowImpact: true },
  { id: 'dips-bench',             name: 'Dips de banco',             baseId: 'dips',    muscle: 'Empuje', type: 'reps', level: 'principiante', difficulty: 1, description: 'Fondos con los pies en el piso y manos en un banco.' },
  { id: 'plank-knees',            name: 'Plancha de rodillas',       baseId: 'plank',   muscle: 'Core',   type: 'time', level: 'principiante', difficulty: 1, description: 'Plancha apoyando rodillas. Menos carga lumbar.', lowImpact: true },
  { id: 'plank-single-leg',       name: 'Plancha una pierna',        baseId: 'plank',   muscle: 'Core',   type: 'time', level: 'intermedio',   difficulty: 3, description: 'Plancha levantando una pierna, mas demanda de estabilidad.' }
];

const SEED_EXERCISES = BASE_EXERCISES.concat(VARIANT_EXERCISES).map((e, i) => ({
  id: e.id, name: e.name, muscle: e.muscle, type: e.type, level: e.level,
  description: e.description || '', baseId: e.baseId || null,
  difficulty: typeof e.difficulty === 'number' ? e.difficulty : (LEVEL_DIFFICULTY[e.level] || 3),
  active: true, favorite: false, custom: false, order: i, lowImpact: !!e.lowImpact
}));

const TYPE_BY_ID = SEED_EXERCISES.reduce((m, e) => { m[e.id] = e.type; return m; }, {});

// Alternativa de bajo impacto sugerida (por si hay molestia de rodilla, etc.).
const LOW_IMPACT_ALT = {
  'squats': 'glute-bridge', 'lunges': 'glute-bridge', 'squats-bulgarian': 'glute-bridge',
  'squats-pistol-assisted': 'wall-sit', 'squats-pistol': 'wall-sit', 'burpees': 'mountain-climbers'
};

/* ---------- Warm-up / cool-down (bloques de tiempo, no son ejercicios del catalogo) ---------- */
const WARMUP_BLOCK = [
  { name: 'Marcha / jumping jacks suave', timeSec: 40 },
  { name: 'Movilidad de muñecas', timeSec: 30 },
  { name: 'Circulos de hombros', timeSec: 30 },
  { name: 'Movilidad de cadera', timeSec: 30 },
  { name: 'Sentadillas suaves', timeSec: 30 },
  { name: 'Scapular push ups', timeSec: 30 },
  { name: 'Hollow hold suave', timeSec: 20 }
];
const COOLDOWN_BLOCK = [
  { name: 'Estiramiento de hombros', timeSec: 30 },
  { name: 'Estiramiento de pecho', timeSec: 30 },
  { name: 'Flexores de cadera', timeSec: 30 },
  { name: 'Estiramiento de isquios', timeSec: 30 },
  { name: 'Estiramiento de cuadriceps', timeSec: 30 },
  { name: 'Estiramiento de espalda (gato/niño)', timeSec: 30 },
  { name: 'Respiracion final', timeSec: 40 }
];

/* ---------- Plantillas rapidas (compat con el plan semanal existente) ---------- */
const I = (exerciseId, sets, reps, timeSec, restSetSec, restExerciseSec) =>
  ({ exerciseId, sets, reps, timeSec, restSetSec, restExerciseSec });

const QUICK_TEMPLATES = [
  { key: 'empuje',   name: 'Empuje rapido',   focus: 'Empuje',    items: [I('pushups',4,10,0,45,75), I('pike-pushups',3,8,0,45,75), I('dips',3,8,0,45,75), I('plank',3,0,30,30,0)] },
  { key: 'tiron',    name: 'Tiron rapido',    focus: 'Tiron',     items: [I('pullups',4,6,0,60,90), I('inverted-row',3,10,0,45,75), I('chinups',3,6,0,60,75), I('leg-raises',3,12,0,30,0)] },
  { key: 'piernas',  name: 'Piernas',         focus: 'Piernas',   items: [I('squats',4,15,0,45,75), I('lunges',3,12,0,45,75), I('wall-sit',3,0,40,40,75), I('squats-bulgarian',3,10,0,45,0)] },
  { key: 'core',     name: 'Core rapido',     focus: 'Core',      items: [I('plank',3,0,30,30,60), I('hollow',3,0,20,30,60), I('leg-raises',3,12,0,30,60), I('mountain-climbers',3,0,30,40,0)] },
  { key: 'fullbody', name: 'Full body',       focus: 'Full body', items: [I('burpees',3,10,0,50,80), I('squats',3,15,0,45,75), I('pushups',3,10,0,45,75), I('mountain-climbers',3,0,30,40,0)] },
  { key: 'movilidad',name: 'Movilidad / liviano', focus: 'Movilidad', items: [I('bird-dog',3,10,0,20,40), I('superman',3,0,20,20,40), I('glute-bridge',3,12,0,20,40), I('plank-knees',3,0,20,20,0)] }
];

const WEEKLY_TEMPLATE = [
  { day: 'Dia 1', focus: 'Empuje',                templateKey: 'empuje',   rest: false },
  { day: 'Dia 2', focus: 'Piernas + core',        templateKey: 'piernas',  rest: false },
  { day: 'Dia 3', focus: 'Tiron',                 templateKey: 'tiron',    rest: false },
  { day: 'Dia 4', focus: 'Movilidad / core liviano', templateKey: 'movilidad', rest: false },
  { day: 'Dia 5', focus: 'Full body',             templateKey: 'fullbody', rest: false },
  { day: 'Dia 6', focus: 'Descanso', rest: true },
  { day: 'Dia 7', focus: 'Descanso', rest: true }
];

/* ---------- Plantillas inteligentes (curadas) ---------- */
const T = (exerciseId, sets, reps, timeSec, restSetSec, restExerciseSec) =>
  ({ exerciseId, sets, reps, timeSec, restSetSec, restExerciseSec });

const SMART_TEMPLATES = [
  { id: 'tpl-fb-beg', name: 'Principiante full body', goal: 'Base de fuerza general', level: 'principiante', focus: 'Full body', kind: 'standard', warmup: true, cooldown: true,
    notes: 'Patrones basicos empuje/tiron/pierna/core. Tecnica antes que volumen.',
    items: [T('pushups-incline',3,8,0,60,75), T('squats',3,12,0,60,75), T('inverted-row',3,8,0,60,75), T('glute-bridge',3,12,0,45,75), T('plank',3,0,20,45,0)] },
  { id: 'tpl-push-basic', name: 'Empuje basico', goal: 'Pecho / hombros / triceps', level: 'principiante', focus: 'Empuje', kind: 'standard', warmup: true, cooldown: true,
    notes: 'Si las flexiones cuestan, empeza inclinadas; baja siempre controlado.',
    items: [T('pushups',4,8,0,75,90), T('pike-pushups',3,6,0,60,75), T('dips-bench',3,8,0,60,75), T('plank',3,0,30,45,0)] },
  { id: 'tpl-core-express', name: 'Core express', goal: 'Abdomen y estabilidad', level: 'intermedio', focus: 'Core', kind: 'standard', warmup: false, cooldown: true,
    notes: 'Circuito corto de ~12 min. Manten la lumbar neutra.',
    items: [T('hollow',3,0,20,30,45), T('plank',3,0,40,30,45), T('leg-raises',3,12,0,30,45), T('mountain-climbers',3,0,30,30,0)] },
  { id: 'tpl-legs-lowimpact', name: 'Piernas sin impacto', goal: 'Piernas cuidando la rodilla', level: 'principiante', focus: 'Piernas', kind: 'standard', warmup: true, cooldown: true,
    notes: 'Sin saltos. Ideal si molesta la rodilla: rango comodo y sin dolor.',
    items: [T('glute-bridge',3,15,0,45,75), T('wall-sit',3,0,40,45,75), T('calf-raise',3,20,0,30,75), T('bird-dog',3,10,0,30,0)] },
  { id: 'tpl-pull-basic', name: 'Tiron basico', goal: 'Espalda y biceps', level: 'principiante', focus: 'Tiron', kind: 'standard', warmup: true, cooldown: true,
    notes: 'Si no salen dominadas, usa negativas y remo invertido.',
    items: [T('scapular-pulls',3,10,0,45,75), T('inverted-row',4,10,0,60,75), T('pullups-negative',4,5,0,75,75), T('leg-raises',3,12,0,30,0)] },
  { id: 'tpl-emom-soft', name: 'EMOM suave', goal: 'Acondicionamiento liviano', level: 'principiante', focus: 'Full body', kind: 'emom', warmup: true, cooldown: true,
    notes: 'Cada minuto un ejercicio, descansa lo que sobre. Ritmo comodo.',
    emom: { totalMinutes: 10, items: [{ exerciseId: 'squats', reps: 12 }, { exerciseId: 'pushups-incline', reps: 8 }, { exerciseId: 'mountain-climbers', reps: 20 }] } },
  { id: 'tpl-emom-hard', name: 'EMOM intenso', goal: 'Condicion metabolica', level: 'avanzado', focus: 'Full body', kind: 'emom', warmup: true, cooldown: true,
    notes: 'Alta intensidad. Baja reps si no llegas a descansar dentro del minuto.',
    emom: { totalMinutes: 16, items: [{ exerciseId: 'burpees', reps: 10 }, { exerciseId: 'pullups', reps: 6 }, { exerciseId: 'pushups', reps: 12 }, { exerciseId: 'squats', reps: 15 }] } },
  { id: 'tpl-recovery', name: 'Recuperacion / movilidad', goal: 'Recuperar y movilizar', level: 'principiante', focus: 'Movilidad', kind: 'standard', warmup: false, cooldown: true,
    notes: 'Dia liviano. Movimientos suaves, sin llegar a la fatiga.',
    items: [T('bird-dog',2,10,0,20,40), T('superman',2,0,20,20,40), T('glute-bridge',2,12,0,20,40), T('plank-knees',2,0,20,20,40), T('hollow',2,0,15,20,0)] },
  { id: 'tpl-fb-int', name: 'Full body intermedio', goal: 'Cuerpo completo equilibrado', level: 'intermedio', focus: 'Full body', kind: 'standard', warmup: true, cooldown: true,
    notes: 'Empuje + tiron + pierna + core en una sola sesion.',
    items: [T('pushups',4,10,0,60,80), T('inverted-row',4,10,0,60,80), T('squats',4,12,0,60,80), T('hollow',3,0,25,40,0)] },
  { id: 'tpl-push-adv', name: 'Empuje avanzado', goal: 'Fuerza de empuje', level: 'avanzado', focus: 'Empuje', kind: 'standard', warmup: true, cooldown: true,
    notes: 'Progresiones duras. Baja a una variante mas facil si pierdes la tecnica.',
    items: [T('pushups-archer',4,6,0,90,90), T('dips',4,8,0,90,90), T('pike-pushups',3,8,0,75,75), T('pushups-diamond',3,10,0,60,0)] },
  { id: 'tpl-legs-strength', name: 'Piernas fuerza', goal: 'Fuerza de piernas', level: 'intermedio', focus: 'Piernas', kind: 'standard', warmup: true, cooldown: true,
    notes: 'Trabajo unilateral. Si molesta la rodilla, reduce rango o usa bajo impacto.',
    items: [T('squats',4,15,0,60,80), T('squats-bulgarian',3,10,0,75,80), T('lunges',3,12,0,60,80), T('calf-raise',3,20,0,40,0)] },
  { id: 'tpl-core-cardio', name: 'Core + cardio', goal: 'Abdomen y condicion', level: 'intermedio', focus: 'Core', kind: 'standard', warmup: true, cooldown: true,
    notes: 'Mezcla isometricos con trabajo dinamico para subir pulsaciones.',
    items: [T('mountain-climbers',4,0,30,30,45), T('hollow',3,0,25,30,45), T('leg-raises',3,14,0,30,45), T('plank',3,0,40,30,0)] },
  { id: 'tpl-pull-int', name: 'Tiron intermedio', goal: 'Espalda y biceps', level: 'intermedio', focus: 'Tiron', kind: 'standard', warmup: true, cooldown: true,
    notes: 'Si las dominadas salen, sumalas; si no, sostene remo y negativas.',
    items: [T('pullups',4,6,0,90,90), T('inverted-row',4,10,0,60,80), T('chinups',3,6,0,75,75), T('leg-raises',3,12,0,30,0)] },
  { id: 'tpl-mob-morning', name: 'Movilidad matutina', goal: 'Activar el cuerpo', level: 'principiante', focus: 'Movilidad', kind: 'standard', warmup: false, cooldown: true,
    notes: 'Rutina corta para empezar el dia. Suave y sin fatiga.',
    items: [T('jumping-jacks',2,0,30,20,30), T('glute-bridge',2,12,0,20,30), T('bird-dog',2,10,0,20,30), T('superman',2,0,20,20,0)] },
  { id: 'tpl-emom-mid', name: 'EMOM intermedio', goal: 'Acondicionamiento', level: 'intermedio', focus: 'Full body', kind: 'emom', warmup: true, cooldown: true,
    notes: 'Cada minuto un ejercicio (rota). Baja reps si no llegas a descansar.',
    emom: { totalMinutes: 12, items: [{ exerciseId: 'pushups', reps: 10 }, { exerciseId: 'squats', reps: 15 }, { exerciseId: 'mountain-climbers', reps: 24 }, { exerciseId: 'inverted-row', reps: 10 }] } }
];

/* ---------- Rutinas por grupo / foco (5 niveles c/u, generadas) ---------- */
const FOCUS_POOLS = {
  'Empuje':   ['pushups-incline', 'dips-bench', 'pushups', 'pike-pushups', 'pushups-diamond', 'pushups-decline', 'dips', 'pushups-archer', 'pushups-pseudo-planche'],
  'Tiron':    ['scapular-pulls', 'inverted-row', 'pullups-negative', 'chinups', 'pullups', 'pullups-wide', 'pullups-archer'],
  'Piernas':  ['glute-bridge', 'wall-sit', 'calf-raise', 'squats', 'lunges', 'squats-bulgarian', 'squats-pistol-assisted', 'squats-pistol'],
  'Core':     ['bird-dog', 'superman', 'plank-knees', 'plank', 'hollow', 'leg-raises', 'plank-single-leg'],
  'Full body':['squats', 'pushups-incline', 'mountain-climbers', 'pushups', 'lunges', 'burpees', 'pullups-negative', 'dips'],
  'Movilidad':['bird-dog', 'superman', 'glute-bridge', 'wall-sit', 'plank-knees', 'hollow']
};

const FIVE_LEVELS = ['principiante', 'principiante/intermedio', 'intermedio', 'intermedio/avanzado', 'avanzado'];

// Parametros por nivel (i: 0..4). Pensados para quedar <= ~35 min con 4 ejercicios.
const GROUP_PARAMS = [
  { sets: 3, reps: 8,  timeSec: 20, restSet: 60, restEx: 75, n: 3 },
  { sets: 3, reps: 10, timeSec: 25, restSet: 60, restEx: 75, n: 4 },
  { sets: 4, reps: 10, timeSec: 30, restSet: 75, restEx: 80, n: 4 },
  { sets: 4, reps: 12, timeSec: 35, restSet: 75, restEx: 85, n: 4 },
  { sets: 4, reps: 12, timeSec: 40, restSet: 90, restEx: 90, n: 4 }
];
// Movilidad: mas suave en todos los niveles.
const MOBILITY_PARAMS = { sets: 2, reps: 10, timeSec: 25, restSet: 30, restEx: 45, n: 4 };

// Estilos de entrenamiento: por cada nivel se generan estas variantes, dando
// muchas opciones distintas (volumen / descanso / cantidad de ejercicios).
const GROUP_STYLES = [
  { key: 'fuerza',      label: 'Fuerza',      adj: p => ({ sets: p.sets, reps: Math.max(5, p.reps - 2), timeSec: p.timeSec, restSet: p.restSet + 15, restEx: p.restEx + 10, n: Math.min(4, p.n) }) },
  { key: 'resistencia', label: 'Resistencia', adj: p => ({ sets: p.sets, reps: p.reps + 4, timeSec: p.timeSec + 10, restSet: Math.max(30, p.restSet - 15), restEx: Math.max(45, p.restEx - 15), n: p.n }) },
  { key: 'circuito',    label: 'Circuito',    adj: p => ({ sets: Math.max(2, p.sets - 1), reps: p.reps + 2, timeSec: p.timeSec + 5, restSet: 30, restEx: 45, n: p.n + 1 }) }
];

function buildGroupRoutines() {
  const out = [];
  FOCUS_LIST.forEach(focus => {
    const pool = FOCUS_POOLS[focus] || [];
    FIVE_LEVELS.forEach((level, i) => {
      const baseParams = focus === 'Movilidad' ? MOBILITY_PARAMS : GROUP_PARAMS[i];
      GROUP_STYLES.forEach((style, sIdx) => {
        const base = style.adj(baseParams);
        const n = Math.max(2, Math.min(base.n, pool.length));
        // Ventana corrida por nivel y por estilo => distintos ejercicios en cada variante.
        const start = Math.max(0, Math.min(pool.length - n, (i - 1) + sIdx));
        const ids = pool.slice(start, start + n);
        if (!ids.length) return;
        const items = ids.map(id => {
          const isTime = TYPE_BY_ID[id] === 'time';
          return T(id, base.sets, isTime ? 0 : base.reps, isTime ? base.timeSec : 0, base.restSet, base.restEx);
        });
        out.push({
          id: `tpl-grp-${focus.toLowerCase().replace(/[^a-z]/g, '')}-${i + 1}-${style.key}`,
          name: `${focus} · ${level} · ${style.label}`,
          goal: `${focus} ${style.label.toLowerCase()} (${level})`,
          level: i <= 1 ? 'principiante' : (i >= 3 ? 'avanzado' : 'intermedio'),
          levelLabel: level, style: style.key, styleLabel: style.label,
          focus, kind: 'standard',
          warmup: focus !== 'Movilidad', cooldown: true,
          notes: focus === 'Movilidad'
            ? 'Sesion suave de movilidad y recuperacion.'
            : `Estilo ${style.label.toLowerCase()}. Si un ejercicio cuesta, usa una variante mas facil; si molesta una articulacion, baja carga o usa la opcion de bajo impacto.`,
          items
        });
      });
    });
  });
  return out;
}

const GROUP_ROUTINES = buildGroupRoutines();
const GROUP_STYLE_OPTIONS = GROUP_STYLES.map(s => ({ key: s.key, label: s.label }));

// Biblioteca completa de plantillas (curadas + por grupo).
const TEMPLATE_LIBRARY = SMART_TEMPLATES.concat(GROUP_ROUTINES);

// Pools (por foco) para el generador de "entreno rapido" en el renderer.
// Ejercicios ordenados de mas facil a mas dificil dentro de cada foco.
const QUICK_FOCUS_POOLS = FOCUS_POOLS;

const REP_SECONDS = 3;
const MAX_SESSION_SEC = 40 * 60;
const QUICK_DURATIONS = [10, 20, 30, 40];

module.exports = {
  MUSCLE_GROUPS, LEVELS, TYPES, FOCUS_LIST,
  SESSION_KINDS, SESSION_STATUS, CONDITIONS, DISCOMFORT_ZONES, ZONE_MUSCLES,
  LEVEL_DIFFICULTY, SEED_EXERCISES, TYPE_BY_ID, LOW_IMPACT_ALT,
  WARMUP_BLOCK, COOLDOWN_BLOCK,
  QUICK_TEMPLATES, WEEKLY_TEMPLATE, SMART_TEMPLATES, GROUP_ROUTINES, TEMPLATE_LIBRARY, GROUP_STYLE_OPTIONS,
  QUICK_FOCUS_POOLS, QUICK_DURATIONS,
  REP_SECONDS, MAX_SESSION_SEC
};
