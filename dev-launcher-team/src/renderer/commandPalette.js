'use strict';

/**
 * Command palette (Ctrl+K): saltar a cualquier vista del sidebar por nombre
 * sin tener que escanear los 11 grupos de nav. La lista de vistas se lee del
 * DOM al abrir (no se hardcodea), así respeta lo que workshop.js/sections.js
 * ya ocultaron (.nav-group.hidden / .nav-item-hidden).
 */
(function () {
  const $modal = document.getElementById('cmdk-modal');
  const $input = document.getElementById('cmdk-input');
  const $list = document.getElementById('cmdk-list');
  if (!$modal || !$input || !$list) return;

  let items = [];
  let filtered = [];
  let selected = 0;

  function collectItems() {
    return Array.from(document.querySelectorAll('.nav-item[data-view]'))
      .filter(btn => !btn.classList.contains('nav-item-hidden'))
      .filter(btn => !btn.closest('.nav-group').classList.contains('hidden'))
      .map(btn => {
        const spans = btn.querySelectorAll('span');
        return {
          view: btn.dataset.view,
          icon: spans[0] ? spans[0].textContent : '',
          label: spans[1] ? spans[1].textContent.trim() : btn.dataset.view,
          group: btn.closest('.nav-group').querySelector('.nav-group-title').textContent.trim()
        };
      });
  }

  function matchScore(item, q) {
    const label = item.label.toLowerCase();
    const idx = label.indexOf(q);
    if (idx !== -1) return idx;
    const group = item.group.toLowerCase();
    if (group.indexOf(q) !== -1) return 100;
    return -1;
  }

  function render(query) {
    const q = query.trim().toLowerCase();
    filtered = !q
      ? items
      : items
        .map(item => ({ item, score: matchScore(item, q) }))
        .filter(x => x.score !== -1)
        .sort((a, b) => a.score - b.score)
        .map(x => x.item);

    selected = 0;
    $list.innerHTML = '';

    if (!filtered.length) {
      $list.innerHTML = '<div class="cmdk-empty">Sin resultados</div>';
      return;
    }

    filtered.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'cmdk-item' + (i === 0 ? ' selected' : '');
      row.dataset.index = String(i);
      row.innerHTML =
        '<span class="cmdk-item-icon">' + item.icon + '</span>' +
        '<span class="cmdk-item-label"></span>' +
        '<span class="cmdk-item-group"></span>';
      row.querySelector('.cmdk-item-label').textContent = item.label;
      row.querySelector('.cmdk-item-group').textContent = item.group;
      row.addEventListener('click', () => activate(i));
      $list.appendChild(row);
    });
  }

  function setSelected(i) {
    const rows = $list.querySelectorAll('.cmdk-item');
    if (!rows.length) return;
    selected = (i + rows.length) % rows.length;
    rows.forEach((row, idx) => row.classList.toggle('selected', idx === selected));
    rows[selected].scrollIntoView({ block: 'nearest' });
  }

  function activate(i) {
    const item = filtered[i];
    if (!item) return;
    close();
    if (window.__router) window.__router.setActive(item.view);
  }

  function open() {
    items = collectItems();
    $input.value = '';
    render('');
    $modal.classList.remove('hidden');
    $modal.setAttribute('aria-hidden', 'false');
    $input.focus();
  }

  function close() {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
  }

  function isOpen() {
    return !$modal.classList.contains('hidden');
  }

  $input.addEventListener('input', () => render($input.value));

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(selected + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(selected - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(selected); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  $modal.querySelectorAll('[data-cmdk-close]').forEach(el => el.addEventListener('click', close));

  document.addEventListener('keydown', (e) => {
    if ((e.key === 'k' || e.key === 'K') && e.ctrlKey) {
      e.preventDefault();
      if (!isOpen()) open();
    }
  });

  window.__cmdk = { open, close };
})();
