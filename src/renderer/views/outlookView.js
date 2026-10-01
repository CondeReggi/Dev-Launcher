'use strict';

/**
 * Vista "Codigos TuPase (Outlook)". Conecta la cuenta de Outlook via Device Code
 * Flow (todo el OAuth + Graph corre en el proceso main) y lista los codigos
 * extraidos de los correos de TuPase recibidos desde una fecha. Solo habla con
 * el backend via window.api.outlook. Carga perezosa: recien al activar la vista.
 */
(function () {
  const $gate       = document.getElementById('ol-config-gate');
  const $openSett   = document.getElementById('ol-open-settings');
  const $main       = document.getElementById('ol-main');

  const $connDot    = document.getElementById('ol-conn-dot');
  const $accountTxt = document.getElementById('ol-account-text');
  const $connect    = document.getElementById('ol-connect');
  const $signout    = document.getElementById('ol-signout');

  const $dc         = document.getElementById('ol-devicecode');
  const $dcLink     = document.getElementById('ol-dc-link');
  const $dcCode     = document.getElementById('ol-dc-code');
  const $dcCopy     = document.getElementById('ol-dc-copy');

  const $since      = document.getElementById('ol-since');
  const $sender     = document.getElementById('ol-sender');
  const $search     = document.getElementById('ol-search');
  const $count      = document.getElementById('ol-count');
  const $spinner    = document.getElementById('ol-spinner');
  const $envSum     = document.getElementById('ol-env-summary');
  const $status     = document.getElementById('ol-status');
  const $tbody      = document.getElementById('ol-tbody');
  const $log        = document.getElementById('ol-log');

  if (!$main) return;

  let loaded    = false;
  let connected = false;
  let cfg       = null;   // public config (sin secretos)
  let verificationUri = 'https://microsoft.com/devicelogin';

  /* ---------- Helpers ---------- */

  const setStatus = (kind, msg) => { $status.className = `status show ${kind}`; $status.textContent = msg; };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  function appendLog(kind, message, ts) {
    // El evento 'code' trae el JSON del device code; lo maneja showDeviceCode, no el log.
    if (kind === 'code') { try { showDeviceCode(JSON.parse(message)); } catch (_) {} return; }
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

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  function todayIso() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function copyText(text, btn) {
    const orig = btn ? btn.textContent : '';
    try {
      await navigator.clipboard.writeText(text || '');
      if (btn) { btn.textContent = 'Copiado'; setTimeout(() => { btn.textContent = orig; }, 1200); }
    } catch (_) { /* ignore */ }
  }

  /* ---------- Estado de conexion ---------- */

  function renderConnection() {
    $connDot.classList.toggle('ol-conn-on', connected);
    $accountTxt.textContent = connected
      ? (cfg && cfg.account ? cfg.account : 'Conectado')
      : 'Sin conectar';
    $connect.textContent = connected ? 'Reconectar' : 'Conectar Outlook';
    $signout.hidden = !connected;
    $search.disabled = !connected;
  }

  function renderEnvSummary() {
    if (!cfg) { $envSum.textContent = ''; return; }
    const parts = [
      `tenant: ${cfg.tenantId || 'common'}`,
      `clientId: ${cfg.clientId ? cfg.clientId : '(falta)'}`,
      `remitente: ${cfg.senderTuPase || '(configurable abajo)'}`
    ];
    $envSum.textContent = parts.join(' · ');
    $envSum.classList.toggle('gu-env-summary-missing', !cfg.configured);
  }

  function showDeviceCode(info) {
    verificationUri = info.verificationUri || verificationUri;
    $dcCode.textContent = info.userCode || '------';
    $dcLink.textContent = (verificationUri || '').replace(/^https?:\/\//, '');
    $dc.classList.remove('hidden');
  }
  function hideDeviceCode() { $dc.classList.add('hidden'); }

  /* ---------- Bootstrap / config gate ---------- */

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    await bootstrap();
  }

  async function bootstrap() {
    try {
      const r = await window.api.outlook.status();
      if (!r.ok) throw new Error(r.error);
      cfg = r.data;
      connected = Boolean(r.data.connected);
    } catch (e) {
      loaded = false; // permitir reintento
      setStatus('error', 'Error leyendo estado de Outlook: ' + e.message);
      return;
    }

    if (!cfg.configured) {
      $gate.classList.remove('hidden');
      $main.classList.add('hidden');
      return;
    }
    $gate.classList.add('hidden');
    $main.classList.remove('hidden');

    if (!$since.value) $since.value = todayIso();
    if (!$sender.value && cfg.senderTuPase) $sender.value = cfg.senderTuPase;
    renderConnection();
    renderEnvSummary();
  }

  /* ---------- Conectar / desconectar ---------- */

  async function connect() {
    clearStatus();
    $log.innerHTML = '';
    $connect.disabled = true;
    setStatus('loading', 'Iniciando login. Segui los pasos que aparecen abajo...');
    const off = window.api.outlook.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.outlook.connect();
      if (!r.ok) throw new Error(r.error);
      connected = true;
      cfg.account = r.data.account || cfg.account;
      hideDeviceCode();
      renderConnection();
      setStatus('success', `Cuenta conectada: ${cfg.account || ''}.`);
    } catch (e) {
      hideDeviceCode();
      setStatus('error', e.message);
    } finally {
      off && off();
      $connect.disabled = false;
    }
  }

  async function signOut() {
    try {
      const r = await window.api.outlook.signOut();
      if (!r.ok) throw new Error(r.error);
      connected = false;
      cfg.account = null;
      renderConnection();
      setStatus('info', 'Cuenta desconectada.');
    } catch (e) {
      setStatus('error', e.message);
    }
  }

  /* ---------- Buscar codigos ---------- */

  async function search() {
    const sinceDate = $since.value;
    if (!sinceDate) { setStatus('error', 'Elegi una fecha desde la cual buscar.'); return; }
    const sender = ($sender.value || '').trim();

    clearStatus();
    $log.innerHTML = '';
    $search.disabled = true;
    $spinner.classList.remove('hidden');
    setStatus('loading', 'Consultando correos en Microsoft Graph...');

    const off = window.api.outlook.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.outlook.fetchCodes({ sinceDate, sender: sender || undefined });
      if (!r.ok) throw new Error(r.error);
      renderResults(r.data);
      if (!r.data.totalCodes) {
        setStatus('info', r.data.totalEmails
          ? `Se encontraron ${r.data.totalEmails} correo(s) pero ninguno con codigos (revisa el patron en Configuracion).`
          : 'No se encontraron correos de TuPase desde esa fecha.');
      } else {
        setStatus('success', `Codigos: ${r.data.totalCodes} en ${r.data.totalEmails} correo(s).`);
      }
    } catch (e) {
      renderResults({ results: [], totalCodes: 0 });
      setStatus('error', e.message);
    } finally {
      off && off();
      $search.disabled = !connected;
      $spinner.classList.add('hidden');
    }
  }

  function renderResults(data) {
    const rows = Array.isArray(data.results) ? data.results : [];
    $count.textContent = String(rows.length);
    $tbody.innerHTML = '';

    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Sin codigos para mostrar.';
      tr.appendChild(td);
      $tbody.appendChild(tr);
      return;
    }

    rows.forEach(row => {
      const tr = document.createElement('tr');

      const tdCode = document.createElement('td');
      const code = document.createElement('code');
      code.className = 'ol-code';
      code.textContent = row.codigo;
      code.title = 'Click para copiar';
      code.style.cursor = 'pointer';
      code.addEventListener('click', () => copyText(row.codigo, null));
      tdCode.appendChild(code);
      tr.appendChild(tdCode);

      const tdDate = document.createElement('td');
      tdDate.textContent = fmtDate(row.fecha);
      tr.appendChild(tdDate);

      const tdSubject = document.createElement('td');
      tdSubject.textContent = row.asunto || '';
      tr.appendChild(tdSubject);

      const tdFrom = document.createElement('td');
      tdFrom.className = 'mono';
      tdFrom.textContent = row.remitente || '';
      tr.appendChild(tdFrom);

      const tdRef = document.createElement('td');
      if (row.webLink) {
        const a = document.createElement('button');
        a.className = 'btn mini';
        a.type = 'button';
        a.textContent = 'Abrir en Outlook ↗';
        a.title = row.referencia || '';
        a.addEventListener('click', () => window.api.openExternal(row.webLink));
        tdRef.appendChild(a);
      } else {
        tdRef.className = 'mono';
        tdRef.textContent = (row.referencia || '').slice(0, 16) + '…';
      }
      tr.appendChild(tdRef);

      $tbody.appendChild(tr);
    });
  }

  /* ---------- Wire ---------- */

  $openSett.addEventListener('click', () => {
    const btn = document.getElementById('btn-settings');
    if (btn) btn.click();
  });
  $connect.addEventListener('click', connect);
  $signout.addEventListener('click', signOut);
  $search.addEventListener('click', search);
  $dcCopy.addEventListener('click', () => copyText($dcCode.textContent, $dcCopy));
  $dcLink.addEventListener('click', (ev) => { ev.preventDefault(); window.api.openExternal(verificationUri); });
  $sender.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && connected) search(); });

  /* ---------- Lazy-load: recien al activar la vista ---------- */

  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.view === 'outlook') ensureLoaded();
  });
  if (document.getElementById('view-outlook').classList.contains('active')) ensureLoaded();
})();
