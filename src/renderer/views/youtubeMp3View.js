'use strict';

(function () {
  const $url        = document.getElementById('yt-url');
  const $add        = document.getElementById('yt-add');
  const $dir        = document.getElementById('yt-output-dir');
  const $pickDir    = document.getElementById('yt-pick-dir');
  const $openDir    = document.getElementById('yt-open-dir');
  const $bitrate    = document.getElementById('yt-bitrate');
  const $restrict   = document.getElementById('yt-restrict');
  const $order      = document.getElementById('yt-order');
  const $run        = document.getElementById('yt-run');
  const $cancel     = document.getElementById('yt-cancel');
  const $clearDone  = document.getElementById('yt-clear-done');
  const $clearAll   = document.getElementById('yt-clear-all');
  const $status     = document.getElementById('yt-status');
  const $log        = document.getElementById('yt-log');
  const $logClear   = document.getElementById('yt-log-clear');
  const $fill       = document.getElementById('yt-progress-fill');
  const $pct        = document.getElementById('yt-progress-pct');
  const $size       = document.getElementById('yt-progress-size');
  const $speed      = document.getElementById('yt-progress-speed');
  const $overall    = document.getElementById('yt-overall');
  const $currentUrl = document.getElementById('yt-current-url');
  const $queue      = document.getElementById('yt-queue');
  const $queueEmpty = document.getElementById('yt-queue-empty');
  const $queueCount = document.getElementById('yt-queue-count');

  // Each item: { id, url, status: 'pending'|'downloading'|'done'|'error'|'cancelled', percent, outputPath, sizeBytes, error }
  const queue = [];
  let nextId = 1;
  let running = false;       // a job is actively being awaited
  let cancellingAll = false; // user pressed cancel; stop the loop
  let currentItemId = null;
  let dragId = null;         // id of the queue item currently being dragged

  /* ---------- helpers ---------- */

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  /* ---------- toast (transient notification, independent of the status banner) ---------- */

  let $toastHost = null;
  function showToast(kind, msg, ms) {
    if (!$toastHost) {
      $toastHost = document.createElement('div');
      $toastHost.className = 'yt-toast-host';
      document.body.appendChild($toastHost);
    }
    const toast = document.createElement('div');
    toast.className = `yt-toast yt-toast-${kind}`;
    toast.textContent = msg;
    $toastHost.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    const remove = () => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 250);
    };
    toast.addEventListener('click', remove);
    setTimeout(remove, ms || 6000);
  }

  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return '?';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function isValidUrl(u) {
    return /^https?:\/\//i.test(u);
  }

  function shortUrl(u) {
    if (!u) return '';
    if (u.length <= 80) return u;
    return u.slice(0, 60) + '...' + u.slice(-15);
  }

  function displayName(item) {
    return item.title || shortUrl(item.url);
  }

  /* ---------- progress + status ---------- */

  function setProgress(pct, totalSize, speed) {
    if (Number.isFinite(pct)) {
      $fill.style.width = `${pct.toFixed(1)}%`;
      $pct.textContent = `${pct.toFixed(1)}%`;
    }
    if (totalSize) $size.textContent = totalSize; else if (totalSize === '') $size.textContent = '';
    if (speed)     $speed.textContent = speed;   else if (speed === '')     $speed.textContent = '';
  }

  function resetProgress() {
    $fill.style.width = '0%';
    $pct.textContent = '0%';
    $size.textContent = '';
    $speed.textContent = '';
  }

  function updateOverall() {
    const total = queue.length;
    const done  = queue.filter(i => i.status === 'done').length;
    const err   = queue.filter(i => i.status === 'error').length;
    const can   = queue.filter(i => i.status === 'cancelled').length;
    $overall.textContent = `Cola: ${done}/${total} listos` + (err ? ` · ${err} con error` : '') + (can ? ` · ${can} cancelados` : '');
    $queueCount.textContent = String(total);
    $queueEmpty.style.display = total ? 'none' : 'block';

    // Run button: enabled if there's something pending and we're not currently running
    const pending = queue.some(i => i.status === 'pending');
    $run.disabled = running || !pending || !$dir.value;
    $clearDone.disabled = !queue.some(i => i.status === 'done' || i.status === 'error' || i.status === 'cancelled');
    $clearAll.disabled  = !total || running;
  }

  /* ---------- queue rendering ---------- */

  function statusBadge(item) {
    const span = document.createElement('span');
    span.className = `yt-status-badge yt-status-${item.status}`;
    if (item.status === 'pending')     span.textContent = 'pendiente';
    else if (item.status === 'downloading') span.textContent = `${(item.percent || 0).toFixed(0)}%`;
    else if (item.status === 'done')   span.textContent = 'listo';
    else if (item.status === 'error')  span.textContent = 'error';
    else if (item.status === 'cancelled') span.textContent = 'cancelado';
    return span;
  }

  function queueIndexPrefix(item) {
    const idx = queue.indexOf(item);
    if (idx < 0) return '';
    const digits = String(queue.length).length;
    return `${String(idx + 1).padStart(digits, '0')}_`;
  }

  function renderItem(item) {
    const li = document.createElement('li');
    li.className = `yt-queue-item yt-item-${item.status}`;
    li.dataset.id = item.id;
    li.draggable = !running;
    attachDragHandlers(li, item);

    const handle = document.createElement('div');
    handle.className = 'yt-item-drag';
    handle.title = 'Arrastra para reordenar';
    handle.textContent = '⠷';
    li.appendChild(handle);

    if ($order.checked) {
      const idx = document.createElement('div');
      idx.className = 'yt-item-index';
      idx.textContent = queueIndexPrefix(item);
      li.appendChild(idx);
    }

    const main = document.createElement('div');
    main.className = 'yt-item-main';

    const urlLine = document.createElement('div');
    urlLine.className = 'yt-item-url';
    urlLine.title = item.url;
    if (item.title) {
      urlLine.textContent = item.title;
    } else if (item.titleError) {
      urlLine.textContent = shortUrl(item.url);
    } else {
      urlLine.textContent = 'Obteniendo titulo...';
      urlLine.classList.add('yt-item-url-loading');
    }
    main.appendChild(urlLine);

    if (item.title) {
      const subUrl = document.createElement('div');
      subUrl.className = 'yt-item-suburl';
      subUrl.title = item.url;
      subUrl.textContent = shortUrl(item.url);
      main.appendChild(subUrl);
    }

    const meta = document.createElement('div');
    meta.className = 'yt-item-meta';
    meta.appendChild(statusBadge(item));
    if (item.status === 'done' && item.outputPath) {
      const fname = document.createElement('span');
      fname.className = 'yt-item-file';
      fname.textContent = ` · ${item.outputPath.split(/[\\/]/).pop()} (${fmtBytes(item.sizeBytes)})`;
      meta.appendChild(fname);
    }
    if (item.status === 'error' && item.error) {
      const errSpan = document.createElement('span');
      errSpan.className = 'yt-item-err';
      errSpan.textContent = ' · ' + item.error;
      meta.appendChild(errSpan);
    }
    if (item.titleError) {
      const titleErrSpan = document.createElement('span');
      titleErrSpan.className = 'yt-item-err';
      titleErrSpan.textContent = ' · no se pudo obtener el titulo' + (item.titleErrorMsg ? ` (${item.titleErrorMsg})` : '');
      meta.appendChild(titleErrSpan);
    }
    main.appendChild(meta);

    if (item.status === 'downloading') {
      const bar = document.createElement('div');
      bar.className = 'yt-item-bar';
      const fill = document.createElement('div');
      fill.style.width = `${item.percent || 0}%`;
      bar.appendChild(fill);
      main.appendChild(bar);
    }

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'yt-item-actions';
    if (item.status === 'done' && item.outputPath) {
      const openBtn = document.createElement('button');
      openBtn.className = 'btn';
      openBtn.textContent = 'Abrir';
      openBtn.addEventListener('click', async () => {
        const r = await window.api.showInFolder(item.outputPath);
        if (!r.ok) setStatus('error', r.error);
      });
      actions.appendChild(openBtn);
    }
    if (item.titleError) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn';
      retryBtn.textContent = 'Reintentar titulo';
      retryBtn.addEventListener('click', () => {
        item.titleError = false;
        item.titleErrorMsg = null;
        updateItemInPlace(item);
        queueTitleFetch(item);
      });
      actions.appendChild(retryBtn);
    }
    if (item.status !== 'downloading') {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'btn';
      rmBtn.textContent = 'Quitar';
      rmBtn.addEventListener('click', () => removeItem(item.id));
      actions.appendChild(rmBtn);
    }
    li.appendChild(actions);

    return li;
  }

  function renderQueue() {
    $queue.innerHTML = '';
    queue.forEach(item => $queue.appendChild(renderItem(item)));
    updateOverall();
  }

  function attachDragHandlers(li, item) {
    li.addEventListener('dragstart', (e) => {
      if (!li.draggable) return;
      dragId = item.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(item.id)); } catch (_) { /* ignore */ }
    });
    li.addEventListener('dragover', (e) => {
      if (dragId == null || dragId === item.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      if (dragId == null || dragId === item.id) return;
      e.preventDefault();
      const fromIdx = queue.findIndex(x => x.id === dragId);
      const toIdx = queue.findIndex(x => x.id === item.id);
      dragId = null;
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const [moved] = queue.splice(fromIdx, 1);
      queue.splice(toIdx, 0, moved);
      renderQueue();
    });
    li.addEventListener('dragend', () => {
      dragId = null;
      $queue.querySelectorAll('.dragging, .drag-over').forEach(el => el.classList.remove('dragging', 'drag-over'));
    });
  }

  function updateItemInPlace(item) {
    const li = $queue.querySelector(`li[data-id="${item.id}"]`);
    if (!li) { renderQueue(); return; }
    li.replaceWith(renderItem(item));
    updateOverall();
  }

  /* ---------- queue ops ---------- */

  function addUrls(rawText) {
    if (!rawText) return 0;
    const lines = rawText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    let added = 0;
    for (const u of lines) {
      if (!isValidUrl(u)) {
        appendLog('warn', `Ignorada (no es URL http/https): ${u}`);
        continue;
      }
      const item = {
        id: nextId++,
        url: u,
        title: null,
        titleError: false,
        titleErrorMsg: null,
        status: 'pending',
        percent: 0,
        outputPath: null,
        sizeBytes: null,
        error: null
      };
      queue.push(item);
      queueTitleFetch(item);
      added++;
    }
    renderQueue();
    return added;
  }

  /* ---------- title fetching (best-effort, one at a time) ---------- */

  const titleFetchQueue = [];
  let titleFetching = false;

  function queueTitleFetch(item) {
    titleFetchQueue.push(item);
    processTitleFetchQueue();
  }

  async function processTitleFetchQueue() {
    if (titleFetching) return;
    titleFetching = true;
    while (titleFetchQueue.length) {
      const item = titleFetchQueue.shift();
      if (!queue.includes(item)) continue; // removed before its turn
      try {
        const r = await window.api.youtube.getTitle(item.url);
        if (r.ok && r.data && r.data.title) {
          item.title = r.data.title;
        } else {
          item.titleError = true;
          item.titleErrorMsg = (r && r.error) || null;
          appendLog('warn', `No se pudo obtener el titulo de ${shortUrl(item.url)}${item.titleErrorMsg ? ': ' + item.titleErrorMsg : ''}`);
          showToast('error', `No se pudo obtener el titulo de ${shortUrl(item.url)}`);
        }
      } catch (e) {
        item.titleError = true;
        item.titleErrorMsg = e && e.message;
        appendLog('warn', `No se pudo obtener el titulo de ${shortUrl(item.url)}${item.titleErrorMsg ? ': ' + item.titleErrorMsg : ''}`);
        showToast('error', `No se pudo obtener el titulo de ${shortUrl(item.url)}`);
      }
      updateItemInPlace(item);
    }
    titleFetching = false;
  }

  function removeItem(id) {
    const i = queue.findIndex(x => x.id === id);
    if (i < 0) return;
    const item = queue[i];
    if (item.status === 'downloading') return; // safety
    queue.splice(i, 1);
    renderQueue();
  }

  function clearDone() {
    for (let i = queue.length - 1; i >= 0; i--) {
      const s = queue[i].status;
      if (s === 'done' || s === 'error' || s === 'cancelled') queue.splice(i, 1);
    }
    renderQueue();
  }

  function clearAll() {
    if (running) return;
    queue.length = 0;
    renderQueue();
  }

  /* ---------- log ---------- */

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

  /* ---------- init ---------- */

  (async () => {
    try {
      const r = await window.api.youtube.defaults();
      if (r.ok && r.data && r.data.outputDir) $dir.value = r.data.outputDir;
    } catch (_) { /* ignore */ }
    updateOverall();
  })();

  // Subscribe to events (one global listener — current item is currentItemId)
  window.api.youtube.onLog((payload) => {
    const { kind, message, ts } = payload || {};
    const item = currentItemId != null ? queue.find(x => x.id === currentItemId) : null;

    if (kind === 'progress' && message && typeof message === 'object') {
      setProgress(message.percent, message.totalSize, message.speed);
      if (item) {
        item.percent = message.percent;
        updateItemInPlace(item);
      }
      return;
    }
    if (kind === 'done' && message && typeof message === 'object') {
      appendLog('done', `OK. ${message.outputPath || '(sin path)'} (${fmtBytes(message.sizeBytes)})`, ts);
      return;
    }
    if (kind === 'log')  { appendLog('info', message, ts); return; }
    if (kind === 'warn') { appendLog('warn', message, ts); return; }
    appendLog(kind, typeof message === 'string' ? message : JSON.stringify(message), ts);
  });

  /* ---------- events ---------- */

  $add.addEventListener('click', () => {
    const n = addUrls($url.value);
    if (n > 0) {
      $url.value = '';
      clearStatus();
    } else {
      setStatus('error', 'No agregué nada. Revisá que las URLs empiecen con http:// o https://.');
    }
  });

  $url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $add.click();
    }
  });

  $openDir.addEventListener('click', async () => {
    const p = $dir.value.trim();
    if (!p) { setStatus('error', 'No hay carpeta destino configurada.'); return; }
    const r = await window.api.openPath(p);
    if (!r.ok) setStatus('error', r.error);
  });

  $pickDir.addEventListener('click', async () => {
    const r = await window.api.youtube.pickOutputDir($dir.value);
    if (!r.ok) { setStatus('error', r.error); return; }
    if (!r.data) return;
    $dir.value = r.data.outputDir;
    updateOverall();
  });

  $order.addEventListener('change', renderQueue);

  $logClear.addEventListener('click', () => { $log.innerHTML = ''; });

  $clearDone.addEventListener('click', clearDone);
  $clearAll.addEventListener('click', clearAll);

  $cancel.addEventListener('click', async () => {
    if (!running) return;
    cancellingAll = true;
    $cancel.disabled = true;
    setStatus('loading', 'Cancelando...');
    await window.api.youtube.cancel();
  });

  async function processQueue() {
    if (running) return;
    if (!$dir.value) { setStatus('error', 'Elegi una carpeta destino.'); return; }
    const pending = queue.filter(i => i.status === 'pending');
    if (!pending.length) { setStatus('error', 'No hay nada pendiente en la cola.'); return; }

    running = true;
    cancellingAll = false;
    $run.disabled = true;
    $cancel.disabled = false;
    $clearAll.disabled = true;
    clearStatus();
    renderQueue(); // lock drag handles while the queue is running

    let okCount = 0, errCount = 0, cancelCount = 0;

    for (const item of pending) {
      if (cancellingAll) break;
      currentItemId = item.id;
      item.status = 'downloading';
      item.percent = 0;
      item.error = null;
      item.outputPath = null;
      item.sizeBytes = null;
      updateItemInPlace(item);
      $currentUrl.textContent = displayName(item);
      resetProgress();
      setStatus('loading', `Descargando ${displayName(item)}...`);

      try {
        const r = await window.api.youtube.download({
          url: item.url,
          outputDir: $dir.value.trim(),
          bitrateKbps: parseInt($bitrate.value, 10),
          restrictFilenames: $restrict.checked,
          filenamePrefix: $order.checked ? queueIndexPrefix(item) : ''
        });
        if (!r.ok) throw new Error(r.error);
        item.status = 'done';
        item.percent = 100;
        item.outputPath = r.data.outputPath || null;
        item.sizeBytes = r.data.sizeBytes || null;
        okCount++;
      } catch (e) {
        if (/cancelada/i.test(e.message)) {
          item.status = 'cancelled';
          item.error = null;
          cancelCount++;
        } else {
          item.status = 'error';
          item.error = e.message;
          errCount++;
        }
      } finally {
        updateItemInPlace(item);
      }
    }

    currentItemId = null;
    $currentUrl.textContent = '';
    running = false;
    $cancel.disabled = true;
    renderQueue(); // unlock drag handles

    if (cancellingAll) {
      // Mark remaining pending items as still pending (no change), let user restart
      setStatus('error', `Cancelado. Listos: ${okCount}, errores: ${errCount}, cancelados: ${cancelCount}. Los pendientes siguen en la cola.`);
    } else if (errCount === 0 && okCount > 0) {
      setStatus('success', `Listo. ${okCount} archivo(s) descargados.`);
    } else if (okCount === 0 && errCount > 0) {
      setStatus('error', `Fallaron ${errCount}. Mirá el log.`);
    } else {
      setStatus('success', `Termino. Listos: ${okCount}, errores: ${errCount}, cancelados: ${cancelCount}.`);
    }
    updateOverall();
  }

  $run.addEventListener('click', processQueue);

  updateOverall();
})();
