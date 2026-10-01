'use strict';

(function () {
  const $drop        = document.getElementById('qrr-drop');
  const $file        = document.getElementById('qrr-file');
  const $pick        = document.getElementById('qrr-pick');
  const $previewWrap = document.getElementById('qrr-preview-wrap');
  const $preview     = document.getElementById('qrr-preview');
  const $decode      = document.getElementById('qrr-decode');
  const $reset       = document.getElementById('qrr-reset');
  const $status      = document.getElementById('qrr-status');
  const $result      = document.getElementById('qrr-result');
  const $meta        = document.getElementById('qrr-meta');
  const $copy        = document.getElementById('qrr-copy');
  const $sendParse   = document.getElementById('qrr-send-parse');

  let currentBytes = null; // Uint8Array
  let currentMime  = '';
  let currentName  = '';

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  function resetResult() {
    $result.value = '';
    $meta.textContent = '';
    $copy.disabled = true;
    $sendParse.disabled = true;
  }

  function resetAll() {
    currentBytes = null;
    currentMime = '';
    currentName = '';
    $preview.removeAttribute('src');
    $previewWrap.classList.add('hidden');
    $file.value = '';
    resetResult();
    clearStatus();
  }

  async function loadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setStatus('error', 'Solo se aceptan imagenes.');
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      currentBytes = new Uint8Array(buf);
      currentMime = file.type;
      currentName = file.name || 'clipboard.png';

      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      $preview.src = dataUrl;
      $previewWrap.classList.remove('hidden');
      resetResult();
      setStatus('success', `Cargada "${currentName}" (${(currentBytes.length / 1024).toFixed(1)} KB). Pulsa "Leer QR".`);
    } catch (e) {
      setStatus('error', 'No se pudo leer la imagen: ' + e.message);
    }
  }

  $pick.addEventListener('click', () => $file.click());
  $drop.addEventListener('click', (e) => {
    if (e.target === $pick || e.target.closest('button')) return;
    $file.click();
  });
  $file.addEventListener('change', () => {
    const f = $file.files && $file.files[0];
    if (f) loadFile(f);
  });

  ['dragenter', 'dragover'].forEach(ev =>
    $drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); $drop.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    $drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); $drop.classList.remove('dragover'); })
  );
  $drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // Paste from clipboard while the view is visible
  document.addEventListener('paste', (e) => {
    const view = document.getElementById('view-qrRead');
    if (!view || !view.classList.contains('active')) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) { loadFile(blob); e.preventDefault(); return; }
      }
    }
  });

  $decode.addEventListener('click', async () => {
    if (!currentBytes) { setStatus('error', 'Adjunta una imagen primero.'); return; }
    setStatus('loading', 'Decodificando QR...');
    $decode.disabled = true;
    try {
      const r = await window.api.decodeQRImage(currentBytes);
      if (!r.ok) throw new Error(r.error);
      $result.value = r.data.text || '';
      $meta.textContent = `Imagen ${r.data.width}x${r.data.height}px · ${r.data.text.length} chars`;
      $copy.disabled = !$result.value;
      $sendParse.disabled = !$result.value;
      setStatus('success', 'QR decodificado.');
    } catch (e) {
      setStatus('error', e.message);
      resetResult();
    } finally {
      $decode.disabled = false;
    }
  });

  $reset.addEventListener('click', resetAll);

  $copy.addEventListener('click', async () => {
    if (!$result.value) return;
    try {
      await navigator.clipboard.writeText($result.value);
      setStatus('success', 'Contenido copiado.');
    } catch (e) {
      setStatus('error', 'No se pudo copiar: ' + e.message);
    }
  });

  $sendParse.addEventListener('click', () => {
    if (!$result.value) return;
    const $parseInput = document.getElementById('qrp-text');
    if ($parseInput) $parseInput.value = $result.value;
    if (window.__router) window.__router.setActive('qrParse');
    const $parseBtn = document.getElementById('qrp-parse');
    if ($parseBtn) $parseBtn.click();
  });
})();
