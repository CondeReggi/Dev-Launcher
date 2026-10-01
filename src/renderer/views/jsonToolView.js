'use strict';

/**
 * JSON · formato y validación. Utilidad 100% local (no IPC, no red).
 * Formatea (indentado), minifica y valida con JSON.parse. En caso de error,
 * intenta ubicar la posición (línea/columna) a partir del mensaje del motor.
 */
(function () {
  const $input    = document.getElementById('jsont-input');
  const $output   = document.getElementById('jsont-output');
  const $status   = document.getElementById('jsont-status');
  const $size     = document.getElementById('jsont-size');
  const $indent   = document.getElementById('jsont-indent');
  const $format   = document.getElementById('jsont-format');
  const $minify   = document.getElementById('jsont-minify');
  const $validate = document.getElementById('jsont-validate');
  const $clear    = document.getElementById('jsont-clear');
  const $copy     = document.getElementById('jsont-copy');
  const $searchBar   = document.getElementById('jsont-search-bar');
  const $search      = document.getElementById('jsont-search');
  const $searchPrev  = document.getElementById('jsont-search-prev');
  const $searchNext  = document.getElementById('jsont-search-next');
  const $searchCount = document.getElementById('jsont-search-count');

  if (!$input) return;

  // Texto crudo del resultado (sin markup) para poder re-resaltar en cada busqueda.
  let currentOutput = '';
  let matches = [];       // offsets de inicio de cada coincidencia dentro de currentOutput
  let currentMatch = 0;   // indice de la coincidencia activa

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  function getIndent() {
    const v = $indent.value;
    if (v === 'tab') return '\t';
    return Number(v) || 2;
  }

  // Calcula línea/columna 1-based a partir de un offset de caracteres.
  function lineColFromPos(text, pos) {
    const upto = text.slice(0, pos);
    const line = (upto.match(/\n/g) || []).length + 1;
    const col = pos - upto.lastIndexOf('\n');
    return { line, col };
  }

  function describeError(text, err) {
    const msg = err && err.message ? err.message : String(err);
    const m = /position (\d+)/i.exec(msg);
    if (m) {
      const pos = Number(m[1]);
      const { line, col } = lineColFromPos(text, pos);
      return `JSON inválido: ${msg} (línea ${line}, columna ${col}).`;
    }
    return `JSON inválido: ${msg}`;
  }

  function setOutput(str) {
    currentOutput = str || '';
    $output.textContent = currentOutput;
    const has = !!currentOutput;
    $copy.disabled = !has;
    if (has) {
      const bytes = new Blob([str]).size;
      $size.textContent = `${bytes.toLocaleString('es-UY')} bytes`;
    } else {
      $size.textContent = '';
    }
    // Reinicia el buscador cada vez que cambia el resultado.
    $searchBar.hidden = !has;
    matches = [];
    currentMatch = 0;
    if (has && $search.value) runSearch(false);
    else updateSearchCount();
  }

  /* ---------- Buscador de propiedades / valores ---------- */

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function updateSearchCount() {
    if (!$search.value) { $searchCount.textContent = ''; return; }
    $searchCount.textContent = matches.length
      ? `${currentMatch + 1}/${matches.length}`
      : '0 resultados';
  }

  // Recalcula coincidencias y re-pinta el <pre> con <mark> por cada match.
  // resetIndex = true reposiciona en la primera coincidencia (al tipear).
  function runSearch(resetIndex) {
    const q = $search.value;
    if (!q) {
      $output.textContent = currentOutput;
      matches = [];
      updateSearchCount();
      return;
    }
    const lower = currentOutput.toLowerCase();
    const ql = q.toLowerCase();
    matches = [];
    let from = 0, idx;
    while ((idx = lower.indexOf(ql, from)) !== -1) {
      matches.push(idx);
      from = idx + ql.length;
    }
    if (!matches.length) {
      $output.textContent = currentOutput;
      currentMatch = 0;
      updateSearchCount();
      return;
    }
    if (resetIndex || currentMatch >= matches.length) currentMatch = 0;

    let html = '', cursor = 0;
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i];
      html += escapeHtml(currentOutput.slice(cursor, start));
      const cls = i === currentMatch ? 'json-hl current' : 'json-hl';
      html += `<mark class="${cls}">` + escapeHtml(currentOutput.slice(start, start + ql.length)) + '</mark>';
      cursor = start + ql.length;
    }
    html += escapeHtml(currentOutput.slice(cursor));
    $output.innerHTML = html;

    updateSearchCount();
    scrollToCurrent();
  }

  function scrollToCurrent() {
    const el = $output.querySelector('mark.current');
    if (!el) return;
    // .json-block es position:relative, asi que offsetTop es relativo al <pre>.
    $output.scrollTop = el.offsetTop - $output.clientHeight / 2 + el.offsetHeight / 2;
  }

  function stepSearch(delta) {
    if (!matches.length) return;
    currentMatch = (currentMatch + delta + matches.length) % matches.length;
    runSearch(false);
  }

  function parseOrFail() {
    const text = $input.value;
    if (!text.trim()) {
      setStatus('error', 'Pega un JSON primero.');
      $input.focus();
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(text), text };
    } catch (e) {
      setOutput('');
      setStatus('error', describeError(text, e));
      return { ok: false };
    }
  }

  function format() {
    const r = parseOrFail();
    if (!r.ok) return;
    setOutput(JSON.stringify(r.value, null, getIndent()));
    setStatus('success', 'JSON válido y formateado.');
  }

  function minify() {
    const r = parseOrFail();
    if (!r.ok) return;
    setOutput(JSON.stringify(r.value));
    setStatus('success', 'JSON válido y minificado.');
  }

  function validate() {
    const r = parseOrFail();
    if (!r.ok) return;
    const t = Array.isArray(r.value) ? `array (${r.value.length} elementos)`
      : (r.value && typeof r.value === 'object') ? `objeto (${Object.keys(r.value).length} claves)`
      : typeof r.value;
    setStatus('success', `JSON válido. Tipo raíz: ${t}.`);
  }

  async function copyResult() {
    if (!$output.textContent) return;
    try {
      await navigator.clipboard.writeText($output.textContent);
      const prev = $copy.textContent;
      $copy.textContent = '¡Copiado!';
      setTimeout(() => { $copy.textContent = prev; }, 1000);
    } catch (e) {
      setStatus('error', 'No se pudo copiar: ' + e.message);
    }
  }

  $format.addEventListener('click', format);
  $minify.addEventListener('click', minify);
  $validate.addEventListener('click', validate);
  $copy.addEventListener('click', copyResult);

  $search.addEventListener('input', () => runSearch(true));
  $search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); stepSearch(ev.shiftKey ? -1 : 1); }
  });
  $searchNext.addEventListener('click', () => stepSearch(1));
  $searchPrev.addEventListener('click', () => stepSearch(-1));
  $clear.addEventListener('click', () => {
    $input.value = '';
    $search.value = '';
    setOutput('');
    clearStatus();
    $input.focus();
  });
  // Ctrl/Cmd+Enter formatea rápido.
  $input.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); format(); }
  });
})();
