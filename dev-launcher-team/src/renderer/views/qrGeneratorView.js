'use strict';

(function () {
  const $text = document.getElementById('qr-text');
  const $gen  = document.getElementById('qr-generate');
  const $clr  = document.getElementById('qr-clear');
  const $cpy  = document.getElementById('qr-copy');
  const $dl   = document.getElementById('qr-download');
  const $out  = document.getElementById('qr-canvas');
  const $st   = document.getElementById('qr-status');

  let lastDataUrl = null;

  const status = (kind, msg) => {
    $st.className = `status show ${kind}`;
    $st.textContent = msg;
  };

  const reset = () => {
    $st.className = 'status';
    $st.textContent = '';
  };

  $gen.addEventListener('click', async () => {
    const text = $text.value.trim();
    if (!text) { status('error', 'El texto no puede estar vacio.'); return; }
    status('loading', 'Generando...');
    $gen.disabled = true;
    try {
      const r = await window.api.generateQR(text);
      if (!r.ok) throw new Error(r.error);
      lastDataUrl = r.data.dataUrl;
      $out.classList.remove('placeholder');
      $out.innerHTML = '';
      const img = document.createElement('img');
      img.src = lastDataUrl;
      img.alt = 'QR generado';
      $out.appendChild(img);
      $dl.disabled = false;
      status('success', 'QR generado.');
    } catch (e) {
      status('error', e.message);
    } finally {
      $gen.disabled = false;
    }
  });

  $clr.addEventListener('click', () => {
    $text.value = '';
    lastDataUrl = null;
    $out.classList.add('placeholder');
    $out.innerHTML = 'QR aparecera aqui';
    $dl.disabled = true;
    reset();
  });

  $cpy.addEventListener('click', async () => {
    const t = $text.value;
    if (!t) { status('error', 'No hay texto para copiar.'); return; }
    try {
      await navigator.clipboard.writeText(t);
      status('success', 'Texto copiado al portapapeles.');
    } catch (e) {
      status('error', 'No se pudo copiar: ' + e.message);
    }
  });

  $dl.addEventListener('click', () => {
    if (!lastDataUrl) return;
    const a = document.createElement('a');
    a.href = lastDataUrl;
    a.download = `qr-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
})();
