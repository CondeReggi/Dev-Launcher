'use strict';

/**
 * Reportes recurrentes: grilla de reportes (una card por reporte, hoy solo uno) +
 * panel de detalle donde se elige ejecutar, ver el resumen y exportar a Excel.
 * El ambiente (Testing/Produccion) reutiliza el selector global de la app
 * (envSelector.js, Ctrl+E), igual que Credenciales B2B / Usuarios B2C / Plexo.
 *
 * Algunos reportes piden un parametro antes de ejecutar (ej: que UserType exportar).
 * `reportes.params(reportId, env)` trae las opciones disponibles para ese reporte en
 * ese ambiente; hoy el unico shape soportado es `{ userTypes: [{id, name}] }`, que
 * se pinta como un <select>. Reportes sin ese campo no muestran selector.
 */
(function () {
  const $list   = document.getElementById('rp-list');
  const $detail = document.getElementById('rp-detail');
  if (!$list || !$detail) return;

  if (window.__skeleton) window.__skeleton.render($list, 2);

  let reports = [];
  let envsData = null;
  let selectedId = null;
  // Ultimo resultado corrido (para exportar sin volver a consultar la base).
  let lastResult = null; // { reportId, env, data }

  function currentEnv() { return window.__envSelector.get(); }
  function currentReport() { return reports.find((r) => r.id === selectedId) || null; }

  /* ---------- Status / log (apuntan siempre a los elementos actualmente en el DOM) ---------- */

  function setStatus(kind, msg) {
    const $status = document.getElementById('rp-status');
    if (!$status) return;
    $status.className = kind ? `status show ${kind}` : 'status';
    $status.textContent = msg || '';
  }

  function appendLog(kind, message, ts) {
    const $log = document.getElementById('rp-log');
    if (!$log) return;
    const line = document.createElement('div');
    line.className = `log-line log-${kind}`;
    const time = new Date(ts || Date.now()).toLocaleTimeString();
    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = `[${time}] ${String(kind).toUpperCase()}`;
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = ' ' + message;
    line.appendChild(tag);
    line.appendChild(msg);
    $log.appendChild(line);
    $log.scrollTop = $log.scrollHeight;
  }

  if (window.api.reportes.onLog) {
    window.api.reportes.onLog((payload) => appendLog(payload.kind, payload.message, payload.ts));
  }

  /* ---------- Carga inicial ---------- */

  async function loadReports() {
    try {
      const r = await window.api.reportes.list();
      reports = (r.ok && r.data) || [];
    } catch (_) {
      reports = [];
    }
    renderList();
  }

  async function loadEnvs() {
    try {
      const r = await window.api.reportes.envs();
      envsData = (r.ok && r.data) || null;
    } catch (_) {
      envsData = null;
    }
    renderEnvBadge();
    renderEnvSummary();
  }

  /* ---------- Grilla de reportes ---------- */

  function renderList() {
    $list.innerHTML = '';
    if (!reports.length) {
      const p = document.createElement('p');
      p.className = 'settings-empty';
      p.textContent = 'Todavia no hay reportes configurados.';
      $list.appendChild(p);
      return;
    }
    reports.forEach((rep) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card project-card' + (rep.id === selectedId ? ' selected' : '');
      card.dataset.id = rep.id;
      card.innerHTML = `
        <div class="card-title"><h3></h3></div>
        <p class="desc"></p>
        <div class="card-hint">Click para ejecutar &rarr;</div>
      `;
      card.querySelector('h3').textContent = rep.title;
      card.querySelector('.desc').textContent = rep.description;
      card.addEventListener('click', () => selectReport(rep.id));
      $list.appendChild(card);
    });
  }

  function selectReport(id) {
    if (id === selectedId) return;
    selectedId = id;
    lastResult = null;
    $list.querySelectorAll('.project-card').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
    renderDetail();
  }

  /* ---------- Panel de detalle ---------- */

  function renderEnvBadge() {
    const $badge = document.getElementById('rp-env-badge');
    if (!$badge) return;
    const env = currentEnv();
    $badge.textContent = 'Ambiente: ' + env;
    $badge.className = 'env-badge ' + (env === 'Produccion' ? 'env-produccion' : 'env-testing');
  }

  function renderEnvSummary() {
    const $summary = document.getElementById('rp-env-summary');
    if (!$summary) return;
    if (!envsData) { $summary.textContent = ''; return; }
    const s = envsData.summaries[currentEnv()] || {};
    const parts = [
      s.database ? `DB: ${s.database}` : '(falta DB)',
      s.server ? `server: ${s.server}` : '(falta server)',
      s.configured ? '[CONFIGURADO]' : '[INCOMPLETO - completar en Configuracion -> Reportes]'
    ];
    $summary.textContent = parts.join(' · ');
    $summary.classList.toggle('gu-env-summary-missing', !s.configured);
  }

  function renderCounts(counts) {
    const $counts = document.getElementById('rp-counts');
    if (!$counts) return;
    $counts.innerHTML = '';
    if (!counts) return;
    const rows = [
      ['Filas crudas', counts.rawRows],
      ['Usuarios', counts.usuarios],
      ['Usuario-Rol', counts.usuariosRoles],
      ['Rol-Feature', counts.rolesFeatures]
    ];
    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'b2b-meta-row';
      const strong = document.createElement('strong');
      strong.textContent = label;
      const span = document.createElement('span');
      span.className = 'mono';
      span.textContent = String(value);
      row.appendChild(strong);
      row.appendChild(span);
      $counts.appendChild(row);
    });
  }

  // Trae las opciones de parametro (hoy: tipos de usuario) para el reporte+ambiente
  // actual y pinta el <select>. Reportes/ambientes sin opciones dejan el campo oculto.
  async function loadParams(rep, env) {
    const $field  = document.getElementById('rp-param-field');
    const $select = document.getElementById('rp-usertype');
    const $run    = document.getElementById('rp-run');
    if (!$field || !$select) return;

    $field.classList.add('hidden');
    $select.innerHTML = '';
    if ($run) $run.disabled = true;

    const envInfo = envsData && envsData.summaries[env];
    if (envInfo && !envInfo.configured) {
      // Sin connection string en este ambiente: ni vale la pena consultar UserTypes.
      return;
    }

    try {
      const r = await window.api.reportes.params(rep.id, env);
      if (!r.ok) throw new Error(r.error);
      const data = r.data || {};
      if (Array.isArray(data.userTypes) && data.userTypes.length) {
        data.userTypes.forEach((ut) => {
          const opt = document.createElement('option');
          opt.value = String(ut.id);
          opt.textContent = `${ut.name} (${ut.id})`;
          $select.appendChild(opt);
        });
        const internoIdx = data.userTypes.findIndex((ut) => /interno/i.test(ut.name || ''));
        $select.selectedIndex = internoIdx >= 0 ? internoIdx : 0;
        $field.classList.remove('hidden');
      }
      if ($run) $run.disabled = false;
    } catch (e) {
      setStatus('error', 'No se pudieron cargar los tipos de usuario: ' + e.message);
    }
  }

  function renderDetail() {
    const rep = currentReport();
    if (!rep) {
      $detail.innerHTML = '<div class="placeholder">Selecciona un reporte para ejecutarlo.</div>';
      return;
    }

    $detail.innerHTML = `
      <div class="detail-content">
        <div class="detail-head">
          <span class="env-badge env-badge-corner" id="rp-env-badge"></span>
          <h3></h3>
          <p class="detail-desc"></p>
        </div>
        <div class="gu-toolbar">
          <label class="gu-toolbar-field hidden" id="rp-param-field">
            <span>Tipo de usuario</span>
            <select id="rp-usertype"></select>
          </label>
          <button id="rp-run" class="btn primary" type="button" disabled>Ejecutar</button>
          <button id="rp-export" class="btn" type="button" disabled>Exportar Excel</button>
          <span id="rp-spinner" class="os-spinner hidden" aria-hidden="true"></span>
        </div>
        <small id="rp-env-summary" class="gu-env-summary"></small>
        <div id="rp-status" class="status" aria-live="polite"></div>
        <div id="rp-counts" class="b2b-meta"></div>
        <div id="rp-log" class="dt-log"></div>
      </div>
    `;
    $detail.querySelector('.detail-head h3').textContent = rep.title;
    $detail.querySelector('.detail-desc').textContent = rep.description;

    renderEnvBadge();
    renderEnvSummary();
    wireDetailEvents(rep);
    loadParams(rep, currentEnv());
  }

  function wireDetailEvents(rep) {
    const $run     = document.getElementById('rp-run');
    const $export  = document.getElementById('rp-export');
    const $spinner = document.getElementById('rp-spinner');
    const $select  = document.getElementById('rp-usertype');
    const $log     = document.getElementById('rp-log');

    $run.addEventListener('click', async () => {
      const env = currentEnv();
      const envInfo = envsData && envsData.summaries[env];
      if (envInfo && !envInfo.configured) {
        setStatus('error', `El ambiente ${env} no tiene connection string configurada (Configuracion -> pestaña "Reportes").`);
        return;
      }
      const opts = {};
      if ($select && $select.options.length) opts.userTypeId = $select.value;

      $run.disabled = true;
      $export.disabled = true;
      $spinner.classList.remove('hidden');
      $log.innerHTML = '';
      renderCounts(null);
      setStatus('loading', `Ejecutando "${rep.title}" (${env})...`);
      try {
        const r = await window.api.reportes.run(rep.id, env, opts);
        if (!r.ok) throw new Error(r.error);
        lastResult = { reportId: rep.id, env, data: r.data };
        renderCounts(r.data.counts);
        setStatus('success', 'Reporte generado. Ya podes exportarlo a Excel.');
        $export.disabled = false;
      } catch (e) {
        setStatus('error', e.message);
      } finally {
        $run.disabled = false;
        $spinner.classList.add('hidden');
      }
    });

    $export.addEventListener('click', async () => {
      if (!lastResult || lastResult.reportId !== rep.id) return;
      $export.disabled = true;
      try {
        const stamp = new Date().toISOString().slice(0, 10);
        const name = `${rep.title} - ${lastResult.env} - ${stamp}.xlsx`;
        const r = await window.api.reportes.export(rep.id, lastResult.data, name);
        if (!r.ok) throw new Error(r.error);
        if (r.data) setStatus('success', `Exportado: ${r.data.path}`);
      } catch (e) {
        setStatus('error', e.message);
      } finally {
        $export.disabled = false;
      }
    });
  }

  document.addEventListener('env:change', () => {
    renderEnvBadge();
    renderEnvSummary();
    const rep = currentReport();
    if (!rep) return;
    // Cambio de ambiente invalida el resultado corrido y los tipos de usuario
    // ya cargados (Testing/Produccion pueden tener UserTypes distintos).
    lastResult = null;
    const $export = document.getElementById('rp-export');
    if ($export) $export.disabled = true;
    renderCounts(null);
    setStatus('', '');
    loadParams(rep, currentEnv());
  });

  loadReports();
  loadEnvs();
})();
