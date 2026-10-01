'use strict';

/**
 * Vista "Entrenamiento / Calistenia". IIFE autocontenida; habla con el backend
 * solo via window.api.calistenia, con el motor de tiempo via window.__caliEngine
 * y con el feedback sonoro via window.__caliSound.
 *
 * Pantallas (`.cali-screen`) dentro de la misma seccion: home, editor, exercises
 * (gestion), emomRandom, free, runner, emom, history, calendar, stats. Carga
 * lazy: pega al backend solo la primera vez que se entra a la seccion.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const engine = window.__caliEngine;
  const sound = window.__caliSound || { unlock(){}, tick(){}, bell(){}, beep(){}, setEnabled(){}, isEnabled(){ return false; } };

  const $loading = $('cali-loading');
  const $status  = $('cali-status');
  const $screens = Array.from(document.querySelectorAll('#view-calistenia .cali-screen'));
  if (!$screens.length || !engine) return;

  const ACTIVE_KEY = 'devlauncher.cali.active';

  /* ---------- Estado ---------- */
  let state = null;
  let byId = {};            // ejercicios por id
  let loaded = false, loading = false;

  /* ---------- Helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtClock(ms) {
    const t = Math.max(0, Math.round(ms / 1000));
    return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
  }
  const fmtSecs = (s) => fmtClock((Number(s) || 0) * 1000);
  const fmtMin = (s) => Math.round((Number(s) || 0) / 60) + ' min';
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('es-UY', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return isNaN(d) ? '' : d.toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
  }
  function isoDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function setStatus(kind, msg) {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
    if (kind === 'success') setTimeout(() => { $status.className = 'status'; $status.textContent = ''; }, 1800);
  }
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  function showScreen(name) {
    $screens.forEach(s => s.classList.toggle('hidden', s.dataset.screen !== name));
  }

  function setSeconds(it) {
    const rs = state ? state.meta.repSeconds : 3;
    return it.timeSec > 0 ? it.timeSec : it.reps * rs;
  }
  function standardDuration(items) {
    let total = 0;
    items.forEach((it, idx) => {
      total += it.sets * setSeconds(it) + it.restSetSec * Math.max(0, it.sets - 1);
      if (idx < items.length - 1) total += it.restExerciseSec;
    });
    return total;
  }

  /* ---------- Opciones de selects ---------- */
  function exerciseOptions(selectedId, onlyActive) {
    const list = (state.exercises || []).filter(e => !onlyActive || e.active);
    return list.map(e => `<option value="${esc(e.id)}"${e.id === selectedId ? ' selected' : ''}>${esc(e.name)} · ${esc(e.muscle)}${e.active ? '' : ' (inactivo)'}</option>`).join('');
  }
  function fillSelect(el, html, keep) {
    if (!el) return;
    const v = keep ? el.value : null;
    el.innerHTML = html;
    if (v != null) el.value = v;
  }

  /* ====================================================================== */
  /*  CARGA                                                                  */
  /* ====================================================================== */

  function applyState(s) {
    state = s;
    byId = {};
    (s.exercises || []).forEach(e => { byId[e.id] = e; });
  }

  function initStaticSelects() {
    const m = state.meta;
    const muscleOpts = m.muscleGroups.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    const levelOpts = m.levels.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    const typeOpts = '<option value="reps">Repeticiones</option><option value="time">Tiempo</option><option value="both">Mixto</option>';
    // filtros gestion
    fillSelect($('cali-exf-muscle'), '<option value="">Todos</option>' + muscleOpts, true);
    fillSelect($('cali-exf-level'), '<option value="">Todas</option>' + levelOpts, true);
    fillSelect($('cali-exf-type'), '<option value="">Todos</option>' + typeOpts, true);
    // modal ejercicio
    fillSelect($('cali-exm-muscle'), muscleOpts);
    fillSelect($('cali-exm-level'), levelOpts);
    // emom random
    fillSelect($('cali-er-level'), '<option value="">Cualquiera</option>' + levelOpts, true);
    fillSelect($('cali-er-muscle'), '<option value="">Cualquiera</option>' + muscleOpts, true);
    // plantillas
    fillSelect($('cali-tpl-select'), '<option value="">Crear desde plantilla...</option>' +
      (m.templates || []).map(t => `<option value="${esc(t.key)}">${esc(t.name)} (${esc(t.focus)})</option>`).join(''));
  }

  function refreshDynamicSelects() {
    // selects que dependen de ejercicios activos
    fillSelect($('cali-ed-ex-select'), exerciseOptions(null, true), true);
    fillSelect($('cali-ed-emom-select'), exerciseOptions(null, true), true);
    fillSelect($('cali-free-ex'), exerciseOptions(null, true), true);
    // base del editor de ejercicio (solo bases activos/inactivos, excluye variantes)
    const bases = (state.exercises || []).filter(e => !e.baseId);
    fillSelect($('cali-exm-base'), '<option value="">— Es un ejercicio base —</option>' +
      bases.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join(''));
  }

  async function ensureLoaded() {
    if (loaded || loading) return;
    loading = true; clearStatus();
    if ($loading) $loading.classList.remove('hidden');
    try {
      const r = await window.api.calistenia.get();
      if (!r.ok) throw new Error(r.error);
      applyState(r.data);
      loaded = true;
      initStaticSelects();
      refreshDynamicSelects();
      updateSoundButtons();
      renderHome();
    } catch (e) {
      setStatus('error', 'No se pudo cargar: ' + e.message);
    } finally {
      loading = false;
      if ($loading) $loading.classList.add('hidden');
    }
  }

  function commit(result) {
    if (result && result.state) { applyState(result.state); refreshDynamicSelects(); renderHome(); }
  }
  function applyResult(result) {
    if (result && result.state) { applyState(result.state); refreshDynamicSelects(); }
  }

  /* ====================================================================== */
  /*  HOME                                                                   */
  /* ====================================================================== */

  /* ----- helpers de UI: tiempo relativo, charts, objetivo ----- */
  const GOAL_KEY = 'devlauncher.cali.goal';
  function getGoal() { const v = parseInt((localStorage.getItem(GOAL_KEY) || '4'), 10); return v > 0 ? v : 4; }
  function setGoal(v) { try { localStorage.setItem(GOAL_KEY, String(v > 0 ? v : 4)); } catch (_) {} }

  function timeAgo(ts) {
    if (!ts) return 'nunca';
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return 'hoy';
    if (days === 1) return 'ayer';
    if (days < 7) return `hace ${days} dias`;
    if (days < 30) return `hace ${Math.floor(days / 7)} sem`;
    return `hace ${Math.floor(days / 30)} meses`;
  }

  function barsChart(days) {
    const max = Math.max(1, ...days.map(d => d.minutes || 0));
    return days.map(d => {
      const h = d.minutes ? Math.max(8, Math.round((d.minutes / max) * 100)) : 0;
      return `<div class="cali-bar${d.isToday ? ' cali-bar-today' : ''}">
        <span class="cali-bar-val">${d.minutes || ''}</span>
        <div class="cali-bar-track"><div class="cali-bar-fill" style="height:${h}%"></div></div>
        <span class="cali-bar-lbl">${esc(d.label)}</span></div>`;
    }).join('');
  }

  function donut(value, goal) {
    const pct = goal > 0 ? Math.min(100, Math.round((value / goal) * 100)) : 0;
    const r = 50, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    return `<svg viewBox="0 0 120 120" class="cali-donut">
      <circle cx="60" cy="60" r="${r}" class="cali-donut-bg"/>
      <circle cx="60" cy="60" r="${r}" class="cali-donut-fg" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 60 60)"/>
      <text x="60" y="56" class="cali-donut-pct">${pct}%</text>
      <text x="60" y="78" class="cali-donut-sub">${value}/${goal} sem</text>
    </svg>`;
  }

  function renderHome() {
    if (!state) return;
    const st = state.stats || {};
    $('cali-kpi-days').textContent = st.daysTrainedThisWeek || 0;
    $('cali-kpi-minutes').textContent = st.minutesThisWeek || 0;
    $('cali-kpi-streak').textContent = st.streak || 0;
    $('cali-kpi-completed').textContent = st.completedTotal || 0;
    $('cali-mostdone').innerHTML = st.mostDoneExercise
      ? `&#x1F3C6; Ejercicio mas realizado: <strong>${esc(st.mostDoneExercise)}</strong> (${st.mostDoneCount}×)`
      : '';
    $('cali-chart-week').innerHTML = barsChart(state.weekDays || []);
    const goal = getGoal();
    $('cali-goal-input').value = goal;
    $('cali-chart-goal').innerHTML = donut(st.sessionsThisWeek || 0, goal);
    renderHero();
    renderSuggestions();
    renderWeekCard();
    renderRoutines();
  }

  function routineOptionsHtml(selectedId) {
    return (state.routines || []).map(r =>
      `<option value="${esc(r.id)}"${r.id === selectedId ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
  }

  function renderWeekCard() {
    const card = $('cali-week-card');
    const plan = state.weeklyPlan;
    if (!plan) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    $('cali-week-days').innerHTML = (plan.days || []).map((d, i) => {
      const tag = d.rest
        ? '<span class="cali-week-rest">Descanso / liviano</span>'
        : (d.routineId
            ? `<span class="cali-week-rname">${esc(d.routineName)}</span> <span class="badge">${d.estimatedMin} min</span>`
            : '<span class="cali-week-rest">Sin rutina</span>');
      const actions = d.routineId
        ? `<button class="btn mini primary" data-week-run="${esc(d.routineId)}">Ejecutar</button>
           <button class="btn mini" data-week-edit="${esc(d.routineId)}">Editar</button>` : '';
      return `<div class="cali-week-day">
        <div class="cali-week-day-head"><strong>${esc(d.day)}</strong><span class="cali-week-focus">${esc(d.focus)}</span></div>
        <div class="cali-week-day-body">${tag}</div>
        <div class="cali-week-day-foot">
          <select class="cali-week-assign" data-day-index="${i}">
            <option value="">— Descanso —</option>${routineOptionsHtml(d.routineId)}
          </select>${actions}
        </div></div>`;
    }).join('');
  }

  function renderRoutines() {
    const cont = $('cali-routines'), empty = $('cali-routines-empty');
    const routines = state.routines || [];
    if (!routines.length) { cont.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    cont.innerHTML = routines.map(r => {
      const kindBadge = r.kind === 'emom'
        ? '<span class="cali-tag cali-tag-emom">EMOM</span>'
        : '<span class="cali-tag cali-tag-series">Series</span>';
      const focusBadge = r.focus ? `<span class="cali-tag cali-tag-focus">${esc(r.focus)}</span>` : '';
      const warn = r.over40 ? '<span class="cali-warn-pill" title="Supera los 40 minutos">&#x26A0; +40 min</span>' : '';
      const gen = r.weeklyGenerated ? '<span class="cali-gen-tag">plan semanal</span>' : '';
      const star = r.favorite ? '★' : '☆';
      const durTxt = r.kind === 'emom' ? `${r.emom.totalMinutes} min` : `~${r.estimatedMin} min`;
      const compTxt = r.completion != null
        ? `<span class="cali-rc-pct" title="${r.completedTimes}/${r.timesDone} completadas">${r.completion}% cumpl.</span>`
        : '<span class="cali-rc-pct cali-rc-pct-new">sin uso</span>';
      return `<div class="cali-routine-card${r.favorite ? ' cali-fav' : ''}">
        <div class="cali-routine-head">
          <h4 title="${esc(r.name)}">${esc(r.name)}</h4>
          <button class="cali-star" data-r-fav="${esc(r.id)}" title="Favorito">${star}</button>
        </div>
        <div class="cali-routine-badges">${kindBadge}${focusBadge}${warn}${gen}</div>
        <div class="cali-routine-stats">
          <span title="Duracion estimada">&#x23F1; ${durTxt}</span>
          <span title="Ejercicios">&#x1F4AA; ${r.exerciseCount}</span>
          <span title="Ultima vez">&#x1F553; ${timeAgo(r.lastDoneAt)}</span>
        </div>
        <div class="cali-routine-foot">${compTxt}</div>
        <div class="cali-routine-actions">
          <button class="btn primary" data-r-run="${esc(r.id)}" title="Iniciar">&#x25B6; Iniciar</button>
          <button class="cali-iconbtn" data-r-edit="${esc(r.id)}" title="Editar">&#x270E;</button>
          <button class="cali-iconbtn" data-r-dup="${esc(r.id)}" title="Duplicar">&#x29C9;</button>
          <button class="cali-iconbtn cali-iconbtn-danger" data-r-del="${esc(r.id)}" title="Eliminar">&#x1F5D1;</button>
        </div></div>`;
    }).join('');
  }

  const findRoutine = (id) => (state.routines || []).find(r => r.id === id);

  // Delegacion home (rutinas + plan semanal)
  $('view-calistenia').addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-r-run],[data-r-edit],[data-r-dup],[data-r-del],[data-r-fav],[data-week-run],[data-week-edit]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.rRun || ds.weekRun) return startRoutine(findRoutine(ds.rRun || ds.weekRun));
    if (ds.rEdit || ds.weekEdit) return openEditor(findRoutine(ds.rEdit || ds.weekEdit));
    if (ds.rFav) { const r = await window.api.calistenia.toggleRoutineFavorite(ds.rFav); if (!r.ok) return setStatus('error', r.error); commit(r.data); }
    if (ds.rDup) { const r = await window.api.calistenia.duplicateRoutine(ds.rDup); if (!r.ok) return setStatus('error', r.error); commit(r.data); setStatus('success', 'Rutina duplicada.'); }
    if (ds.rDel) {
      const r0 = findRoutine(ds.rDel);
      if (r0 && !window.confirm(`¿Eliminar la rutina "${r0.name}"?`)) return;
      const r = await window.api.calistenia.removeRoutine(ds.rDel);
      if (!r.ok) return setStatus('error', r.error);
      commit(r.data); setStatus('success', 'Rutina eliminada.');
    }
  });

  $('view-calistenia').addEventListener('change', async (ev) => {
    const sel = ev.target.closest('.cali-week-assign');
    if (!sel) return;
    const r = await window.api.calistenia.setWeeklyPlanDay(parseInt(sel.dataset.dayIndex, 10), sel.value || null);
    if (!r.ok) return setStatus('error', r.error);
    commit(r.data);
  });

  // Dashboard de accesos (tiles) + acciones
  $('cali-new').addEventListener('click', () => openEditor(null));
  function scrollToRoutines() { const el = $('cali-routines'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  function goTile(go) {
    switch (go) {
      case 'rutina': scrollToRoutines(); break;
      case 'emom': openEmomRandom(); break;
      case 'free': openFree(); break;
      case 'videos': openVideos(); break;
      case 'new': openEditor(null); break;
      case 'quick': openQuick(); break;
      case 'templates': openTemplates(); break;
      case 'exercises': renderExercises(); showScreen('exercises'); break;
      case 'history': renderHistory(); showScreen('history'); break;
      case 'calendar': openCalendar(); break;
      case 'stats': renderStats(); showScreen('stats'); break;
    }
  }
  document.querySelectorAll('.cali-dash .cali-tile').forEach(t => t.addEventListener('click', () => goTile(t.dataset.go)));

  // Boton de sonido con icono (delegacion global)
  function updateSoundButtons() {
    const on = sound.isEnabled();
    document.querySelectorAll('[data-sound-toggle]').forEach(b => {
      b.textContent = on ? '🔊' : '🔇';
      b.classList.toggle('cali-sound-off', !on);
      b.title = on ? 'Sonido activado (tocar para silenciar)' : 'Sonido silenciado (tocar para activar)';
    });
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sound-toggle]');
    if (!b) return;
    sound.setEnabled(!sound.isEnabled());
    if (sound.isEnabled()) sound.unlock();
    updateSoundButtons();
  });

  // Objetivo semanal (home)
  $('cali-goal-input').addEventListener('input', (e) => { setGoal(parseInt(e.target.value, 10) || 4); renderHome(); });

  // Hero "En progreso"
  $('cali-hero').addEventListener('click', (ev) => {
    const t = ev.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-hero-resume')) { const s = activeSnapshot(); if (s) (s.mode === 'emom' ? resumeEmom(s) : resumeRoutine(s)); }
    else if (t.hasAttribute('data-hero-discard')) { clearActive(); renderHero(); }
    else if (t.hasAttribute('data-hero-emom')) openEmomRandom();
    else if (t.hasAttribute('data-go')) goTile(t.dataset.go);
  });

  $('cali-tpl-select').addEventListener('change', async (ev) => {
    const key = ev.target.value;
    if (!key) return;
    ev.target.value = '';
    const r = await window.api.calistenia.createFromTemplate(key);
    if (!r.ok) return setStatus('error', r.error);
    commit(r.data); setStatus('success', 'Rutina creada desde plantilla.');
  });

  $('cali-gen-week').addEventListener('click', async () => {
    if (state.weeklyPlan && !window.confirm('Ya existe un plan semanal. Regenerarlo reemplaza las rutinas generadas automaticamente. ¿Continuar?')) return;
    const r = await window.api.calistenia.generateWeeklyPlan();
    if (!r.ok) return setStatus('error', r.error);
    commit(r.data); setStatus('success', 'Plan semanal generado.');
  });
  $('cali-week-regen').addEventListener('click', () => $('cali-gen-week').click());
  $('cali-week-del').addEventListener('click', async () => {
    if (!window.confirm('¿Quitar el plan semanal?')) return;
    const r = await window.api.calistenia.removeWeeklyPlan();
    if (!r.ok) return setStatus('error', r.error);
    commit(r.data); setStatus('success', 'Plan quitado.');
  });

  /* ====================================================================== */
  /*  GESTION DE EJERCICIOS                                                  */
  /* ====================================================================== */

  const exFilters = { muscle: '', level: '', type: '', search: '', fav: false, inactive: false, sort: 'default' };

  function exRowHtml(e, canReorder, isFirst, isLast) {
    const typeLabel = e.type === 'reps' ? 'Reps' : e.type === 'time' ? 'Tiempo' : 'Mixto';
    const fav = e.favorite ? '★' : '☆';
    const inactiveCls = e.active ? '' : ' cali-ex-inactive';
    const reorder = canReorder
      ? `<button class="cali-iconbtn" data-ex-up="${esc(e.id)}" title="Menos dificil"${isFirst ? ' disabled' : ''}>▲</button>
         <button class="cali-iconbtn" data-ex-down="${esc(e.id)}" title="Mas dificil"${isLast ? ' disabled' : ''}>▼</button>` : '';
    return `<div class="cali-ex-row${inactiveCls}${e.baseId ? ' cali-ex-variant' : ''}">
      <div class="cali-ex-main">
        <span class="cali-ex-name">${esc(e.name)}${e.baseId ? ' <span class="cali-ex-vtag">variante</span>' : ''}${e.favorite ? ' <span class="cali-ex-favtag">★</span>' : ''}</span>
        <span class="cali-ex-meta">${esc(e.muscle)} · ${typeLabel} · <span class="cali-level cali-level-${esc(e.level)}">${esc(e.level)}</span> · dif ${e.difficulty} · usado ${timeAgo(e.lastUsedAt)}</span>
      </div>
      <div class="cali-ex-actions">
        <button class="cali-star" data-ex-fav="${esc(e.id)}" title="Favorito">${fav}</button>
        ${reorder}
        <button class="cali-iconbtn" data-ex-edit="${esc(e.id)}" title="Editar">&#x270E;</button>
        <button class="cali-iconbtn" data-ex-toggle="${esc(e.id)}" title="${e.active ? 'Desactivar' : 'Activar'}">${e.active ? '&#x1F441;' : '&#x1F576;'}</button>
        <button class="cali-iconbtn cali-iconbtn-danger" data-ex-del="${esc(e.id)}" title="Eliminar">&#x1F5D1;</button>
      </div></div>`;
  }

  function renderExercises() {
    let list = (state.exercises || []).filter(e => {
      if (exFilters.muscle && e.muscle !== exFilters.muscle) return false;
      if (exFilters.level && e.level !== exFilters.level) return false;
      if (exFilters.type && e.type !== exFilters.type) return false;
      if (exFilters.fav && !e.favorite) return false;
      if (!exFilters.inactive && !e.active) return false;
      if (exFilters.search && !e.name.toLowerCase().includes(exFilters.search.toLowerCase())) return false;
      return true;
    });
    const cont = $('cali-ex-list'), empty = $('cali-ex-empty');
    if (!list.length) { cont.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');

    if (exFilters.sort !== 'default') {
      // Lista plana ordenada (sin reordenar dificultad por familia).
      const cmp = {
        name: (a, b) => a.name.localeCompare(b.name),
        difficulty: (a, b) => a.difficulty - b.difficulty || a.name.localeCompare(b.name),
        muscle: (a, b) => a.muscle.localeCompare(b.muscle) || a.name.localeCompare(b.name),
        lastUsed: (a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || a.name.localeCompare(b.name)
      }[exFilters.sort];
      list = list.slice().sort(cmp);
      cont.innerHTML = `<div class="cali-ex-group">${list.map(e => exRowHtml(e, false)).join('')}</div>`;
      return;
    }

    // Por defecto: agrupar por familia (base + variantes), permite reordenar dificultad.
    const groups = [];
    const idx = {};
    list.forEach(e => {
      const root = e.familyRoot;
      if (idx[root] == null) { idx[root] = groups.length; groups.push({ root, items: [] }); }
      groups[idx[root]].items.push(e);
    });
    cont.innerHTML = groups.map(g => {
      const rows = g.items.map((e, i) => exRowHtml(e, true, i === 0, i === g.items.length - 1)).join('');
      const base = byId[g.root];
      const title = base ? base.name : g.items[0].name;
      return `<div class="cali-ex-group"><div class="cali-ex-group-title">${esc(title)}</div>${rows}</div>`;
    }).join('');
  }

  $('cali-ex-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-ex-new').addEventListener('click', () => openExerciseModal(null));
  $('cali-exf-muscle').addEventListener('change', e => { exFilters.muscle = e.target.value; renderExercises(); });
  $('cali-exf-level').addEventListener('change', e => { exFilters.level = e.target.value; renderExercises(); });
  $('cali-exf-type').addEventListener('change', e => { exFilters.type = e.target.value; renderExercises(); });
  $('cali-exf-sort').addEventListener('change', e => { exFilters.sort = e.target.value; renderExercises(); });
  $('cali-exf-search').addEventListener('input', e => { exFilters.search = e.target.value; renderExercises(); });
  $('cali-exf-fav').addEventListener('change', e => { exFilters.fav = e.target.checked; renderExercises(); });
  $('cali-exf-inactive').addEventListener('change', e => { exFilters.inactive = e.target.checked; renderExercises(); });

  $('cali-ex-list').addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-ex-fav],[data-ex-up],[data-ex-down],[data-ex-edit],[data-ex-toggle],[data-ex-del]');
    if (!t) return;
    const d = t.dataset;
    let r;
    if (d.exFav) r = await window.api.calistenia.toggleExerciseFavorite(d.exFav);
    else if (d.exUp) r = await window.api.calistenia.reorderExercise(d.exUp, 'up');
    else if (d.exDown) r = await window.api.calistenia.reorderExercise(d.exDown, 'down');
    else if (d.exToggle) { const e = byId[d.exToggle]; r = await window.api.calistenia.setExerciseActive(d.exToggle, !e.active); }
    else if (d.exEdit) return openExerciseModal(byId[d.exEdit]);
    else if (d.exDel) {
      const e = byId[d.exDel];
      if (e && !window.confirm(`¿Eliminar el ejercicio "${e.name}"? (Las rutinas que lo usen quedaran sin ese ejercicio)`)) return;
      r = await window.api.calistenia.removeExercise(d.exDel);
    }
    if (r && !r.ok) return setStatus('error', r.error);
    applyResult(r.data); renderExercises();
  });

  /* ----- Modal editor de ejercicio ----- */
  let exEditId = null;
  function openExerciseModal(ex) {
    exEditId = ex ? ex.id : null;
    $('cali-ex-modal-title').textContent = ex ? 'Editar ejercicio' : 'Nuevo ejercicio';
    $('cali-exm-name').value = ex ? ex.name : '';
    $('cali-exm-muscle').value = ex ? ex.muscle : state.meta.muscleGroups[0];
    $('cali-exm-type').value = ex ? ex.type : 'reps';
    $('cali-exm-level').value = ex ? ex.level : 'principiante';
    $('cali-exm-difficulty').value = ex ? ex.difficulty : 3;
    // base: excluir el propio ejercicio
    refreshDynamicSelects();
    if (ex && exEditId) {
      const opt = $('cali-exm-base').querySelector(`option[value="${CSS.escape(exEditId)}"]`);
      if (opt) opt.remove();
    }
    $('cali-exm-base').value = ex && ex.baseId ? ex.baseId : '';
    $('cali-exm-desc').value = ex ? ex.description : '';
    $('cali-exm-active').checked = ex ? ex.active : true;
    $('cali-ex-modal-status').className = 'status';
    $('cali-ex-modal').classList.remove('hidden');
  }
  function closeExerciseModal() { $('cali-ex-modal').classList.add('hidden'); }
  $('cali-ex-modal').addEventListener('click', (ev) => { if (ev.target.dataset && ev.target.dataset.caliExClose) closeExerciseModal(); });
  $('cali-exm-save').addEventListener('click', async () => {
    const st = $('cali-ex-modal-status');
    const payload = {
      id: exEditId,
      name: $('cali-exm-name').value.trim(),
      muscle: $('cali-exm-muscle').value,
      type: $('cali-exm-type').value,
      level: $('cali-exm-level').value,
      difficulty: parseInt($('cali-exm-difficulty').value, 10) || 3,
      baseId: $('cali-exm-base').value || null,
      description: $('cali-exm-desc').value.trim(),
      active: $('cali-exm-active').checked
    };
    if (!payload.name) { st.className = 'status show error'; st.textContent = 'El nombre es obligatorio.'; return; }
    const r = await window.api.calistenia.saveExercise(payload);
    if (!r.ok) { st.className = 'status show error'; st.textContent = r.error; return; }
    applyResult(r.data); closeExerciseModal(); renderExercises();
    setStatus('success', 'Ejercicio guardado.');
  });

  /* ====================================================================== */
  /*  EDITOR DE RUTINAS                                                      */
  /* ====================================================================== */

  let ed = null;
  function defaultItem(exId) {
    const ex = byId[exId];
    const isTime = ex && ex.type === 'time';
    return {
      exerciseId: exId, sets: 3, reps: isTime ? 0 : 10, timeSec: isTime ? 30 : 0,
      restSetSec: parseInt($('cali-ed-rest-set').value, 10) || 45,
      restExerciseSec: parseInt($('cali-ed-rest-ex').value, 10) || 75
    };
  }

  function openEditor(routine) {
    refreshDynamicSelects();
    if (routine) {
      ed = {
        id: routine.id, kind: routine.kind,
        items: (routine.items || []).map(it => ({ exerciseId: it.exerciseId, sets: it.sets, reps: it.reps, timeSec: it.timeSec, restSetSec: it.restSetSec, restExerciseSec: it.restExerciseSec })),
        emomItems: routine.kind === 'emom' ? (routine.emom.items || []).map(i => ({ exerciseId: i.exerciseId, reps: i.reps })) : [],
        emomMins: routine.kind === 'emom' ? routine.emom.totalMinutes : 10
      };
      $('cali-ed-title').textContent = 'Editar rutina';
      $('cali-ed-name').value = routine.name;
    } else {
      ed = { id: null, kind: 'standard', items: [], emomItems: [], emomMins: 10 };
      $('cali-ed-title').textContent = 'Nueva rutina';
      $('cali-ed-name').value = '';
    }
    $('cali-ed-emom-mins').value = ed.emomMins;
    setKind(ed.kind);
    $('cali-ed-status').className = 'status'; $('cali-ed-status').textContent = '';
    showScreen('editor');
  }

  function setKind(kind) {
    ed.kind = kind;
    document.querySelectorAll('.cali-kind-tab').forEach(b => b.classList.toggle('active', b.dataset.kind === kind));
    document.querySelectorAll('[data-kind-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.kindPanel !== kind));
    renderEditorItems();
  }
  document.querySelectorAll('.cali-kind-tab').forEach(b => b.addEventListener('click', () => setKind(b.dataset.kind)));

  function renderEditorItems() {
    if (ed.kind === 'emom') return renderEmomItems();
    const tbody = $('cali-ed-items');
    $('cali-ed-items-empty').classList.toggle('hidden', ed.items.length > 0);
    tbody.innerHTML = ed.items.map((it, i) => {
      const ex = byId[it.exerciseId] || { name: it.exerciseId };
      return `<tr data-i="${i}">
        <td><strong>${esc(ex.name)}</strong></td>
        <td><input type="number" min="1" value="${it.sets}" data-f="sets" /></td>
        <td><input type="number" min="0" value="${it.reps}" data-f="reps" /></td>
        <td><input type="number" min="0" value="${it.timeSec}" data-f="timeSec" /></td>
        <td><input type="number" min="0" value="${it.restSetSec}" data-f="restSetSec" /></td>
        <td><input type="number" min="0" value="${it.restExerciseSec}" data-f="restExerciseSec" /></td>
        <td><button class="btn mini danger" data-rm="${i}">✕</button></td></tr>`;
    }).join('');
    updateDuration();
  }
  function renderEmomItems() {
    const tbody = $('cali-ed-emom-items');
    $('cali-ed-emom-empty').classList.toggle('hidden', ed.emomItems.length > 0);
    tbody.innerHTML = ed.emomItems.map((it, i) => {
      const ex = byId[it.exerciseId] || { name: it.exerciseId };
      return `<tr data-i="${i}"><td><strong>${esc(ex.name)}</strong></td>
        <td><input type="number" min="1" value="${it.reps}" data-ef="reps" /></td>
        <td><button class="btn mini danger" data-emrm="${i}">✕</button></td></tr>`;
    }).join('');
    updateDuration();
  }
  function updateDuration() {
    const box = $('cali-ed-duration');
    const sec = ed.kind === 'emom' ? (parseInt($('cali-ed-emom-mins').value, 10) || 0) * 60 : standardDuration(ed.items);
    const over = sec > (state.meta.maxSessionSec || 2400);
    box.className = 'cali-duration' + (over ? ' cali-duration-over' : '');
    box.innerHTML = `Duracion estimada: <strong>${fmtMin(sec)}</strong> (${fmtSecs(sec)})` +
      (over ? ' &nbsp;&#x26A0; Supera los 40 minutos recomendados.' : '');
  }

  $('cali-ed-items').addEventListener('input', (ev) => {
    const inp = ev.target.closest('input[data-f]'); if (!inp) return;
    const i = parseInt(inp.closest('tr').dataset.i, 10);
    ed.items[i][inp.dataset.f] = Math.max(0, parseInt(inp.value, 10) || 0);
    updateDuration();
  });
  $('cali-ed-items').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-rm]'); if (!b) return;
    ed.items.splice(parseInt(b.dataset.rm, 10), 1); renderEditorItems();
  });
  $('cali-ed-emom-items').addEventListener('input', (ev) => {
    const inp = ev.target.closest('input[data-ef]'); if (!inp) return;
    ed.emomItems[parseInt(inp.closest('tr').dataset.i, 10)].reps = Math.max(1, parseInt(inp.value, 10) || 1);
  });
  $('cali-ed-emom-items').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-emrm]'); if (!b) return;
    ed.emomItems.splice(parseInt(b.dataset.emrm, 10), 1); renderEmomItems();
  });
  $('cali-ed-emom-mins').addEventListener('input', updateDuration);
  $('cali-ed-add-ex').addEventListener('click', () => { const id = $('cali-ed-ex-select').value; if (id) { ed.items.push(defaultItem(id)); renderEditorItems(); } });
  $('cali-ed-emom-add').addEventListener('click', () => { const id = $('cali-ed-emom-select').value; if (id) { ed.emomItems.push({ exerciseId: id, reps: 8 }); renderEmomItems(); } });
  $('cali-ed-rest-apply').addEventListener('click', () => {
    const rs = parseInt($('cali-ed-rest-set').value, 10) || 0;
    const re = parseInt($('cali-ed-rest-ex').value, 10) || 0;
    ed.items.forEach(it => { it.restSetSec = rs; it.restExerciseSec = re; });
    renderEditorItems();
  });
  $('cali-ed-cancel').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-ed-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-ed-save').addEventListener('click', async () => {
    const name = $('cali-ed-name').value.trim();
    const st = $('cali-ed-status');
    if (!name) { st.className = 'status show error'; st.textContent = 'Ponele un nombre a la rutina.'; return; }
    const payload = { id: ed.id, name, kind: ed.kind };
    if (ed.kind === 'emom') {
      if (!ed.emomItems.length) { st.className = 'status show error'; st.textContent = 'Agrega al menos un ejercicio por minuto.'; return; }
      payload.emom = { totalMinutes: parseInt($('cali-ed-emom-mins').value, 10) || 0, items: ed.emomItems };
    } else {
      if (!ed.items.length) { st.className = 'status show error'; st.textContent = 'Agrega al menos un ejercicio.'; return; }
      payload.items = ed.items;
    }
    const r = await window.api.calistenia.saveRoutine(payload);
    if (!r.ok) { st.className = 'status show error'; st.textContent = r.error; return; }
    commit(r.data); showScreen('home'); setStatus('success', 'Rutina guardada.');
  });

  /* ====================================================================== */
  /*  CUENTA REGRESIVA 3-2-1                                                 */
  /* ====================================================================== */

  function countdown(cb) {
    sound.unlock();
    const ov = $('cali-countdown'), num = $('cali-countdown-num');
    let n = 3;
    ov.classList.remove('hidden');
    num.textContent = n; sound.beep(false);
    const iv = setInterval(() => {
      n--;
      if (n > 0) { num.textContent = n; sound.beep(false); }
      else if (n === 0) { num.textContent = '¡YA!'; sound.beep(true); }
      else { clearInterval(iv); ov.classList.add('hidden'); cb(); }
    }, 1000);
  }

  /* ====================================================================== */
  /*  PERSISTENCIA DE SESION ACTIVA (reanudar)                              */
  /* ====================================================================== */

  function saveActive(snap) {
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(snap)); } catch (_) {}
  }
  function clearActive() {
    try { localStorage.removeItem(ACTIVE_KEY); } catch (_) {}
  }
  function readActive() {
    try { const v = localStorage.getItem(ACTIVE_KEY); return v ? JSON.parse(v) : null; } catch (_) { return null; }
  }
  // Devuelve la sesion activa si existe y no caduco (6h); si caduco la limpia.
  function activeSnapshot() {
    const snap = readActive();
    if (!snap || (Date.now() - (snap.savedAt || 0) > 6 * 3600 * 1000)) { if (snap) clearActive(); return null; }
    return snap;
  }

  // Resumen (ejercicio actual / proximo / %) de una sesion activa para el hero.
  function heroProgress(snap) {
    if (snap.mode === 'emom') {
      const a = snap.assigned || [];
      const cur = a.length ? a[(snap.idx || 0) % a.length] : null;
      const nx = a.length ? a[((snap.idx || 0) + 1) % a.length] : null;
      const minNo = (snap.idx || 0) + 1;
      const pct = snap.total ? Math.min(100, Math.round(((snap.idx || 0) / snap.total) * 100)) : null;
      return { current: cur ? cur.exerciseName : '—', next: nx ? nx.exerciseName : '—', pct, label: snap.total ? `Min ${minNo}/${snap.total}` : `Min ${minNo} · abierto` };
    }
    const routine = findRoutine(snap.routineId);
    if (!routine) return { current: '—', next: '—', pct: 0, label: '' };
    const steps = engine.expandRoutine(routine);
    const idx = Math.min(snap.idx || 0, Math.max(0, steps.length - 1));
    const step = steps[idx] || {};
    const exTotal = engine.countExerciseSteps(steps);
    const done = (snap.itemProgress || []).reduce((a, b) => a + b, 0);
    const pct = exTotal ? Math.min(100, Math.round((done / exTotal) * 100)) : 0;
    const cur = step.type === 'rest' ? 'Descanso' : (step.exerciseName || '—');
    let next = '—';
    for (let i = idx + 1; i < steps.length; i++) { if (steps[i].type === 'exercise') { next = steps[i].exerciseName; break; } }
    return { current: cur, next, pct, label: `${done}/${exTotal} series` };
  }

  function renderHero() {
    const hero = $('cali-hero');
    if (!hero) return;
    const snap = activeSnapshot();
    if (!snap) {
      hero.className = 'cali-hero cali-hero-empty';
      hero.innerHTML = `
        <div class="cali-hero-empty-body">
          <span class="cali-hero-ico">&#x1F4AA;</span>
          <div>
            <strong>Sin sesion activa</strong>
            <p class="vc-hint">Empeza una rutina o un EMOM y registra tu progreso.</p>
          </div>
        </div>
        <div class="cali-hero-actions">
          <button class="btn primary" data-go="rutina" type="button">&#x25B6; Iniciar rutina</button>
          <button class="btn" data-hero-emom type="button">&#x267E; EMOM</button>
        </div>`;
      return;
    }
    const p = heroProgress(snap);
    hero.className = 'cali-hero cali-hero-active';
    hero.innerHTML = `
      <div class="cali-hero-main">
        <span class="cali-hero-tag">&#x23F8; En progreso</span>
        <h3 class="cali-hero-name">${esc(snap.name)}</h3>
        <div class="cali-hero-meta"><span>&#x23F1; ${fmtClock(snap.elapsedMs || 0)}</span><span>${esc(p.label)}</span></div>
        <div class="cali-hero-now"><span class="vc-hint">Ahora</span> <strong>${esc(p.current)}</strong> &middot; <span class="vc-hint">sigue</span> ${esc(p.next)}</div>
        ${p.pct != null ? `<div class="cali-run-overall cali-hero-bar"><div class="cali-run-overall-fill" style="width:${p.pct}%"></div></div>` : ''}
      </div>
      <div class="cali-hero-actions">
        <button class="btn primary cali-big" data-hero-resume type="button">&#x25B6; Continuar</button>
        <button class="btn" data-hero-discard type="button">Descartar</button>
      </div>`;
  }

  /* ====================================================================== */
  /*  RUNNER (rutina por series)                                            */
  /* ====================================================================== */

  let run = null;

  const isMainStep = (s) => s.type === 'exercise' && (s.phase === undefined || s.phase === 'main');

  // Convierte un bloque {name,timeSec}[] en pasos de tiempo para el runner.
  function blockSteps(block, phase) {
    return (block || []).map((b, i) => ({
      type: 'exercise', mode: 'time', phase,
      exerciseName: b.name, muscle: '', timeSec: b.timeSec,
      setIndex: 1, setsTotal: 1, itemIndex: -1,
      nextName: i < block.length - 1 ? block[i + 1].name : null
    }));
  }
  function mainStepsOf(routine) {
    // Enriquece items con nombre/musculo (las rutinas efimeras de entreno rapido /
    // plantillas traen solo exerciseId) antes de expandir a pasos.
    const enriched = {
      ...routine,
      items: (routine.items || []).map(it => {
        const ex = byId[it.exerciseId] || {};
        return { ...it, exerciseName: ex.name || it.exerciseName || it.exerciseId, muscle: ex.muscle || it.muscle || '' };
      })
    };
    return engine.expandRoutine(enriched).map(s => ({ ...s, phase: 'main' }));
  }

  /* ---------- Orquestador de sesion (warm-up / principal / cool-down) ---------- */

  // routine: objeto rutina computada (con items / emom). meta de sesion en opts.
  function startSession(opts) {
    // opts: { routine, kind, name, routineId, warmupDefault, cooldownDefault }
    promptWarmup(opts.routine, (doW, doC) => launchSession(opts, doW, doC));
  }

  function launchSession(opts, doW, doC) {
    const routine = opts.routine;
    const warm = doW ? blockSteps(state.meta.warmupBlock, 'warmup') : [];
    const cool = doC ? blockSteps(state.meta.cooldownBlock, 'cooldown') : [];
    const blocks = { warmup: doW, cooldown: doC };
    sound.unlock();
    if (routine.kind === 'emom') return startEmomChain(opts, warm, cool, blocks);

    const main = mainStepsOf(routine);
    if (!main.length) return setStatus('error', 'La rutina no tiene pasos para ejecutar.');
    const steps = warm.concat(main, cool);
    showScreen('runner');
    countdown(() => beginRoutine(routine, steps, 0, [], Date.now(), 0, {
      mainTotal: main.filter(s => s.type === 'exercise').length,
      kind: opts.kind || 'standard', name: opts.name || routine.name,
      routineId: opts.routineId !== undefined ? opts.routineId : (routine.id || null),
      blocks
    }));
  }

  // EMOM: encadena calentamiento (bloque) -> EMOM -> estiramiento (bloque).
  function startEmomChain(opts, warm, cool, blocks) {
    const assigned = (opts.routine.emom.items || []).map(i => ({ exerciseId: i.exerciseId || null, exerciseName: i.exerciseName, reps: i.reps }));
    if (!assigned.length) return setStatus('error', 'El EMOM no tiene ejercicios para ejecutar.');
    const total = opts.routine.emom.totalMinutes || null;
    const chain = { startedAt: Date.now(), accSec: 0, blocks };

    const runMain = () => {
      showScreen('emom');
      countdown(() => beginEmom({ id: opts.routineId || null, name: opts.name, kind: opts.kind || 'emom' }, assigned, total, 0, Date.now(), 0, {
        blocks,
        onComplete: (res) => {
          chain.accSec += res.elapsedSec;
          const done = () => openFinish({
            routineId: opts.routineId || null, routineName: opts.name, kind: opts.kind || 'emom',
            plannedSec: total ? total * 60 : 0, actualSec: chain.accSec,
            startedAt: chain.startedAt, endedAt: Date.now(),
            exercisesCompleted: res.seriesDone, exercisesTotal: total || res.seriesDone,
            results: res.results, reachedEnd: res.reachedEnd, blocks,
            onClose: () => { emom = null; clearActive(); }
          });
          if (cool.length) runBlockThen(cool, 'Estiramiento', chain, done); else done();
        }
      }));
    };
    if (warm.length) runBlockThen(warm, 'Calentamiento', chain, runMain); else runMain();
  }

  // Corre un bloque (warm-up / cool-down) como mini-runner y sigue con `next`.
  function runBlockThen(steps, label, chain, next) {
    showScreen('runner');
    beginRoutine({ name: label, items: [] }, steps.map(s => ({ ...s, phase: 'main' })), 0, [], Date.now(), 0, {
      mainTotal: steps.length, kind: 'block', name: label, routineId: null, blockMode: true,
      onComplete: (res) => { chain.accSec += res.elapsedSec; next(); }
    });
  }

  function startRoutine(routine) {
    if (!routine) return;
    startSession({ routine, kind: routine.kind === 'emom' ? 'emom' : 'standard', name: routine.name, routineId: routine.id,
      warmupDefault: false, cooldownDefault: false });
  }

  function beginRoutine(routine, steps, idx, itemProgress, startedAt, presetElapsed, opts) {
    opts = opts || {};
    run = {
      routine, steps, idx,
      exerciseTotal: opts.mainTotal != null ? opts.mainTotal : engine.countExerciseSteps(steps),
      itemProgress: itemProgress.length ? itemProgress : (routine.items || []).map(() => 0),
      doneExercises: itemProgress.reduce((a, b) => a + b, 0),
      currentItem: 0, stepStartMs: presetElapsed, lastBeepSec: -1, startedAt,
      onComplete: opts.onComplete || null,
      blockMode: !!opts.blockMode,
      sessionKind: opts.kind || 'standard',
      sessionName: opts.name || routine.name,
      sessionRoutineId: opts.routineId !== undefined ? opts.routineId : (routine.id || null),
      blocks: opts.blocks || { warmup: false, cooldown: false },
      master: new engine.Ticker({ onTick: onRunTick })
    };
    if (presetElapsed) run.master.setElapsed(presetElapsed);
    $('cali-run-name').textContent = run.sessionName;
    $('cali-run-pause').textContent = 'Pausar';
    renderRunCards();
    showRunStep();
    run.master.start();
  }

  function resumeRoutine(snap) {
    const routine = findRoutine(snap.routineId);
    if (!routine) { clearActive(); return setStatus('error', 'La rutina de la sesion activa ya no existe.'); }
    const steps = engine.expandRoutine(routine);
    showScreen('runner');
    beginRoutine(routine, steps, Math.min(snap.idx || 0, steps.length - 1), snap.itemProgress || [], snap.startedAt || Date.now(), snap.elapsedMs || 0);
  }

  function persistRun() {
    // No persistir bloques (warm-up/cool-down) ni sesiones efimeras sin rutina guardada.
    if (!run || run.blockMode || !run.sessionRoutineId) return;
    saveActive({ mode: 'runner', routineId: run.sessionRoutineId, name: run.sessionName, idx: run.idx, itemProgress: run.itemProgress, elapsedMs: run.master.elapsedMs(), startedAt: run.startedAt, savedAt: Date.now() });
  }

  function renderRunCards() {
    const cont = $('cali-run-cards');
    cont.innerHTML = (run.routine.items || []).map((it, i) => {
      const ex = byId[it.exerciseId] || { name: it.exerciseId, type: 'reps' };
      const done = run.itemProgress[i] || 0;
      const pct = Math.min(100, Math.round((done / it.sets) * 100));
      const target = it.timeSec > 0 ? `${it.timeSec}s` : `${it.reps} reps`;
      const stateCls = done >= it.sets ? ' cali-rc-done' : (i === run.currentItem ? ' cali-rc-current' : '');
      const badge = done >= it.sets ? '<span class="cali-rc-check">✓</span>' : (i === run.currentItem ? '<span class="cali-rc-now">en curso</span>' : '<span class="cali-rc-pending">pendiente</span>');
      return `<div class="cali-run-card${stateCls}">
        <div class="cali-rc-head"><strong>${esc(ex.name)}</strong>${badge}</div>
        <div class="cali-rc-sub">${done}/${it.sets} series · ${esc(target)}</div>
        <div class="cali-rc-bar"><div class="cali-rc-fill" style="width:${pct}%"></div></div></div>`;
    }).join('');
  }

  function showRunStep() {
    const step = run.steps[run.idx];
    run.stepStartMs = run.master.elapsedMs();
    run.lastBeepSec = -1;
    if (isMainStep(step)) run.currentItem = step.itemIndex;
    const doneSoFar = run.steps.slice(0, run.idx).filter(isMainStep).length;
    $('cali-run-progress').textContent = `${Math.min(doneSoFar + (isMainStep(step) ? 1 : 0), run.exerciseTotal)} / ${run.exerciseTotal}`;
    const overallPct = run.exerciseTotal ? Math.round((run.doneExercises / run.exerciseTotal) * 100) : 0;
    $('cali-run-overall-fill').style.width = overallPct + '%';

    const stage = $('cali-run-stage');
    const isBlock = step.phase === 'warmup' || step.phase === 'cooldown';
    stage.classList.toggle('cali-stage-warm', isBlock);
    if (step.type === 'rest') {
      stage.classList.add('cali-stage-rest');
      $('cali-run-kind').textContent = step.label || 'Descanso';
      $('cali-run-exname').textContent = '⏸ Descanso';
      $('cali-run-set').textContent = '';
      $('cali-run-target').textContent = step.context ? 'Proximo: ' + step.context : '';
      $('cali-run-next').textContent = '';
      $('cali-run-done').classList.add('hidden');
    } else {
      stage.classList.remove('cali-stage-rest');
      const kindLabel = step.phase === 'warmup' ? '🤸 Calentamiento'
        : step.phase === 'cooldown' ? '🧘 Estiramiento'
        : 'Ejercicio' + (step.muscle ? ' · ' + step.muscle : '');
      $('cali-run-kind').textContent = kindLabel;
      $('cali-run-exname').textContent = step.exerciseName;
      $('cali-run-set').textContent = isBlock ? '' : `Serie ${step.setIndex} de ${step.setsTotal}`;
      if (step.mode === 'time') { $('cali-run-target').textContent = `Sostene ${step.timeSec}s`; $('cali-run-done').classList.add('hidden'); }
      else { $('cali-run-target').textContent = `${step.reps} repeticiones`; $('cali-run-done').classList.remove('hidden'); }
      $('cali-run-next').textContent = step.nextName ? 'Sigue: ' + step.nextName : 'Ultima estacion';
    }
    renderRunCards();
    persistRun();
  }

  function onRunTick(elapsedMs) {
    if (!run) return;
    $('cali-run-clock').textContent = fmtClock(elapsedMs);
    const step = run.steps[run.idx];
    const stepElapsed = elapsedMs - run.stepStartMs;
    if (step.type === 'rest' || step.mode === 'time') {
      const dur = (step.type === 'rest' ? step.durationSec : step.timeSec) * 1000;
      const remaining = dur - stepElapsed;
      $('cali-run-timer').textContent = fmtClock(remaining);
      const remSec = Math.ceil(remaining / 1000);
      if (remSec <= 3 && remSec >= 1 && remSec !== run.lastBeepSec) { run.lastBeepSec = remSec; sound.tick(); }
      if (remaining <= 0) { sound.bell(); advanceRun(true); }
    } else {
      $('cali-run-timer').textContent = fmtClock(stepElapsed);
    }
  }

  function advanceRun(countDone) {
    const step = run.steps[run.idx];
    if (countDone && isMainStep(step)) {
      run.doneExercises++;
      if (step.itemIndex >= 0) run.itemProgress[step.itemIndex] = (run.itemProgress[step.itemIndex] || 0) + 1;
    }
    run.idx++;
    if (run.idx >= run.steps.length) { finishRun(true); return; }
    showRunStep();
  }

  $('cali-run-done').addEventListener('click', () => advanceRun(true));
  $('cali-run-skip').addEventListener('click', () => advanceRun(false));
  $('cali-run-pause').addEventListener('click', () => { if (!run) return; run.master.toggle(); $('cali-run-pause').textContent = run.master.running ? 'Pausar' : 'Reanudar'; persistRun(); });
  $('cali-run-finish').addEventListener('click', () => finishRun(false));
  $('cali-run-exit').addEventListener('click', () => {
    if (!window.confirm('¿Salir sin registrar la sesion?')) return;
    if (run) run.master.stop();
    run = null; clearActive(); renderHome(); showScreen('home');
  });

  function buildRoutineResults() {
    return (run.routine.items || []).map((it, i) => {
      const ex = byId[it.exerciseId] || { name: it.exerciseId, type: 'reps' };
      const done = run.itemProgress[i] || 0;
      const completedAll = done >= it.sets;
      return {
        exerciseId: it.exerciseId, exerciseName: ex.name, type: ex.type,
        setsPlanned: it.sets, setsCompleted: done, reps: it.reps, timeSec: it.timeSec,
        bestReps: completedAll && it.reps ? it.reps : 0,
        bestTimeSec: completedAll && it.timeSec ? it.timeSec : 0
      };
    });
  }

  function finishRun(reachedEnd) {
    run.master.pause();
    const elapsedSec = Math.round(run.master.elapsedMs() / 1000);
    if (run.onComplete) {
      const cb = run.onComplete;
      const results = run.blockMode ? [] : buildRoutineResults();
      cb({ elapsedSec, results, reachedEnd });
      return;
    }
    openFinish({
      routineId: run.sessionRoutineId, routineName: run.sessionName, kind: run.sessionKind,
      plannedSec: run.routine.estimatedSec || 0, actualSec: elapsedSec,
      startedAt: run.startedAt, endedAt: Date.now(),
      exercisesCompleted: run.doneExercises, exercisesTotal: run.exerciseTotal,
      results: buildRoutineResults(), reachedEnd, blocks: run.blocks,
      onClose: () => { run = null; clearActive(); }
    });
  }

  /* ====================================================================== */
  /*  EMOM RUNNER (rutina EMOM + EMOM random)                               */
  /* ====================================================================== */

  // emom = { meta, assigned:[{exerciseId,exerciseName,reps}], total:number|null (null = abierto/infinito), idx, ... }
  let emom = null;
  const emomMinuteAt = (i) => emom.assigned[i % emom.assigned.length];

  // Rutina EMOM (finita): arma assigned + total desde la rutina computada.
  function startEmom(routine) {
    const items = (routine.emom && routine.emom.items) || [];
    if (!items.length) return setStatus('error', 'El EMOM no tiene ejercicios para ejecutar.');
    const assigned = items.map(i => ({ exerciseId: i.exerciseId || null, exerciseName: i.exerciseName, reps: i.reps }));
    sound.unlock();
    showScreen('emom');
    countdown(() => beginEmom({ id: routine.id, name: routine.name, kind: 'emom' }, assigned, routine.emom.totalMinutes, 0, Date.now(), 0));
  }

  function beginEmom(meta, assigned, total, idx, startedAt, presetElapsed, opts) {
    opts = opts || {};
    emom = { meta, assigned, total: total || null, idx, stepStartMs: presetElapsed, lastBeepSec: -1, startedAt,
      onComplete: opts.onComplete || null, blocks: opts.blocks || { warmup: false, cooldown: false },
      master: new engine.Ticker({ onTick: onEmomTick }) };
    if (presetElapsed) emom.master.setElapsed(presetElapsed);
    $('cali-emom-name').textContent = meta.name;
    $('cali-emom-pause').textContent = 'Pausar';
    showEmomStep();
    emom.master.start();
  }

  function resumeEmom(snap) {
    const assigned = snap.assigned;
    if (!assigned || !assigned.length) { clearActive(); return setStatus('error', 'La sesion EMOM activa ya no se puede reanudar.'); }
    showScreen('emom');
    const idx = snap.total ? Math.min(snap.idx || 0, snap.total - 1) : (snap.idx || 0);
    beginEmom({ id: snap.routineId || null, name: snap.name, kind: snap.kind || 'emom' }, assigned, snap.total || null, idx, snap.startedAt || Date.now(), snap.elapsedMs || 0);
  }

  function persistEmom() {
    if (!emom) return;
    saveActive({ mode: 'emom', routineId: emom.meta.id, kind: emom.meta.kind, name: emom.meta.name, assigned: emom.assigned, total: emom.total, idx: emom.idx, elapsedMs: emom.master.elapsedMs(), startedAt: emom.startedAt, savedAt: Date.now() });
  }

  function showEmomStep() {
    const m = emomMinuteAt(emom.idx);
    emom.stepStartMs = emom.master.elapsedMs();
    emom.lastBeepSec = -1;
    const minNo = emom.idx + 1;
    $('cali-emom-progress').textContent = emom.total ? `Min ${minNo} / ${emom.total}` : `Min ${minNo} · abierto`;
    $('cali-emom-minute').textContent = minNo;
    $('cali-emom-exname').textContent = m.exerciseName;
    $('cali-emom-reps').textContent = `${m.reps} repeticiones`;
    const next = emomMinuteAt(emom.idx + 1);
    $('cali-emom-next').textContent = next ? 'Proximo minuto: ' + next.exerciseName : '';
    persistEmom();
  }

  function onEmomTick(elapsedMs) {
    if (!emom) return;
    $('cali-emom-clock').textContent = fmtClock(elapsedMs);
    const remaining = 60000 - (elapsedMs - emom.stepStartMs);
    const remSec = Math.max(0, Math.ceil(remaining / 1000));
    $('cali-emom-timer').textContent = remSec;
    if (remSec <= 3 && remSec >= 1 && remSec !== emom.lastBeepSec) { emom.lastBeepSec = remSec; sound.tick(); }
    if (remaining <= 0) { sound.bell(); advanceEmom(); }
  }

  function advanceEmom() {
    emom.idx++;
    if (emom.total && emom.idx >= emom.total) { finishEmom(true); return; }
    showEmomStep();
  }

  $('cali-emom-skip').addEventListener('click', () => advanceEmom());
  $('cali-emom-pause').addEventListener('click', () => { if (!emom) return; emom.master.toggle(); $('cali-emom-pause').textContent = emom.master.running ? 'Pausar' : 'Reanudar'; persistEmom(); });
  $('cali-emom-finish').addEventListener('click', () => finishEmom(false));
  $('cali-emom-exit').addEventListener('click', () => {
    if (!window.confirm('¿Salir sin registrar la sesion?')) return;
    if (emom) emom.master.stop();
    emom = null; clearActive(); renderHome(); showScreen('home');
  });

  // Series hechas = minutos EMPEZADOS (el minuto en curso cuenta). Ej: parar en
  // 9:15 estando en el minuto 10 => 10 series. En finito, al terminar = total.
  function emomSeriesDone(reachedEnd) {
    const started = emom.idx + 1;
    return emom.total ? Math.min(reachedEnd ? emom.total : started, emom.total) : started;
  }

  function buildEmomResults(seriesDone) {
    const agg = {};
    for (let i = 0; i < seriesDone; i++) {
      const m = emomMinuteAt(i);
      const key = m.exerciseId || m.exerciseName;
      if (!agg[key]) agg[key] = { exerciseId: m.exerciseId || null, exerciseName: m.exerciseName, type: 'reps', setsPlanned: 0, setsCompleted: 0, reps: m.reps, bestReps: m.reps, timeSec: 0, bestTimeSec: 0 };
      agg[key].setsPlanned++; agg[key].setsCompleted++;
      if (m.reps > agg[key].bestReps) agg[key].bestReps = m.reps;
    }
    return Object.values(agg);
  }

  function finishEmom(reachedEnd) {
    emom.master.pause();
    const seriesDone = emomSeriesDone(reachedEnd);
    const elapsedSec = Math.round(emom.master.elapsedMs() / 1000);
    if (emom.onComplete) {
      emom.onComplete({ elapsedSec, results: buildEmomResults(seriesDone), seriesDone, total: emom.total, reachedEnd });
      return;
    }
    openFinish({
      routineId: emom.meta.id, routineName: emom.meta.name, kind: emom.meta.kind,
      plannedSec: emom.total ? emom.total * 60 : 0, actualSec: elapsedSec,
      startedAt: emom.startedAt, endedAt: Date.now(),
      exercisesCompleted: seriesDone, exercisesTotal: emom.total || seriesDone,
      results: buildEmomResults(seriesDone), reachedEnd, blocks: emom.blocks,
      onClose: () => { emom = null; clearActive(); }
    });
  }

  /* ====================================================================== */
  /*  EMOM RANDOM (config)                                                  */
  /* ====================================================================== */

  const erPool = new Set();
  const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function erSyncMode() {
    $('cali-er-mins-field').classList.toggle('hidden', $('cali-er-mode').value !== 'fixed');
    $('cali-er-pool').classList.toggle('cali-pool-disabled', $('cali-er-random').checked);
  }
  function openEmomRandom() {
    renderErPool();
    erSyncMode();
    $('cali-er-status').className = 'status'; $('cali-er-status').textContent = '';
    showScreen('emomRandom');
  }
  function erCandidates() {
    const lvl = $('cali-er-level').value, mus = $('cali-er-muscle').value;
    return (state.exercises || []).filter(e => e.active && (!lvl || e.level === lvl) && (!mus || e.muscle === mus));
  }
  function renderErPool() {
    // Seleccion manual: NO se auto-tilda nada; los filtros solo acotan la lista
    // visible. Lo ya elegido se mantiene aunque quede fuera del filtro.
    const cands = erCandidates();
    $('cali-er-pool').innerHTML = cands.map(e =>
      `<label class="cali-er-chip${erPool.has(e.id) ? ' on' : ''}"><input type="checkbox" data-er="${esc(e.id)}"${erPool.has(e.id) ? ' checked' : ''}/> ${esc(e.name)}</label>`).join('') ||
      '<p class="cali-hint">No hay ejercicios activos para ese filtro.</p>';
    $('cali-er-count').textContent = `${erPool.size} seleccionados`;
  }
  $('cali-er-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-er-level').addEventListener('change', renderErPool);
  $('cali-er-muscle').addEventListener('change', renderErPool);
  $('cali-er-pool').addEventListener('change', (ev) => {
    const cb = ev.target.closest('input[data-er]'); if (!cb) return;
    if (cb.checked) erPool.add(cb.dataset.er); else erPool.delete(cb.dataset.er);
    cb.closest('.cali-er-chip').classList.toggle('on', cb.checked);
    $('cali-er-count').textContent = `${erPool.size} seleccionados`;
  });
  $('cali-er-all').addEventListener('click', () => { erCandidates().forEach(e => erPool.add(e.id)); renderErPool(); });
  $('cali-er-none').addEventListener('click', () => { erPool.clear(); renderErPool(); });
  $('cali-er-mode').addEventListener('change', erSyncMode);
  $('cali-er-random').addEventListener('change', erSyncMode);
  $('cali-er-start').addEventListener('click', () => {
    const reps = parseInt($('cali-er-reps').value, 10) || 10;
    const random = $('cali-er-random').checked;
    const open = $('cali-er-mode').value !== 'fixed';
    const total = open ? null : (parseInt($('cali-er-mins').value, 10) || 0);
    const st = $('cali-er-status');
    if (!open && total < 1) { st.className = 'status show error'; st.textContent = 'La duracion debe ser de al menos 1 minuto.'; return; }
    let assigned, name;
    if (random) {
      // Random por dificultad: usa los candidatos del filtro, en orden aleatorio.
      const cands = erCandidates();
      if (!cands.length) { st.className = 'status show error'; st.textContent = 'No hay ejercicios para ese filtro.'; return; }
      assigned = shuffle(cands).map(e => ({ exerciseId: e.id, exerciseName: e.name, reps }));
      name = 'EMOM random';
    } else {
      // Manual, en el orden del catalogo (rotan minuto a minuto).
      assigned = (state.exercises || []).filter(e => erPool.has(e.id)).map(e => ({ exerciseId: e.id, exerciseName: e.name, reps }));
      if (!assigned.length) { st.className = 'status show error'; st.textContent = 'Elegi al menos un ejercicio (o usa "Random por dificultad").'; return; }
      name = open ? 'EMOM abierto' : 'EMOM fijo';
    }
    // Pasa por el prompt de calentamiento/estiramiento y la cadena de EMOM.
    const routine = { kind: 'emom', name, emom: { totalMinutes: total, items: assigned } };
    startSession({ routine, kind: 'emom-random', name, routineId: null });
  });

  /* ====================================================================== */
  /*  EJERCICIO LIBRE                                                        */
  /* ====================================================================== */

  let freeSets = [];
  let freeStart = 0;
  function openFree() {
    freeSets = []; freeStart = Date.now();
    refreshDynamicSelects();
    renderFreeSets();
    showScreen('free');
  }
  function renderFreeSets() {
    $('cali-free-empty').classList.toggle('hidden', freeSets.length > 0);
    $('cali-free-sets').innerHTML = freeSets.map((s, i) => {
      const ex = byId[s.exerciseId] || { name: s.exerciseId };
      return `<tr><td>${i + 1}</td><td>${esc(ex.name)}</td><td>${s.reps || '—'}</td><td>${s.timeSec || '—'}</td>
        <td><button class="btn mini danger" data-fs="${i}">✕</button></td></tr>`;
    }).join('');
  }
  $('cali-free-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-free-add').addEventListener('click', () => {
    const id = $('cali-free-ex').value; if (!id) return;
    const reps = Math.max(0, parseInt($('cali-free-reps').value, 10) || 0);
    const timeSec = Math.max(0, parseInt($('cali-free-time').value, 10) || 0);
    if (reps <= 0 && timeSec <= 0) { setStatus('error', 'Carga reps o tiempo para la serie.'); return; }
    freeSets.push({ exerciseId: id, reps, timeSec });
    renderFreeSets();
  });
  $('cali-free-sets').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-fs]'); if (!b) return;
    freeSets.splice(parseInt(b.dataset.fs, 10), 1); renderFreeSets();
  });
  $('cali-free-finish').addEventListener('click', () => {
    if (!freeSets.length) { setStatus('error', 'Agrega al menos una serie.'); return; }
    // agrupar por ejercicio para results
    const agg = {};
    freeSets.forEach(s => {
      const ex = byId[s.exerciseId] || { name: s.exerciseId, type: 'reps' };
      if (!agg[s.exerciseId]) agg[s.exerciseId] = { exerciseId: s.exerciseId, exerciseName: ex.name, type: ex.type, setsPlanned: 0, setsCompleted: 0, reps: 0, timeSec: 0, bestReps: 0, bestTimeSec: 0 };
      const a = agg[s.exerciseId];
      a.setsPlanned++; a.setsCompleted++;
      a.bestReps = Math.max(a.bestReps, s.reps); a.bestTimeSec = Math.max(a.bestTimeSec, s.timeSec);
      a.reps = a.bestReps; a.timeSec = a.bestTimeSec;
    });
    const name = freeSets.length === 1 || Object.keys(agg).length === 1
      ? (byId[freeSets[0].exerciseId] || {}).name || 'Ejercicio libre'
      : 'Ejercicio libre';
    openFinish({
      routineId: null, routineName: name, kind: 'free',
      plannedSec: 0, actualSec: Math.round((Date.now() - freeStart) / 1000),
      startedAt: freeStart, endedAt: Date.now(),
      exercisesCompleted: freeSets.length, exercisesTotal: freeSets.length,
      results: Object.values(agg), reachedEnd: true,
      onClose: () => { freeSets = []; }
    });
  });

  /* ====================================================================== */
  /*  FINISH MODAL                                                          */
  /* ====================================================================== */

  let pendingFinish = null;
  let finishCondition = null;
  let finishDiscomforts = [];

  function renderFinishCond() {
    $('cali-finish-cond').innerHTML = (state.meta.conditions || []).map(c =>
      `<button type="button" class="cali-cond-btn${finishCondition === c.key ? ' on' : ''}" data-cond="${esc(c.key)}">${esc(c.label)}</button>`).join('');
  }
  function renderFinishDiscomforts() {
    const cont = $('cali-finish-disc-list');
    if (!finishDiscomforts.length) { cont.innerHTML = '<p class="cali-hint">Ninguna molestia registrada.</p>'; return; }
    const zones = state.meta.discomfortZones || [];
    const exs = (state.activeExercises || []);
    cont.innerHTML = finishDiscomforts.map((d, i) => `
      <div class="cali-disc-row" data-i="${i}">
        <select data-df="zone">${zones.map(z => `<option value="${esc(z)}"${z === d.zone ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select>
        <label class="cali-disc-int">int <input type="number" min="1" max="10" value="${d.intensity}" data-df="intensity" /></label>
        <select data-df="exerciseId"><option value="">(¿ejercicio?)</option>${exs.map(e => `<option value="${esc(e.id)}"${e.id === d.exerciseId ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
        <input type="text" data-df="note" placeholder="nota" value="${esc(d.note || '')}" />
        <button class="cali-iconbtn cali-iconbtn-danger" data-disc-rm="${i}" type="button">✕</button>
      </div>`).join('');
  }

  function openFinish(data) {
    pendingFinish = data;
    finishCondition = null;
    finishDiscomforts = [];
    const blocksTxt = data.blocks && (data.blocks.warmup || data.blocks.cooldown)
      ? `<span>${data.blocks.warmup ? '🤸 calent.' : ''}${data.blocks.warmup && data.blocks.cooldown ? ' + ' : ''}${data.blocks.cooldown ? '🧘 estir.' : ''}</span>` : '';
    $('cali-finish-summary').innerHTML =
      `<div><strong>${esc(data.routineName)}</strong></div>
       <div class="cali-finish-stats">
         <span>Duracion: <strong>${fmtSecs(data.actualSec)}</strong></span>
         ${data.plannedSec ? `<span>Estimado: ${fmtSecs(data.plannedSec)}</span>` : ''}
         <span>Ejercicios: ${data.exercisesCompleted}/${data.exercisesTotal}</span>
         ${blocksTxt}
       </div>`;
    $('cali-finish-status').value = data.reachedEnd ? 'completada' : 'incompleta';
    $('cali-finish-effort').value = 5; $('cali-finish-effort-val').textContent = '5';
    $('cali-finish-feeling').value = ''; $('cali-finish-note').value = '';
    renderFinishCond();
    renderFinishDiscomforts();
    $('cali-finish-modal').classList.remove('hidden');
  }
  $('cali-finish-effort').addEventListener('input', (e) => { $('cali-finish-effort-val').textContent = e.target.value; });
  $('cali-finish-cond').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-cond]'); if (!b) return;
    finishCondition = finishCondition === b.dataset.cond ? null : b.dataset.cond;
    renderFinishCond();
  });
  $('cali-finish-add-disc').addEventListener('click', () => {
    finishDiscomforts.push({ zone: (state.meta.discomfortZones || ['Otra'])[0], intensity: 5, exerciseId: '', note: '' });
    renderFinishDiscomforts();
  });
  $('cali-finish-disc-list').addEventListener('input', (ev) => {
    const f = ev.target.closest('[data-df]'); if (!f) return;
    const i = parseInt(f.closest('.cali-disc-row').dataset.i, 10);
    const key = f.dataset.df;
    finishDiscomforts[i][key] = key === 'intensity' ? (parseInt(f.value, 10) || 1) : f.value;
  });
  $('cali-finish-disc-list').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-disc-rm]'); if (!b) return;
    finishDiscomforts.splice(parseInt(b.dataset.discRm, 10), 1);
    renderFinishDiscomforts();
  });

  function closeFinish(goHome) {
    $('cali-finish-modal').classList.add('hidden');
    const cb = pendingFinish && pendingFinish.onClose;
    pendingFinish = null;
    if (cb) cb();
    if (goHome !== false) { renderHome(); showScreen('home'); }
  }
  $('cali-finish-discard').addEventListener('click', () => { closeFinish(); setStatus('success', 'Sesion descartada.'); });
  $('cali-finish-save').addEventListener('click', async () => {
    if (!pendingFinish) return;
    const d = pendingFinish;
    const r = await window.api.calistenia.recordSession({
      routineId: d.routineId, routineName: d.routineName, kind: d.kind,
      plannedSec: d.plannedSec, actualSec: d.actualSec, startedAt: d.startedAt, endedAt: d.endedAt,
      status: $('cali-finish-status').value,
      exercisesCompleted: d.exercisesCompleted, exercisesTotal: d.exercisesTotal,
      results: d.results || [],
      effort: parseInt($('cali-finish-effort').value, 10) || null,
      condition: finishCondition,
      discomforts: finishDiscomforts.filter(x => x.zone),
      blocks: d.blocks || { warmup: false, cooldown: false },
      feeling: $('cali-finish-feeling').value,
      note: $('cali-finish-note').value
    });
    if (!r.ok) { setStatus('error', r.error); return; }
    applyResult(r.data); refreshDynamicSelects();
    closeFinish();
    setStatus('success', 'Sesion registrada. ¡Bien ahi!');
  });

  /* ---------- Prompt de calentamiento / estiramiento ---------- */
  let warmupCb = null;
  function promptWarmup(routine, cb) {
    warmupCb = cb;
    $('cali-warm-modal').classList.remove('hidden');
  }
  document.querySelectorAll('#cali-warm-options [data-warm]').forEach(b => b.addEventListener('click', () => {
    const map = { cal: [true, false], est: [false, true], ambos: [true, true], no: [false, false] };
    const [w, c] = map[b.dataset.warm] || [false, false];
    $('cali-warm-modal').classList.add('hidden');
    const cb = warmupCb; warmupCb = null;
    if (cb) cb(w, c);
  }));
  $('cali-warm-modal').addEventListener('click', (ev) => {
    if (ev.target.dataset && ev.target.dataset.warmClose) { $('cali-warm-modal').classList.add('hidden'); warmupCb = null; }
  });

  /* ====================================================================== */
  /*  HISTORIAL                                                             */
  /* ====================================================================== */

  function statusTag(s) {
    if (s === 'completada') return '<span class="cali-done-yes">✓ Completada</span>';
    if (s === 'cancelada') return '<span class="cali-done-cancel">✕ Cancelada</span>';
    return '<span class="cali-done-no">○ Incompleta</span>';
  }
  function kindBadge(k) {
    const map = state.meta.sessionKinds || {};
    const cls = k === 'emom' || k === 'emom-random' ? ' cali-badge-emom' : (k === 'free' ? ' cali-badge-free' : '');
    return `<span class="badge${cls}">${esc(map[k] || 'Rutina')}</span>`;
  }
  function sessionResultsHtml(s) {
    if (!s.results || !s.results.length) return '';
    return '<ul class="cali-sess-results">' + s.results.map(r => {
      const m = r.type === 'time' || (r.bestTimeSec && !r.bestReps)
        ? `${r.setsCompleted}× ${r.bestTimeSec || r.timeSec}s`
        : `${r.setsCompleted}× ${r.bestReps || r.reps} reps`;
      return `<li>${esc(r.exerciseName)} — ${esc(m)}</li>`;
    }).join('') + '</ul>';
  }
  function sessionItemHtml(s) {
    const note = s.note ? `<div class="cali-hist-note">“${esc(s.note)}”</div>` : '';
    const feeling = (s.feeling || s.effort) ? `<div class="cali-hist-feel">${s.effort ? 'Esfuerzo ' + s.effort + '/10' : ''}${s.feeling ? (s.effort ? ' · ' : '') + esc(s.feeling) : ''}</div>` : '';
    return `<div class="cali-hist-item">
      <div class="cali-hist-item-main">
        <span class="cali-hist-time">${fmtTime(s.startedAt || s.ts)}</span>
        <strong>${esc(s.routineName)}</strong> ${kindBadge(s.kind)} ${statusTag(s.status)}
        <button class="btn mini danger cali-hist-del" data-sess="${esc(s.id)}" title="Borrar sesion">✕</button>
      </div>
      <div class="cali-hist-item-sub">Duracion ${fmtSecs(s.actualSec)}${s.plannedSec ? ' · estimado ' + fmtSecs(s.plannedSec) : ''} · ejercicios ${s.exercisesCompleted}/${s.exercisesTotal}</div>
      ${sessionResultsHtml(s)}${feeling}${note}</div>`;
  }

  /* ====================================================================== */
  /*  RUTINAS EN VIDEO                                                        */
  /* ====================================================================== */

  let editingVideoId = null;

  function resetVideoForm() {
    editingVideoId = null;
    $('cali-vid-id').value = '';
    $('cali-vid-title').value = '';
    $('cali-vid-url').value = '';
    $('cali-vid-note').value = '';
    $('cali-vid-save').textContent = '+ Agregar rutina';
    $('cali-vid-cancel').classList.add('hidden');
  }

  function openVideos() {
    resetVideoForm();
    renderVideos();
    showScreen('videos');
  }

  const findVideo = (id) => (state.videoRoutines || []).find(v => v.id === id);

  function renderVideos() {
    const cont = $('cali-vid-list'), empty = $('cali-vid-empty');
    const videos = state.videoRoutines || [];
    if (!videos.length) { cont.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    cont.innerHTML = videos.map(v => {
      const stats = v.timesDone
        ? `<span title="Veces hecha">&#x2705; ${v.timesDone}×</span> <span title="Ultima vez">&#x1F553; ${timeAgo(v.lastDoneAt)}</span>`
        : '<span class="cali-rc-pct cali-rc-pct-new">sin hacer</span>';
      const note = v.note ? `<p class="cali-vid-note">${esc(v.note)}</p>` : '';
      return `<div class="cali-vid-card">
        <div class="cali-vid-card-head">
          <h4 title="${esc(v.title)}">${esc(v.title)}</h4>
        </div>
        ${note}
        <div class="cali-vid-card-stats">${stats}</div>
        <div class="cali-vid-card-actions">
          <button class="btn primary" data-vid-done="${esc(v.id)}" title="Registrar que la hiciste">&#x2714; Hice la rutina</button>
          <button class="btn" data-vid-open="${esc(v.id)}" title="Abrir en YouTube">&#x25B6; Ver</button>
          <button class="cali-iconbtn" data-vid-edit="${esc(v.id)}" title="Editar">&#x270E;</button>
          <button class="cali-iconbtn cali-iconbtn-danger" data-vid-del="${esc(v.id)}" title="Eliminar">&#x1F5D1;</button>
        </div></div>`;
    }).join('');
  }

  $('cali-vid-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-vid-cancel').addEventListener('click', resetVideoForm);

  $('cali-vid-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = {
      id: editingVideoId || undefined,
      title: $('cali-vid-title').value,
      url: $('cali-vid-url').value,
      note: $('cali-vid-note').value
    };
    const r = await window.api.calistenia.saveVideoRoutine(payload);
    if (!r.ok) return setStatus('error', r.error);
    applyResult(r.data);
    resetVideoForm();
    renderVideos();
    setStatus('success', 'Rutina en video guardada.');
  });

  $('cali-vid-list').addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-vid-done],[data-vid-open],[data-vid-edit],[data-vid-del]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.vidOpen) {
      const v = findVideo(ds.vidOpen);
      if (v && window.api.openExternal) window.api.openExternal(v.url);
      return;
    }
    if (ds.vidEdit) {
      const v = findVideo(ds.vidEdit);
      if (!v) return;
      editingVideoId = v.id;
      $('cali-vid-id').value = v.id;
      $('cali-vid-title').value = v.title;
      $('cali-vid-url').value = v.url;
      $('cali-vid-note').value = v.note || '';
      $('cali-vid-save').textContent = 'Guardar cambios';
      $('cali-vid-cancel').classList.remove('hidden');
      $('cali-vid-title').focus();
      return;
    }
    if (ds.vidDel) {
      const v = findVideo(ds.vidDel);
      if (v && !window.confirm(`¿Eliminar la rutina en video "${v.title}"?`)) return;
      const r = await window.api.calistenia.removeVideoRoutine(ds.vidDel);
      if (!r.ok) return setStatus('error', r.error);
      applyResult(r.data);
      if (editingVideoId === ds.vidDel) resetVideoForm();
      renderVideos();
      setStatus('success', 'Rutina eliminada.');
      return;
    }
    if (ds.vidDone) {
      const r = await window.api.calistenia.markVideoRoutineDone(ds.vidDone);
      if (!r.ok) return setStatus('error', r.error);
      applyResult(r.data);
      renderVideos();
      setStatus('success', '¡Registrada! Suma a tu racha e historial.');
    }
  });

  function renderHistory() {
    const st = state.stats || {};
    $('cali-hist-days').textContent = st.daysTrainedThisWeek || 0;
    $('cali-hist-streak').innerHTML = (st.streak || 0) + ' &#x1F525;';
    $('cali-hist-total').textContent = st.totalSessions || 0;

    const sessions = state.sessions || [];
    const list = $('cali-hist-list'), empty = $('cali-hist-empty');
    if (!sessions.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');

    const groups = [], byDate = {};
    sessions.forEach(s => { const d = s.date || ''; if (!byDate[d]) { byDate[d] = []; groups.push(d); } byDate[d].push(s); });
    list.innerHTML = groups.map(date => {
      const day = byDate[date].slice().sort((a, b) => (b.startedAt || b.ts || 0) - (a.startedAt || a.ts || 0));
      return `<div class="cali-hist-group"><div class="cali-hist-date">${esc(fmtDate(date))} <span class="badge">${day.length}</span></div>${day.map(sessionItemHtml).join('')}</div>`;
    }).join('');
  }

  $('cali-hist-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('.cali-hist-del'); if (!b) return;
    if (!window.confirm('¿Borrar esta sesion del historial?')) return;
    const r = await window.api.calistenia.removeSession(b.dataset.sess);
    if (!r.ok) return setStatus('error', r.error);
    applyResult(r.data); renderHistory();
  });
  $('cali-hist-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-hist-clear').addEventListener('click', async () => {
    if (!window.confirm('¿Vaciar TODO el historial de entrenamientos?')) return;
    const r = await window.api.calistenia.clearSessions();
    if (!r.ok) return setStatus('error', r.error);
    applyResult(r.data); renderHistory();
  });

  /* ====================================================================== */
  /*  CALENDARIO                                                            */
  /* ====================================================================== */

  let calYear, calMonth;
  function openCalendar() {
    const now = new Date();
    calYear = now.getFullYear(); calMonth = now.getMonth();
    renderCalendar();
    showScreen('calendar');
  }
  function renderCalendar() {
    const cal = state.calendar || {};
    const label = new Date(calYear, calMonth, 1).toLocaleDateString('es-UY', { month: 'long', year: 'numeric' });
    $('cali-cal-label').textContent = label.charAt(0).toUpperCase() + label.slice(1);
    const first = new Date(calYear, calMonth, 1);
    const startDow = (first.getDay() + 6) % 7; // lunes=0
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const todayIso = isoDate(new Date());
    let cells = '';
    for (let i = 0; i < startDow; i++) cells += '<div class="cali-cal-cell cali-cal-empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${calYear}-${pad2(calMonth + 1)}-${pad2(d)}`;
      const info = cal[iso];
      let cls = '';
      if (info) {
        if (info.completed > 0) cls = ' cali-cal-ok';
        else if (info.cancelled === info.total) cls = ' cali-cal-cancel';
        else cls = ' cali-cal-partial';
      }
      const today = iso === todayIso ? ' cali-cal-today' : '';
      const dot = info ? `<span class="cali-cal-count">${info.total}</span>` : '';
      cells += `<div class="cali-cal-cell${cls}${today}" data-cal-day="${iso}"><span class="cali-cal-day">${d}</span>${dot}</div>`;
    }
    $('cali-cal-grid').innerHTML = cells;
  }
  $('cali-cal-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-cal-prev').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); });
  $('cali-cal-next').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); });
  $('cali-cal-grid').addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-cal-day]'); if (!c) return;
    openDayModal(c.dataset.calDay);
  });

  function openDayModal(date) {
    const sessions = (state.sessions || []).filter(s => s.date === date)
      .sort((a, b) => (a.startedAt || a.ts || 0) - (b.startedAt || b.ts || 0));
    $('cali-day-title').textContent = fmtDate(date);
    $('cali-day-body').innerHTML = sessions.length
      ? sessions.map(sessionItemHtml).join('')
      : '<div class="dd-empty">Sin sesiones registradas este dia.</div>';
    $('cali-day-modal').classList.remove('hidden');
  }
  $('cali-day-modal').addEventListener('click', (ev) => {
    if (ev.target.dataset && ev.target.dataset.caliDayClose) $('cali-day-modal').classList.add('hidden');
    const del = ev.target.closest('.cali-hist-del');
    if (del) {
      if (!window.confirm('¿Borrar esta sesion?')) return;
      window.api.calistenia.removeSession(del.dataset.sess).then(r => {
        if (!r.ok) return setStatus('error', r.error);
        applyResult(r.data);
        $('cali-day-modal').classList.add('hidden');
        renderCalendar();
      });
    }
  });

  /* ====================================================================== */
  /*  PROGRESO / STATS                                                      */
  /* ====================================================================== */

  function renderStats() {
    const st = state.stats || {};
    $('cali-st-week').textContent = st.sessionsThisWeek || 0;
    $('cali-st-min').textContent = st.minutesThisWeek || 0;
    $('cali-st-days').textContent = st.daysTrainedThisWeek || 0;
    $('cali-st-streak').textContent = st.streak || 0;
    $('cali-st-completed').textContent = st.completedTotal || 0;
    $('cali-st-most').textContent = st.mostDoneExercise || '—';
    $('cali-st-bars').innerHTML = barsChart(state.weekDays || []);
    const goal = getGoal();
    $('cali-st-goal').value = goal;
    $('cali-st-donut').innerHTML = donut(st.sessionsThisWeek || 0, goal);

    const prog = state.progression || [];
    const cont = $('cali-st-prog'), empty = $('cali-st-prog-empty');
    if (!prog.length) { cont.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    cont.innerHTML = prog.map(p => {
      const best = [];
      if (p.maxReps) best.push(`<span class="cali-prog-best">${p.maxReps} reps max</span>`);
      if (p.maxTimeSec) best.push(`<span class="cali-prog-best">${p.maxTimeSec}s max</span>`);
      return `<div class="cali-prog-row"><div class="cali-prog-name">${esc(p.name)}</div>
        <div class="cali-prog-vals">${best.join(' ')} <span class="vc-hint">${p.sessions} sesion(es)</span></div></div>`;
    }).join('');
  }
  $('cali-stats-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-stats-cal').addEventListener('click', () => openCalendar());
  $('cali-st-goal').addEventListener('input', (e) => { setGoal(parseInt(e.target.value, 10) || 4); renderStats(); });

  /* ====================================================================== */
  /*  SUGERENCIAS DE PROGRESION (home)                                      */
  /* ====================================================================== */

  function renderSuggestions() {
    const cont = $('cali-suggestions');
    if (!cont) return;
    const list = (state.suggestions || []);
    if (!list.length) { cont.innerHTML = ''; cont.classList.add('hidden'); return; }
    cont.classList.remove('hidden');
    cont.innerHTML = `<h3 class="cali-section-title">Sugerencias</h3>` + list.map(s => `
      <div class="cali-sug cali-sug-${esc(s.severity)}">
        <div class="cali-sug-body">
          <strong>${esc(s.title)}</strong>
          <p>${esc(s.message)}</p>
          <p class="cali-sug-detail hidden">${esc(s.detail || '')}</p>
        </div>
        <div class="cali-sug-actions">
          <button class="btn primary mini" data-sug-apply="${esc(s.key)}">Aplicar</button>
          <button class="btn mini" data-sug-ignore="${esc(s.key)}">Ignorar</button>
          <button class="btn mini" data-sug-detail="1" type="button">Detalle</button>
        </div>
      </div>`).join('');
  }
  $('cali-suggestions').addEventListener('click', async (ev) => {
    const det = ev.target.closest('[data-sug-detail]');
    if (det) { const p = det.closest('.cali-sug').querySelector('.cali-sug-detail'); if (p) p.classList.toggle('hidden'); return; }
    const ap = ev.target.closest('[data-sug-apply]');
    const ig = ev.target.closest('[data-sug-ignore]');
    const key = ap ? ap.dataset.sugApply : ig ? ig.dataset.sugIgnore : null;
    if (!key) return;
    const r = await window.api.calistenia.setSuggestionDecision(key, ap ? 'accepted' : 'rejected');
    if (!r.ok) return setStatus('error', r.error);
    commit(r.data);
    setStatus('success', ap ? 'Sugerencia aplicada (anotada). Ajustala en tu rutina cuando quieras.' : 'Sugerencia ignorada.');
  });

  /* ====================================================================== */
  /*  ENTRENO RAPIDO                                                        */
  /* ====================================================================== */

  const QUICK_DUR = { 10: { n: 3, sets: 2, rest: 30 }, 20: { n: 4, sets: 3, rest: 40 }, 30: { n: 5, sets: 3, rest: 45 }, 40: { n: 6, sets: 4, rest: 50 } };
  let quickGen = { durationMin: 20, routine: null };

  function quickPoolFor(focus) {
    const pools = state.meta.quickPools || {};
    let ids;
    if (focus === 'Random') ids = shuffle((state.activeExercises || []).map(e => e.id));
    else if (focus === 'Recuperacion' || focus === 'Movilidad') ids = pools['Movilidad'] || [];
    else ids = pools[focus] || [];
    ids = ids.filter(id => byId[id] && byId[id].active);
    if (!ids.length) ids = (state.activeExercises || []).filter(e => e.muscle === focus).map(e => e.id);
    if (!ids.length) ids = (state.activeExercises || []).map(e => e.id);
    return ids;
  }

  function generateQuick() {
    const durationMin = quickGen.durationMin;
    const focus = $('cali-q-focus').value;
    const levelIdx = parseInt($('cali-q-level').value, 10) || 0;
    const p = QUICK_DUR[durationMin] || QUICK_DUR[20];
    const pool = quickPoolFor(focus);
    if (!pool.length) { $('cali-q-status').className = 'status show error'; $('cali-q-status').textContent = 'No hay ejercicios disponibles.'; return; }
    const n = Math.min(p.n, pool.length);
    // Variedad: la ventana arranca cerca del nivel pero con un offset aleatorio,
    // asi cada "Generar" propone una combinacion distinta de ejercicios.
    const maxStart = Math.max(0, pool.length - n);
    const lvlStart = Math.max(0, Math.min(maxStart, levelIdx - 1));
    const lo = Math.max(0, lvlStart - 1), hi = Math.min(maxStart, lvlStart + 1);
    const offset = focus === 'Random'
      ? Math.floor(Math.random() * (maxStart + 1))
      : lo + Math.floor(Math.random() * (hi - lo + 1));
    const ids = pool.slice(offset, offset + n);
    const reps = 8 + levelIdx * 2, timeSec = 20 + levelIdx * 5;
    let items = ids.map(id => {
      const isTime = (byId[id] || {}).type === 'time';
      return { exerciseId: id, sets: p.sets, reps: isTime ? 0 : reps, timeSec: isTime ? timeSec : 0, restSetSec: p.rest, restExerciseSec: p.rest + 15 };
    });
    // Recorta para no pasar el tiempo elegido (deja ~5 min para warm/cooldown si se agregan).
    const target = durationMin * 60;
    let guard = 30;
    while (standardDuration(items) > target && guard-- > 0) {
      const last = items[items.length - 1];
      if (last.sets > 2) last.sets--;
      else if (items.length > 2) items.pop();
      else break;
    }
    const routine = { kind: 'standard', name: `Rapido ${durationMin}' · ${focus}`, items, emom: null, estimatedSec: standardDuration(items) };
    quickGen.routine = routine;
    renderQuickPreview(routine, focus);
  }

  function renderQuickPreview(routine, focus) {
    $('cali-q-status').className = 'status'; $('cali-q-status').textContent = '';
    const mins = Math.round(routine.estimatedSec / 60);
    $('cali-q-preview').innerHTML = `
      <div class="cali-q-prev-head"><strong>${esc(routine.name)}</strong> <span class="badge">~${mins} min</span></div>
      <ul class="cali-q-prev-list">${routine.items.map(it => {
        const ex = byId[it.exerciseId] || { name: it.exerciseId };
        const tgt = it.timeSec > 0 ? `${it.timeSec}s` : `${it.reps} reps`;
        return `<li>${esc(ex.name)} — ${it.sets}×${esc(tgt)} <span class="vc-hint">desc ${it.restSetSec}s</span></li>`;
      }).join('')}</ul>`;
    $('cali-q-start').disabled = false;
    $('cali-q-save').disabled = false;
  }

  function openQuick() {
    quickGen = { durationMin: 20, routine: null };
    document.querySelectorAll('.cali-q-dur').forEach(b => b.classList.toggle('on', parseInt(b.dataset.min, 10) === 20));
    fillSelect($('cali-q-focus'), ['Full body', 'Empuje', 'Tiron', 'Piernas', 'Core', 'Movilidad', 'Recuperacion', 'Random'].map(f => `<option value="${esc(f)}">${esc(f)}</option>`));
    fillSelect($('cali-q-level'), state.meta.levels.map((l, i) => `<option value="${i * 2}">${esc(l)}</option>`));
    $('cali-q-preview').innerHTML = '<p class="cali-hint">Elegi duracion y foco, despues "Generar".</p>';
    $('cali-q-start').disabled = true; $('cali-q-save').disabled = true;
    $('cali-q-status').className = 'status'; $('cali-q-status').textContent = '';
    showScreen('quick');
  }
  $('cali-q-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  document.querySelectorAll('.cali-q-dur').forEach(b => b.addEventListener('click', () => {
    quickGen.durationMin = parseInt(b.dataset.min, 10);
    document.querySelectorAll('.cali-q-dur').forEach(x => x.classList.toggle('on', x === b));
    if (quickGen.routine) generateQuick();
  }));
  $('cali-q-generate').addEventListener('click', generateQuick);
  $('cali-q-start').addEventListener('click', () => {
    if (!quickGen.routine) return;
    startSession({ routine: quickGen.routine, kind: 'quick', name: quickGen.routine.name, routineId: null });
  });
  $('cali-q-save').addEventListener('click', async () => {
    if (!quickGen.routine) return;
    const r = await window.api.calistenia.saveRoutine({ name: quickGen.routine.name, kind: 'standard', items: quickGen.routine.items });
    if (!r.ok) return setStatus('error', r.error);
    commit(r.data); setStatus('success', 'Guardada como rutina.');
  });

  /* ====================================================================== */
  /*  PLANTILLAS (biblioteca)                                               */
  /* ====================================================================== */

  const tplFilters = { focus: '', level: '', style: '' };
  function openTemplates() {
    fillSelect($('cali-tplf-focus'), '<option value="">Todos los focos</option>' + (state.meta.focusList || []).map(f => `<option value="${esc(f)}">${esc(f)}</option>`), true);
    fillSelect($('cali-tplf-level'), '<option value="">Todos los niveles</option>' + (state.meta.levels || []).map(l => `<option value="${esc(l)}">${esc(l)}</option>`), true);
    fillSelect($('cali-tplf-style'), '<option value="">Todos los estilos</option>' + (state.meta.templateStyles || []).map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`), true);
    renderTemplates();
    showScreen('templates');
  }
  function renderTemplates() {
    const list = (state.library || []).filter(t =>
      (!tplFilters.focus || t.focus === tplFilters.focus) &&
      (!tplFilters.level || t.level === tplFilters.level) &&
      (!tplFilters.style || t.style === tplFilters.style));
    const cont = $('cali-tpl-list'), empty = $('cali-tpl-empty');
    $('cali-tpl-count').textContent = `${list.length} rutinas`;
    if (!list.length) { cont.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    cont.innerHTML = list.map(t => {
      const kindB = t.kind === 'emom' ? '<span class="cali-tag cali-tag-emom">EMOM</span>' : '<span class="cali-tag cali-tag-series">Series</span>';
      const styleB = t.styleLabel ? `<span class="cali-tag cali-tag-style">${esc(t.styleLabel)}</span>` : '';
      return `<div class="cali-tpl-card">
        <div class="cali-routine-head"><h4>${esc(t.name)}</h4></div>
        <div class="cali-routine-badges">${kindB}<span class="cali-tag cali-tag-focus">${esc(t.focus)}</span>${styleB}<span class="cali-level cali-level-${esc(t.level)}">${esc(t.levelLabel || t.level)}</span></div>
        <div class="cali-tpl-goal">${esc(t.goal || '')}</div>
        <div class="cali-routine-stats"><span>&#x23F1; ~${t.estimatedMin} min</span><span>&#x1F4AA; ${t.exerciseCount}</span>${t.warmup ? '<span>🤸 warm-up</span>' : ''}${t.cooldown ? '<span>🧘 cooldown</span>' : ''}</div>
        <div class="cali-routine-actions">
          <button class="btn primary" data-tpl-exec="${esc(t.id)}">&#x25B6; Ejecutar</button>
          <button class="btn" data-tpl-detail="${esc(t.id)}">Detalle</button>
          <button class="cali-iconbtn" data-tpl-save="${esc(t.id)}" title="Guardar como rutina">&#x1F4BE;</button>
          <button class="cali-iconbtn" data-tpl-edit="${esc(t.id)}" title="Editar antes de guardar">&#x270E;</button>
        </div></div>`;
    }).join('');
  }
  const findTpl = (id) => (state.library || []).find(t => t.id === id);
  function tplToRoutine(t) {
    if (t.kind === 'emom') return { kind: 'emom', name: t.name, emom: { totalMinutes: t.emom.totalMinutes, items: t.emom.items.map(i => ({ exerciseId: i.exerciseId, reps: i.reps, exerciseName: i.exerciseName })) }, estimatedSec: t.estimatedSec };
    return { kind: 'standard', name: t.name, items: t.items.map(it => ({ exerciseId: it.exerciseId, sets: it.sets, reps: it.reps, timeSec: it.timeSec, restSetSec: it.restSetSec, restExerciseSec: it.restExerciseSec })), emom: null, estimatedSec: t.estimatedSec };
  }
  async function saveTpl(t) {
    const r = await window.api.calistenia.saveRoutine(t.kind === 'emom'
      ? { name: t.name, kind: 'emom', emom: { totalMinutes: t.emom.totalMinutes, items: t.emom.items.map(i => ({ exerciseId: i.exerciseId, reps: i.reps })) } }
      : { name: t.name, kind: 'standard', items: t.items.map(it => ({ exerciseId: it.exerciseId, sets: it.sets, reps: it.reps, timeSec: it.timeSec, restSetSec: it.restSetSec, restExerciseSec: it.restExerciseSec })) });
    if (!r.ok) { setStatus('error', r.error); return false; }
    commit(r.data); return true;
  }
  $('cali-tpl-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
  $('cali-tplf-focus').addEventListener('change', e => { tplFilters.focus = e.target.value; renderTemplates(); });
  $('cali-tplf-level').addEventListener('change', e => { tplFilters.level = e.target.value; renderTemplates(); });
  $('cali-tplf-style').addEventListener('change', e => { tplFilters.style = e.target.value; renderTemplates(); });
  $('cali-tpl-list').addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-tpl-exec],[data-tpl-detail],[data-tpl-save],[data-tpl-edit]'); if (!t) return;
    const d = t.dataset;
    const tpl = findTpl(d.tplExec || d.tplDetail || d.tplSave || d.tplEdit);
    if (!tpl) return;
    if (d.tplExec) startSession({ routine: tplToRoutine(tpl), kind: 'template', name: tpl.name, routineId: null, warmupDefault: tpl.warmup, cooldownDefault: tpl.cooldown });
    else if (d.tplDetail) openTplDetail(tpl);
    else if (d.tplSave) { if (await saveTpl(tpl)) setStatus('success', 'Guardada en tus rutinas.'); }
    else if (d.tplEdit) openEditor(tplToRoutine(tpl));
  });

  function openTplDetail(t) {
    $('cali-tpld-title').textContent = t.name;
    const rows = t.kind === 'emom'
      ? `<p>${t.emom.totalMinutes} min · 1 ejercicio por minuto (rota):</p><ul class="cali-tpld-list">${t.emom.items.map(i => `<li>${esc(i.exerciseName)} — ${i.reps} reps</li>`).join('')}</ul>`
      : `<ul class="cali-tpld-list">${t.items.map(it => {
          const tgt = it.timeSec > 0 ? `${it.timeSec}s` : `${it.reps} reps`;
          const alts = [];
          if (it.altEasier) alts.push(`mas facil: ${esc(it.altEasier)}`);
          if (it.altLowImpact) alts.push(`bajo impacto: ${esc(it.altLowImpact)}`);
          return `<li><strong>${esc(it.exerciseName)}</strong> — ${it.sets}×${esc(tgt)} · desc ${it.restSetSec}s${alts.length ? `<br><span class="vc-hint">${alts.join(' · ')}</span>` : ''}</li>`;
        }).join('')}</ul>`;
    $('cali-tpld-body').innerHTML = `
      <div class="cali-tpld-meta">
        <span class="cali-tag cali-tag-focus">${esc(t.focus)}</span>
        <span class="cali-level cali-level-${esc(t.level)}">${esc(t.levelLabel || t.level)}</span>
        <span class="badge">~${t.estimatedMin} min</span>
        ${t.warmup ? '<span class="badge">🤸 warm-up</span>' : ''}${t.cooldown ? '<span class="badge">🧘 cooldown</span>' : ''}
      </div>
      ${t.goal ? `<p class="cali-tpld-goal">${esc(t.goal)}</p>` : ''}
      ${t.notes ? `<p class="cali-hint">${esc(t.notes)}</p>` : ''}
      ${rows}`;
    $('cali-tpld-modal').dataset.tplId = t.id;
    $('cali-tpld-modal').classList.remove('hidden');
  }
  $('cali-tpld-modal').addEventListener('click', async (ev) => {
    if (ev.target.dataset && ev.target.dataset.tpldClose) { $('cali-tpld-modal').classList.add('hidden'); return; }
    const tpl = findTpl($('cali-tpld-modal').dataset.tplId); if (!tpl) return;
    if (ev.target.closest('#cali-tpld-exec')) { $('cali-tpld-modal').classList.add('hidden'); startSession({ routine: tplToRoutine(tpl), kind: 'template', name: tpl.name, routineId: null, warmupDefault: tpl.warmup, cooldownDefault: tpl.cooldown }); }
    else if (ev.target.closest('#cali-tpld-save')) { if (await saveTpl(tpl)) { $('cali-tpld-modal').classList.add('hidden'); setStatus('success', 'Guardada en tus rutinas.'); } }
    else if (ev.target.closest('#cali-tpld-edit')) { $('cali-tpld-modal').classList.add('hidden'); openEditor(tplToRoutine(tpl)); }
  });

  /* ====================================================================== */
  /*  Lazy load + pausa al salir                                            */
  /* ====================================================================== */

  document.addEventListener('view:change', (ev) => {
    const view = ev.detail && ev.detail.view;
    if (view === 'calistenia') {
      ensureLoaded();
    } else {
      if (run && run.master.running) { run.master.pause(); $('cali-run-pause').textContent = 'Reanudar'; persistRun(); }
      if (emom && emom.master.running) { emom.master.pause(); $('cali-emom-pause').textContent = 'Reanudar'; persistEmom(); }
    }
  });
})();
