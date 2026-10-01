'use strict';

/**
 * Decode JWT. Utilidad 100% local (no IPC, no red, no verifica firma).
 * Decodifica header y payload (base64url -> UTF-8) y muestra los claims más
 * comunes interpretados (fechas exp/iat/nbf, estado de expiración).
 */
(function () {
  const $input     = document.getElementById('jwt-input');
  const $decode    = document.getElementById('jwt-decode');
  const $clear     = document.getElementById('jwt-clear');
  const $copy      = document.getElementById('jwt-copy');
  const $status    = document.getElementById('jwt-status');
  const $output    = document.getElementById('jwt-output');
  const $claims    = document.getElementById('jwt-claims');
  const $header    = document.getElementById('jwt-header');
  const $payload   = document.getElementById('jwt-payload');
  const $signature = document.getElementById('jwt-signature');
  const $copyHead  = document.getElementById('jwt-copy-header');
  const $copyPay   = document.getElementById('jwt-copy-payload');

  if (!$input) return;

  let lastPayloadStr = '';
  let lastHeaderStr  = '';

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  // base64url -> string UTF-8 (maneja acentos via TextDecoder).
  function b64urlDecode(seg) {
    let s = String(seg).replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad) s += '='.repeat(4 - pad);
    const bin = atob(s); // lanza si no es base64 válido
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  function fmtDate(unixSeconds) {
    const d = new Date(Number(unixSeconds) * 1000);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function relTime(d) {
    const diffMs = d.getTime() - Date.now();
    const past = diffMs < 0;
    let s = Math.abs(diffMs) / 1000;
    const units = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
    const parts = [];
    for (const [label, secs] of units) {
      if (s >= secs || (label === 's' && !parts.length)) {
        const n = Math.floor(s / secs);
        if (n > 0 || (label === 's' && !parts.length)) parts.push(`${n}${label}`);
        s -= n * secs;
      }
      if (parts.length >= 2) break;
    }
    const txt = parts.join(' ');
    return past ? `hace ${txt}` : `en ${txt}`;
  }

  function addClaim(label, value, tone) {
    const row = document.createElement('div');
    row.className = 'b2b-meta-row';
    const strong = document.createElement('strong');
    strong.textContent = label + ':';
    const span = document.createElement('span');
    span.textContent = ' ' + value;
    if (tone) span.className = `jwt-tone-${tone}`;
    row.appendChild(strong);
    row.appendChild(span);
    $claims.appendChild(row);
  }

  const TIME_CLAIMS = { exp: 'Expira (exp)', iat: 'Emitido (iat)', nbf: 'Válido desde (nbf)' };

  function renderClaims(header, payload) {
    $claims.innerHTML = '';

    if (header && (header.alg || header.typ || header.kid)) {
      const meta = [header.alg && `alg=${header.alg}`, header.typ && `typ=${header.typ}`, header.kid && `kid=${header.kid}`]
        .filter(Boolean).join('  ·  ');
      addClaim('Header', meta);
    }

    const known = ['iss', 'sub', 'aud', 'jti'];
    known.forEach((k) => {
      if (payload[k] != null) {
        const v = Array.isArray(payload[k]) ? payload[k].join(', ') : String(payload[k]);
        addClaim(k, v);
      }
    });

    Object.keys(TIME_CLAIMS).forEach((k) => {
      if (payload[k] == null) return;
      const d = fmtDate(payload[k]);
      if (!d) { addClaim(TIME_CLAIMS[k], String(payload[k])); return; }
      addClaim(TIME_CLAIMS[k], `${d.toLocaleString('es-UY')}  (${relTime(d)})`);
    });

    // Estado de expiración.
    if (payload.exp != null) {
      const d = fmtDate(payload.exp);
      if (d) {
        const expired = d.getTime() < Date.now();
        addClaim('Estado', expired ? 'EXPIRADO' : 'Vigente', expired ? 'bad' : 'good');
      }
    }
    if (payload.nbf != null) {
      const d = fmtDate(payload.nbf);
      if (d && d.getTime() > Date.now()) addClaim('Aviso', 'Todavía no es válido (nbf en el futuro)', 'bad');
    }

    if (!$claims.children.length) addClaim('Claims', 'sin claims estándar reconocidos');
  }

  function decode() {
    clearStatus();
    const raw = $input.value.trim().replace(/^Bearer\s+/i, '');
    if (!raw) {
      setStatus('error', 'Pega un JWT primero.');
      $input.focus();
      return;
    }
    const parts = raw.split('.');
    if (parts.length < 2) {
      $output.classList.add('hidden');
      setStatus('error', 'No parece un JWT (se esperan al menos 2 segmentos separados por ".").');
      return;
    }

    let header, payload;
    try {
      header = JSON.parse(b64urlDecode(parts[0]));
    } catch (e) {
      $output.classList.add('hidden');
      setStatus('error', 'No se pudo decodificar el header: ' + e.message);
      return;
    }
    try {
      payload = JSON.parse(b64urlDecode(parts[1]));
    } catch (e) {
      $output.classList.add('hidden');
      setStatus('error', 'No se pudo decodificar el payload: ' + e.message);
      return;
    }

    lastHeaderStr  = JSON.stringify(header, null, 2);
    lastPayloadStr = JSON.stringify(payload, null, 2);
    $header.textContent  = lastHeaderStr;
    $payload.textContent = lastPayloadStr;
    $signature.textContent = parts[2] || '(sin firma)';
    renderClaims(header, payload);

    $output.classList.remove('hidden');
    $copy.disabled = false;
    setStatus('success', `Decodificado. ${parts.length} segmento(s).`);
  }

  async function copyText(text, btn) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = '¡Copiado!';
      setTimeout(() => { btn.textContent = prev; }, 1000);
    } catch (e) {
      setStatus('error', 'No se pudo copiar: ' + e.message);
    }
  }

  $decode.addEventListener('click', decode);
  $copy.addEventListener('click', () => copyText(lastPayloadStr, $copy));
  if ($copyHead) $copyHead.addEventListener('click', () => copyText(lastHeaderStr, $copyHead));
  if ($copyPay)  $copyPay.addEventListener('click', () => copyText(lastPayloadStr, $copyPay));
  $clear.addEventListener('click', () => {
    $input.value = '';
    $output.classList.add('hidden');
    $copy.disabled = true;
    lastPayloadStr = '';
    lastHeaderStr = '';
    clearStatus();
    $input.focus();
  });
  $input.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); decode(); }
  });
})();
