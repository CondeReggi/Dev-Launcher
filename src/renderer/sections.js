'use strict';

/**
 * Gestion de la barra lateral: ocultar/mostrar y REORDENAR solapas.
 *
 * Se controla desde el modal de Configuracion (tab "Solapas visibles") y se
 * aplica al instante (localStorage), igual que el workshop switcher.
 *
 * Persistencia (localStorage):
 *   - devlauncher.hiddenSections : array de `data-view` ocultos.
 *   - devlauncher.groupOrder     : array de titulos de `.nav-group` en el orden deseado.
 *   - devlauncher.itemOrder      : { <titulo grupo>: [<data-view>, ...] } orden interno.
 *
 * Compone con `workshop.js`: aca reordenamos el DOM y marcamos `.nav-item-hidden`;
 * la visibilidad final de grupos (workshop + grupos sin items) y el salto a la
 * primera vista visible los recomputa `window.__workshop.apply()`.
 */
(function () {
  const HIDDEN_KEY = 'devlauncher.hiddenSections';
  const GROUP_ORDER_KEY = 'devlauncher.groupOrder';
  const ITEM_ORDER_KEY = 'devlauncher.itemOrder';

  /* ---------- localStorage helpers ---------- */
  function readArray(key) {
    try {
      const a = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(a) ? a.filter((v) => typeof v === 'string') : [];
    } catch (_) { return []; }
  }
  function readObject(key) {
    try {
      const o = JSON.parse(localStorage.getItem(key) || '{}');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (_) { return {}; }
  }

  const getHidden = () => readArray(HIDDEN_KEY);
  const getGroupOrder = () => readArray(GROUP_ORDER_KEY);
  const getItemOrder = () => readObject(ITEM_ORDER_KEY);

  /* ---------- DOM helpers ---------- */
  const navRoot = () => document.getElementById('nav');
  function groupKey(g) {
    const t = g.querySelector('.nav-group-title');
    return t ? t.textContent.trim() : '';
  }
  const allGroups = () => Array.from(document.querySelectorAll('#nav .nav-group'));
  const groupItems = (g) => Array.from(g.querySelectorAll('.nav-item'));

  // Orden original (del HTML), capturado una sola vez antes de tocar el DOM, para
  // que "Restablecer orden" vuelva al orden de fabrica sin necesidad de recargar.
  let ORIGINAL_GROUPS = null;
  let ORIGINAL_ITEMS = null;
  function captureOriginal() {
    if (ORIGINAL_GROUPS) return;
    ORIGINAL_GROUPS = allGroups().map(groupKey);
    ORIGINAL_ITEMS = {};
    allGroups().forEach((g) => { ORIGINAL_ITEMS[groupKey(g)] = groupItems(g).map((it) => it.dataset.view); });
  }

  /* ---------- Ocultar / mostrar ---------- */
  function isHidden(view) { return getHidden().includes(view); }
  function setHidden(view, hidden) {
    if (!view) return;
    const set = new Set(getHidden());
    if (hidden) set.add(view); else set.delete(view);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(set)));
    apply();
  }

  /* ---------- Reordenar ---------- */
  // Orden de grupos: primero los del orden guardado (que existan), luego los nuevos
  // en su orden original de index.html.
  function moveGroup(key, dir) {
    const keys = allGroups().map(groupKey); // DOM ya esta en el orden aplicado
    const i = keys.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(keys));
    apply();
  }

  function moveItem(view, dir) {
    const g = allGroups().find((gr) => groupItems(gr).some((it) => it.dataset.view === view));
    if (!g) return;
    const key = groupKey(g);
    const views = groupItems(g).map((it) => it.dataset.view);
    const i = views.indexOf(view);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= views.length) return;
    [views[i], views[j]] = [views[j], views[i]];
    const all = getItemOrder();
    all[key] = views;
    localStorage.setItem(ITEM_ORDER_KEY, JSON.stringify(all));
    apply();
  }

  function resetOrder() {
    localStorage.removeItem(GROUP_ORDER_KEY);
    localStorage.removeItem(ITEM_ORDER_KEY);
    apply(); // vuelve al orden original capturado (ORIGINAL_GROUPS / ORIGINAL_ITEMS)
  }

  // Reordena el DOM segun el orden guardado (o el original si no hay guardado).
  // Los elementos sin entrada en el orden base quedan al final, en su orden actual,
  // asi grupos/vistas nuevos (de una version futura) no se pierden.
  function applyOrder() {
    const nav = navRoot();
    if (!nav) return;

    // Grupos
    const groups = allGroups();
    const byKey = new Map(groups.map((g) => [groupKey(g), g]));
    const storedGroups = getGroupOrder();
    const baseOrder = storedGroups.length ? storedGroups : (ORIGINAL_GROUPS || []);
    const orderedGroups = [];
    baseOrder.forEach((k) => { if (byKey.has(k)) { orderedGroups.push(byKey.get(k)); byKey.delete(k); } });
    groups.forEach((g) => { if (byKey.has(groupKey(g))) orderedGroups.push(g); });
    orderedGroups.forEach((g) => nav.appendChild(g));

    // Items dentro de cada grupo (el titulo es el primer hijo y no se toca).
    const storedItems = getItemOrder();
    orderedGroups.forEach((g) => {
      const key = groupKey(g);
      const stored = storedItems[key];
      const ord = (Array.isArray(stored) && stored.length) ? stored : (ORIGINAL_ITEMS ? ORIGINAL_ITEMS[key] : null);
      if (!Array.isArray(ord) || !ord.length) return;
      const items = groupItems(g);
      const byView = new Map(items.map((it) => [it.dataset.view, it]));
      const list = [];
      ord.forEach((v) => { if (byView.has(v)) { list.push(byView.get(v)); byView.delete(v); } });
      items.forEach((it) => { if (byView.has(it.dataset.view)) list.push(it); });
      list.forEach((it) => g.appendChild(it));
    });
  }

  /* ---------- Listado para el panel de Configuracion ---------- */
  function listGroups() {
    return allGroups().map((g) => ({
      key: groupKey(g),
      items: groupItems(g).map((el) => {
        const spans = el.querySelectorAll('span');
        const iconEl = el.querySelector('.nav-icon');
        const labelEl = spans[spans.length - 1];
        return {
          view: el.dataset.view,
          label: labelEl ? labelEl.textContent.trim() : el.dataset.view,
          icon: iconEl ? iconEl.innerHTML : ''
        };
      })
    }));
  }

  // Compat: lista plana de vistas (por si se usa en otro lado).
  function listViews() {
    return listGroups().flatMap((g) => g.items.map((it) => ({ ...it, group: g.key })));
  }

  /* ---------- Aplicar todo ---------- */
  function apply() {
    applyOrder();
    const hidden = new Set(getHidden());
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('nav-item-hidden', hidden.has(el.dataset.view));
    });
    // Recompone visibilidad de grupos (workshop + grupos vacios) y salto de vista.
    if (window.__workshop) window.__workshop.apply(window.__workshop.get());
  }

  window.__sections = {
    getHidden, isHidden, setHidden,
    moveGroup, moveItem, resetOrder,
    listGroups, listViews, apply
  };

  captureOriginal();
  apply();
})();
