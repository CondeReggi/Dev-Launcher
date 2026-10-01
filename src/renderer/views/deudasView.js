'use strict';

(function () {
  /* ---------- DOM refs ---------- */

  const $kpiTotal   = document.getElementById('dd-kpi-total');
  const $kpiPending = document.getElementById('dd-kpi-pending');
  const $kpiPaid    = document.getElementById('dd-kpi-paid');
  const $kpiCount   = document.getElementById('dd-kpi-count');

  const $addDebtor  = document.getElementById('dd-add-debtor');
  const $import     = document.getElementById('dd-import');
  const $backup     = document.getElementById('dd-backup');
  const $restore    = document.getElementById('dd-restore');
  const $shared       = document.getElementById('dd-shared');
  const $copyAccount  = document.getElementById('dd-copy-account');
  const $search     = document.getElementById('dd-search');
  const $list       = document.getElementById('dd-debtor-list');

  const $empty      = document.getElementById('dd-empty');
  const $content    = document.getElementById('dd-detail-content');
  const $name       = document.getElementById('dd-detail-name');
  const $note       = document.getElementById('dd-detail-note');
  const $pay        = document.getElementById('dd-pay');
  const $export     = document.getElementById('dd-export');
  const $editDebtor = document.getElementById('dd-edit-debtor');
  const $delDebtor  = document.getElementById('dd-del-debtor');

  const $dTotal     = document.getElementById('dd-d-total');
  const $dPending   = document.getElementById('dd-d-pending');
  const $dPaid      = document.getElementById('dd-d-paid');
  const $dCredit    = document.getElementById('dd-d-credit');

  const $tabs       = Array.from(document.querySelectorAll('.dd-tab'));
  const $panels     = Array.from(document.querySelectorAll('.dd-tab-panel'));

  const $debtForm   = document.getElementById('dd-add-debt-form');
  const $debtDesc   = document.getElementById('dd-debt-desc');
  const $debtAmount = document.getElementById('dd-debt-amount');
  const $debtDate   = document.getElementById('dd-debt-date');
  const $debtTbody  = document.getElementById('dd-debt-tbody');

  const $history    = document.getElementById('dd-history');
  const $status     = document.getElementById('dd-status');
  const $loading    = document.getElementById('dd-loading');
  const $body       = document.getElementById('dd-body');

  const $modal       = document.getElementById('dd-debtor-modal');
  const $modalTitle  = document.getElementById('dd-debtor-modal-title');
  const $modalName   = document.getElementById('dd-debtor-name');
  const $modalNote   = document.getElementById('dd-debtor-note');
  const $modalStatus = document.getElementById('dd-debtor-modal-status');
  const $modalSave   = document.getElementById('dd-debtor-save');

  const $sharedModal   = document.getElementById('dd-shared-modal');
  const $sharedDesc    = document.getElementById('dd-shared-desc');
  const $sharedTotal   = document.getElementById('dd-shared-total');
  const $sharedDate    = document.getElementById('dd-shared-date');
  const $sharedSearch  = document.getElementById('dd-shared-search');
  const $sharedList    = document.getElementById('dd-shared-list');
  const $sharedAll     = document.getElementById('dd-shared-all');
  const $sharedNone    = document.getElementById('dd-shared-none');
  const $sharedCount   = document.getElementById('dd-shared-count');
  const $sharedIncludeMe = document.getElementById('dd-shared-includeme');
  const $sharedPreview = document.getElementById('dd-shared-preview');
  const $sharedStatus  = document.getElementById('dd-shared-modal-status');
  const $sharedSave    = document.getElementById('dd-shared-save');

  const $exportMany    = document.getElementById('dd-export-many');
  const $exportModal   = document.getElementById('dd-export-modal');
  const $exportSearch  = document.getElementById('dd-export-search');
  const $exportList    = document.getElementById('dd-export-list');
  const $exportAll     = document.getElementById('dd-export-all');
  const $exportNone    = document.getElementById('dd-export-none');
  const $exportCount   = document.getElementById('dd-export-count');
  const $exportPending = document.getElementById('dd-export-pending');
  const $exportPreview = document.getElementById('dd-export-preview');
  const $exportStatus  = document.getElementById('dd-export-modal-status');
  const $exportGo      = document.getElementById('dd-export-go');

  const $payModal    = document.getElementById('dd-payment-modal');
  const $payName     = document.getElementById('dd-pay-name');
  const $payPending  = document.getElementById('dd-pay-pending');
  const $payCredit   = document.getElementById('dd-pay-credit');
  const $payAmount   = document.getElementById('dd-pay-amount');
  const $payDate     = document.getElementById('dd-pay-date');
  const $payNote     = document.getElementById('dd-pay-note');
  const $payPreview  = document.getElementById('dd-pay-preview');
  const $payStatus   = document.getElementById('dd-payment-modal-status');
  const $paySave     = document.getElementById('dd-pay-save');

  if (!$list) return;

  /* ---------- State ---------- */

  let state      = { debtors: [], history: [], totals: {} };
  let selectedId = null;
  let activeTab  = 'debts';
  let modalMode  = 'add'; // 'add' | 'edit'
  let loaded     = false; // datos cargados (lazy, al entrar a la seccion)
  let loading    = false;

  /* ---------- Helpers ---------- */

  const money = new Intl.NumberFormat('es-UY', {
    style: 'currency', currency: 'UYU', maximumFractionDigits: 0
  });
  const fmt = (n) => money.format(Number(n) || 0);

  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d)) return String(value);
    return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function fmtDateTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString('es-UY', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
    if (kind === 'success') setTimeout(() => { $status.className = 'status'; $status.textContent = ''; }, 1800);
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  const setModalStatus = (kind, msg) => {
    $modalStatus.className = `status show ${kind}`;
    $modalStatus.textContent = msg;
  };

  const HISTORY_LABEL = {
    debtor_added:   'Deudor creado',
    debtor_edited:  'Deudor editado',
    debtor_removed: 'Deudor eliminado',
    debt_added:     'Deuda agregada',
    debt_edited:    'Deuda editada',
    debt_removed:   'Deuda eliminada',
    debt_paid:      'Marcada como cobrada',
    debt_unpaid:    'Marcada como pendiente',
    payment:        'Pago registrado',
    shared:         'Gasto compartido',
    import:         'Importacion',
    restore:        'Restauracion'
  };
  const HISTORY_KIND = {
    debt_paid: 'ok', debt_added: 'add', debt_removed: 'del', debtor_removed: 'del',
    payment: 'pay', shared: 'add', import: 'add', restore: 'add'
  };

  function selectedDebtor() {
    return state.debtors.find(d => d.id === selectedId) || null;
  }

  /* ---------- IPC wrapper ---------- */

  // Cada mutacion del backend devuelve { state, debtorId }. Centralizamos el
  // manejo de error + el re-render desde la nueva fuente de verdad.
  async function run(promise) {
    try {
      const r = await promise;
      if (!r.ok) throw new Error(r.error);
      // getState() devuelve el state directo; las mutaciones { state, debtorId }.
      if (r.data && r.data.debtors) {
        state = r.data;
      } else if (r.data && r.data.state) {
        state = r.data.state;
        if (r.data.debtorId !== undefined) selectedId = r.data.debtorId;
      }
      render();
      return r.data;
    } catch (e) {
      setStatus('error', e.message);
      throw e;
    }
  }

  /* ---------- Render ---------- */

  function render() {
    renderKpis();
    renderList();
    renderDetail();
  }

  function renderKpis() {
    const t = state.totals || {};
    $kpiTotal.textContent   = fmt(t.total);
    $kpiPending.textContent = fmt(t.outstanding);
    $kpiPaid.textContent    = fmt(t.paid);
    $kpiCount.textContent   = String(t.debtorCount || 0);
  }

  function renderList() {
    const q = ($search.value || '').trim().toLowerCase();
    const debtors = q
      ? state.debtors.filter(d => d.name.toLowerCase().includes(q))
      : state.debtors;

    $list.innerHTML = '';

    if (!debtors.length) {
      const div = document.createElement('div');
      div.className = 'dd-list-empty';
      div.textContent = state.debtors.length ? 'Sin resultados.' : 'Todavia no hay deudores.';
      $list.appendChild(div);
      return;
    }

    debtors.forEach(d => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dd-debtor' + (d.id === selectedId ? ' active' : '');
      item.addEventListener('click', () => { selectedId = d.id; activeTab = 'debts'; render(); });

      const top = document.createElement('div');
      top.className = 'dd-debtor-top';
      const nm = document.createElement('span');
      nm.className = 'dd-debtor-name';
      nm.textContent = d.name;
      const amt = document.createElement('span');
      const out = d.totals.outstanding;
      const cr = d.totals.credit;
      if (out > 0) {
        amt.className = 'dd-debtor-amount';
        amt.textContent = fmt(out);
        amt.title = 'Pendiente de cobro';
      } else if (cr > 0) {
        amt.className = 'dd-debtor-amount favor';
        amt.textContent = '+' + fmt(cr);
        amt.title = 'Saldo a favor del deudor';
      } else {
        amt.className = 'dd-debtor-amount settled';
        amt.textContent = fmt(0);
        amt.title = 'Saldado';
      }
      top.appendChild(nm);
      top.appendChild(amt);

      const bar = document.createElement('div');
      bar.className = 'dd-bar';
      const fill = document.createElement('div');
      fill.className = 'dd-bar-fill';
      const pct = d.totals.total > 0 ? Math.round((d.totals.paid / d.totals.total) * 100) : 0;
      fill.style.width = pct + '%';
      bar.appendChild(fill);

      const meta = document.createElement('div');
      meta.className = 'dd-debtor-meta';
      meta.textContent = d.totals.count
        ? `${d.totals.count} deuda(s) · ${pct}% cobrado`
        : 'Sin deudas';

      item.appendChild(top);
      item.appendChild(bar);
      item.appendChild(meta);
      $list.appendChild(item);
    });
  }

  function renderDetail() {
    const d = selectedDebtor();
    if (!d) {
      $empty.classList.remove('hidden');
      $content.classList.add('hidden');
      return;
    }
    $empty.classList.add('hidden');
    $content.classList.remove('hidden');

    $name.textContent = d.name;
    $note.textContent = d.note || '';
    $note.style.display = d.note ? '' : 'none';

    $dTotal.textContent   = fmt(d.totals.total);
    $dPending.textContent = fmt(d.totals.outstanding);
    $dPaid.textContent    = fmt(d.totals.paid);
    $dCredit.textContent  = fmt(d.totals.credit);

    $tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
    $panels.forEach(p => p.classList.toggle('hidden', p.dataset.panel !== activeTab));

    renderDebts(d);
    renderHistory(d);
  }

  function renderDebts(d) {
    $debtTbody.innerHTML = '';
    if (!d.debts.length) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'Sin deudas cargadas. Agrega una arriba.';
      tr.appendChild(td);
      $debtTbody.appendChild(tr);
      return;
    }

    d.debts.forEach(x => {
      const tr = document.createElement('tr');
      tr.className = x.paid ? 'dd-row-paid' : '';

      // check
      const tdChk = document.createElement('td');
      tdChk.className = 'dd-col-check';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!x.paid;
      chk.title = x.paid ? 'Marcar como pendiente' : 'Marcar como cobrada';
      chk.addEventListener('change', () => togglePaid(d.id, x.id, chk.checked));
      tdChk.appendChild(chk);

      // desc
      const tdDesc = document.createElement('td');
      tdDesc.className = 'dd-desc';
      tdDesc.textContent = x.description;
      tdDesc.title = x.description;

      // amount (si tiene credito aplicado parcial, muestra el original tachado + el restante)
      const tdAmt = document.createElement('td');
      tdAmt.className = 'dd-col-amount mono';
      const creditApplied = Number(x.creditApplied || 0);
      if (!x.paid && creditApplied > 1e-9) {
        const orig = document.createElement('span');
        orig.className = 'dd-amount-orig';
        orig.textContent = fmt(x.amount);
        const rem = document.createElement('span');
        rem.className = 'dd-amount-remaining';
        rem.textContent = fmt(x.remaining != null ? x.remaining : x.amount);
        tdAmt.appendChild(orig);
        tdAmt.appendChild(document.createTextNode(' '));
        tdAmt.appendChild(rem);
        tdAmt.title = `Saldo a favor aplicado: ${fmt(creditApplied)}`;
      } else {
        tdAmt.textContent = fmt(x.amount);
      }

      // date
      const tdDate = document.createElement('td');
      tdDate.className = 'dd-col-date';
      tdDate.textContent = fmtDate(x.date);

      // state badge
      const tdState = document.createElement('td');
      tdState.className = 'dd-col-state';
      const badge = document.createElement('span');
      badge.className = 'dd-state ' + (x.paid ? 'paid' : 'pending');
      badge.textContent = x.paid ? (x.autoPaidByCredit ? 'Cobrada (crédito)' : 'Cobrada') : 'Pendiente';
      if (x.autoPaidByCredit) badge.title = 'Saldada automaticamente con saldo a favor';
      tdState.appendChild(badge);

      // actions
      const tdAct = document.createElement('td');
      tdAct.className = 'dd-col-act';
      const del = document.createElement('button');
      del.className = 'btn mini';
      del.type = 'button';
      del.textContent = 'Eliminar';
      del.addEventListener('click', () => removeDebt(d.id, x.id, x.description));
      tdAct.appendChild(del);

      tr.appendChild(tdChk);
      tr.appendChild(tdDesc);
      tr.appendChild(tdAmt);
      tr.appendChild(tdDate);
      tr.appendChild(tdState);
      tr.appendChild(tdAct);
      $debtTbody.appendChild(tr);
    });
  }

  function renderHistory(d) {
    $history.innerHTML = '';
    const entries = state.history.filter(h => h.debtorId === d.id);
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
      time.textContent = fmtDateTime(h.ts);
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

  /* ---------- Actions: debts ---------- */

  async function addDebt(ev) {
    ev.preventDefault();
    const d = selectedDebtor();
    if (!d) return;
    const description = $debtDesc.value.trim();
    const amount = $debtAmount.value;
    const date = $debtDate.value || null;
    if (!description) { setStatus('error', 'Ingresa una descripcion.'); $debtDesc.focus(); return; }
    if (!(Number(amount) > 0)) { setStatus('error', 'Ingresa un monto mayor a 0.'); $debtAmount.focus(); return; }
    try {
      await run(window.api.deudas.addDebt(d.id, { description, amount, date }));
      $debtDesc.value = '';
      $debtAmount.value = '';
      $debtDate.value = '';
      $debtDesc.focus();
      setStatus('success', 'Deuda agregada.');
    } catch (_) { /* status ya seteado */ }
  }

  async function togglePaid(debtorId, debtId, paid) {
    try { await run(window.api.deudas.setPaid(debtorId, debtId, paid)); }
    catch (_) { /* status ya seteado */ }
  }

  async function removeDebt(debtorId, debtId, desc) {
    if (!confirm(`Eliminar la deuda "${desc}"?`)) return;
    try {
      await run(window.api.deudas.removeDebt(debtorId, debtId));
      setStatus('success', 'Deuda eliminada.');
    } catch (_) { /* status ya seteado */ }
  }

  /* ---------- Actions: debtor modal ---------- */

  function openDebtorModal(mode) {
    modalMode = mode;
    setModalStatus('', '');
    $modalStatus.className = 'status';
    if (mode === 'edit') {
      const d = selectedDebtor();
      if (!d) return;
      $modalTitle.textContent = 'Editar deudor';
      $modalName.value = d.name;
      $modalNote.value = d.note || '';
    } else {
      $modalTitle.textContent = 'Nuevo deudor';
      $modalName.value = '';
      $modalNote.value = '';
    }
    $modal.classList.remove('hidden');
    $modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => $modalName.focus(), 30);
  }

  function closeDebtorModal() {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
  }

  async function saveDebtor() {
    const name = $modalName.value.trim();
    const note = $modalNote.value.trim();
    if (!name) { setModalStatus('error', 'El nombre es obligatorio.'); $modalName.focus(); return; }
    $modalSave.disabled = true;
    try {
      if (modalMode === 'edit') {
        const d = selectedDebtor();
        await run(window.api.deudas.updateDebtor(d.id, { name, note }));
        setStatus('success', 'Deudor actualizado.');
      } else {
        await run(window.api.deudas.addDebtor(name, note));
        setStatus('success', 'Deudor creado.');
      }
      closeDebtorModal();
    } catch (_) {
      setModalStatus('error', $status.textContent || 'No se pudo guardar.');
    } finally {
      $modalSave.disabled = false;
    }
  }

  async function removeDebtor() {
    const d = selectedDebtor();
    if (!d) return;
    const extra = d.totals.count ? ` y sus ${d.totals.count} deuda(s)` : '';
    if (!confirm(`Eliminar al deudor "${d.name}"${extra}? Esta accion no se puede deshacer.`)) return;
    try {
      await run(window.api.deudas.removeDebtor(d.id));
      setStatus('success', 'Deudor eliminado.');
    } catch (_) { /* status ya seteado */ }
  }

  /* ---------- Actions: importar / exportar ---------- */

  async function doImport() {
    $import.disabled = true;
    const prev = $import.textContent;
    $import.textContent = 'Importando...';
    try {
      const res = await run(window.api.deudas.importXlsx());
      if (res === null) { setStatus('', ''); return; } // cancelado
      const msg = res.imported
        ? `Importados ${res.imported} deudor(es) y ${res.debtsImported} deuda(s).` +
          (res.skipped ? ` Omitidos ${res.skipped} ya existentes.` : '')
        : (res.skipped ? `Sin novedades: ${res.skipped} deudor(es) ya existian.` : 'No se encontraron deudores en el Excel.');
      setStatus('success', msg);
    } catch (_) { /* status ya seteado */ }
    finally { $import.disabled = false; $import.textContent = prev; }
  }

  async function doExport() {
    const d = selectedDebtor();
    if (!d) return;
    $export.disabled = true;
    try {
      const r = await window.api.deudas.exportDebtor(d.id, d.name);
      if (!r.ok) throw new Error(r.error);
      if (!r.data) { setStatus('', ''); return; } // cancelado
      setStatus('success', `Estado de cuenta exportado.`);
      // Abrir el archivo en el explorador.
      try { window.api.showInFolder(r.data.path); } catch (_) { /* ignore */ }
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      $export.disabled = false;
    }
  }

  /* ---------- Actions: exportar varios deudores ---------- */

  const exportSelected = new Set();

  function openExportModal() {
    if (!state.debtors.length) {
      setStatus('error', 'Primero agrega al menos un deudor.');
      return;
    }
    // Arranca con el deudor abierto preseleccionado (o todos si no hay ninguno).
    exportSelected.clear();
    if (selectedId) exportSelected.add(selectedId);
    else state.debtors.forEach(d => exportSelected.add(d.id));
    $exportSearch.value = '';
    $exportPending.checked = false;
    $exportStatus.className = 'status';
    $exportStatus.textContent = '';
    renderExportList();
    updateExportPreview();
    $exportModal.classList.remove('hidden');
    $exportModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => $exportSearch.focus(), 30);
  }

  function closeExportModal() {
    $exportModal.classList.add('hidden');
    $exportModal.setAttribute('aria-hidden', 'true');
  }

  function renderExportList() {
    const q = ($exportSearch.value || '').trim().toLowerCase();
    const items = q
      ? state.debtors.filter(d => d.name.toLowerCase().includes(q))
      : state.debtors;

    $exportList.innerHTML = '';
    if (!items.length) {
      const div = document.createElement('div');
      div.className = 'dd-list-empty';
      div.textContent = 'Sin resultados.';
      $exportList.appendChild(div);
      return;
    }

    items.forEach(d => {
      const row = document.createElement('label');
      row.className = 'dd-shared-row' + (exportSelected.has(d.id) ? ' selected' : '');

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = exportSelected.has(d.id);
      chk.addEventListener('change', () => {
        if (chk.checked) exportSelected.add(d.id);
        else exportSelected.delete(d.id);
        row.classList.toggle('selected', chk.checked);
        updateExportPreview();
      });

      const name = document.createElement('span');
      name.className = 'dd-shared-row-name';
      name.textContent = d.name;

      const meta = document.createElement('span');
      meta.className = 'dd-shared-row-meta';
      meta.textContent = d.totals.outstanding > 0
        ? `pendiente ${fmt(d.totals.outstanding)}`
        : 'al dia';

      row.appendChild(chk);
      row.appendChild(name);
      row.appendChild(meta);
      $exportList.appendChild(row);
    });
  }

  function updateExportPreview() {
    const n = exportSelected.size;
    $exportCount.textContent = `${n} seleccionado(s)`;
    if (!n) { $exportPreview.textContent = ''; return; }
    const chosen = state.debtors.filter(d => exportSelected.has(d.id));
    const pending = chosen.reduce((s, d) => s + (Number(d.totals.outstanding) || 0), 0);
    $exportPreview.textContent =
      `${n} deudor(es) · pendiente total ${fmt(pending)} · ${n + 1} hojas en el Excel`;
  }

  async function doExportMany() {
    const debtorIds = Array.from(exportSelected);
    if (!debtorIds.length) {
      $exportStatus.className = 'status show error';
      $exportStatus.textContent = 'Selecciona al menos un deudor.';
      return;
    }
    $exportGo.disabled = true;
    try {
      const r = await window.api.deudas.exportMany(debtorIds, { onlyPending: $exportPending.checked });
      if (!r.ok) throw new Error(r.error);
      if (!r.data) { $exportGo.disabled = false; return; } // cancelado en el dialogo
      closeExportModal();
      setStatus('success', `Excel exportado con ${r.data.debtors} deudor(es).`);
      try { window.api.showInFolder(r.data.path); } catch (_) { /* ignore */ }
    } catch (e) {
      $exportStatus.className = 'status show error';
      $exportStatus.textContent = e.message;
    } finally {
      $exportGo.disabled = false;
    }
  }

  /* ---------- Actions: copiar cuenta al portapapeles ---------- */

  async function copyAccount() {
    if (!$copyAccount) return;
    const labelEl = $copyAccount.querySelector('.dd-copy-label');
    const originalLabel = labelEl ? labelEl.textContent : '';
    $copyAccount.disabled = true;
    try {
      const r = await window.api.settings.get();
      if (!r.ok) throw new Error(r.error);
      const value = r.data && r.data.effective && r.data.effective.app
        ? String(r.data.effective.app.CUENTA_A_TRANSFERIR || '').trim()
        : '';
      if (!value) {
        setStatus('error', 'CUENTA_A_TRANSFERIR esta vacia. Editala en Configuracion → App.');
        return;
      }
      await navigator.clipboard.writeText(value);
      setStatus('success', 'Cuenta copiada al portapapeles.');
      if (labelEl) {
        labelEl.textContent = '¡Copiado!';
        $copyAccount.classList.add('copied');
        setTimeout(() => {
          labelEl.textContent = originalLabel;
          $copyAccount.classList.remove('copied');
        }, 1200);
      }
    } catch (e) {
      setStatus('error', 'No se pudo copiar: ' + e.message);
    } finally {
      $copyAccount.disabled = false;
    }
  }

  /* ---------- Actions: gasto compartido ---------- */

  const sharedSelected = new Set();

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  function openSharedModal() {
    if (!state.debtors.length) {
      setStatus('error', 'Primero agrega al menos un deudor.');
      return;
    }
    sharedSelected.clear();
    $sharedDesc.value = '';
    $sharedTotal.value = '';
    $sharedDate.value = todayISO();
    $sharedSearch.value = '';
    $sharedIncludeMe.checked = false;
    $sharedStatus.className = 'status';
    $sharedStatus.textContent = '';
    renderSharedList();
    updateSharedPreview();
    $sharedModal.classList.remove('hidden');
    $sharedModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => $sharedDesc.focus(), 30);
  }

  function closeSharedModal() {
    $sharedModal.classList.add('hidden');
    $sharedModal.setAttribute('aria-hidden', 'true');
  }

  function renderSharedList() {
    const q = ($sharedSearch.value || '').trim().toLowerCase();
    const items = q
      ? state.debtors.filter(d => d.name.toLowerCase().includes(q))
      : state.debtors;

    $sharedList.innerHTML = '';
    if (!items.length) {
      const div = document.createElement('div');
      div.className = 'dd-list-empty';
      div.textContent = 'Sin resultados.';
      $sharedList.appendChild(div);
      return;
    }

    items.forEach(d => {
      const row = document.createElement('label');
      row.className = 'dd-shared-row' + (sharedSelected.has(d.id) ? ' selected' : '');

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = sharedSelected.has(d.id);
      chk.addEventListener('change', () => {
        if (chk.checked) sharedSelected.add(d.id);
        else sharedSelected.delete(d.id);
        row.classList.toggle('selected', chk.checked);
        updateSharedPreview();
      });

      const name = document.createElement('span');
      name.className = 'dd-shared-row-name';
      name.textContent = d.name;

      const meta = document.createElement('span');
      meta.className = 'dd-shared-row-meta';
      meta.textContent = d.totals.outstanding > 0
        ? `pendiente ${fmt(d.totals.outstanding)}`
        : 'al dia';

      row.appendChild(chk);
      row.appendChild(name);
      row.appendChild(meta);
      $sharedList.appendChild(row);
    });
  }

  function updateSharedPreview() {
    const n = sharedSelected.size;
    $sharedCount.textContent = `${n} seleccionado(s)`;
    const total = Number($sharedTotal.value);
    if (!(total > 0) || n === 0) { $sharedPreview.textContent = ''; return; }
    const includeMe = $sharedIncludeMe.checked;
    const shares = includeMe ? n + 1 : n;
    const per = Math.round((total / shares) * 100) / 100;
    if (includeMe) {
      const myShare = Math.round((total - per * n) * 100) / 100;
      $sharedPreview.textContent =
        `Cada deudor recibe ${fmt(per)} · tu parte ${fmt(myShare)} · total ${fmt(total)} entre ${shares} (incluyendote)`;
    } else {
      $sharedPreview.textContent = `Cada deudor recibe ${fmt(per)} · total ${fmt(total)} entre ${shares}`;
    }
  }

  async function saveSharedDebt() {
    const description = $sharedDesc.value.trim();
    const total = $sharedTotal.value;
    const date = $sharedDate.value || todayISO();
    const debtorIds = Array.from(sharedSelected);

    if (!description) {
      $sharedStatus.className = 'status show error';
      $sharedStatus.textContent = 'Ingresa una descripcion.';
      $sharedDesc.focus(); return;
    }
    if (!(Number(total) > 0)) {
      $sharedStatus.className = 'status show error';
      $sharedStatus.textContent = 'Ingresa un monto total mayor a 0.';
      $sharedTotal.focus(); return;
    }
    if (!debtorIds.length) {
      $sharedStatus.className = 'status show error';
      $sharedStatus.textContent = 'Selecciona al menos un deudor.';
      return;
    }

    $sharedSave.disabled = true;
    try {
      const includeMe = $sharedIncludeMe.checked;
      const res = await run(window.api.deudas.addSharedDebt({ description, totalAmount: total, date, debtorIds, includeMe }));
      const s = res && res.summary;
      setStatus('success', s
        ? (s.includeMe
            ? `Agregada "${s.description}" a ${s.count} deudor(es) — ${fmt(s.perPerson)} c/u (tu parte ${fmt(s.myShare)}, sin deuda).`
            : `Agregada "${s.description}" a ${s.count} deudor(es) — ${fmt(s.perPerson)} c/u.`)
        : 'Gasto compartido agregado.');
      closeSharedModal();
    } catch (_) {
      $sharedStatus.className = 'status show error';
      $sharedStatus.textContent = $status.textContent || 'No se pudo agregar.';
    } finally {
      $sharedSave.disabled = false;
    }
  }

  async function doBackup() {
    $backup.disabled = true;
    try {
      const r = await window.api.deudas.backup();
      if (!r.ok) throw new Error(r.error);
      if (!r.data) { setStatus('', ''); return; } // cancelado
      setStatus('success', `Respaldo guardado (${r.data.debtors} deudor/es).`);
      try { window.api.showInFolder(r.data.path); } catch (_) { /* ignore */ }
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      $backup.disabled = false;
    }
  }

  async function doRestore() {
    if (!confirm('Restaurar reemplaza TODOS los datos actuales por los del respaldo. ' +
                 'Se guardara una copia de seguridad de lo actual en deudas.json.bak. ¿Continuar?')) return;
    $restore.disabled = true;
    try {
      const res = await run(window.api.deudas.restore());
      if (res === null) { setStatus('', ''); return; } // cancelado
      setStatus('success', `Datos restaurados (${res.debtors} deudor/es).`);
    } catch (_) { /* status ya seteado */ }
    finally { $restore.disabled = false; }
  }

  /* ---------- Actions: registrar pago ---------- */

  function openPaymentModal() {
    const d = selectedDebtor();
    if (!d) return;
    $payName.textContent = d.name;
    $payPending.textContent = fmt(d.totals.outstanding);
    $payCredit.textContent = fmt(d.totals.credit);
    $payAmount.value = '';
    $payDate.value = '';
    $payNote.value = '';
    $payPreview.textContent = '';
    $payStatus.className = 'status';
    $payStatus.textContent = '';
    $payModal.classList.remove('hidden');
    $payModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => $payAmount.focus(), 30);
  }

  function closePaymentModal() {
    $payModal.classList.add('hidden');
    $payModal.setAttribute('aria-hidden', 'true');
  }

  // Simula localmente el resultado del pago (cuantas deudas cubre y el saldo).
  function updatePaymentPreview() {
    const d = selectedDebtor();
    if (!d) return;
    const amt = Number($payAmount.value);
    if (!(amt > 0)) { $payPreview.textContent = ''; return; }
    let pool = d.totals.credit + amt;
    const unpaid = d.debts.filter(x => !x.paid)
      .map(x => Number(x.remaining != null ? x.remaining : x.amount))
      .sort((a, b) => a - b);
    let covered = 0;
    for (const a of unpaid) { if (pool + 1e-9 >= a) { pool -= a; covered++; } else break; }
    const left = unpaid.length - covered;
    const parts = [`Cubre ${covered} de ${unpaid.length} deuda(s)`];
    if (pool > 1e-9 && left > 0) parts.push(`reduce la deuda mas grande en ${fmt(pool)}`);
    else if (pool > 1e-9) parts.push(`saldo a favor ${fmt(pool)}`);
    if (left > 0) parts.push(`quedan ${left} pendiente(s)`);
    $payPreview.textContent = parts.join(' · ');
  }

  async function savePayment() {
    const d = selectedDebtor();
    if (!d) return;
    const amount = $payAmount.value;
    if (!(Number(amount) > 0)) {
      $payStatus.className = 'status show error';
      $payStatus.textContent = 'Ingresa un monto mayor a 0.';
      $payAmount.focus();
      return;
    }
    $paySave.disabled = true;
    try {
      const res = await run(window.api.deudas.registerPayment(d.id, amount, $payNote.value, $payDate.value || null));
      const s = res && res.summary;
      setStatus('success', s
        ? `Pago aplicado: cubrio ${s.covered} deuda(s)${s.credit > 0 ? `, saldo a favor ${fmt(s.credit)}` : ''}.`
        : 'Pago aplicado.');
      closePaymentModal();
    } catch (_) {
      $payStatus.className = 'status show error';
      $payStatus.textContent = $status.textContent || 'No se pudo registrar el pago.';
    } finally {
      $paySave.disabled = false;
    }
  }

  /* ---------- Wire ---------- */

  $import.addEventListener('click', doImport);
  $backup.addEventListener('click', doBackup);
  $restore.addEventListener('click', doRestore);
  $shared.addEventListener('click', openSharedModal);
  if ($copyAccount) $copyAccount.addEventListener('click', copyAccount);
  $pay.addEventListener('click', openPaymentModal);

  $sharedSearch.addEventListener('input', renderSharedList);
  $sharedTotal.addEventListener('input', updateSharedPreview);
  $sharedIncludeMe.addEventListener('change', updateSharedPreview);
  $sharedAll.addEventListener('click', () => {
    state.debtors.forEach(d => sharedSelected.add(d.id));
    renderSharedList(); updateSharedPreview();
  });
  $sharedNone.addEventListener('click', () => {
    sharedSelected.clear();
    renderSharedList(); updateSharedPreview();
  });
  $sharedSave.addEventListener('click', saveSharedDebt);
  $sharedModal.addEventListener('click', (ev) => {
    if (ev.target && ev.target.dataset && ev.target.dataset.ddsClose) closeSharedModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$sharedModal.classList.contains('hidden')) closeSharedModal();
  });
  $exportMany.addEventListener('click', openExportModal);
  $exportSearch.addEventListener('input', renderExportList);
  $exportAll.addEventListener('click', () => {
    state.debtors.forEach(d => exportSelected.add(d.id));
    renderExportList(); updateExportPreview();
  });
  $exportNone.addEventListener('click', () => {
    exportSelected.clear();
    renderExportList(); updateExportPreview();
  });
  $exportGo.addEventListener('click', doExportMany);
  $exportModal.addEventListener('click', (ev) => {
    if (ev.target && ev.target.dataset && ev.target.dataset.ddeClose) closeExportModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$exportModal.classList.contains('hidden')) closeExportModal();
  });

  $export.addEventListener('click', doExport);
  $payAmount.addEventListener('input', updatePaymentPreview);
  $paySave.addEventListener('click', savePayment);
  $payModal.addEventListener('click', (ev) => {
    if (ev.target && ev.target.dataset && ev.target.dataset.ddpClose) closePaymentModal();
  });
  $payNote.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') savePayment(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$payModal.classList.contains('hidden')) closePaymentModal();
  });

  $addDebtor.addEventListener('click', () => openDebtorModal('add'));
  $editDebtor.addEventListener('click', () => openDebtorModal('edit'));
  $delDebtor.addEventListener('click', removeDebtor);
  $search.addEventListener('input', renderList);
  $debtForm.addEventListener('submit', addDebt);

  $tabs.forEach(t => t.addEventListener('click', () => { activeTab = t.dataset.tab; renderDetail(); }));

  $modalSave.addEventListener('click', saveDebtor);
  $modal.addEventListener('click', (ev) => {
    if (ev.target && ev.target.dataset && ev.target.dataset.ddClose) closeDebtorModal();
  });
  $modalName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveDebtor(); });
  $modalNote.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveDebtor(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$modal.classList.contains('hidden')) closeDebtorModal();
  });

  /* ---------- Tabs de modo (Deudas de terceros / Gastos fijos mias) ---------- */

  const $modeTabs     = Array.from(document.querySelectorAll('.dd-mode-tab'));
  const $modeTerceros = document.getElementById('dd-mode-terceros');
  const $modeMias      = document.getElementById('dd-mode-mias');

  if ($modeTabs.length) {
    $modeTabs.forEach(t => t.addEventListener('click', () => {
      $modeTabs.forEach(x => x.classList.toggle('active', x === t));
      const mode = t.dataset.mode;
      $modeTerceros.classList.toggle('hidden', mode !== 'terceros');
      $modeMias.classList.toggle('hidden', mode !== 'mias');
      if (mode === 'mias' && window.__misGastos) window.__misGastos.ensureLoaded();
    }));
  }

  /* ---------- Carga lazy (al entrar a la seccion) ---------- */

  function showLoading(on) {
    if ($loading) $loading.classList.toggle('hidden', !on);
    if ($body) $body.classList.toggle('hidden', on);
  }

  // Trae los datos una sola vez, la primera vez que se entra a Deudas.
  async function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    clearStatus();
    showLoading(true);
    try {
      const r = await window.api.deudas.get();
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

  // El router (app.js) emite 'view:change' al activar una vista.
  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.view === 'deudas') ensureLoaded();
  });

  // Defensivo: si Deudas ya estuviera activa al cargar la pagina.
  if (document.getElementById('view-deudas').classList.contains('active')) ensureLoaded();
})();
