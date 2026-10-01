'use strict';

(function () {
  /* ---------- DOM refs ---------- */

  const $loading   = document.getElementById('gs-loading');
  const $body      = document.getElementById('gs-body');

  const $import       = document.getElementById('gs-import');
  const $monthSelect   = document.getElementById('gs-month-select');
  const $rulesBtn      = document.getElementById('gs-rules');
  const $removeMonthBtn = document.getElementById('gs-remove-month');

  const $empty     = document.getElementById('gs-empty');
  const $content   = document.getElementById('gs-content');

  const $kpiGastos     = document.getElementById('gs-kpi-gastos');
  const $kpiIngresos   = document.getElementById('gs-kpi-ingresos');
  const $kpiBalance    = document.getElementById('gs-kpi-balance');
  const $kpiBalanceCard = document.getElementById('gs-kpi-balance-card');
  const $kpiCount      = document.getElementById('gs-kpi-count');

  const $byCategory   = document.getElementById('gs-by-category');
  const $monthsChart   = document.getElementById('gs-months-chart');
  const $topMerchants  = document.getElementById('gs-top-merchants');
  const $movementsTbody = document.getElementById('gs-movements-tbody');

  const $status    = document.getElementById('gs-status');

  const $rulesModal   = document.getElementById('gs-rules-modal');
  const $ruleForm      = document.getElementById('gs-rule-form');
  const $ruleKeyword   = document.getElementById('gs-rule-keyword');
  const $ruleCategory  = document.getElementById('gs-rule-category');
  const $categoryOptions = document.getElementById('gs-category-options');
  const $rulesTbody    = document.getElementById('gs-rules-tbody');
  const $rulesStatus   = document.getElementById('gs-rules-status');
  const $rulesClose    = document.getElementById('gs-rules-close');

  if (!$content) return;

  /* ---------- State ---------- */

  let state = { months: {}, monthsSummary: [], categoryRules: [], categories: [] };
  let selectedMonth = null;
  let loaded = false, loading = false;

  /* ---------- Helpers ---------- */

  const money = new Intl.NumberFormat('es-UY', {
    style: 'currency', currency: 'UYU', maximumFractionDigits: 0
  });
  const fmt = (n) => money.format(Number(n) || 0);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const MONTH_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  function fmtMonthLabel(mk) {
    const parts = String(mk || '').split('-');
    const idx = parseInt(parts[1], 10) - 1;
    return (MONTH_NAMES[idx] || parts[1] || mk) + ' ' + (parts[0] || '');
  }

  function shortMonthLabel(mk) {
    const parts = String(mk || '').split('-');
    const idx = parseInt(parts[1], 10) - 1;
    return (MONTH_SHORT[idx] || parts[1] || mk) + ' ' + String(parts[0] || '').slice(2);
  }

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
    if (kind === 'success') setTimeout(() => { $status.className = 'status'; $status.textContent = ''; }, 1800);
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  const setRulesStatus = (kind, msg) => {
    $rulesStatus.className = kind ? `status show ${kind}` : 'status';
    $rulesStatus.textContent = msg || '';
  };

  /* ---------- IPC ---------- */

  function applyState(newState) {
    state = newState || { months: {}, monthsSummary: [], categoryRules: [], categories: [] };
    const keys = Object.keys(state.months || {});
    if (!selectedMonth || !state.months[selectedMonth]) {
      selectedMonth = keys.length ? keys[keys.length - 1] : null;
    }
    render();
  }

  // Desenvuelve la respuesta IPC ({ok, data}/{ok,error}) y aplica el estado
  // si vino ({state,...} de una mutacion, o el estado crudo de getState()).
  function unwrap(r) {
    if (!r.ok) throw new Error(r.error);
    if (r.data && r.data.state) applyState(r.data.state);
    else if (r.data) applyState(r.data);
    return r.data;
  }

  /* ---------- Render ---------- */

  function render() {
    renderMonthSelect();
    renderRulesTable();
    renderCategoryOptions();

    const hasData = Object.keys(state.months || {}).length > 0;
    $empty.classList.toggle('hidden', hasData);
    $content.classList.toggle('hidden', !hasData);
    $removeMonthBtn.classList.toggle('hidden', !hasData);
    renderMonthsChart(state.monthsSummary);
    if (!hasData) return;

    const month = state.months[selectedMonth];
    if (!month) return;
    renderKpis(month.stats);
    renderByCategory(month.stats.byCategory);
    renderTopMerchants(month.stats.topMerchants);
    renderMovements(month.movements);
  }

  function renderMonthSelect() {
    const keys = Object.keys(state.months || {});
    $monthSelect.innerHTML = '';
    keys.slice().reverse().forEach(mk => {
      const opt = document.createElement('option');
      opt.value = mk;
      opt.textContent = fmtMonthLabel(mk);
      $monthSelect.appendChild(opt);
    });
    if (selectedMonth) $monthSelect.value = selectedMonth;
  }

  function renderKpis(stats) {
    $kpiGastos.textContent = fmt(stats.totalGastos);
    $kpiIngresos.textContent = fmt(stats.totalIngresos);
    $kpiBalance.textContent = fmt(stats.balance);
    $kpiBalanceCard.classList.toggle('dd-kpi-warn', stats.balance < 0);
    $kpiBalanceCard.classList.toggle('dd-kpi-ok', stats.balance >= 0);
    $kpiCount.textContent = String(stats.count || 0);
  }

  function renderByCategory(byCategory) {
    const list = byCategory || [];
    if (!list.length) { $byCategory.innerHTML = '<p class="dd-empty">Sin movimientos.</p>'; return; }
    const max = Math.max(1, ...list.map(c => c.total));
    $byCategory.innerHTML = list.map(c => {
      const w = Math.max(2, Math.round((c.total / max) * 100));
      return `<div class="gs-bar-row">
        <span class="gs-bar-label">${esc(c.category)}</span>
        <div class="gs-bar-track"><div class="gs-bar-fill" style="width:${w}%"></div></div>
        <span class="gs-bar-value">${esc(fmt(c.total))} <small>(${c.pct}%)</small></span>
      </div>`;
    }).join('');
  }

  function renderMonthsChart(monthsSummary) {
    const list = monthsSummary || [];
    if (!list.length) { $monthsChart.innerHTML = '<p class="dd-empty">Sin datos.</p>'; return; }
    const max = Math.max(1, ...list.map(m => m.totalGastos || 0));
    $monthsChart.innerHTML = list.map(m => {
      const h = m.totalGastos ? Math.max(8, Math.round((m.totalGastos / max) * 100)) : 0;
      const active = m.monthKey === selectedMonth;
      return `<div class="cali-bar${active ? ' cali-bar-today' : ''}" data-month="${esc(m.monthKey)}" title="${esc(fmtMonthLabel(m.monthKey))}: ${esc(fmt(m.totalGastos))}">
        <span class="cali-bar-val">${m.totalGastos ? Math.round(m.totalGastos) : ''}</span>
        <div class="cali-bar-track"><div class="cali-bar-fill" style="height:${h}%"></div></div>
        <span class="cali-bar-lbl">${esc(shortMonthLabel(m.monthKey))}</span>
      </div>`;
    }).join('');
  }

  function renderTopMerchants(topMerchants) {
    const items = topMerchants || [];
    if (!items.length) { $topMerchants.innerHTML = '<li class="dd-empty">Sin gastos.</li>'; return; }
    $topMerchants.innerHTML = items.map(m => `<li class="gs-merchant-row">
      <span class="gs-merchant-name">${esc(m.merchant)}</span>
      <span class="gs-merchant-count">${m.count}x</span>
      <span class="gs-merchant-total">${esc(fmt(m.total))}</span>
    </li>`).join('');
  }

  function renderMovements(movements) {
    const list = (movements || []).slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    $movementsTbody.innerHTML = '';
    if (!list.length) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = 'Sin movimientos.';
      tr.appendChild(td);
      $movementsTbody.appendChild(tr);
      return;
    }
    const categories = state.categories || [];
    list.forEach(mv => {
      const tr = document.createElement('tr');
      if (mv.amount >= 0) tr.className = 'gs-row-income';

      const tdDate = document.createElement('td');
      tdDate.className = 'dd-col-date';
      tdDate.textContent = fmtDate(mv.date);

      const tdDesc = document.createElement('td');
      tdDesc.className = 'dd-desc';
      tdDesc.textContent = mv.description;
      tdDesc.title = mv.description;

      const tdAmt = document.createElement('td');
      tdAmt.className = 'dd-col-amount mono';
      tdAmt.textContent = fmt(mv.amount);

      const tdCat = document.createElement('td');
      const sel = document.createElement('select');
      sel.className = 'gs-cat-select' + (mv.categorySource === 'manual' ? ' gs-cat-manual' : '');
      const options = categories.includes(mv.category) ? categories : categories.concat([mv.category]);
      options.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        if (c === mv.category) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => setMovementCategory(mv.id, sel.value));
      tdCat.appendChild(sel);

      tr.appendChild(tdDate);
      tr.appendChild(tdDesc);
      tr.appendChild(tdAmt);
      tr.appendChild(tdCat);
      $movementsTbody.appendChild(tr);
    });
  }

  function renderRulesTable() {
    const rules = state.categoryRules || [];
    $rulesTbody.innerHTML = '';
    if (!rules.length) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 3;
      td.textContent = 'Sin reglas.';
      tr.appendChild(td);
      $rulesTbody.appendChild(tr);
      return;
    }
    rules.forEach(r => {
      const tr = document.createElement('tr');
      const tdKw = document.createElement('td');
      tdKw.textContent = r.keyword;
      const tdCat = document.createElement('td');
      tdCat.textContent = r.category;
      const tdAct = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'btn mini';
      del.type = 'button';
      del.textContent = 'Eliminar';
      del.addEventListener('click', () => removeRule(r.id));
      tdAct.appendChild(del);
      tr.appendChild(tdKw);
      tr.appendChild(tdCat);
      tr.appendChild(tdAct);
      $rulesTbody.appendChild(tr);
    });
  }

  function renderCategoryOptions() {
    $categoryOptions.innerHTML = (state.categories || []).map(c => `<option value="${esc(c)}"></option>`).join('');
  }

  /* ---------- Acciones ---------- */

  async function setMovementCategory(movementId, category) {
    try {
      unwrap(await window.api.gastosStats.setMovementCategory(selectedMonth, movementId, category));
      setStatus('success', 'Categoria actualizada.');
    } catch (e) {
      setStatus('error', e.message || 'No se pudo actualizar la categoria.');
    }
  }

  async function removeRule(id) {
    try {
      unwrap(await window.api.gastosStats.removeCategoryRule(id));
      setRulesStatus('success', 'Regla eliminada.');
    } catch (e) {
      setRulesStatus('error', e.message || 'No se pudo eliminar la regla.');
    }
  }

  async function addRule() {
    const keyword = $ruleKeyword.value.trim();
    const category = $ruleCategory.value.trim();
    if (!keyword || !category) { setRulesStatus('error', 'Completa palabra clave y categoria.'); return; }
    try {
      unwrap(await window.api.gastosStats.addCategoryRule({ keyword, category }));
      $ruleKeyword.value = '';
      $ruleCategory.value = '';
      setRulesStatus('success', 'Regla agregada. Se aplicara en la proxima importacion.');
      $ruleKeyword.focus();
    } catch (e) {
      setRulesStatus('error', e.message || 'No se pudo agregar la regla.');
    }
  }

  function openRulesModal() {
    setRulesStatus('', '');
    $rulesModal.classList.remove('hidden');
    $rulesModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => $ruleKeyword.focus(), 30);
  }

  function closeRulesModal() {
    $rulesModal.classList.add('hidden');
    $rulesModal.setAttribute('aria-hidden', 'true');
  }

  async function importMonth() {
    clearStatus();
    $import.disabled = true;
    try {
      const data = unwrap(await window.api.gastosStats.importXlsx());
      if (data && data.monthKey) {
        selectedMonth = data.monthKey;
        render();
        setStatus('success', `Importados ${data.count} movimientos de ${fmtMonthLabel(data.monthKey)}.`);
      }
    } catch (e) {
      setStatus('error', e.message || 'No se pudo importar el archivo.');
    } finally {
      $import.disabled = false;
    }
  }

  async function removeSelectedMonth() {
    if (!selectedMonth) return;
    const mk = selectedMonth;
    if (!confirm(`Eliminar el mes ${fmtMonthLabel(mk)} completo? Esta accion no se puede deshacer.`)) return;
    selectedMonth = null;
    try {
      unwrap(await window.api.gastosStats.removeMonth(mk));
      setStatus('success', 'Mes eliminado.');
    } catch (e) {
      setStatus('error', e.message || 'No se pudo eliminar el mes.');
    }
  }

  /* ---------- Wire ---------- */

  $import.addEventListener('click', importMonth);
  $removeMonthBtn.addEventListener('click', removeSelectedMonth);
  $monthSelect.addEventListener('change', () => { selectedMonth = $monthSelect.value; render(); });
  $monthsChart.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-month]');
    if (!el) return;
    selectedMonth = el.dataset.month;
    render();
  });

  $rulesBtn.addEventListener('click', openRulesModal);
  $rulesClose.addEventListener('click', closeRulesModal);
  $rulesModal.addEventListener('click', (ev) => {
    if (ev.target && ev.target.dataset && ev.target.dataset.gsClose) closeRulesModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$rulesModal.classList.contains('hidden')) closeRulesModal();
  });
  $ruleForm.addEventListener('submit', (ev) => { ev.preventDefault(); addRule(); });

  /* ---------- Carga lazy ---------- */

  function showLoading(on) {
    $loading.classList.toggle('hidden', !on);
    $body.classList.toggle('hidden', on);
  }

  async function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    clearStatus();
    showLoading(true);
    try {
      const r = await window.api.gastosStats.get();
      if (!r.ok) throw new Error(r.error);
      applyState(r.data);
      loaded = true;
    } catch (e) {
      setStatus('error', 'No se pudo cargar la informacion: ' + e.message);
    } finally {
      loading = false;
      showLoading(false);
    }
  }

  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.view === 'gastos-stats') ensureLoaded();
  });

  if (document.getElementById('view-gastos-stats').classList.contains('active')) ensureLoaded();
})();
