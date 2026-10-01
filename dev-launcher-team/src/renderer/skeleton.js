'use strict';

/**
 * Placeholder shimmer para cards-grid mientras se espera la primera carga de datos
 * (ej: lista de proyectos, lista de reportes). Reemplaza el "en blanco un instante"
 * por algo que ya se ve como la card real tomando forma (estilo YouTube).
 * `renderList()`/`renderDetail()` de cada vista pisa el contenido apenas los datos
 * reales llegan (mismo container, mismo innerHTML de siempre).
 */
window.__skeleton = {
  render(container, count) {
    if (!container) return;
    const n = count || 4;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const card = document.createElement('div');
      card.className = 'card skeleton-card';
      card.innerHTML = `
        <div class="skeleton-line skeleton-title"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line skeleton-desc-2"></div>
        <div class="skeleton-line skeleton-hint"></div>
      `;
      frag.appendChild(card);
    }
    container.innerHTML = '';
    container.appendChild(frag);
  }
};
