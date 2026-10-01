'use strict';

(function () {
  const $input        = document.getElementById('vc-input');
  const $output       = document.getElementById('vc-output');
  const $pickInput    = document.getElementById('vc-pick-input');
  const $pickOutput   = document.getElementById('vc-pick-output');
  const $openOutDir   = document.getElementById('vc-open-output-dir');
  const $crf          = document.getElementById('vc-crf');
  const $crfVal       = document.getElementById('vc-crf-val');
  const $audio        = document.getElementById('vc-audio');
  const $run          = document.getElementById('vc-run');
  const $cancel       = document.getElementById('vc-cancel');
  const $openFolder   = document.getElementById('vc-open-folder');
  const $status       = document.getElementById('vc-status');
  const $log          = document.getElementById('vc-log');
  const $logClear     = document.getElementById('vc-log-clear');
  const $fill         = document.getElementById('vc-progress-fill');
  const $pct          = document.getElementById('vc-progress-pct');
  const $time         = document.getElementById('vc-progress-time');
  const $speed        = document.getElementById('vc-progress-speed');

  let running = false;
  let lastOutputPath = null;

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  function fmtTime(sec) {
    if (sec == null || !Number.isFinite(sec)) return '--:--';
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
  }

  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return '?';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function setProgress(pct, currentSec, durationSec) {
    if (Number.isFinite(pct)) {
      $fill.style.width = `${pct.toFixed(1)}%`;
      $pct.textContent = `${pct.toFixed(1)}%`;
    } else {
      $fill.style.width = '0%';
      $pct.textContent = '...';
    }
    $time.textContent = `${fmtTime(currentSec)} / ${fmtTime(durationSec)}`;
  }

  function resetProgress() {
    setProgress(0, 0, null);
    $speed.textContent = '';
  }

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

  function refreshRunButton() {
    $run.disabled = running || !$input.value || !$output.value;
  }

  $crf.addEventListener('input', () => { $crfVal.textContent = $crf.value; });

  $pickInput.addEventListener('click', async () => {
    const r = await window.api.video.pickInput();
    if (!r.ok) { setStatus('error', r.error); return; }
    if (!r.data) return; // user cancelled
    $input.value = r.data.inputPath;
    if (!$output.value) $output.value = r.data.suggestedOutput;
    refreshRunButton();
    clearStatus();
  });

  $pickOutput.addEventListener('click', async () => {
    const def = $output.value || ($input.value ? $input.value.replace(/\.[^.\\/]+$/, '.webm') : 'output.webm');
    const r = await window.api.video.pickOutput(def);
    if (!r.ok) { setStatus('error', r.error); return; }
    if (!r.data) return;
    $output.value = r.data.outputPath;
    refreshRunButton();
  });

  $openFolder.addEventListener('click', async () => {
    if (!lastOutputPath) return;
    const r = await window.api.showInFolder(lastOutputPath);
    if (!r.ok) setStatus('error', r.error);
  });

  $openOutDir.addEventListener('click', async () => {
    const p = $output.value.trim();
    if (!p) { setStatus('error', 'No hay archivo de salida configurado.'); return; }
    const r = await window.api.openPath(p);
    if (!r.ok) setStatus('error', r.error);
  });

  $logClear.addEventListener('click', () => { $log.innerHTML = ''; });

  // Subscribe to ffmpeg events once
  window.api.video.onLog((payload) => {
    const { kind, message, ts } = payload || {};
    if (kind === 'progress' && message && typeof message === 'object') {
      setProgress(message.percent, message.currentSec, message.durationSec);
      return;
    }
    if (kind === 'speed') {
      $speed.textContent = `speed ${message}`;
      return;
    }
    if (kind === 'done' && message && typeof message === 'object') {
      appendLog('done', `OK. Salida: ${message.outputPath} (${fmtBytes(message.sizeBytes)})`, ts);
      return;
    }
    if (kind === 'log') {
      appendLog('info', message, ts);
      return;
    }
    appendLog(kind, typeof message === 'string' ? message : JSON.stringify(message), ts);
  });

  $run.addEventListener('click', async () => {
    if (running) return;
    const inputPath  = $input.value.trim();
    const outputPath = $output.value.trim();
    if (!inputPath || !outputPath) { setStatus('error', 'Elegi entrada y salida.'); return; }

    running = true;
    lastOutputPath = null;
    $run.disabled = true;
    $cancel.disabled = false;
    $openFolder.disabled = true;
    resetProgress();
    setStatus('loading', 'Convirtiendo...');

    const opts = {
      inputPath,
      outputPath,
      crf: parseInt($crf.value, 10),
      audioKbps: parseInt($audio.value, 10) // 0 = sin audio (-an)
    };

    try {
      const r = await window.api.video.convert(opts);
      if (!r.ok) throw new Error(r.error);
      lastOutputPath = r.data.outputPath;
      setStatus('success', `Listo. ${r.data.outputPath} (${fmtBytes(r.data.sizeBytes)})`);
      setProgress(100, r.data.durationSec, r.data.durationSec);
      $openFolder.disabled = false;
    } catch (e) {
      if (/cancelada/i.test(e.message)) {
        setStatus('error', 'Conversion cancelada.');
      } else {
        setStatus('error', e.message);
      }
    } finally {
      running = false;
      $cancel.disabled = true;
      refreshRunButton();
    }
  });

  $cancel.addEventListener('click', async () => {
    if (!running) return;
    $cancel.disabled = true;
    await window.api.video.cancel();
  });

  refreshRunButton();
})();
