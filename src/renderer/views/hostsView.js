'use strict';

(function () {
  /* ---------- DOM refs ---------- */

  const $gate      = document.getElementById('hosts-admin-gate');
  const $relaunch  = document.getElementById('hosts-admin-relaunch');
  const $reload    = document.getElementById('hosts-reload');
  const $count     = document.getElementById('hosts-count');
  const $status    = document.getElementById('hosts-status');
  const $tbody     = document.getElementById('hosts-tbody');
  const $path      = document.getElementById('hosts-path');
  const $newIp     = document.getElementById('hosts-new-ip');
  const $newRest   = document.getElementById('hosts-new-rest');
  const $add       = document.getElementById('hosts-add');
  const $filterText    = document.getElementById('hosts-filter-text');
  const $filterEnabled = document.getElementById('hosts-filter-enabled');

  if (!$reload) return;

  // Chromium puede restaurar el estado de formularios de una carga previa de este
  // mismo file:// (misma URL => misma entrada de historial), pisando el atributo
  // `checked` del HTML. Se fuerza el default acá para que sea determinístico.
  if ($filterEnabled) $filterEnabled.checked = true;

  /* ---------- State ---------- */

  let entries = [];
  let isAdmin = false;
  let loaded  = false; // datos cargados (lazy, al entrar a la seccion)

  /* ---------- Helpers ---------- */

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  function applyState(state) {
    entries = Array.isArray(state.entries) ? state.entries : [];
    if ($path) $path.textContent = state.path || '';
    loaded = true;
    renderRows();
  }

  /* ---------- Admin gate ---------- */

  function applyAdminState() {
    if ($gate) $gate.classList.toggle('hidden', isAdmin);
    [$newIp, $newRest, $add].forEach((el) => { if (el) el.disabled = !isAdmin; });
    renderRows();
  }

  async function checkAdmin() {
    try {
      const r = await window.api.admin.status();
      isAdmin = !!(r.ok && r.data && r.data.isAdmin);
    } catch (_) {
      isAdmin = false;
    }
    applyAdminState();
  }

  async function relaunchAsAdmin() {
    $relaunch.disabled = true;
    const prev = $relaunch.textContent;
    $relaunch.textContent = 'Abriendo UAC...';
    try {
      const r = await window.api.admin.relaunch();
      if (!r.ok) throw new Error(r.error);
    } catch (e) {
      setStatus('error', `No se pudo reiniciar como administrador: ${e.message}`);
      $relaunch.disabled = false;
      $relaunch.textContent = prev;
    }
  }

  /* ---------- Filtros (client-side, sobre las entries ya cargadas) ---------- */

  function getFilteredEntries() {
    const q = ($filterText ? $filterText.value : '').trim().toLowerCase();
    const showDisabled = $filterEnabled ? $filterEnabled.checked : true;

    return entries.filter((e) => {
      if (!showDisabled && !e.enabled) return false;
      if (!q) return true;
      return e.ip.toLowerCase().includes(q) || e.rest.toLowerCase().includes(q);
    });
  }

  /* ---------- Table render ---------- */

  function renderRows() {
    $tbody.innerHTML = '';
    const filtered = getFilteredEntries();
    $count.textContent = entries.length ? `${filtered.length} / ${entries.length}` : '0';

    if (!filtered.length) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = !loaded
        ? 'Apreta "Recargar" para leer el archivo hosts.'
        : !entries.length
          ? 'El archivo hosts no tiene lineas.'
          : 'Ninguna linea coincide con el filtro.';
      tr.appendChild(td);
      $tbody.appendChild(tr);
      return;
    }

    filtered.forEach((entry) => {
      const tr = document.createElement('tr');
      if (!entry.enabled) tr.classList.add('hosts-row-disabled');

      const tdCheck = document.createElement('td');
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = entry.enabled;
      chk.disabled = !isAdmin;
      chk.title = entry.enabled ? 'Deshabilitar (comentar la linea)' : 'Habilitar (descomentar la linea)';
      chk.addEventListener('change', () => toggleEnabled(entry.index, chk.checked));
      tdCheck.appendChild(chk);
      tr.appendChild(tdCheck);

      const tdIp = document.createElement('td');
      const ipInput = document.createElement('input');
      ipInput.type = 'text';
      ipInput.className = 'mono';
      ipInput.value = entry.ip;
      ipInput.disabled = !isAdmin;
      ipInput.addEventListener('change', () => updateField(entry.index, 'ip', ipInput.value));
      ipInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ipInput.blur(); });
      tdIp.appendChild(ipInput);
      tr.appendChild(tdIp);

      const tdRest = document.createElement('td');
      const restInput = document.createElement('input');
      restInput.type = 'text';
      restInput.value = entry.rest;
      restInput.disabled = !isAdmin;
      restInput.addEventListener('change', () => updateField(entry.index, 'rest', restInput.value));
      restInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') restInput.blur(); });
      tdRest.appendChild(restInput);
      tr.appendChild(tdRest);

      const tdAct = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'btn';
      delBtn.type = 'button';
      delBtn.textContent = 'Eliminar';
      delBtn.disabled = !isAdmin;
      delBtn.addEventListener('click', () => removeRow(entry.index));
      tdAct.appendChild(delBtn);
      tr.appendChild(tdAct);

      $tbody.appendChild(tr);
    });
  }

  /* ---------- Actions ---------- */

  async function load() {
    clearStatus();
    setStatus('loading', 'Leyendo archivo hosts...');
    try {
      const r = await window.api.hosts.get();
      if (!r.ok) throw new Error(r.error);
      applyState(r.data);
      clearStatus();
    } catch (e) {
      setStatus('error', e.message);
    }
  }

  async function toggleEnabled(index, enabled) {
    setStatus('loading', enabled ? 'Habilitando linea...' : 'Deshabilitando linea...');
    try {
      const r = await window.api.hosts.setEnabled(index, enabled);
      if (!r.ok) throw new Error(r.error);
      applyState(r.data);
      setStatus('success', enabled ? 'Linea habilitada.' : 'Linea deshabilitada.');
    } catch (e) {
      setStatus('error', e.message);
      renderRows(); // vuelve al ultimo estado conocido (revierte el checkbox visualmente)
    }
  }

  async function updateField(index, field, value) {
    const current = entries.find((e) => e.index === index);
    if (current && current[field] === value) return; // sin cambios reales
    setStatus('loading', 'Guardando...');
    try {
      const r = await window.api.hosts.update(index, { [field]: value });
      if (!r.ok) throw new Error(r.error);
      applyState(r.data);
      setStatus('success', 'Linea actualizada.');
    } catch (e) {
      setStatus('error', e.message);
      renderRows();
    }
  }

  async function removeRow(index) {
    setStatus('loading', 'Eliminando linea...');
    try {
      const r = await window.api.hosts.remove(index);
      if (!r.ok) throw new Error(r.error);
      applyState(r.data);
      setStatus('success', 'Linea eliminada.');
    } catch (e) {
      setStatus('error', e.message);
    }
  }

  async function addRow() {
    const ip = $newIp.value.trim();
    const rest = $newRest.value.trim();
    if (!ip) { setStatus('error', 'Ingresa al menos una IP / host.'); $newIp.focus(); return; }

    setStatus('loading', 'Agregando linea...');
    try {
      const r = await window.api.hosts.add({ ip, rest, enabled: true });
      if (!r.ok) throw new Error(r.error);
      applyState(r.data);
      $newIp.value = '';
      $newRest.value = '';
      setStatus('success', 'Linea agregada.');
      $newIp.focus();
    } catch (e) {
      setStatus('error', e.message);
    }
  }

  /* ---------- Wire ---------- */

  $reload.addEventListener('click', load);
  $add.addEventListener('click', addRow);
  [$newIp, $newRest].forEach((el) => {
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addRow(); } });
  });
  if ($relaunch) $relaunch.addEventListener('click', relaunchAsAdmin);
  if ($filterText) $filterText.addEventListener('input', renderRows);
  if ($filterEnabled) $filterEnabled.addEventListener('change', renderRows);

  /* ---------- Carga lazy (al entrar a la seccion) ---------- */

  function ensureLoaded() {
    checkAdmin();
    if (!loaded) load();
  }

  // El router (app.js) emite 'view:change' al activar una vista.
  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.view === 'hosts') ensureLoaded();
  });

  // Defensivo: si Hosts ya estuviera activa al cargar la pagina.
  if (document.getElementById('view-hosts').classList.contains('active')) ensureLoaded();
})();
