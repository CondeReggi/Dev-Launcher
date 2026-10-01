'use strict';

/**
 * Vista "OneSignal (directo)". Habla solo con window.api.oneSignalDirect.
 *
 *  - Trae subscriptions de OneSignal (GET /players paginado) y las lista.
 *  - Filtros por columna (id, externalUserId, plataforma, identifier, idioma).
 *  - Tres modos de envio: Masivo (segmento) / Lista seleccionada / Puntual.
 *  - Preview obligatorio: muestra curl + body exacto antes de confirmar envio.
 */
(function () {
  const $refresh     = document.getElementById('osd-refresh');
  if (!$refresh) return;

  const $clearFilt   = document.getElementById('osd-clear-filters');
  const $count       = document.getElementById('osd-count');
  const $deliverable = document.getElementById('osd-deliverable');
  const $onlyRecv    = document.getElementById('osd-only-receivable');
  const $onlyUsers   = document.getElementById('osd-only-users');
  const $spinner     = document.getElementById('osd-spinner');
  const $configSum   = document.getElementById('osd-config-summary');
  const $status      = document.getElementById('osd-status');
  const $jobBanner   = document.getElementById('osd-job-banner');
  const $tbody       = document.getElementById('osd-tbody');
  const $filters     = document.getElementById('osd-filters');
  const $checkAll    = document.getElementById('osd-check-all');
  const $log         = document.getElementById('osd-log');

  const $tabs        = document.querySelectorAll('#view-osDirect .os-mode-tab');
  const $blocks      = document.querySelectorAll('#view-osDirect .osd-target-block');
  const $segment     = document.getElementById('osd-segment');
  const $selCount    = document.getElementById('osd-selected-count');
  const $idType      = document.getElementById('osd-id-type');
  const $idValue     = document.getElementById('osd-id-value');

  const $title       = document.getElementById('osd-title');
  const $message     = document.getElementById('osd-message');
  const $subtitle    = document.getElementById('osd-subtitle');
  const $url         = document.getElementById('osd-url');
  const $largeIcon   = document.getElementById('osd-large-icon');
  const $bigPicture  = document.getElementById('osd-big-picture');
  const $dataJson    = document.getElementById('osd-data');
  const $templateId  = document.getElementById('osd-template-id');

  const $throttle    = document.getElementById('osd-throttle');
  const $ttl         = document.getElementById('osd-ttl');
  const $priority    = document.getElementById('osd-priority');
  const $delayed     = document.getElementById('osd-delayed');
  const $tod         = document.getElementById('osd-tod');
  const $sendAfter   = document.getElementById('osd-send-after');

  const $batch       = document.getElementById('osd-batch');
  const $rate        = document.getElementById('osd-rate');
  const $filtCount   = document.getElementById('osd-filtered-count');
  const $cancelBulk  = document.getElementById('osd-cancel-bulk');
  const bulkSrc = () => {
    const el = document.querySelector('#view-osDirect input[name="osd-bulk-src"]:checked');
    return el ? el.value : 'selected';
  };

  const $previewBtn  = document.getElementById('osd-preview-btn');

  const $modal       = document.getElementById('osd-preview-modal');
  const $pvTarget    = document.getElementById('osd-preview-target-text');
  const $pvUrl       = document.getElementById('osd-preview-url');
  const $pvThrottle  = document.getElementById('osd-preview-throttle');
  const $pvBody      = document.getElementById('osd-preview-body');
  const $pvCurl      = document.getElementById('osd-preview-curl');
  const $pvStatus    = document.getElementById('osd-preview-status');
  const $confirmBtn  = document.getElementById('osd-confirm-send');
  const $bulkHint    = document.getElementById('osd-bulk-hint');

  let lastIsBulk = false;

  const MAX_RENDER_ROWS = 500;

  let subs = [];
  let dedupedSubs = [];          // subs deduplicadas por external_user_id (1 por usuario)
  let dedupInfo = { users: 0, anonDropped: 0 };
  let filtered = [];
  let targetMode = 'segment';
  let lastOptions = null;        // opciones usadas en el ultimo preview (para confirmar)
  const selected = new Set();    // subscription ids tildados

  // Filtros client-side. Texto (q) se busca contra varios campos; el resto son
  // exactos (selects) o rangos. Todo opera sobre las subscriptions ya traidas.
  const filters = {
    q: '', status: 'all', platform: '', language: '',
    minSessions: '', activeFrom: '', activeTo: ''
  };

  /* ---------- status / log ---------- */
  const setStatus = (k, m) => { $status.className = `status show ${k}`; $status.textContent = m; };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };
  const setPvStatus = (k, m) => { $pvStatus.className = `status show ${k}`; $pvStatus.textContent = m; };
  const clearPvStatus = () => { $pvStatus.className = 'status'; $pvStatus.textContent = ''; };

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
    line.appendChild(tag); line.appendChild(msg);
    $log.appendChild(line);
    $log.scrollTop = $log.scrollHeight;
  }

  function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length <= n ? s : s.slice(0, n) + '...';
  }

  /* ---------- filtros ---------- */
  // Texto concatenado (lowercase) de los campos que cubre la busqueda global.
  function searchBlob(s) {
    if (s._blob == null) {
      s._blob = [s.id, s.externalUserId, s.identifier, s.deviceModel, s.deviceOs]
        .map(v => (v || '').toLowerCase()).join(' ');
    }
    return s._blob;
  }

  // notification_types: >0 suscripto, <=0 desuscripto, null/ausente => se asume
  // suscripto (mismo criterio que computeCanReceive en el servicio).
  function isSubscribed(s) {
    return s.notificationTypes == null ? true : Number(s.notificationTypes) > 0;
  }

  function matchesStatus(s, st) {
    switch (st) {
      case 'receivable':   return !!s.canReceive;
      case 'subscribed':   return isSubscribed(s);
      case 'unsubscribed': return s.notificationTypes != null && Number(s.notificationTypes) <= 0;
      case 'invalid':      return !!s.invalid;
      case 'notoken':      return !String(s.identifier || '').trim();
      default:             return true;
    }
  }

  function matches(s) {
    if ($onlyRecv && $onlyRecv.checked && !s.canReceive) return false;
    if (filters.q && !searchBlob(s).includes(filters.q)) return false;
    if (filters.platform && s.platform !== filters.platform) return false;
    if (filters.language && s.language !== filters.language) return false;
    if (filters.status !== 'all' && !matchesStatus(s, filters.status)) return false;
    if (filters.minSessions !== '') {
      const n = Number(filters.minSessions);
      if (Number.isFinite(n) && !(Number(s.sessionCount) >= n)) return false;
    }
    if (filters.activeFrom || filters.activeTo) {
      const d = (s.lastActive || '').slice(0, 10);          // YYYY-MM-DD
      if (!d) return false;
      if (filters.activeFrom && d < filters.activeFrom) return false;
      if (filters.activeTo && d > filters.activeTo) return false;
    }
    return true;
  }

  // Rellena los selects de Plataforma / Idioma con los valores presentes en los
  // datos cargados (distinct, ordenado). Conserva la seleccion si sigue existiendo.
  function populateFacets() {
    fillFacet('platform', subs.map(s => s.platform));
    fillFacet('language', subs.map(s => s.language));
  }
  function fillFacet(key, values) {
    const sel = $filters.querySelector(`select[data-filter="${key}"]`);
    if (!sel) return;
    const set = new Set(values.filter(Boolean));
    const first = sel.options[0];                            // "Todas"/"Todos"
    sel.replaceChildren(first);
    Array.from(set).sort((a, b) => String(a).localeCompare(String(b))).forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
    if (filters[key] && set.has(filters[key])) sel.value = filters[key];
    else { sel.value = ''; filters[key] = ''; }
  }

  let filterTimer = null;
  function scheduleApply() {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { filterTimer = null; applyFilters(); }, 180);
  }

  // Deduplica por external_user_id: 1 subscription por usuario. Prefiere la que
  // puede recibir push y, entre esas, la mas reciente (lastActive). Las anonimas
  // (sin external_user_id) se omiten (no mapean a un usuario).
  function computeDeduped(list) {
    const byUser = new Map();
    let anonDropped = 0;
    for (const s of list) {
      const key = (s.externalUserId || '').trim();
      if (!key) { anonDropped++; continue; }
      const cur = byUser.get(key);
      if (!cur || isBetter(s, cur)) byUser.set(key, s);
    }
    return { list: Array.from(byUser.values()), users: byUser.size, anonDropped };
  }
  function isBetter(a, b) {
    if (a.canReceive !== b.canReceive) return a.canReceive;        // prioriza recibible
    return (a.lastActive || '') > (b.lastActive || '');            // luego mas reciente
  }

  // Base sobre la que se filtra: deduplicada o completa, segun el toggle.
  function activeBase() {
    return ($onlyUsers && $onlyUsers.checked) ? dedupedSubs : subs;
  }
  function applyFilters() { filtered = activeBase().filter(matches); renderRows(); }

  /* ---------- render ---------- */
  function updateSelectedCount() {
    $selCount.textContent = String(selected.size);
  }

  function renderRows() {
    const total = filtered.length;
    const cap = Math.min(total, MAX_RENDER_ROWS);
    $count.textContent = total > cap ? `${cap} / ${total}` : String(total);
    if ($filtCount) $filtCount.textContent = String(total);
    $tbody.replaceChildren();

    if (!total) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 9;
      td.textContent = subs.length === 0
        ? 'Sin subscriptions cargadas. Apreta "Traer subscriptions".'
        : 'Sin resultados para los filtros actuales.';
      tr.appendChild(td); $tbody.appendChild(tr);
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < cap; i++) {
      const s = filtered[i];
      const tr = document.createElement('tr');
      tr.dataset.idx = String(i);
      if (!s.canReceive) {
        tr.classList.add('osd-invalid');
        tr.title = s.invalid ? 'Token invalido (no puede recibir)'
          : (s.notificationTypes != null && s.notificationTypes <= 0 ? 'Desuscripto (no puede recibir)'
          : 'Sin push token (no puede recibir)');
      }

      // checkbox
      const tdChk = document.createElement('td');
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'osd-row-chk';
      chk.checked = selected.has(s.id);
      chk.dataset.id = s.id;
      tdChk.appendChild(chk);
      tr.appendChild(tdChk);

      const cells = [
        s.id || '',
        s.externalUserId || '',
        (s.platform || '') + (s.invalid ? ' (invalid)' : ''),
        s.deviceModel || '',
        truncate(s.identifier || '', 40),
        s.language || '',
        s.sessionCount != null ? String(s.sessionCount) : '',
        s.lastActive ? s.lastActive.replace('T', ' ').slice(0, 19) : ''
      ];
      for (let c = 0; c < cells.length; c++) {
        const td = document.createElement('td');
        if (c === 0 || c === 4) { td.className = 'mono'; td.title = c === 0 ? s.id : s.identifier; }
        if (c === 6) td.className = 'osd-col-num';
        td.textContent = cells[c];
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    $tbody.appendChild(frag);

    if (total > cap) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 9;
      td.textContent = `Mostrando ${cap} de ${total}. Refina los filtros para ver el resto.`;
      tr.appendChild(td); $tbody.appendChild(tr);
    }
  }

  /* ---------- filtro wiring ---------- */
  function onFilterInput(ev) {
    const el = ev.target;
    if (!el || !el.dataset || !el.dataset.filter) return;
    const key = el.dataset.filter;
    if (!(key in filters)) return;
    const raw = (el.value || '').trim();
    filters[key] = key === 'q' ? raw.toLowerCase() : raw;
    scheduleApply();
  }
  // 'input' cubre texto/number/date; 'change' cubre los selects.
  $filters.addEventListener('input', onFilterInput);
  $filters.addEventListener('change', onFilterInput);

  $clearFilt.addEventListener('click', () => {
    filters.q = ''; filters.status = 'all'; filters.platform = '';
    filters.language = ''; filters.minSessions = ''; filters.activeFrom = ''; filters.activeTo = '';
    $filters.querySelectorAll('[data-filter]').forEach(el => {
      if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = '';
    });
    applyFilters();
  });

  if ($onlyRecv) $onlyRecv.addEventListener('change', applyFilters);
  if ($onlyUsers) $onlyUsers.addEventListener('change', () => {
    applyFilters();
    if ($onlyUsers.checked) {
      setStatus('info', `Usuarios únicos: ${dedupInfo.users} (deduplicado por External User ID; se omitieron ${dedupInfo.anonDropped} subscriptions sin External User ID).`);
    } else {
      clearStatus();
    }
  });

  /* ---------- seleccion ---------- */
  $tbody.addEventListener('change', (ev) => {
    const chk = ev.target.closest('.osd-row-chk');
    if (!chk) return;
    if (chk.checked) selected.add(chk.dataset.id);
    else selected.delete(chk.dataset.id);
    updateSelectedCount();
  });

  // En modo puntual, click en una fila autocompleta el id-value.
  $tbody.addEventListener('click', (ev) => {
    if (targetMode !== 'single') return;
    if (ev.target.closest('.osd-row-chk')) return;
    const tr = ev.target.closest('tr[data-idx]');
    if (!tr) return;
    const s = filtered[Number(tr.dataset.idx)];
    if (s && s.id) {
      $idType.value = 'subscription_id';
      $idValue.value = s.id;
      setStatus('info', `Destinatario puntual: ${s.id}`);
    }
  });

  $checkAll.addEventListener('change', () => {
    const on = $checkAll.checked;
    const cap = Math.min(filtered.length, MAX_RENDER_ROWS);
    for (let i = 0; i < cap; i++) {
      const s = filtered[i];
      if (on) selected.add(s.id); else selected.delete(s.id);
    }
    $tbody.querySelectorAll('.osd-row-chk').forEach(c => { c.checked = on; });
    updateSelectedCount();
  });

  /* ---------- tabs de target ---------- */
  function setTargetMode(mode) {
    targetMode = ['segment', 'subscriptions', 'single'].includes(mode) ? mode : 'segment';
    $tabs.forEach(t => {
      const active = t.dataset.target === targetMode;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $blocks.forEach(b => b.classList.toggle('hidden', b.dataset.block !== targetMode));
  }
  $tabs.forEach(t => t.addEventListener('click', () => setTargetMode(t.dataset.target)));

  /* ---------- armado de opciones ---------- */
  function isHttpUrl(s) {
    if (!s) return false;
    try { const u = new URL(String(s).trim()); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch (_) { return false; }
  }

  // Contenido + throttling/delivery comun a todos los modos.
  function gatherContent(options) {
    const title = ($title.value || '').trim();
    const message = ($message.value || '').trim();
    const templateId = ($templateId.value || '').trim();
    if (!templateId) {
      if (!title) throw new Error('El titulo es requerido.');
      if (!message) throw new Error('El mensaje es requerido.');
    }
    options.title = title;
    options.message = message;
    if (templateId) options.templateId = templateId;

    const subtitle = ($subtitle.value || '').trim();
    if (subtitle) options.subtitle = subtitle;

    for (const [el, key, label] of [[$url, 'url', 'URL al tocar'], [$largeIcon, 'largeIcon', 'Icono grande'], [$bigPicture, 'bigPicture', 'Imagen grande']]) {
      const v = (el.value || '').trim();
      if (v) {
        if (!isHttpUrl(v)) throw new Error(`${label}: debe ser una URL http/https valida.`);
        options[key] = v;
      }
    }

    const dataRaw = ($dataJson.value || '').trim();
    if (dataRaw) {
      let obj;
      try { obj = JSON.parse(dataRaw); }
      catch (e) { throw new Error('El payload "data" no es JSON valido: ' + e.message); }
      if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) {
        throw new Error('El payload "data" debe ser un objeto JSON plano.');
      }
      options.data = obj;
    }

    if (($ttl.value || '').trim() !== '') options.ttl = Number($ttl.value);
    if (($priority.value || '').trim() !== '') options.priority = Number($priority.value);
    if ($delayed.value && $delayed.value !== 'immediate') options.delayedOption = $delayed.value;
    if (($tod.value || '').trim()) options.deliveryTimeOfDay = ($tod.value || '').trim();
    if (($sendAfter.value || '').trim()) options.sendAfter = ($sendAfter.value || '').trim();
    return options;
  }

  // Opciones para segment / single (un solo request, preview/send normales).
  function buildOptions() {
    const options = { targetMode };
    if (targetMode === 'segment') {
      options.segment = ($segment.value || '').trim() || 'Subscribed Users';
    } else { // single
      const v = ($idValue.value || '').trim();
      if (!v) throw new Error('Falta el identificador del destinatario puntual.');
      options.idType = $idType.value;
      options.idValue = v;
    }
    if (($throttle.value || '').trim() !== '') options.throttleRatePerMinute = Number($throttle.value);
    return gatherContent(options);
  }

  // Opciones para el envio por bloques (subscriptions).
  function buildBulkOptions() {
    const src = bulkSrc();
    let ids;
    if (src === 'filtered') {
      ids = filtered.map(s => s.id).filter(Boolean);
      if (!ids.length) throw new Error('No hay filas filtradas. Trae subscriptions o ajusta los filtros.');
    } else {
      if (selected.size === 0) throw new Error('No hay subscriptions tildadas. Tilda filas o cambia el origen a "Todas las filtradas".');
      ids = Array.from(selected);
    }
    const options = {
      ids,
      idField: 'subscription_id',
      batchSize: ($batch.value || '').trim() !== '' ? Number($batch.value) : 1000,
      ratePerMinute: ($rate.value || '').trim() !== '' ? Number($rate.value) : 0
    };
    return gatherContent(options);
  }

  /* ---------- preview ---------- */
  $previewBtn.addEventListener('click', async () => {
    clearStatus();
    const isBulk = targetMode === 'subscriptions';
    let options;
    try { options = isBulk ? buildBulkOptions() : buildOptions(); }
    catch (e) { setStatus('error', e.message); return; }

    $previewBtn.disabled = true;
    try {
      const r = isBulk
        ? await window.api.oneSignalDirect.previewBulk(options)
        : await window.api.oneSignalDirect.preview(options);
      if (!r.ok) throw new Error(r.error);
      const p = r.data;
      lastOptions = options;
      lastIsBulk = isBulk;
      $pvTarget.textContent = p.target ? p.target.text : '';
      $pvUrl.textContent = p.url;
      if (isBulk) {
        $pvThrottle.textContent = p.note || '';
      } else {
        $pvThrottle.textContent = p.throttleRatePerMinute != null
          ? `Throttling OneSignal: ${p.throttleRatePerMinute} msg/min (feature de pago)`
          : 'Sin throttle_rate_per_minute (envio directo).';
      }
      $pvBody.textContent = isBulk ? ('// Body del PRIMER bloque (se repite por cada bloque):\n' + p.bodyJson) : p.bodyJson;
      $pvCurl.textContent = p.curl;
      if ($bulkHint) $bulkHint.classList.toggle('hidden', !isBulk);
      clearPvStatus();
      $confirmBtn.disabled = false;
      $confirmBtn.textContent = isBulk ? `Confirmar y enviar (${p.plan ? p.plan.batches : '?'} bloques)` : 'Confirmar y enviar';
      $modal.classList.remove('hidden');
      $modal.setAttribute('aria-hidden', 'false');
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      $previewBtn.disabled = false;
    }
  });

  function closeModal() {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
  }
  $modal.addEventListener('click', (ev) => {
    if (ev.target.dataset && ev.target.dataset.osdClose) closeModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$modal.classList.contains('hidden')) closeModal();
  });

  // copiar body / curl
  $modal.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.osd-copy');
    if (!btn) return;
    const text = btn.dataset.copy === 'curl' ? $pvCurl.textContent : $pvBody.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copiado!'; setTimeout(() => { btn.textContent = btn.dataset.copy === 'curl' ? 'Copiar curl' : 'Copiar JSON'; }, 1200); }
    catch (_) { /* ignore */ }
  });

  /* ---------- pausar envio por bloques (desde el modal) ---------- */
  $cancelBulk.addEventListener('click', async () => {
    $cancelBulk.disabled = true;
    setPvStatus('warn', 'Pausando tras el bloque en curso...');
    try { await window.api.oneSignalDirect.pauseBulk(); } catch (_) { /* ignore */ }
  });

  function statusLabel(s) {
    return s === 'done' ? 'Completado' : s === 'paused' ? 'Pausado'
      : s === 'failed' ? 'Abortado (fatal)' : s === 'running' ? 'Enviando…' : 'Detenido';
  }

  // Tiempo restante hasta el proximo bloque (cuando el throttle propio esta
  // esperando entre bloques). Devuelve "h:mm:ss" / "m:ss" o '' si no aplica.
  function waitingCountdown(j) {
    if (!j || !j.waitingUntil) return '';
    const ms = new Date(j.waitingUntil).getTime() - Date.now();
    if (!(ms > 0)) return '';
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  // Poller del progreso: mientras hay un envio corriendo, refresca el banner
  // (barra + contadores) cada 1.5s leyendo el checkpoint del job en disco. Asi
  // el feedback en vivo sobrevive aunque cierres el modal del curl. Si el modal
  // sigue abierto, tambien actualiza su status. Se auto-detiene al terminar.
  let jobPoll = null;
  function startJobPoll() {
    if (jobPoll) return;
    jobPoll = setInterval(async () => {
      const j = await refreshJob();
      if (j && j.status === 'running') {
        if (!$modal.classList.contains('hidden')) {
          const pct = j.totalBatches ? Math.round((j.cursor / j.totalBatches) * 100) : 0;
          const wait = waitingCountdown(j);
          setPvStatus('loading', `Enviando… ${j.cursor}/${j.totalBatches} bloques (${pct}%) · ${j.sentMsgs} msgs · recipients ${j.recipients}${j.failedBatches ? ' · fallidos ' + j.failedBatches : ''}${wait ? ' · próximo bloque en ' + wait : ''}.`);
        }
      } else {
        stopJobPoll();
      }
    }, 1500);
  }
  function stopJobPoll() { if (jobPoll) { clearInterval(jobPoll); jobPoll = null; } }

  // Runner compartido para sendBulk/resumeBulk: streamea logs, maneja el boton
  // de pausa y refresca el banner del job (en vivo durante la corrida y al terminar).
  async function runBulk(opFactory, setS, pauseBtn) {
    const off = window.api.oneSignalDirect.onLog(p => appendLog(p.kind, p.message, p.ts));
    if (pauseBtn) { pauseBtn.classList.remove('hidden'); pauseBtn.disabled = false; }
    setS('loading', 'Procesando envio por bloques...');
    startJobPoll();
    try {
      const r = await opFactory();
      if (!r.ok) throw new Error(r.error);
      const d = r.data || {};
      const done = d.status === 'done' && !d.failedBatches;
      setS(done ? 'success' : 'warn',
        `${statusLabel(d.status)} · bloques OK=${d.okBatches}/${d.batches}, fallidos=${d.failedBatches}, cursor=${d.cursor}. Mensajes≈${d.sentMsgs}, recipients≈${d.recipients}.`);
      return d;
    } catch (e) {
      setS('error', e.message);
      return null;
    } finally {
      off && off();
      if (pauseBtn) pauseBtn.classList.add('hidden');
      stopJobPoll();
      refreshJob();
    }
  }

  /* ---------- confirmar envio ---------- */
  $confirmBtn.addEventListener('click', async () => {
    if (!lastOptions) return;
    $confirmBtn.disabled = true;

    try {
      if (lastIsBulk) {
        const d = await runBulk(() => window.api.oneSignalDirect.sendBulk(lastOptions), setPvStatus, $cancelBulk);
        if (d && d.status === 'done' && !d.failedBatches) setTimeout(closeModal, 1800);
      } else {
        setPvStatus('loading', 'Enviando...');
        const off = window.api.oneSignalDirect.onLog(p => appendLog(p.kind, p.message, p.ts));
        try {
          const r = await window.api.oneSignalDirect.send(lastOptions);
          if (!r.ok) throw new Error(r.error);
          const recipients = r.data && typeof r.data.recipients === 'number' ? r.data.recipients : null;
          if (recipients === 0) {
            setPvStatus('warn', 'Aceptado pero recipients=0 (target no encontrado / sin suscriptos).');
          } else {
            setPvStatus('success', `Enviado. id=${r.data && r.data.id ? r.data.id : '?'} · recipients=${recipients == null ? '?' : recipients}`);
            setTimeout(closeModal, 1400);
          }
        } finally { off && off(); }
      }
    } catch (e) {
      setPvStatus('error', e.message);
    } finally {
      $confirmBtn.disabled = false;
    }
  });

  /* ---------- banner de job guardado / en curso (progreso en vivo) ---------- */
  async function refreshJob() {
    if (!$jobBanner) return null;
    try {
      const r = await window.api.oneSignalDirect.bulkJob();
      const j = r && r.ok ? r.data : null;
      renderJobBanner(j);
      // Recuperacion: si quedo un envio corriendo (p.ej. tras recargar el
      // renderer), arranca el poller para seguir mostrando progreso en vivo.
      if (j && j.status === 'running') startJobPoll();
      return j;
    } catch (_) { renderJobBanner(null); return null; }
  }

  function renderJobBanner(j) {
    if (!$jobBanner) return;
    if (!j) { $jobBanner.classList.add('hidden'); $jobBanner.replaceChildren(); $jobBanner.classList.remove('is-running'); return; }
    $jobBanner.classList.remove('hidden');
    const running = j.status === 'running';
    $jobBanner.classList.toggle('is-running', running);
    const pct = j.totalBatches ? Math.round((j.cursor / j.totalBatches) * 100) : 0;

    const info = document.createElement('div');
    info.className = 'osd-job-info';
    const waitTxt = running ? waitingCountdown(j) : '';
    const head = document.createElement('div');
    head.className = 'osd-job-headline';
    head.textContent = `${running ? 'Enviando' : 'Envio guardado'} [${statusLabel(j.status)}] — ${j.cursor}/${j.totalBatches} bloques (${pct}%)${waitTxt ? ' · ⏳ próximo en ' + waitTxt : ''}`;
    const sub = document.createElement('div');
    sub.className = 'osd-job-sub';
    sub.textContent = `OK ${j.okBatches} · fallidos ${j.failedBatches} · ${j.sentMsgs} msgs · recipients ${j.recipients} · ${j.totalIds} ids${j.title ? ' · "' + j.title + '"' : ''}`;
    const bar = document.createElement('div');
    bar.className = 'osd-job-bar';
    const fill = document.createElement('div');
    fill.className = 'osd-job-bar-fill' + (running ? ' is-running' : '') + (j.status === 'failed' ? ' is-failed' : '');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    info.append(head, sub, bar);

    const actions = document.createElement('div');
    actions.className = 'osd-job-actions';
    if (!running) {
      if (j.resumable) {
        const b = document.createElement('button');
        b.className = 'btn primary'; b.type = 'button'; b.dataset.act = 'resume'; b.textContent = 'Reanudar';
        actions.appendChild(b);
      }
      if (j.failedBatches > 0) {
        const rf = document.createElement('button');
        rf.className = 'btn'; rf.type = 'button'; rf.dataset.act = 'retry-failed';
        rf.textContent = `Reintentar fallidos (${j.failedBatches})`;
        actions.appendChild(rf);
      }
    }
    // Pausar: visible mientras corre; oculto si esta terminado (lo revela runBulk al reanudar).
    const pb = document.createElement('button');
    pb.className = 'btn' + (running ? '' : ' hidden'); pb.type = 'button';
    pb.dataset.act = 'pause-banner'; pb.textContent = 'Pausar';
    actions.appendChild(pb);
    if (!running) {
      const dz = document.createElement('button');
      dz.className = 'btn'; dz.type = 'button'; dz.dataset.act = 'discard'; dz.textContent = 'Descartar';
      actions.appendChild(dz);
    }
    $jobBanner.replaceChildren(info, actions);
  }

  if ($jobBanner) $jobBanner.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const pauseBtn = $jobBanner.querySelector('button[data-act="pause-banner"]');
    if (act === 'resume') {
      await runBulk(() => window.api.oneSignalDirect.resumeBulk(), setStatus, pauseBtn);
    } else if (act === 'retry-failed') {
      await runBulk(() => window.api.oneSignalDirect.retryFailed(), setStatus, pauseBtn);
    } else if (act === 'pause-banner') {
      btn.disabled = true;
      setStatus('warn', 'Pausando tras el bloque en curso...');
      try { await window.api.oneSignalDirect.pauseBulk(); } catch (_) { /* ignore */ }
    } else if (act === 'discard') {
      if (!confirm('¿Descartar el envio guardado? No se podra reanudar.')) return;
      try { await window.api.oneSignalDirect.clearBulk(); } catch (_) { /* ignore */ }
      refreshJob();
      setStatus('info', 'Envio guardado descartado.');
    }
  });

  /* ---------- config summary ---------- */
  let configLoaded = false;
  async function loadConfig() {
    if (configLoaded) return;
    try {
      const r = await window.api.oneSignalDirect.config();
      if (!r.ok) throw new Error(r.error);
      const c = r.data;
      const parts = [];
      if (c.oneSignal && c.oneSignal.appId) parts.push(`AppId: ${c.oneSignal.appId}`);
      if (c.oneSignal && c.oneSignal.apiRestKey) parts.push(`ApiKey: ${c.oneSignal.apiRestKey}`);
      if (c.direct && c.direct.defaultThrottleRatePerMinute != null && ($throttle.value || '').trim() === '') {
        $throttle.value = c.direct.defaultThrottleRatePerMinute;
      }
      if (c.direct && c.direct.defaultSegment && !$segment.value.trim()) $segment.value = c.direct.defaultSegment;
      $configSum.textContent = parts.join(' · ');
      configLoaded = true;
    } catch (e) {
      appendLog('warn', 'No se pudo leer config OneSignal: ' + e.message);
    }
  }

  /* ---------- load subscriptions ---------- */
  let loading = false;
  async function loadSubs() {
    if (loading) return;
    loading = true;
    clearStatus();
    $refresh.disabled = true;
    if ($spinner) $spinner.classList.remove('hidden');
    loadConfig();
    selected.clear(); updateSelectedCount();
    $checkAll.checked = false;
    $tbody.replaceChildren();
    const tr = document.createElement('tr');
    tr.className = 'os-empty';
    const td = document.createElement('td'); td.colSpan = 9; td.textContent = 'Consultando OneSignal...';
    tr.appendChild(td); $tbody.appendChild(tr);
    setStatus('loading', 'Trayendo subscriptions...');

    const off = window.api.oneSignalDirect.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.oneSignalDirect.listSubscriptions({});
      if (!r.ok) throw new Error(r.error);
      subs = (r.data && r.data.subscriptions) || [];
      const dd = computeDeduped(subs);
      dedupedSubs = dd.list;
      dedupInfo = { users: dd.users, anonDropped: dd.anonDropped };
      populateFacets();
      applyFilters();
      const t = r.data && r.data.totalCount;
      const deliv = r.data && typeof r.data.deliverable === 'number' ? r.data.deliverable : subs.reduce((n, s) => n + (s.canReceive ? 1 : 0), 0);
      if ($deliverable) $deliverable.textContent = `recibibles: ${deliv}`;
      setStatus('success', `Cargadas ${subs.length}${t != null && t !== subs.length ? ' de ' + t : ''} subscriptions · ${deliv} pueden recibir push · ${dd.users} usuarios únicos.`);
    } catch (e) {
      subs = []; filtered = []; renderRows();
      setStatus('error', e.message);
    } finally {
      off && off();
      $refresh.disabled = false;
      if ($spinner) $spinner.classList.add('hidden');
      loading = false;
    }
  }

  $refresh.addEventListener('click', loadSubs);

  // link a la doc de throttling
  document.querySelector('#view-osDirect [data-osd-doc]')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    window.api.openExternal && window.api.openExternal('https://documentation.onesignal.com/docs/en/throttling');
  });

  // Config se trae al activar la vista por primera vez (no toca la red salvo config local).
  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.view === 'osDirect') { loadConfig(); refreshJob(); }
  });

  setTargetMode('segment');
  refreshJob();
})();
