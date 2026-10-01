'use strict';

(function () {
  const $refresh      = document.getElementById('os-refresh');
  const $clearFilt    = document.getElementById('os-clear-filters');
  const $count        = document.getElementById('os-count');
  const $spinner      = document.getElementById('os-spinner');
  const $configSum    = document.getElementById('os-config-summary');
  const $status       = document.getElementById('os-status');
  const $tbody        = document.getElementById('os-tbody');
  const $thead        = document.querySelector('#os-table thead');
  const $log          = document.getElementById('os-log');
  const $modal        = document.getElementById('os-send-modal');
  const $modalUser    = document.getElementById('os-target-user');
  const $modalHandle  = document.getElementById('os-target-handle');
  const $title        = document.getElementById('os-title');
  const $message      = document.getElementById('os-message');
  const $subtitle     = document.getElementById('os-subtitle');
  const $largeIcon    = document.getElementById('os-large-icon');
  const $bigPicture   = document.getElementById('os-big-picture');
  const $url          = document.getElementById('os-url');
  const $dataJson     = document.getElementById('os-data');
  const $templateId   = document.getElementById('os-template-id');
  const $customWrap   = document.getElementById('os-custom-fields');
  const $modeTabs     = $modal.querySelectorAll('.os-mode-tab');
  const $sendBtn      = document.getElementById('os-send');
  const $sendStatus   = document.getElementById('os-send-status');

  let sendMode = 'standard'; // 'standard' | 'custom'

  if (!$refresh) return;

  // Cap de filas pintadas en el DOM. El filtro contempla TODOS los devices,
  // pero solo se materializan los primeros N. Si la query devuelve mucho mas,
  // se muestra un indicador "mostrando X de Y".
  const MAX_RENDER_ROWS = 500;

  let devices = [];
  let filtered = [];
  let currentTarget = null;

  // Cache de filtros por columna. Las claves coinciden con data-filter del HTML.
  const filters = {
    usuarioId: '', documento: '', email: '', celular: '', plataforma: '', pnsHandle: ''
  };

  /* ---------- Status helpers ---------- */

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  const setSendStatus = (kind, msg) => {
    $sendStatus.className = `status show ${kind}`;
    $sendStatus.textContent = msg;
  };
  const clearSendStatus = () => { $sendStatus.className = 'status'; $sendStatus.textContent = ''; };

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

  function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length <= n ? s : s.slice(0, n) + '...';
  }

  /* ---------- Filtering ---------- */

  // Extrae el string buscable de un device para una columna dada.
  // Se calcula una sola vez por device (cache en _searchCache).
  function fieldValue(dev, key) {
    if (!dev._searchCache) {
      const cel = dev.usuario && (dev.usuario.Celular || dev.usuario.celular) || '';
      dev._searchCache = {
        usuarioId:  dev.usuarioId == null ? '' : String(dev.usuarioId).toLowerCase(),
        documento:  (dev.documento  || '').toLowerCase(),
        email:      (dev.email      || '').toLowerCase(),
        celular:    String(cel).toLowerCase(),
        plataforma: (dev.plataforma || '').toLowerCase(),
        pnsHandle:  (dev.pnsHandle  || '').toLowerCase()
      };
    }
    return dev._searchCache[key] || '';
  }

  function matches(dev) {
    // AND entre columnas. Vacio = no filtra esa columna.
    for (const k of Object.keys(filters)) {
      const q = filters[k];
      if (!q) continue;
      if (!fieldValue(dev, k).includes(q)) return false;
    }
    return true;
  }

  function applyFilters() {
    filtered = devices.filter(matches);
    renderRows();
  }

  // Debounce para que escribir rapido no congele la UI.
  let filterTimer = null;
  function scheduleApply() {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { filterTimer = null; applyFilters(); }, 180);
  }

  /* ---------- Render ---------- */

  function renderRows() {
    const total = filtered.length;
    const cap = Math.min(total, MAX_RENDER_ROWS);
    $count.textContent = total > cap ? `${cap} / ${total}` : String(total);

    // Vaciar tbody sin layout thrashing.
    $tbody.replaceChildren();

    if (!total) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = devices.length === 0
        ? 'Sin dispositivos cargados. Apreta "Recargar".'
        : 'Sin resultados para los filtros actuales.';
      tr.appendChild(td);
      $tbody.appendChild(tr);
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < cap; i++) {
      const d = filtered[i];
      const tr = document.createElement('tr');
      const hasHandle = !!(d.pnsHandle && String(d.pnsHandle).trim());
      const celular = d.usuario && (d.usuario.Celular || d.usuario.celular) || '';

      tr.dataset.idx = String(i);

      const cells = [
        d.usuarioId == null ? '' : String(d.usuarioId),
        d.documento || '',
        d.email || '',
        celular,
        d.plataforma || '',
        truncate(d.pnsHandle || '', 56)
      ];
      for (let c = 0; c < cells.length; c++) {
        const td = document.createElement('td');
        if (c === 5) {
          td.className = 'mono';
          td.title = d.pnsHandle || '';
        }
        td.textContent = cells[c];
        tr.appendChild(td);
      }

      const tdAct = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.type = 'button';
      btn.textContent = 'Enviar';
      btn.dataset.act = 'send';
      btn.disabled = !hasHandle;
      if (!hasHandle) btn.title = 'PnsHandle vacio';
      tdAct.appendChild(btn);
      tr.appendChild(tdAct);

      frag.appendChild(tr);
    }
    $tbody.appendChild(frag);

    if (total > cap) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = `Mostrando ${cap} de ${total} filas. Refina los filtros para ver el resto.`;
      tr.appendChild(td);
      $tbody.appendChild(tr);
    }
  }

  /* ---------- Filter wiring (delegado) ---------- */

  $thead.addEventListener('input', (ev) => {
    const inp = ev.target;
    if (!inp || !inp.dataset || !inp.dataset.filter) return;
    const key = inp.dataset.filter;
    if (!(key in filters)) return;
    filters[key] = (inp.value || '').trim().toLowerCase();
    // Primera interaccion del usuario con un filtro: recien aca disparamos el
    // fetch a SQL. Antes de esto la seccion no toca la base ni hace nada.
    if (!everLoaded && !loadingDevices) {
      loadDevices();
    } else {
      scheduleApply();
    }
  });

  $clearFilt.addEventListener('click', () => {
    Object.keys(filters).forEach(k => { filters[k] = ''; });
    $thead.querySelectorAll('input[data-filter]').forEach(i => { i.value = ''; });
    if (everLoaded) applyFilters();
  });

  /* ---------- Row action (delegado) ---------- */

  $tbody.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act="send"]');
    if (!btn || btn.disabled) return;
    const tr = btn.closest('tr');
    if (!tr || tr.dataset.idx == null) return;
    const idx = Number(tr.dataset.idx);
    const dev = filtered[idx];
    if (dev) openSendModal(dev);
  });

  /* ---------- Send modal ---------- */

  function setMode(mode) {
    sendMode = (mode === 'custom') ? 'custom' : 'standard';
    $modeTabs.forEach(t => {
      const active = t.dataset.mode === sendMode;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $customWrap.classList.toggle('hidden', sendMode !== 'custom');
  }

  $modeTabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));

  function openSendModal(dev) {
    if (!dev || !dev.pnsHandle || !String(dev.pnsHandle).trim()) {
      setStatus('error', 'Ese dispositivo no tiene PnsHandle valido.');
      return;
    }
    currentTarget = dev;
    $modalUser.textContent = [dev.displayName, dev.email, dev.documento]
      .filter(Boolean).join(' · ') || `UsuarioId ${dev.usuarioId}`;
    $modalHandle.textContent = dev.pnsHandle;
    $title.value = '';
    $message.value = '';
    $subtitle.value = '';
    $largeIcon.value = '';
    $bigPicture.value = '';
    $url.value = '';
    $dataJson.value = '';
    $templateId.value = '';
    setMode('standard');
    clearSendStatus();
    $sendBtn.disabled = false;
    $modal.classList.remove('hidden');
    $modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => $title.focus(), 30);
  }

  function closeSendModal() {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
    currentTarget = null;
  }

  $modal.addEventListener('click', (ev) => {
    if (ev.target.dataset && ev.target.dataset.osClose) closeSendModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$modal.classList.contains('hidden')) closeSendModal();
  });

  function isHttpUrl(s) {
    if (!s) return false;
    try {
      const u = new URL(String(s).trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) { return false; }
  }

  $sendBtn.addEventListener('click', async () => {
    if (!currentTarget) return;
    if (!currentTarget.pnsHandle || !String(currentTarget.pnsHandle).trim()) {
      setSendStatus('error', 'PnsHandle invalido.');
      return;
    }

    const title = ($title.value || '').trim();
    const message = ($message.value || '').trim();
    const payload = {
      pnsHandle: currentTarget.pnsHandle,
      title,
      message
    };

    if (sendMode === 'custom') {
      const subtitle   = ($subtitle.value   || '').trim();
      const largeIcon  = ($largeIcon.value  || '').trim();
      const bigPicture = ($bigPicture.value || '').trim();
      const url        = ($url.value        || '').trim();
      const dataRaw    = ($dataJson.value   || '').trim();
      const templateId = ($templateId.value || '').trim();

      // Validacion de URLs opcionales
      for (const [name, val] of [['URL al tocar', url], ['Icono grande', largeIcon], ['Imagen grande', bigPicture]]) {
        if (val && !isHttpUrl(val)) {
          setSendStatus('error', `${name}: debe ser una URL http/https valida.`);
          return;
        }
      }

      // Parseo del JSON data
      let dataObj = null;
      if (dataRaw) {
        try {
          dataObj = JSON.parse(dataRaw);
        } catch (e) {
          setSendStatus('error', 'El payload "data" no es JSON valido: ' + e.message);
          $dataJson.focus();
          return;
        }
        if (typeof dataObj !== 'object' || Array.isArray(dataObj) || dataObj === null) {
          setSendStatus('error', 'El payload "data" debe ser un objeto JSON plano.');
          return;
        }
      }

      // Title/message obligatorios salvo que se use templateId
      if (!templateId) {
        if (!title) { setSendStatus('error', 'El titulo es requerido.'); $title.focus(); return; }
        if (!message) { setSendStatus('error', 'El mensaje es requerido.'); $message.focus(); return; }
      }

      if (subtitle)   payload.subtitle = subtitle;
      if (largeIcon)  payload.largeIcon = largeIcon;
      if (bigPicture) payload.bigPicture = bigPicture;
      if (url)        payload.url = url;
      if (dataObj)    payload.data = dataObj;
      if (templateId) payload.templateId = templateId;
    } else {
      // Standard mode: ambos requeridos
      if (!title) { setSendStatus('error', 'El titulo es requerido.'); $title.focus(); return; }
      if (!message) { setSendStatus('error', 'El mensaje es requerido.'); $message.focus(); return; }
    }

    $sendBtn.disabled = true;
    setSendStatus('loading', 'Enviando...');

    const off = window.api.oneSignal.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.oneSignal.send(payload);
      if (!r.ok) throw new Error(r.error);

      const recipients = r.data && typeof r.data.recipients === 'number' ? r.data.recipients : null;
      if (recipients === 0) {
        setSendStatus('warn', 'OneSignal acepto el request pero no encontro el dispositivo (recipients=0).');
      } else {
        setSendStatus('success', `Enviado. id=${r.data && r.data.id ? r.data.id : '?'} · recipients=${recipients == null ? '?' : recipients}`);
        setTimeout(closeSendModal, 1200);
      }
    } catch (e) {
      setSendStatus('error', e.message);
    } finally {
      off && off();
      $sendBtn.disabled = false;
    }
  });

  /* ---------- Load ---------- */

  function setSpinner(on) {
    if (!$spinner) return;
    $spinner.classList.toggle('hidden', !on);
  }

  let configLoaded = false;
  async function loadConfig() {
    if (configLoaded) return;
    try {
      const r = await window.api.oneSignal.config();
      if (!r.ok) throw new Error(r.error);
      const c = r.data;
      const parts = [];
      if (c.oneSignal && c.oneSignal.appId) parts.push(`AppId: ${c.oneSignal.appId}`);
      if (c.oneSignal && c.oneSignal.apiRestKey) parts.push(`ApiKey: ${c.oneSignal.apiRestKey}`);
      if (c.targeting && c.targeting.pnsHandleAs) parts.push(`mode: ${c.targeting.pnsHandleAs}`);
      $configSum.textContent = parts.join(' · ');
      configLoaded = true;
    } catch (e) {
      $configSum.textContent = '';
      appendLog('warn', 'No se pudo leer config OneSignal: ' + e.message);
    }
  }

  let loadingDevices = false;
  let everLoaded = false;
  async function loadDevices() {
    if (loadingDevices) return;
    loadingDevices = true;
    clearStatus();
    $refresh.disabled = true;
    setSpinner(true);
    // Config se trae solo la primera vez que el usuario interactua (lazy).
    loadConfig();
    $tbody.replaceChildren();
    const loading = document.createElement('tr');
    loading.className = 'os-empty';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = 'Consultando SQL Server...';
    loading.appendChild(td);
    $tbody.appendChild(loading);
    setStatus('loading', 'Consultando dispositivos...');

    const off = window.api.oneSignal.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.oneSignal.listDevices();
      if (!r.ok) throw new Error(r.error);
      devices = (r.data && r.data.devices) || [];
      everLoaded = true;
      applyFilters();
      setStatus('success', `Cargados ${devices.length} dispositivos.`);
    } catch (e) {
      devices = [];
      filtered = [];
      renderRows();
      setStatus('error', e.message);
    } finally {
      off && off();
      $refresh.disabled = false;
      setSpinner(false);
      loadingDevices = false;
    }
  }

  $refresh.addEventListener('click', loadDevices);

  // Nota: NO hay auto-load al entrar a la seccion. La query a SQL Server solo
  // se dispara cuando el usuario clickea "Recargar" o escribe en cualquier
  // filtro. Hasta entonces, la vista esta totalmente inactiva.
})();
