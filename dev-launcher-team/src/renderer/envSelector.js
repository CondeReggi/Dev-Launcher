'use strict';

/**
 * Selector de ambiente global (Testing/Produccion) para las features de DUCSA
 * (Credenciales B2B, Usuarios B2C, Tarjetas Plexo, Devolucion Plexo). No es elegible desde
 * un control siempre visible en el sidebar (solo un indicador de lectura) para evitar
 * cambios accidentales de un click; el cambio real vive en un modal (Ctrl+E) para que
 * cambiar de ambiente sea una accion deliberada.
 */
(function () {
  const STORAGE_KEY = 'devlauncher.env';
  const ENVS = ['Testing', 'Produccion'];
  const DEFAULT = 'Testing';

  const $indicator      = document.getElementById('env-indicator');
  const $indicatorLabel = document.getElementById('env-indicator-label');
  const $modal          = document.getElementById('env-modal');
  const optButtons      = Array.from(document.querySelectorAll('.env-opt'));

  function get() {
    const v = localStorage.getItem(STORAGE_KEY);
    return ENVS.includes(v) ? v : DEFAULT;
  }

  function apply(env) {
    optButtons.forEach(b => {
      const on = b.dataset.env === env;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    if ($indicator) $indicator.dataset.env = env;
    if ($indicatorLabel) $indicatorLabel.textContent = 'Ambiente: ' + env;
  }

  function set(env) {
    if (!ENVS.includes(env)) return;
    if (env === get()) return;
    localStorage.setItem(STORAGE_KEY, env);
    apply(env);
    document.dispatchEvent(new CustomEvent('env:change', { detail: { env } }));
  }

  optButtons.forEach(b => b.addEventListener('click', () => { set(b.dataset.env); closeModal(); }));

  /* ---------- Modal (Ctrl+E) ---------- */

  // El indicador vive dentro del dropdown de Workshop (#workshop-menu): al abrir el modal
  // de ambiente hay que cerrar ese dropdown primero, si no quedan los dos superpuestos.
  function closeWorkshopMenu() {
    const menu = document.getElementById('workshop-menu');
    const toggle = document.getElementById('workshop-toggle');
    if (menu) menu.classList.add('hidden');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  function openModal() {
    if (!$modal) return;
    closeWorkshopMenu();
    $modal.classList.remove('hidden');
    $modal.setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    if (!$modal) return;
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
  }

  if ($indicator) $indicator.addEventListener('click', openModal);
  if ($modal) {
    $modal.querySelectorAll('[data-env-close]').forEach(el => el.addEventListener('click', closeModal));
  }

  document.addEventListener('keydown', (e) => {
    if ((e.key === 'e' || e.key === 'E') && e.ctrlKey) {
      e.preventDefault();
      if ($modal && $modal.classList.contains('hidden')) openModal();
      return;
    }
    if (e.key === 'Escape' && $modal && !$modal.classList.contains('hidden')) closeModal();
  });

  apply(get());

  window.__envSelector = { get, set, ENVS };
})();
