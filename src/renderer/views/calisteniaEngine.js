'use strict';

/**
 * Motor de ejecucion de rutinas (SIN DOM): expande una rutina computada en una
 * secuencia de pasos (ejercicios / descansos), expande un EMOM en minutos, y
 * ofrece un `Ticker` (cronometro con pausa/reanudar) que la vista usa como reloj
 * maestro. La logica de UI vive en calisteniaView.js; aca solo hay datos y tiempo.
 *
 * Se expone como window.__caliEngine (CSP: script-src 'self', sin modulos ES).
 */
(function () {

  /**
   * Cronometro acumulativo con pausa/reanudar. Cuenta milisegundos transcurridos
   * (hacia arriba) y dispara onTick(elapsedMs) ~cada `intervalMs`. La vista deriva
   * cuentas regresivas restando del total del paso actual; asi pausar afecta a
   * TODO (reloj total y paso actual) desde un solo lugar.
   */
  function Ticker(opts) {
    opts = opts || {};
    this.onTick = opts.onTick || function () {};
    this.intervalMs = opts.intervalMs || 200;
    this._accum = 0;          // ms acumulados antes de la pausa actual
    this._startedAt = 0;      // marca de la reanudacion en curso
    this._timer = null;
    this.running = false;
  }
  Ticker.prototype.elapsedMs = function () {
    return this._accum + (this.running ? (Date.now() - this._startedAt) : 0);
  };
  Ticker.prototype._fire = function () { this.onTick(this.elapsedMs()); };
  Ticker.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this._startedAt = Date.now();
    const self = this;
    this._timer = setInterval(function () { self._fire(); }, this.intervalMs);
    this._fire();
  };
  Ticker.prototype.pause = function () {
    if (!this.running) return;
    this._accum += Date.now() - this._startedAt;
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._fire();
  };
  Ticker.prototype.resume = function () { this.start(); };
  Ticker.prototype.toggle = function () { this.running ? this.pause() : this.resume(); };
  Ticker.prototype.stop = function () {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.running = false;
  };
  Ticker.prototype.reset = function () {
    this.stop();
    this._accum = 0;
    this._startedAt = 0;
  };
  // Precarga tiempo transcurrido (para reanudar una sesion interrumpida).
  Ticker.prototype.setElapsed = function (ms) {
    this._accum = Math.max(0, ms || 0);
    this._startedAt = Date.now();
  };

  /**
   * Expande una rutina estandar (computada, con exerciseName/exerciseType ya
   * resueltos) en una lista plana de pasos para la ejecucion guiada.
   *
   * Pasos:
   *  - { type:'exercise', exerciseName, mode:'time'|'reps', reps, timeSec,
   *      setIndex, setsTotal, muscle, itemIndex }
   *  - { type:'rest', durationSec, label, restKind:'set'|'exercise' }
   */
  function expandRoutine(routine) {
    const items = (routine && routine.items) || [];
    const steps = [];
    items.forEach(function (it, i) {
      const mode = it.timeSec > 0 ? 'time' : 'reps';
      const nextName = i < items.length - 1 ? items[i + 1].exerciseName : null;
      for (let s = 1; s <= it.sets; s++) {
        steps.push({
          type: 'exercise',
          itemIndex: i,
          exerciseName: it.exerciseName,
          muscle: it.muscle || '',
          mode: mode,
          reps: it.reps,
          timeSec: it.timeSec,
          setIndex: s,
          setsTotal: it.sets,
          nextName: nextName
        });
        const isLastSet = s === it.sets;
        if (!isLastSet && it.restSetSec > 0) {
          steps.push({ type: 'rest', durationSec: it.restSetSec, restKind: 'set', label: 'Descanso entre series', context: it.exerciseName });
        }
      }
      const isLastItem = i === items.length - 1;
      if (!isLastItem && it.restExerciseSec > 0) {
        steps.push({ type: 'rest', durationSec: it.restExerciseSec, restKind: 'exercise', label: 'Descanso', context: nextName });
      }
    });
    return steps;
  }

  /**
   * Expande un EMOM en minutos. Cada minuto tiene UN ejercicio asignado, rotando
   * por la lista de ejercicios del EMOM: minuto m -> items[(m-1) % N].
   * Devuelve [{ minute, exerciseName, reps, durationSec:60 }].
   */
  function expandEmom(routine) {
    const emom = routine && routine.emom;
    if (!emom || !emom.items || !emom.items.length) return [];
    const minutes = [];
    const N = emom.items.length;
    for (let m = 1; m <= emom.totalMinutes; m++) {
      const it = emom.items[(m - 1) % N];
      minutes.push({ minute: m, exerciseName: it.exerciseName, reps: it.reps, durationSec: 60 });
    }
    return minutes;
  }

  // Cantidad de "pasos de ejercicio" (para contar progreso/ejercicios completados).
  function countExerciseSteps(steps) {
    return steps.filter(function (s) { return s.type === 'exercise'; }).length;
  }

  // Mezcla y elige `count` minutos de un pool de ejercicios para un EMOM random.
  // pool: [{ exerciseId, exerciseName, reps }]. Repite si el pool es chico.
  function buildRandomEmom(pool, totalMinutes, rand) {
    rand = rand || Math.random;
    const minutes = [];
    if (!pool || !pool.length) return minutes;
    for (let m = 1; m <= totalMinutes; m++) {
      const pick = pool[Math.floor(rand() * pool.length) % pool.length];
      minutes.push({ minute: m, exerciseId: pick.exerciseId, exerciseName: pick.exerciseName, reps: pick.reps, durationSec: 60 });
    }
    return minutes;
  }

  window.__caliEngine = {
    Ticker: Ticker,
    expandRoutine: expandRoutine,
    expandEmom: expandEmom,
    countExerciseSteps: countExerciseSteps,
    buildRandomEmom: buildRandomEmom
  };
})();
