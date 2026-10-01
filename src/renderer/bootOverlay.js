'use strict';

/**
 * Overlay de pantalla completa mientras carga la vista inicial (Proyectos). Se
 * oculta desde projectsView.js apenas resuelve el primer `listProjects()` (exito
 * o error) de la categoria "dev", que es la que arranca activa. Timeout de
 * seguridad: si algo cuelga, no deja al usuario mirando el overlay para siempre.
 */
(function () {
  const $overlay = document.getElementById('app-boot-overlay');
  let done = false;

  window.__bootOverlay = {
    done() {
      if (done || !$overlay) return;
      done = true;
      $overlay.classList.add('app-boot-overlay-hide');
      setTimeout(() => { $overlay.remove(); }, 300);
    }
  };

  setTimeout(() => window.__bootOverlay.done(), 8000);
})();
