'use strict';

(function () {
  /* ---------- DOM refs ---------- */

  const $envBadge   = document.getElementById('gu-env-badge');
  const $search     = document.getElementById('gu-search');
  const $load       = document.getElementById('gu-load');
  const $clearBtn   = document.getElementById('gu-clear');
  const $count      = document.getElementById('gu-count');
  const $spinner    = document.getElementById('gu-spinner');
  const $envSummary = document.getElementById('gu-env-summary');
  const $status     = document.getElementById('gu-status');
  const $tbody      = document.getElementById('gu-tbody');
  const $log        = document.getElementById('gu-log');

  const $modal           = document.getElementById('gu-edit-modal');
  const $modalTitle      = document.getElementById('gu-edit-title');
  const $editId          = document.getElementById('gu-edit-id');
  const $editDisplay     = document.getElementById('gu-edit-display');
  const $editIdentities  = document.getElementById('gu-edit-identities');
  const $editFields      = document.getElementById('gu-edit-fields');
  const $editChanged     = document.getElementById('gu-edit-changed');
  const $editStatus      = document.getElementById('gu-edit-status');
  const $editSave        = document.getElementById('gu-edit-save');
  const $editReset       = document.getElementById('gu-edit-reset');

  if (!$envBadge) return;

  function currentEnv() { return window.__envSelector.get(); }

  function renderEnvBadge() {
    const env = currentEnv();
    $envBadge.textContent = 'Ambiente: ' + env;
    $envBadge.className = 'env-badge ' + (env === 'Produccion' ? 'env-produccion' : 'env-testing');
  }

  /* ---------- State ---------- */

  let envsData          = null;
  let allUsers          = [];
  let filteredUsers     = [];
  let currentEnvForList = null;
  let extensionAppId    = '';
  let extensionProps    = [];

  // Edit-modal state
  let editingUser = null;
  let original    = {};       // { graphKey: rawOriginalValue }
  let inputs      = {};       // { graphKey: { el, kind, def } }
  let dirty       = new Set();

  /* ---------- Helpers ---------- */

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  const setEditStatus = (kind, msg) => {
    $editStatus.className = `status show ${kind}`;
    $editStatus.textContent = msg;
  };
  const clearEditStatus = () => { $editStatus.className = 'status'; $editStatus.textContent = ''; };

  function appendLog(kind, message, ts) {
    const line = document.createElement('div');
    line.className = `log-line log-${kind}`;
    const time = new Date(ts || Date.now()).toLocaleTimeString();
    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = `[${time}] ${kind.toUpperCase()}`;
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = ' ' + message;
    line.appendChild(tag);
    line.appendChild(msg);
    $log.appendChild(line);
    $log.scrollTop = $log.scrollHeight;
  }

  function pickEmail(u) {
    const ids = Array.isArray(u.identities) ? u.identities : [];
    const email = ids.find(i => i.signInType === 'emailAddress');
    return email ? (email.issuerAssignedId || '') : '';
  }

  function extKey(propName) {
    return extensionAppId ? `extension_${extensionAppId}_${propName}` : null;
  }

  function getExtVal(user, propName) {
    const k = extKey(propName);
    return (k && user && user[k] !== undefined) ? user[k] : null;
  }

  /* ---------- Env summary + bootstrap ---------- */

  function renderEnvSummary() {
    if (!envsData) { $envSummary.textContent = ''; return; }
    const s = envsData.summaries[currentEnv()] || {};
    const parts = [
      `tenant: ${s.tenantId || '(falta)'}`,
      `client_id: ${s.clientId || '(falta)'}`,
      `extensionAppId: ${s.extensionAppId || '(falta)'}`,
      s.configured ? '[CONFIGURADO]' : '[INCOMPLETO - completar en Configuracion -> Graph Users]'
    ];
    $envSummary.textContent = parts.join(' · ');
    $envSummary.classList.toggle('gu-env-summary-missing', !s.configured);
  }

  async function bootstrap() {
    try {
      const r = await window.api.graphUsers.envs();
      if (!r.ok) throw new Error(r.error);
      envsData = r.data;
      extensionProps = envsData.extensionProps || [];
      renderEnvBadge();
      renderEnvSummary();
    } catch (e) {
      setStatus('error', 'Error cargando ambientes: ' + e.message);
    }
  }

  /* ---------- Filter + table render ---------- */

  function userMatches(u, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    const haystacks = [
      u.id, u.displayName, u.userPrincipalName, u.mailNickname,
      u.userType, u.givenName, u.surname, u.mail, u.mobilePhone
    ];
    for (const h of haystacks) {
      if (h && String(h).toLowerCase().includes(needle)) return true;
    }
    const ids = Array.isArray(u.identities) ? u.identities : [];
    if (ids.some(i => (i.issuerAssignedId || '').toLowerCase().includes(needle))) return true;
    const doc = getExtVal(u, 'Documento');
    if (doc != null && String(doc).toLowerCase().includes(needle)) return true;
    return false;
  }

  function applyFilter() {
    const q = $search.value.trim();
    filteredUsers = allUsers.filter(u => userMatches(u, q));
    renderRows();
  }

  function renderRows() {
    $tbody.innerHTML = '';
    $count.textContent = String(filteredUsers.length);

    if (!filteredUsers.length) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 8;
      td.textContent = allUsers.length
        ? 'Sin coincidencias para el filtro actual.'
        : 'Apreta "Cargar usuarios" para traer el directorio del ambiente seleccionado.';
      tr.appendChild(td);
      $tbody.appendChild(tr);
      return;
    }

    // Cap render to 500 rows for responsiveness; refine search to see more.
    const CAP = 500;
    const slice = filteredUsers.slice(0, CAP);
    slice.forEach(u => {
      const tr = document.createElement('tr');
      const email  = pickEmail(u);
      const doc    = getExtVal(u, 'Documento');
      const tenant = getExtVal(u, 'TenantId');
      const cells = [
        { v: u.displayName || '',       mono: false },
        { v: email,                     mono: true  },
        { v: u.userPrincipalName || '', mono: true  },
        { v: doc == null ? '' : String(doc), mono: false },
        { v: tenant == null ? '' : String(tenant), mono: false },
        { v: u.userType || '',          mono: false },
        { v: u.id || '',                mono: true  }
      ];
      cells.forEach(({ v, mono }) => {
        const td = document.createElement('td');
        if (mono) td.className = 'mono';
        td.textContent = v;
        td.title = v;
        tr.appendChild(td);
      });
      const tdAct = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.type = 'button';
      btn.textContent = 'Editar';
      btn.addEventListener('click', () => openEdit(u));
      tdAct.appendChild(btn);
      tr.appendChild(tdAct);
      $tbody.appendChild(tr);
    });

    if (filteredUsers.length > CAP) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 8;
      td.textContent = `Mostrando ${CAP} de ${filteredUsers.length}. Refina el filtro para ver mas resultados.`;
      tr.appendChild(td);
      $tbody.appendChild(tr);
    }
  }

  /* ---------- Load users ---------- */

  async function loadUsers() {
    clearStatus();
    $log.innerHTML = '';
    allUsers = [];
    filteredUsers = [];
    renderRows();

    $load.disabled = true;
    $clearBtn.disabled = true;
    $spinner.classList.remove('hidden');
    setStatus('loading', 'Solicitando token y trayendo usuarios...');

    const off = window.api.graphUsers.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.graphUsers.list({ env: currentEnv() });
      if (!r.ok) throw new Error(r.error);
      allUsers = Array.isArray(r.data.users) ? r.data.users : [];
      currentEnvForList = r.data.env;
      extensionAppId = r.data.extensionAppId || '';
      extensionProps = r.data.extensionProps || extensionProps;
      applyFilter();
      setStatus('success', `Usuarios cargados: ${allUsers.length} (env=${currentEnvForList}).`);
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      off && off();
      $load.disabled = false;
      $clearBtn.disabled = false;
      $spinner.classList.add('hidden');
    }
  }

  /* ---------- Edit modal ---------- */

  function fmtValueForInput(value, kind) {
    if (value === null || value === undefined) return '';
    if (kind === 'json') {
      try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return JSON.stringify(parsed, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  function parseValueForPatch(text, kind) {
    if (kind === 'boolean') return Boolean(text);
    if (kind === 'number') {
      if (text === '' || text === null || text === undefined) return null;
      const n = Number(text);
      if (Number.isNaN(n)) throw new Error('Valor numerico invalido.');
      return n;
    }
    if (kind === 'json') {
      // Graph stores extension_..._Roles como STRING con JSON adentro. Lo validamos
      // parseando y re-stringificando, para mandar un JSON canonico de una linea.
      const trimmed = (text || '').trim();
      if (trimmed === '') return null;
      const parsed = JSON.parse(trimmed); // throws on invalid JSON
      return JSON.stringify(parsed);
    }
    // string
    if (text === '') return null;
    return text;
  }

  function valuesEqual(a, b, kind) {
    if (kind === 'boolean') return Boolean(a) === Boolean(b);
    if (kind === 'number') {
      const norm = (v) => (v === '' || v === null || v === undefined) ? null : Number(v);
      return norm(a) === norm(b);
    }
    if (kind === 'json') {
      const norm = (v) => {
        if (v === null || v === undefined || v === '') return '';
        try {
          const p = typeof v === 'string' ? JSON.parse(v) : v;
          return JSON.stringify(p);
        } catch {
          return String(v);
        }
      };
      return norm(a) === norm(b);
    }
    const sa = (a === null || a === undefined) ? '' : String(a);
    const sb = (b === null || b === undefined) ? '' : String(b);
    return sa === sb;
  }

  function buildEditableFields() {
    const fields = [
      { key: 'displayName',       label: 'displayName',       kind: 'string'  },
      { key: 'givenName',         label: 'givenName',         kind: 'string'  },
      { key: 'surname',           label: 'surname',           kind: 'string'  },
      { key: 'userPrincipalName', label: 'userPrincipalName', kind: 'string', risky: true },
      { key: 'mailNickname',      label: 'mailNickname',      kind: 'string', risky: true },
      { key: 'userType',          label: 'userType',          kind: 'string'  },
      { key: 'mobilePhone',       label: 'mobilePhone',       kind: 'string'  },
      { key: 'mail',              label: 'mail',              kind: 'string'  },
      { key: 'accountEnabled',    label: 'accountEnabled',    kind: 'boolean' }
    ];
    extensionProps.forEach(ep => {
      const k = extKey(ep.graph);
      if (!k) return;
      fields.push({
        key: k,
        label: `${ep.logical} (extension)`,
        kind: ep.kind,
        extension: true
      });
    });
    return fields;
  }

  function renderEditFields(user) {
    $editFields.innerHTML = '';
    inputs = {};
    original = {};
    dirty = new Set();

    const defs = buildEditableFields();

    if (!extensionAppId && defs.every(d => !d.extension)) {
      const warn = document.createElement('div');
      warn.className = 'gu-edit-warn';
      warn.textContent = 'Sin extensionAppId configurado para este ambiente: las extension_* properties no se muestran.';
      $editFields.appendChild(warn);
    }

    defs.forEach(def => {
      const baseValue = (user[def.key] === undefined) ? null : user[def.key];
      original[def.key] = baseValue;

      const wrap = document.createElement('div');
      wrap.className = 'gu-field';
      if (def.extension) wrap.classList.add('gu-field-ext');
      if (def.risky)     wrap.classList.add('gu-field-risky');

      const label = document.createElement('label');
      label.textContent = def.label;
      label.title = def.key;
      wrap.appendChild(label);

      let input;
      if (def.kind === 'boolean') {
        const ck = document.createElement('label');
        ck.className = 'gu-check';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(baseValue);
        const t = document.createElement('span');
        t.textContent = input.checked ? 'true' : 'false';
        input.addEventListener('change', () => { t.textContent = input.checked ? 'true' : 'false'; });
        ck.appendChild(input);
        ck.appendChild(t);
        wrap.appendChild(ck);
      } else if (def.kind === 'number') {
        input = document.createElement('input');
        input.type = 'number';
        input.step = 'any';
        input.value = baseValue == null ? '' : String(baseValue);
        input.className = 'gu-input';
        wrap.appendChild(input);
      } else if (def.kind === 'json') {
        input = document.createElement('textarea');
        input.rows = 5;
        input.value = fmtValueForInput(baseValue, 'json');
        input.className = 'gu-input gu-input-json';
        input.spellcheck = false;
        wrap.appendChild(input);
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = baseValue == null ? '' : String(baseValue);
        input.className = 'gu-input';
        wrap.appendChild(input);
      }
      input.dataset.key = def.key;
      input.addEventListener(def.kind === 'boolean' ? 'change' : 'input', () => onFieldChange(def.key));

      inputs[def.key] = { el: input, kind: def.kind, def };
      $editFields.appendChild(wrap);
    });

    updateChangedSummary();
  }

  function onFieldChange(key) {
    const info = inputs[key];
    if (!info) return;
    const cur = (info.kind === 'boolean') ? info.el.checked : info.el.value;
    let isDirty = false;
    try {
      isDirty = !valuesEqual(cur, original[key], info.kind);
    } catch {
      isDirty = true;
    }
    if (info.kind === 'json' && info.el.value.trim()) {
      try { JSON.parse(info.el.value); info.el.classList.remove('gu-input-invalid'); }
      catch { info.el.classList.add('gu-input-invalid'); }
    } else {
      info.el.classList.remove('gu-input-invalid');
    }
    const wrap = info.el.closest('.gu-field');
    if (wrap) wrap.classList.toggle('gu-field-dirty', isDirty);
    if (isDirty) dirty.add(key); else dirty.delete(key);
    updateChangedSummary();
  }

  function updateChangedSummary() {
    $editSave.disabled = dirty.size === 0;
    if (!dirty.size) {
      $editChanged.textContent = 'Sin cambios. Modifica un campo para habilitar el guardado.';
      $editChanged.classList.remove('has-changes');
      return;
    }
    const names = [...dirty].map(k => inputs[k] && inputs[k].def.label).filter(Boolean);
    $editChanged.classList.add('has-changes');
    $editChanged.textContent = `Cambios pendientes (${dirty.size}): ${names.join(', ')}`;
  }

  function openEdit(user) {
    editingUser = user;
    $modalTitle.textContent = `Editar: ${user.displayName || user.id}`;
    $editId.textContent = user.id || '';
    $editDisplay.textContent = user.displayName || '';
    const ids = Array.isArray(user.identities) ? user.identities : [];
    $editIdentities.textContent = ids.length
      ? ids.map(i => `${i.signInType}=${i.issuerAssignedId}  (${i.issuer})`).join('   |   ')
      : '(sin identities)';
    renderEditFields(user);
    clearEditStatus();
    $modal.classList.remove('hidden');
    $modal.setAttribute('aria-hidden', 'false');
  }

  function closeEdit() {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
    editingUser = null;
  }

  function resetEdit() {
    if (editingUser) renderEditFields(editingUser);
    clearEditStatus();
  }

  async function saveEdit() {
    if (!editingUser) return;
    if (!dirty.size) { setEditStatus('error', 'Sin cambios.'); return; }

    const updates = {};
    try {
      for (const key of dirty) {
        const info = inputs[key];
        const raw = (info.kind === 'boolean') ? info.el.checked : info.el.value;
        updates[key] = parseValueForPatch(raw, info.kind);
      }
    } catch (e) {
      setEditStatus('error', `JSON invalido: ${e.message}`);
      return;
    }

    $editSave.disabled = true;
    $editReset.disabled = true;
    setEditStatus('loading', 'Aplicando PATCH...');

    const off = window.api.graphUsers.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.graphUsers.patch({
        env: currentEnvForList || currentEnv(),
        id: editingUser.id,
        updates
      });
      if (!r.ok) throw new Error(r.error);
      Object.assign(editingUser, updates);
      applyFilter();
      setEditStatus('success', `PATCH OK (HTTP ${r.data.status}). Campos: ${r.data.updatedKeys.join(', ')}`);
      renderEditFields(editingUser);
    } catch (e) {
      setEditStatus('error', e.message);
    } finally {
      off && off();
      $editSave.disabled = dirty.size === 0;
      $editReset.disabled = false;
    }
  }

  /* ---------- Wire ---------- */

  document.addEventListener('env:change', () => {
    renderEnvBadge();
    renderEnvSummary();
    if (allUsers.length && currentEnvForList !== currentEnv()) {
      setStatus('error', `La lista en pantalla es del ambiente "${currentEnvForList}". Apreta "Cargar usuarios" para refrescar con "${currentEnv()}".`);
    }
  });
  $load.addEventListener('click', loadUsers);
  $clearBtn.addEventListener('click', () => {
    allUsers = [];
    filteredUsers = [];
    currentEnvForList = null;
    $search.value = '';
    renderRows();
    clearStatus();
    $log.innerHTML = '';
  });
  $search.addEventListener('input', applyFilter);
  $search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (!allUsers.length) loadUsers();
    }
  });

  $editSave.addEventListener('click', saveEdit);
  $editReset.addEventListener('click', resetEdit);
  $modal.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.dataset && t.dataset.guClose) closeEdit();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$modal.classList.contains('hidden')) closeEdit();
  });

  bootstrap();
})();
