'use strict';

/**
 * Modal propio de la app para la X de la ventana (en vez del dialogo nativo de
 * Electron, que no respeta el tema oscuro). `main.js` intercepta el 'close' de la
 * BrowserWindow y avisa por IPC ('app:confirmClose'); este modal junta la decision
 * del usuario y la manda de vuelta con `window.api.closeDecision(...)`.
 */
(function () {
  const $modal    = document.getElementById('close-confirm-modal');
  if (!$modal || !window.api.onConfirmClose) return;

  const $quit     = document.getElementById('cc-quit');
  const $minimize = document.getElementById('cc-minimize');
  const $restart  = document.getElementById('cc-restart');
  const $cancel   = document.getElementById('cc-cancel');

  function openModal() {
    $modal.classList.remove('hidden');
    $modal.setAttribute('aria-hidden', 'false');
    if ($quit) $quit.focus();
  }

  function closeModal(decision) {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
    window.api.closeDecision(decision);
  }

  window.api.onConfirmClose(openModal);

  if ($quit) $quit.addEventListener('click', () => closeModal('quit'));
  if ($minimize) $minimize.addEventListener('click', () => closeModal('minimize'));
  if ($restart) $restart.addEventListener('click', () => closeModal('restart'));
  if ($cancel) $cancel.addEventListener('click', () => closeModal('cancel'));
  $modal.querySelectorAll('[data-cc-cancel]').forEach((el) => el.addEventListener('click', () => closeModal('cancel')));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$modal.classList.contains('hidden')) closeModal('cancel');
  });
})();
