'use strict';

(function () {
  const $btn      = document.getElementById('btn-settings');
  const $modal    = document.getElementById('settings-modal');
  if (!$btn || !$modal) return;

  const $backdrop = $modal.querySelector('.modal-backdrop');
  const $close    = document.getElementById('settings-close');
  const $cancel   = document.getElementById('settings-cancel');
  const $save     = document.getElementById('settings-save');
  const $reset    = document.getElementById('settings-reset');
  const $status   = document.getElementById('settings-status');
  const $tabs     = document.getElementById('settings-tabs');
  const $body     = document.getElementById('settings-body');

  // Section labels (top-level keys in sendQr.config.js)
  const SECTIONS = ['qr', 'entidades', 'convenios', 'usuarios', 'identity', 'b2bCredentials', 'graphUsers', 'plexo', 'jira', 'outlook', 'factura', 'reportesRecurrentes', 'auth', 'app'];
  const LABELS = {
    app: 'App',
    qr: 'QR', entidades: 'Entidades', convenios: 'Convenios',
    usuarios: 'Usuarios', identity: 'Identity', b2bCredentials: 'B2B Cred',
    graphUsers: 'Graph Users', plexo: 'Plexo', jira: 'Jira', outlook: 'Outlook', factura: 'Factura',
    reportesRecurrentes: 'Reportes', auth: 'Auth'
  };

  // Tab especial (no es config): gestiona que solapas de la barra se ven.
  const SPECIAL_SECTIONS = '__sections';

  // State
  let baseline = {};   // defaults from sendQr.config.js
  let working  = {};   // baseline + overrides, edited in-place by inputs
  let activeTab = SECTIONS[0];

  /* ---------- Helpers ---------- */

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
    if (kind === 'success') setTimeout(() => { $status.className = 'status'; $status.textContent = ''; }, 1800);
  };

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // Compute deep diff (only fields that differ from baseline). Used to build overrides JSON.
  function diff(base, edit) {
    if (!isPlainObject(base) || !isPlainObject(edit)) {
      return JSON.stringify(base) === JSON.stringify(edit) ? undefined : edit;
    }
    const out = {};
    let touched = false;
    for (const k of new Set([...Object.keys(base), ...Object.keys(edit)])) {
      const d = diff(base[k], edit[k]);
      if (d !== undefined) { out[k] = d; touched = true; }
    }
    return touched ? out : undefined;
  }

  // Set value at a dotted path inside `obj`, creating intermediate objects.
  function setAt(obj, dotted, value) {
    const parts = dotted.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  /* ---------- Field rendering ---------- */

  function inferKind(value) {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return 'json';
    if (isPlainObject(value)) return 'object';
    return 'string';
  }

  function renderField(container, key, value, dottedPath, depth) {
    const kind = inferKind(value);

    if (kind === 'object') {
      if (depth === 0) {
        // Nivel superior de una seccion (ej: "identityServer" en Reportes, o
        // "Testing"/"Produccion" en Plexo/B2B): una sola linea solapeable en vez
        // de volcar todos los campos siempre expandidos.
        const details = document.createElement('details');
        details.className = 'settings-group settings-group-collapsible';
        const summary = document.createElement('summary');
        summary.textContent = key;
        details.appendChild(summary);
        Object.keys(value).forEach(k => renderField(details, k, value[k], `${dottedPath}.${k}`, depth + 1));
        container.appendChild(details);
        return;
      }
      // Nesteado mas profundo (ej: Testing/Produccion dentro de identityServer):
      // se muestra expandido apenas se abre el nivel de arriba, sin otro click mas.
      const group = document.createElement('div');
      group.className = 'settings-group';
      group.style.marginLeft = `${depth * .5}rem`;
      const h = document.createElement('h4');
      h.textContent = key;
      group.appendChild(h);
      Object.keys(value).forEach(k => renderField(group, k, value[k], `${dottedPath}.${k}`, depth + 1));
      container.appendChild(group);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'settings-field';

    const label = document.createElement('label');
    label.textContent = key;
    label.title = dottedPath;
    wrap.appendChild(label);

    let input;
    if (kind === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.addEventListener('change', () => setAt(working, dottedPath, input.checked));
    } else if (kind === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.value = value;
      input.step = 'any';
      input.addEventListener('input', () => {
        const v = input.value === '' ? null : Number(input.value);
        setAt(working, dottedPath, Number.isNaN(v) ? input.value : v);
      });
    } else if (kind === 'json') {
      input = document.createElement('textarea');
      input.rows = 3;
      input.value = JSON.stringify(value, null, 2);
      input.addEventListener('input', () => {
        try {
          const parsed = JSON.parse(input.value);
          setAt(working, dottedPath, parsed);
          input.classList.remove('invalid');
        } catch {
          input.classList.add('invalid');
        }
      });
    } else if (key === 'defaultEnv') {
      // Ambiente por defecto (Testing/Produccion): select, no texto libre.
      input = document.createElement('select');
      ['Testing', 'Produccion'].forEach((envName) => {
        const opt = document.createElement('option');
        opt.value = envName;
        opt.textContent = envName;
        input.appendChild(opt);
      });
      input.value = ['Testing', 'Produccion'].includes(value) ? value : 'Produccion';
      input.addEventListener('change', () => setAt(working, dottedPath, input.value));
    } else {
      // string
      const isLong = typeof value === 'string' && value.length > 80;
      input = document.createElement(isLong ? 'textarea' : 'input');
      if (!isLong) input.type = 'text';
      else input.rows = 3;
      input.value = value == null ? '' : String(value);
      input.addEventListener('input', () => setAt(working, dottedPath, input.value));
    }

    input.dataset.path = dottedPath;
    wrap.appendChild(input);
    container.appendChild(wrap);
  }

  // Boton de flecha (↑/↓) para reordenar.
  function orderBtn(glyph, title, disabled, onClick) {
    const b = document.createElement('button');
    b.className = 'settings-order-btn';
    b.type = 'button';
    b.textContent = glyph;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return b;
  }

  // Panel "Solapas visibles": por cada grupo (seccion) y cada vista, permite
  // habilitar/deshabilitar (checkbox) y reordenar (flechas). Persistido en
  // localStorage por sections.js, aplica al instante.
  function renderSectionsPanel() {
    $body.innerHTML = '';

    const hint = document.createElement('p');
    hint.className = 'settings-empty';
    hint.textContent = 'Activa/desactiva y reordena las solapas de la barra lateral. Se aplica al instante (no requiere Guardar).';
    $body.appendChild(hint);

    if (!window.__sections) {
      const e = document.createElement('p');
      e.className = 'settings-empty';
      e.textContent = 'Gestor de solapas no disponible.';
      $body.appendChild(e);
      return;
    }

    const S = window.__sections;
    const groups = S.listGroups();

    const list = document.createElement('div');
    list.className = 'settings-sections-list';

    groups.forEach((g, gi) => {
      // Cabecera del grupo con flechas para mover el grupo entero.
      const head = document.createElement('div');
      head.className = 'settings-sections-grouphead';
      const gl = document.createElement('span');
      gl.className = 'settings-sections-grouplabel';
      gl.textContent = g.key;
      head.appendChild(gl);
      const gbtns = document.createElement('div');
      gbtns.className = 'settings-order-btns';
      gbtns.appendChild(orderBtn('▲', 'Subir seccion', gi === 0,
        () => { S.moveGroup(g.key, -1); renderSectionsPanel(); }));
      gbtns.appendChild(orderBtn('▼', 'Bajar seccion', gi === groups.length - 1,
        () => { S.moveGroup(g.key, 1); renderSectionsPanel(); }));
      head.appendChild(gbtns);
      list.appendChild(head);

      // Filas de vistas del grupo, con checkbox + flechas (mover dentro del grupo).
      g.items.forEach((it, ii) => {
        const row = document.createElement('div');
        row.className = 'settings-section-row';

        const lbl = document.createElement('label');
        lbl.className = 'settings-section-toggle';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !S.isHidden(it.view);
        cb.addEventListener('change', () => S.setHidden(it.view, !cb.checked));
        const icon = document.createElement('span');
        icon.className = 'nav-icon';
        icon.innerHTML = it.icon;
        const name = document.createElement('span');
        name.className = 'settings-section-name';
        name.textContent = it.label;
        lbl.appendChild(cb);
        lbl.appendChild(icon);
        lbl.appendChild(name);
        row.appendChild(lbl);

        const ibtns = document.createElement('div');
        ibtns.className = 'settings-order-btns';
        ibtns.appendChild(orderBtn('▲', 'Subir solapa', ii === 0,
          () => { S.moveItem(it.view, -1); renderSectionsPanel(); }));
        ibtns.appendChild(orderBtn('▼', 'Bajar solapa', ii === g.items.length - 1,
          () => { S.moveItem(it.view, 1); renderSectionsPanel(); }));
        row.appendChild(ibtns);

        list.appendChild(row);
      });
    });

    $body.appendChild(list);

    const resetRow = document.createElement('div');
    resetRow.className = 'settings-sections-reset';
    const rbtn = document.createElement('button');
    rbtn.className = 'btn';
    rbtn.type = 'button';
    rbtn.textContent = 'Restablecer orden';
    rbtn.title = 'Borra el orden guardado. El orden original vuelve al recargar (Ctrl+R).';
    rbtn.addEventListener('click', () => { S.resetOrder(); renderSectionsPanel(); });
    resetRow.appendChild(rbtn);
    $body.appendChild(resetRow);
  }

  function renderSection(sectionKey) {
    $body.innerHTML = '';
    if (sectionKey === SPECIAL_SECTIONS) { renderSectionsPanel(); return; }
    const sectionVal = working[sectionKey];
    if (sectionVal == null) {
      const empty = document.createElement('p');
      empty.className = 'settings-empty';
      empty.textContent = `Sin datos para "${sectionKey}".`;
      $body.appendChild(empty);
      return;
    }
    if (!isPlainObject(sectionVal)) {
      // Top-level scalar - shouldn't happen for our schema but handle anyway
      renderField($body, sectionKey, sectionVal, sectionKey, 0);
      return;
    }
    Object.keys(sectionVal).forEach(k => renderField($body, k, sectionVal[k], `${sectionKey}.${k}`, 0));
  }

  function makeTab(key, label) {
    const t = document.createElement('button');
    t.className = `settings-tab ${key === activeTab ? 'active' : ''}`;
    t.type = 'button';
    t.textContent = label;
    t.addEventListener('click', () => {
      activeTab = key;
      renderTabs();
      renderSection(activeTab);
    });
    return t;
  }

  function makeGroupLabel(text) {
    const g = document.createElement('div');
    g.className = 'settings-tab-group';
    g.textContent = text;
    return g;
  }

  function renderTabs() {
    $tabs.innerHTML = '';
    $tabs.appendChild(makeGroupLabel('Vista'));
    $tabs.appendChild(makeTab(SPECIAL_SECTIONS, 'Solapas visibles'));
    $tabs.appendChild(makeGroupLabel('Configuracion'));
    SECTIONS.forEach(s => $tabs.appendChild(makeTab(s, LABELS[s] || s)));
  }

  /* ---------- Modal lifecycle ---------- */

  async function openModal() {
    setStatus('', '');
    try {
      const r = await window.api.settings.get();
      if (!r.ok) throw new Error(r.error);
      baseline = r.data.defaults;
      working  = clone(r.data.effective);
      activeTab = SECTIONS[0];
      renderTabs();
      renderSection(activeTab);
      $modal.classList.remove('hidden');
      $modal.setAttribute('aria-hidden', 'false');
    } catch (e) {
      alert('Error cargando configuracion: ' + e.message);
    }
  }

  function closeModal() {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
  }

  async function saveModal() {
    const overrides = diff(baseline, working) || {};
    $save.disabled = true;
    setStatus('loading', 'Guardando...');
    try {
      const r = await window.api.settings.save(overrides);
      if (!r.ok) throw new Error(r.error);
      setStatus('success', 'Guardado. Cambios activos en proximo Run.');
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      $save.disabled = false;
    }
  }

  async function resetModal() {
    if (!confirm('Borrar todos los overrides y volver al baseline del .js?')) return;
    $reset.disabled = true;
    setStatus('loading', 'Reseteando...');
    try {
      const r = await window.api.settings.save({});
      if (!r.ok) throw new Error(r.error);
      // Reload working from defaults
      working = clone(baseline);
      renderSection(activeTab);
      setStatus('success', 'Overrides borrados.');
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      $reset.disabled = false;
    }
  }

  /* ---------- Wire ---------- */

  $btn.addEventListener('click', openModal);
  $close.addEventListener('click', closeModal);
  $cancel.addEventListener('click', closeModal);
  $backdrop.addEventListener('click', closeModal);
  $save.addEventListener('click', saveModal);
  $reset.addEventListener('click', resetModal);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$modal.classList.contains('hidden')) closeModal();
  });
})();
