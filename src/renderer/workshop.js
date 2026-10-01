'use strict';

/**
 * Workshop switcher: filtra que `.nav-group` de la barra lateral se ven.
 * Cada grupo declara su workshop con `data-workshop` en index.html.
 *   - "todos"    -> muestra todos los grupos.
 *   - "personal" -> solo grupos data-workshop="personal" (Media).
 *   - "trabajo"  -> solo grupos data-workshop="trabajo" (Dev, QR, DUCSA, Push).
 *
 * La preferencia se guarda en localStorage y se aplica al instante. Si el
 * workshop oculta la vista activa, salta a la primera vista visible. El control
 * es una solapa desplegable en el pie de la barra lateral (index.html).
 */
(function () {
  const STORAGE_KEY = 'devlauncher.workshop';
  const DEFAULT = 'todos';
  const WORKSHOPS = {
    todos:    { label: 'Todos',    allow: null },          // null = todos visibles
    personal: { label: 'Personal', allow: ['personal'] },
    trabajo:  { label: 'Trabajo',  allow: ['trabajo'] }
  };

  const groups     = Array.from(document.querySelectorAll('.nav-group'));
  const optButtons = Array.from(document.querySelectorAll('.workshop-opt'));
  const $switcher  = document.getElementById('workshop-switcher');
  const $toggle    = document.getElementById('workshop-toggle');
  const $menu      = document.getElementById('workshop-menu');
  const $current   = document.getElementById('workshop-current');

  function get() {
    const v = localStorage.getItem(STORAGE_KEY);
    return WORKSHOPS[v] ? v : DEFAULT;
  }

  function groupVisible(group, name) {
    const allow = WORKSHOPS[name].allow;
    return !allow || allow.includes(group.dataset.workshop);
  }

  // Un item cuenta como visible si su vista no fue deshabilitada (sections.js
  // le pone `.nav-item-hidden`). Si sections.js no esta cargado, todos visibles.
  function itemEnabled(item) {
    return !item.classList.contains('nav-item-hidden');
  }

  function apply(name) {
    if (!WORKSHOPS[name]) name = DEFAULT;

    // Un grupo se oculta si el workshop lo oculta O si no le queda ninguna vista
    // habilitada (todas deshabilitadas desde Configuracion).
    groups.forEach(g => {
      const hasVisibleItem = Array.from(g.querySelectorAll('.nav-item')).some(itemEnabled);
      g.classList.toggle('hidden', !groupVisible(g, name) || !hasVisibleItem);
    });

    // Si la vista activa quedo oculta (por workshop o por estar deshabilitada),
    // salto a la primera vista visible y habilitada.
    const active = document.querySelector('.nav-item.active');
    const activeHidden = !active
      || active.closest('.nav-group').classList.contains('hidden')
      || !itemEnabled(active);
    if (activeHidden) {
      const firstVisible = document.querySelector('.nav-group:not(.hidden) .nav-item:not(.nav-item-hidden)');
      if (firstVisible && window.__router) window.__router.setActive(firstVisible.dataset.view);
    }

    optButtons.forEach(b => {
      const on = b.dataset.workshop === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    if ($current) $current.textContent = WORKSHOPS[name].label;
  }

  function set(name) {
    if (!WORKSHOPS[name]) return;
    localStorage.setItem(STORAGE_KEY, name);
    apply(name);
  }

  /* ---------- Desplegable ---------- */

  function openMenu() {
    if (!$menu || !$toggle) return;
    $menu.classList.remove('hidden');
    $toggle.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    if (!$menu || !$toggle) return;
    $menu.classList.add('hidden');
    $toggle.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu() {
    if ($menu && $menu.classList.contains('hidden')) openMenu(); else closeMenu();
  }

  if ($toggle) $toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });

  optButtons.forEach(b => b.addEventListener('click', () => { set(b.dataset.workshop); closeMenu(); }));

  // Cerrar al click afuera o con Escape.
  document.addEventListener('click', (e) => {
    if ($switcher && !$switcher.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  apply(get());

  window.__workshop = { get, set, apply, WORKSHOPS };
})();
