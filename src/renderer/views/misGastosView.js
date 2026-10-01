'use strict';

(function () {
  /* ---------- DOM refs ---------- */

  const $loading      = document.getElementById('mg-loading');
  const $body         = document.getElementById('mg-body');
  const $monthLabel   = document.getElementById('mg-month-label');

  const $overdue      = document.getElementById('mg-overdue');
  const $overdueList  = document.getElementById('mg-overdue-list');

  const $addItem      = document.getElementById('mg-add-item');

  const $kpiTotal    = document.getElementById('mg-kpi-total');
  const $kpiPending  = document.getElementById('mg-kpi-pending');
  const $kpiPaid     = document.getElementById('mg-kpi-paid');
  const $kpiOverdue  = document.getElementById('mg-kpi-overdue');

  const $tbody   = document.getElementById('mg-tbody');
  const $history = document.getElementById('mg-history');
  const $status  = document.getElementById('mg-status');

  const $modal        = document.getElementById('mg-item-modal');
  const $modalTitle    = document.getElementById('mg-item-modal-title');
  const $itemName      = document.getElementById('mg-item-name');
  const $itemDesc       = document.getElementById('mg-item-desc');
  const $itemAmount    = document.getElementById('mg-item-amount');
  const $itemDay        = document.getElementById('mg-item-day');
  const $itemLink        = document.getElementById('mg-item-link');
  const $modalStatus   = document.getElementById('mg-item-modal-status');
  const $modalSave     = document.getElementById('mg-item-save');

  if (!$tbody) return;

  /* ---------- State ---------- */

  let state    = { items: [], currentMonth: '', instances: [], overdue: [], history: [], totals: {} };
  let loaded   = false;
  let loading  = false;
  let modalMode = 'add'; // 'add' | 'edit'
  let editingId = null;

  /* ---------- Helpers ---------- */

  const money = new Intl.NumberFormat('es-UY', {
    style: 'currency', currency: 'UYU', maximumFractionDigits: 0
  });
  const fmt = (n) => (n == null ? '—' : money.format(Number(n) || 0));

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function fmtMonth(monthKey) {
    if (!monthKey) return '';
    const [y, m] = monthKey.split('-');
    return `${m}/${y}`;
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
    if (kind === 'success') setTimeout(() => { $status.className = 'status'; $status.textContent = ''; }, 1800);
  };

  const setModalStatus = (kind, msg) => {
    $modalStatus.className = kind ? `status show ${kind}` : 'status';
    $modalStatus.textContent = msg || '';
  };

  const HISTORY_LABEL = {
    item_added:      'Gasto fijo creado',
    item_edited:     'Gasto fijo editado',
    item_removed:    'Gasto fijo eliminado',
    generated:       'Gastos del mes generados',
    instance_paid:   'Marcado como pagado',
    instance_unpaid: 'Marcado como pendiente'
  };
  const HISTORY_KIND = {
    instance_paid: 'ok', item_added: 'add', item_removed: 'del', generated: 'add'
  };

  /* ---------- IPC wrapper ---------- */

  async function run(promise) {
    try {
      const r = await promise;
      if (!r.ok) throw new Error(r.error);
      state = r.data;
      render();
      return r.data;
    } catch (e) {
      setStatus('error', e.message);
      throw e;
    }
  }

  /* ---------- Render ---------- */

  function render() {
    $monthLabel.textContent = state.currentMonth ? `Mes actual: ${fmtMonth(state.currentMonth)}` : '';
    renderOverdue();
    renderKpis();
    renderTable();
    renderHistory();
  }

  function linkButton(link) {
    if (!link) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mg-link-btn';
    btn.title = 'Abrir pagina de pago';
    btn.innerHTML = '&#x1F517;';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      window.api.openExternal(link).catch(() => {});
    });
    return btn;
  }

  function renderOverdue() {
    const items = state.overdue || [];
    $overdue.classList.toggle('hidden', !items.length);
    $overdueList.innerHTML = '';
    items.forEach(i => {
      const li = document.createElement('li');
      li.className = 'mg-overdue-item';

      const name = document.createElement('span');
      name.className = 'mg-overdue-name';
      name.textContent = i.name;

      const month = document.createElement('span');
      month.className = 'mg-overdue-month';
      month.textContent = fmtMonth(i.month);

      const amount = document.createElement('span');
      amount.className = 'mg-overdue-amount';
      amount.textContent = fmt(i.amount);

      li.appendChild(name);
      li.appendChild(month);
      li.appendChild(amount);
      const link = linkButton(i.link);
      if (link) li.appendChild(link);

      const btn = document.createElement('button');
      btn.className = 'btn mini';
      btn.type = 'button';
      btn.textContent = 'Marcar pagado';
      btn.addEventListener('click', () => togglePaid(i.id, true));
      li.appendChild(btn);

      $overdueList.appendChild(li);
    });
  }

  function renderKpis() {
    const t = state.totals || {};
    $kpiTotal.textContent   = fmt(t.total);
    $kpiPending.textContent = fmt(t.pending);
    $kpiPaid.textContent    = fmt(t.paid);
    $kpiOverdue.textContent = String(t.overdueCount || 0);
  }

  function renderTable() {
    $tbody.innerHTML = '';
    const instances = state.instances || [];
    if (!instances.length) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'Sin gastos fijos cargados. Agrega uno arriba.';
      tr.appendChild(td);
      $tbody.appendChild(tr);
      return;
    }

    const today = todayISO();
    instances.forEach(i => {
      const late = !i.paid && i.dueDate < today;
      const tr = document.createElement('tr');
      tr.className = i.paid ? 'dd-row-paid' : '';

      const tdChk = document.createElement('td');
      tdChk.className = 'dd-col-check';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!i.paid;
      chk.title = i.paid ? 'Marcar como pendiente' : 'Marcar como pagado';
      chk.addEventListener('change', () => togglePaid(i.id, chk.checked));
      tdChk.appendChild(chk);

      const tdName = document.createElement('td');
      tdName.className = 'dd-desc';
      const nameRow = document.createElement('div');
      nameRow.className = 'mg-name-row';
      const strong = document.createElement('strong');
      strong.textContent = i.name;
      nameRow.appendChild(strong);
      const link = linkButton(i.link);
      if (link) nameRow.appendChild(link);
      tdName.appendChild(nameRow);
      if (i.description) {
        const small = document.createElement('div');
        small.className = 'mg-item-desc';
        small.textContent = i.description;
        tdName.appendChild(small);
      }

      const tdAmt = document.createElement('td');
      tdAmt.className = 'dd-col-amount mono';
      tdAmt.textContent = fmt(i.amount);

      const tdDate = document.createElement('td');
      tdDate.className = 'dd-col-date';
      tdDate.textContent = fmtDate(i.dueDate);

      const tdState = document.createElement('td');
      tdState.className = 'dd-col-state';
      const badge = document.createElement('span');
      badge.className = 'dd-state ' + (i.paid ? 'paid' : (late ? 'late' : 'pending'));
      badge.textContent = i.paid ? 'Pagado' : (late ? 'Vencido' : 'Pendiente');
      tdState.appendChild(badge);

      const tdAct = document.createElement('td');
      tdAct.className = 'dd-col-act';
      const actRow = document.createElement('div');
      actRow.className = 'mg-row-actions';
      const edit = document.createElement('button');
      edit.className = 'btn mini';
      edit.type = 'button';
      edit.textContent = 'Editar';
      edit.addEventListener('click', () => openItemModal('edit', i.itemId));
      const del = document.createElement('button');
      del.className = 'btn mini';
      del.type = 'button';
      del.textContent = 'Eliminar';
      del.addEventListener('click', () => removeItem(i.itemId, i.name));
      actRow.appendChild(edit);
      actRow.appendChild(del);
      tdAct.appendChild(actRow);

      tr.appendChild(tdChk);
      tr.appendChild(tdName);
      tr.appendChild(tdAmt);
      tr.appendChild(tdDate);
      tr.appendChild(tdState);
      tr.appendChild(tdAct);
      $tbody.appendChild(tr);
    });
  }

  function renderHistory() {
    $history.innerHTML = '';
    const entries = state.history || [];
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'dd-history-empty';
      li.textContent = 'Sin movimientos registrados.';
      $history.appendChild(li);
      return;
    }
    entries.forEach(h => {
      const li = document.createElement('li');
      li.className = 'dd-history-item ' + (HISTORY_KIND[h.action] || '');
      const head = document.createElement('div');
      head.className = 'dd-history-head';
      const label = document.createElement('span');
      label.className = 'dd-history-label';
      label.textContent = HISTORY_LABEL[h.action] || h.action;
      const time = document.createElement('span');
      time.className = 'dd-history-time';
      time.textContent = new Date(h.ts).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
      head.appendChild(label);
      head.appendChild(time);

      const detail = document.createElement('div');
      detail.className = 'dd-history-detail';
      detail.textContent = h.detail + (h.amount ? ` · ${fmt(h.amount)}` : '');

      li.appendChild(head);
      li.appendChild(detail);
      $history.appendChild(li);
    });
  }

  /* ---------- Actions ---------- */

  async function togglePaid(instanceId, paid) {
    try { await run(window.api.misGastos.setPaid(instanceId, paid)); }
    catch (_) { /* status ya seteado */ }
  }

  async function removeItem(id, name) {
    if (!confirm(`Eliminar el gasto fijo "${name}"? Se deja de generar todos los meses (el historial ya pagado se conserva).`)) return;
    try {
      await run(window.api.misGastos.removeItem(id));
      setStatus('success', 'Gasto fijo eliminado.');
    } catch (_) { /* status ya seteado */ }
  }

  /* ---------- Modal: agregar / editar item ---------- */

  function openItemModal(mode, itemId) {
    modalMode = mode;
    editingId = itemId || null;
    setModalStatus('', '');
    if (mode === 'edit') {
      const item = state.items.find(i => i.id === itemId);
      if (!item) return;
      $modalTitle.textContent = 'Editar gasto fijo';
      $itemName.value = item.name;
      $itemDesc.value = item.description || '';
      $itemAmount.value = item.amount != null ? item.amount : '';
      $itemDay.value = item.dueDay || '';
      $itemLink.value = item.link || '';
    } else {
      $modalTitle.textContent = 'Nuevo gasto fijo';
      $itemName.value = '';
      $itemDesc.value = '';
      $itemAmount.value = '';
      $itemDay.value = '';
      $itemLink.value = '';
    }
    $modal.classList.remove('hidden');
    $modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => $itemName.focus(), 30);
  }

  function closeItemModal() {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
  }

  async function saveItem() {
    const name = $itemName.value.trim();
    if (!name) { setModalStatus('error', 'El nombre es obligatorio.'); $itemName.focus(); return; }
    const payload = {
      name,
      description: $itemDesc.value,
      amount: $itemAmount.value,
      dueDay: $itemDay.value,
      link: $itemLink.value
    };
    $modalSave.disabled = true;
    try {
      if (modalMode === 'edit') {
        await run(window.api.misGastos.updateItem(editingId, payload));
        setStatus('success', 'Gasto fijo actualizado.');
      } else {
        await run(window.api.misGastos.addItem(payload));
        setStatus('success', 'Gasto fijo creado.');
      }
      closeItemModal();
    } catch (e) {
      setModalStatus('error', e.message || 'No se pudo guardar.');
    } finally {
      $modalSave.disabled = false;
    }
  }

  /* ---------- Wire ---------- */

  $addItem.addEventListener('click', () => openItemModal('add'));
  $modalSave.addEventListener('click', saveItem);
  $modal.addEventListener('click', (ev) => {
    if (ev.target && ev.target.dataset && ev.target.dataset.mgClose) closeItemModal();
  });
  $itemName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveItem(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$modal.classList.contains('hidden')) closeItemModal();
  });

  /* ---------- Carga lazy (al entrar por primera vez al tab "mias") ---------- */

  function showLoading(on) {
    $loading.classList.toggle('hidden', !on);
    $body.classList.toggle('hidden', on);
  }

  async function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    showLoading(true);
    try {
      const r = await window.api.misGastos.get();
      if (!r.ok) throw new Error(r.error);
      state = r.data;
      loaded = true;
      render();
    } catch (e) {
      setStatus('error', 'No se pudo cargar la informacion: ' + e.message);
    } finally {
      loading = false;
      showLoading(false);
    }
  }

  window.__misGastos = { ensureLoaded };
})();
