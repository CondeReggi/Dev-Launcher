'use strict';

// Router minimo: esta app tiene una unica vista (OneSignal Directo), asi que
// no hace falta el sistema de nav-items/vistas multiples de dev-launcher.
// Igual disparamos 'view:change' porque osDirectView.js lo escucha para
// hacer su primera carga de config (lazy, igual que en la app completa).
(function () {
  // Diferido a DOMContentLoaded: osDirectView.js (script siguiente en el HTML)
  // recien registra su listener de 'view:change' cuando se ejecuta, y eso pasa
  // despues de este archivo pero antes de DOMContentLoaded.
  document.addEventListener('DOMContentLoaded', () => {
    document.dispatchEvent(new CustomEvent('view:change', { detail: { view: 'osDirect' } }));
    window.__bootOverlay && window.__bootOverlay.done();
  });
})();
