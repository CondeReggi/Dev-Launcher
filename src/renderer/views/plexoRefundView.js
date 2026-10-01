'use strict';

(function () {
  /* ---------- DOM refs ---------- */

  const $orderId    = document.getElementById('prf-orderid');
  const $lookup     = document.getElementById('prf-lookup');
  const $spinner    = document.getElementById('prf-spinner');
  const $envBadge   = document.getElementById('prf-env-badge');
  const $envSummary = document.getElementById('prf-env-summary');
  const $status     = document.getElementById('prf-status');

  const $amount     = document.getElementById('prf-amount');
  const $meta       = document.getElementById('prf-meta');
  const $origin     = document.getElementById('prf-origin');
  const $refund     = document.getElementById('prf-refund');
  const $result     = document.getElementById('prf-result');
  const $log        = document.getElementById('prf-log');

  const $gate       = document.getElementById('prf-admin-gate');
  const $relaunch   = document.getElementById('prf-admin-relaunch');

  if (!$lookup) return;

  /* ---------- State ---------- */

  let isAdmin    = false;
  let currentId  = null; // OrderId con datos cargados
  let envsData   = null;

  function currentEnv() { return window.__envSelector.get(); }

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

  // El boton de devolucion se habilita solo si hay OrderId cargado + monto > 0 + metaReference.
  function refreshRefundEnabled() {
    const amount = parseFloat(String($amount.value).replace(',', '.'));
    const okAmount = Number.isFinite(amount) && amount > 0;
    const okMeta = String($meta.value).trim() !== '';
    $refund.disabled = !isAdmin || currentId == null || !okAmount || !okMeta;
  }

  /* ---------- Env badge + config summary ---------- */

  function renderEnvBadge() {
    const env = currentEnv();
    $envBadge.textContent = 'Ambiente: ' + env;
    $envBadge.className = 'env-badge ' + (env === 'Produccion' ? 'env-produccion' : 'env-testing');
  }

  function renderEnvSummary() {
    if (!envsData) { $envSummary.textContent = ''; return; }
    const s = envsData.summaries[currentEnv()] || {};
    const parts = [
      `Client: ${s.netId || '(falta)'}`,
      `ECommerce: ${s.commerceId === '' ? '(falta)' : s.commerceId}`,
      `cert: ${s.thumbprintMasked || '(falta)'}`,
      s.baseUrl || '(falta URL)',
      s.configured ? '[CONFIGURADO]' : '[INCOMPLETO - completar en Configuracion -> Plexo]'
    ];
    $envSummary.textContent = parts.join(' · ');
    $envSummary.classList.toggle('gu-env-summary-missing', !s.configured);
  }

  async function bootstrapEnv() {
    try {
      const r = await window.api.plexo.envs();
      if (!r.ok) throw new Error(r.error);
      envsData = r.data;
    } catch (e) {
      envsData = null;
    }
    renderEnvBadge();
    renderEnvSummary();
  }

  /* ---------- Admin gate ---------- */

  function applyAdminState() {
    if ($gate) $gate.classList.toggle('hidden', isAdmin);
    [$orderId, $lookup, $amount, $meta].forEach((el) => { if (el) el.disabled = !isAdmin; });
    refreshRefundEnabled();
    if (!isAdmin) clearStatus();
  }

  async function checkAdmin() {
    try {
      const r = await window.api.admin.status();
      isAdmin = !!(r.ok && r.data && r.data.isAdmin);
    } catch (_) {
      isAdmin = false;
    }
    applyAdminState();
  }

  async function relaunchAsAdmin() {
    $relaunch.disabled = true;
    const prev = $relaunch.textContent;
    $relaunch.textContent = 'Abriendo UAC...';
    try {
      const r = await window.api.admin.relaunch();
      if (!r.ok) throw new Error(r.error);
    } catch (e) {
      setStatus('error', `No se pudo reiniciar como administrador: ${e.message}`);
      $relaunch.disabled = false;
      $relaunch.textContent = prev;
    }
  }

  /* ---------- Lookup (datos de la orden) ---------- */

  function resetLoaded() {
    currentId = null;
    $amount.value = '';
    $meta.value = '';
    $origin.textContent = '';
    $result.classList.add('hidden');
    $result.innerHTML = '';
    refreshRefundEnabled();
  }

  async function lookup() {
    if (!isAdmin) {
      setStatus('error', 'Necesitas ejecutar la app como administrador.');
      return;
    }
    const id = $orderId.value.trim();
    if (!id) {
      setStatus('error', 'Ingresa un OrderId.');
      $orderId.focus();
      return;
    }

    clearStatus();
    $log.innerHTML = '';
    resetLoaded();

    $lookup.disabled = true;
    $spinner.classList.remove('hidden');
    setStatus('loading', 'Buscando datos de la orden...');

    const off = window.api.plexo.onLog((p) => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.plexo.refundLookup({ ordenId: id });
      if (!r.ok) throw new Error(r.error);
      const d = r.data;

      if (!d.found) {
        setStatus('error', `No se encontro la orden ${d.ordenId}.`);
        return;
      }

      currentId = d.ordenId;
      $amount.value = d.amount != null ? String(d.amount) : '';
      $meta.value = d.metaReference || '';
      $origin.textContent =
        `Orden ${d.ordenId} · ${d.isGlp ? 'GLP' : 'Combustible'} · ` +
        `ImporteServicio: ${d.importeServicio != null ? d.importeServicio : '—'} · ` +
        `Importe: ${d.importePago != null ? d.importePago : '—'}`;

      if (d.amount == null || !d.metaReference) {
        setStatus('error', 'La orden no tiene monto y/o MetaReference cargados. Completalos manualmente para devolver.');
      } else {
        setStatus('success', `Datos cargados para la orden ${d.ordenId}. Revisa y simula la devolucion.`);
      }
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      off && off();
      $lookup.disabled = false;
      $spinner.classList.add('hidden');
      refreshRefundEnabled();
    }
  }

  /* ---------- Refund ---------- */

  async function doRefund() {
    if (currentId == null) {
      setStatus('error', 'Primero busca una orden por OrderId.');
      return;
    }
    const amount = String($amount.value).replace(',', '.').trim();
    const metaReference = String($meta.value).trim();
    const amountNum = parseFloat(amount);

    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setStatus('error', 'El monto a devolver debe ser mayor a 0.');
      return;
    }
    if (!metaReference) {
      setStatus('error', 'Falta el MetaReference (codigo de autorizacion de Plexo).');
      return;
    }

    const env = currentEnv();
    const okConfirm = window.confirm(
      `Vas a enviar una DEVOLUCION REAL a Plexo (${env.toUpperCase()}):\n\n` +
      `OrderId: ${currentId}\nMonto: ${amountNum}\nMetaReference: ${metaReference}\n\n` +
      `Esta accion no se puede deshacer. ¿Continuar?`
    );
    if (!okConfirm) return;

    $refund.disabled = true;
    $lookup.disabled = true;
    $spinner.classList.remove('hidden');
    $result.classList.add('hidden');
    setStatus('loading', 'Firmando y enviando la devolucion a Plexo...');

    const off = window.api.plexo.onLog((p) => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.plexo.refund({ ordenId: currentId, amount: amountNum, metaReference, env });
      if (!r.ok) throw new Error(r.error);

      setStatus('success', `Devolucion aceptada por Plexo para la orden ${currentId}.`);
      $result.classList.remove('hidden');
      $result.textContent = JSON.stringify(r.data.transaction, null, 2);
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      off && off();
      $lookup.disabled = false;
      $spinner.classList.add('hidden');
      refreshRefundEnabled();
    }
  }

  /* ---------- Wire ---------- */

  $lookup.addEventListener('click', lookup);
  $orderId.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); lookup(); }
  });
  $amount.addEventListener('input', refreshRefundEnabled);
  $meta.addEventListener('input', refreshRefundEnabled);
  $refund.addEventListener('click', doRefund);
  if ($relaunch) $relaunch.addEventListener('click', relaunchAsAdmin);

  // Revalida el estado de admin cada vez que se entra a la vista (por si se reabrio elevada).
  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.view === 'plexoRefund') checkAdmin();
  });

  document.addEventListener('env:change', () => {
    renderEnvBadge();
    renderEnvSummary();
  });

  bootstrapEnv();
  checkAdmin();
})();
