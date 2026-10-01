'use strict';

(async function () {
  const $envBadge = document.getElementById('b2b-env-badge');
  const $user    = document.getElementById('b2b-user');
  const $pass    = document.getElementById('b2b-pass');
  const $summary = document.getElementById('b2b-env-summary');
  const $run     = document.getElementById('b2b-run');
  const $clear   = document.getElementById('b2b-clear');
  const $status  = document.getElementById('b2b-status');
  const $result  = document.getElementById('b2b-result');
  const $log     = document.getElementById('b2b-log');

  if (!$user) return;

  function currentEnv() { return window.__envSelector.get(); }

  function renderEnvBadge() {
    const env = currentEnv();
    $envBadge.textContent = 'Ambiente: ' + env;
    $envBadge.className = 'env-badge ' + (env === 'Produccion' ? 'env-produccion' : 'env-testing');
  }

  /* ---------- Helpers ---------- */

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

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

  function field(name) { return document.querySelector(`[data-field="${name}"]`); }

  function setVal(name, value) {
    const el = field(name);
    if (!el) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.value = value == null ? '' : String(value);
    else el.textContent = value == null ? '' : String(value);
  }

  function setDecoded(name, payload) {
    const el = field(name);
    if (!el) return;
    el.textContent = payload ? JSON.stringify(payload, null, 2) : '(no se pudo decodificar)';
    el.dataset.json = el.textContent;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text || '');
      const old = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = old; }, 1100);
    } catch (e) {
      setStatus('error', 'No se pudo copiar: ' + e.message);
    }
  }

  /* ---------- Env summary ---------- */

  let envsData = null;

  function updateSummaryFor(env) {
    if (!envsData) return;
    const s = envsData.summaries[env];
    if (!s) { $summary.textContent = ''; return; }
    $summary.innerHTML = '';
    const a = document.createElement('div'); a.textContent = `tokenUrl: ${s.tokenUrl}`;
    const b = document.createElement('div'); b.textContent = `loginUrl: ${s.loginUrl}`;
    const c = document.createElement('div'); c.textContent = `client_id: ${s.clientId}`;
    [a, b, c].forEach(x => $summary.appendChild(x));
    // Pre-fill user/password from config defaults if empty
    if (!$user.value) $user.value = s.username || '';
    if (!$pass.value) $pass.value = s.password || '';
  }

  /* ---------- Boot ---------- */

  try {
    const r = await window.api.b2b.envs();
    if (!r.ok) throw new Error(r.error);
    envsData = r.data;
    renderEnvBadge();
    updateSummaryFor(currentEnv());
  } catch (e) {
    setStatus('error', 'Error cargando ambientes: ' + e.message);
  }

  document.addEventListener('env:change', () => {
    // Reset user/password to defaults of new env
    $user.value = '';
    $pass.value = '';
    renderEnvBadge();
    updateSummaryFor(currentEnv());
  });

  /* ---------- Run ---------- */

  $run.addEventListener('click', async () => {
    clearStatus();
    $log.innerHTML = '';
    $result.classList.add('hidden');

    if (!$user.value.trim() || !$pass.value) {
      setStatus('error', 'Usuario y password son requeridos.');
      return;
    }

    $run.disabled = true;
    $clear.disabled = true;
    setStatus('loading', 'Solicitando token y autenticando...');

    const off = window.api.b2b.onLog(p => appendLog(p.kind, p.message, p.ts));

    try {
      const r = await window.api.b2b.get({
        env: currentEnv(),
        username: $user.value.trim(),
        password: $pass.value
      });
      if (!r.ok) throw new Error(r.error);
      const d = r.data;

      setVal('email', d.email);
      setVal('b2c-token', d.b2c.accessToken);
      setVal('api-token', d.api.token);
      setVal('tokenQr', d.api.tokenQr);
      setVal('codigoVerificacion', d.api.codigoVerificacion);
      setVal('usuarioAceptaTerminos', d.api.usuarioAceptaTerminos);
      setDecoded('b2c-decoded', d.b2c.payload);
      setDecoded('api-decoded', d.api.payload);

      $result.classList.remove('hidden');
      setStatus('success', 'Credenciales obtenidas. Ambiente: ' + d.env);
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      off && off();
      $run.disabled = false;
      $clear.disabled = false;
    }
  });

  $clear.addEventListener('click', () => {
    $result.classList.add('hidden');
    $log.innerHTML = '';
    clearStatus();
    ['email','b2c-token','api-token','tokenQr','codigoVerificacion','usuarioAceptaTerminos','b2c-decoded','api-decoded'].forEach(k => setVal(k, ''));
    document.querySelectorAll('.b2b-decoded').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.btn-copy-decoded').forEach(b => b.classList.add('hidden'));
    document.querySelectorAll('.btn-toggle').forEach(b => b.textContent = 'Ver decoded');
  });

  /* ---------- Copy + toggle handlers (delegated) ---------- */

  document.getElementById('view-b2bCreds').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;

    if (btn.dataset.copy) {
      const target = btn.dataset.copy;
      const el = field(target);
      let text = '';
      if (el) {
        text = el.value !== undefined ? el.value : (el.dataset.json || el.textContent);
      }
      copyText(text, btn);
      return;
    }

    if (btn.dataset.toggle) {
      const target = btn.dataset.toggle;
      const el = field(target);
      if (!el) return;
      const card = btn.closest('.b2b-token-card');
      const copyDecoded = card.querySelector('.btn-copy-decoded');
      const isHidden = el.classList.toggle('hidden');
      if (copyDecoded) copyDecoded.classList.toggle('hidden', isHidden);
      btn.textContent = isHidden ? 'Ver decoded' : 'Ocultar decoded';
      return;
    }
  });
})();
