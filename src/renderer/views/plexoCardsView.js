'use strict';

(function () {
  /* ---------- DOM refs ---------- */

  const $docType    = document.getElementById('plx-doctype');
  const $document   = document.getElementById('plx-document');
  const $load       = document.getElementById('plx-load');
  const $clearBtn   = document.getElementById('plx-clear');
  const $count      = document.getElementById('plx-count');
  const $spinner    = document.getElementById('plx-spinner');
  const $envBadge   = document.getElementById('plx-env-badge');
  const $envSummary = document.getElementById('plx-env-summary');
  const $status     = document.getElementById('plx-status');
  const $tbody      = document.getElementById('plx-tbody');
  const $log        = document.getElementById('plx-log');

  const $gate        = document.getElementById('plx-admin-gate');
  const $relaunch    = document.getElementById('plx-admin-relaunch');

  const $modal       = document.getElementById('plx-del-modal');
  const $delDoc      = document.getElementById('plx-del-doc');
  const $delBrand    = document.getElementById('plx-del-brand');
  const $delName     = document.getElementById('plx-del-name');
  const $delToken    = document.getElementById('plx-del-token');
  const $delStatus   = document.getElementById('plx-del-status');
  const $delConfirm  = document.getElementById('plx-del-confirm');

  const $infoModal   = document.getElementById('plx-info-modal');
  const $infoBody    = document.getElementById('plx-info-body');

  if (!$load) return;

  /* ---------- State ---------- */

  let cards             = [];
  let currentDoc        = '';
  let currentDocType    = 0;
  let currentEnvForList = null; // ambiente real de los datos en pantalla (puede diferir del switch global)
  let pendingDelete     = null; // card en proceso de eliminacion
  let isAdmin           = false;
  let envsData          = null;

  function currentEnv() { return window.__envSelector.get(); }

  /* ---------- Helpers ---------- */

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  const setDelStatus = (kind, msg) => {
    $delStatus.className = `status show ${kind}`;
    $delStatus.textContent = msg;
  };
  const clearDelStatus = () => { $delStatus.className = 'status'; $delStatus.textContent = ''; };

  function appendLog(kind, message, ts) {
    const line = document.createElement('div');
    line.className = `log-line log-${kind}`;
    const time = new Date(ts || Date.now()).toLocaleTimeString();
    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = `[${time}] ${kind.toUpperCase()}`;
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = ' ' + message;
    line.appendChild(tag);
    line.appendChild(msg);
    $log.appendChild(line);
    $log.scrollTop = $log.scrollHeight;
  }

  /* ---------- Env badge + config summary ---------- */

  function renderEnvBadge() {
    const env = currentEnv();
    $envBadge.textContent = 'Ambiente: ' + env;
    $envBadge.className = 'env-badge ' + (env === 'Produccion' ? 'env-produccion' : 'env-testing');
  }

  function renderEnvSummary() {
    if (!envsData) { $envSummary.textContent = ''; return; }
    const s = envsData.summaries[currentEnv()] || {};
    const parts = [
      `Client: ${s.netId || '(falta)'}`,
      `ECommerce: ${s.commerceId === '' ? '(falta)' : s.commerceId}`,
      `cert: ${s.thumbprintMasked || '(falta)'}`,
      s.baseUrl || '(falta URL)',
      s.configured ? '[CONFIGURADO]' : '[INCOMPLETO - completar en Configuracion -> Plexo]'
    ];
    $envSummary.textContent = parts.join(' · ');
    $envSummary.classList.toggle('gu-env-summary-missing', !s.configured);
  }

  async function bootstrapEnv() {
    try {
      const r = await window.api.plexo.envs();
      if (!r.ok) throw new Error(r.error);
      envsData = r.data;
    } catch (e) {
      envsData = null;
    }
    renderEnvBadge();
    renderEnvSummary();
  }

  /* ---------- Admin gate ---------- */

  function applyAdminState() {
    if ($gate) $gate.classList.toggle('hidden', isAdmin);
    // Bloquea los controles cuando no se corre como administrador.
    [$load, $clearBtn, $document, $docType].forEach((el) => {
      if (el) el.disabled = !isAdmin;
    });
    if (!isAdmin) clearStatus();
  }

  async function checkAdmin() {
    try {
      const r = await window.api.admin.status();
      isAdmin = !!(r.ok && r.data && r.data.isAdmin);
    } catch (_) {
      isAdmin = false;
    }
    applyAdminState();
  }

  async function relaunchAsAdmin() {
    $relaunch.disabled = true;
    const prev = $relaunch.textContent;
    $relaunch.textContent = 'Abriendo UAC...';
    try {
      const r = await window.api.admin.relaunch();
      // Si el usuario acepta, la app se cierra y reabre elevada (esta ventana desaparece).
      if (!r.ok) throw new Error(r.error);
    } catch (e) {
      setStatus('error', `No se pudo reiniciar como administrador: ${e.message}`);
      $relaunch.disabled = false;
      $relaunch.textContent = prev;
    }
  }

  /* ---------- Table render ---------- */

  function renderRows() {
    $tbody.innerHTML = '';
    $count.textContent = String(cards.length);

    if (!cards.length) {
      const tr = document.createElement('tr');
      tr.className = 'os-empty';
      const td = document.createElement('td');
      td.colSpan = 10;
      td.textContent = currentDoc
        ? `Sin tarjetas para el documento ${currentDoc}.`
        : 'Ingresa un documento y apreta "Listar tarjetas".';
      tr.appendChild(td);
      $tbody.appendChild(tr);
      return;
    }

    const TIPO_LABELS = { credito: 'Crédito', debito: 'Débito', prepaga: 'Prepaga' };

    cards.forEach((c) => {
      const tr = document.createElement('tr');

      const tipoLabel = TIPO_LABELS[c.tipoMedioPago] || '—';
      // El título muestra el valor crudo de Plexo para diagnosticar mapeos.
      const tipoTitle = c.tipoMedioPagoRaw
        ? `Plexo: ${c.tipoMedioPagoRaw}`
        : (c.cardType ? `Plexo: ${c.cardType}` : 'Tipo no determinado por Plexo');

      const cells = [
        { v: c.issuerName || '',      mono: false },
        { v: c.issuer || '',          mono: true  },
        { v: c.name || '',            mono: false },
        { v: c.email || '',           mono: false },
        { v: tipoLabel,               mono: false, title: tipoTitle },
        { badge: true },
        { v: c.expiration || '',      mono: false },
        { v: c.bank || '',            mono: false },
        { v: c.instrumentToken || '', mono: true  }
      ];
      cells.forEach((cell) => {
        const td = document.createElement('td');
        if (cell.badge) {
          // Celda "Habilitado": badge Sí/No según validación contra la BD.
          // Si está en "No" y es accionable (no existe el medio de pago -> INSERT,
          // o existe deshabilitado -> UPDATE), el badge es un botón que copia el SQL.
          const yes = !!c.medioPagoHabilitado;
          const actionable = !yes && (c.medioPagoStatus === 'not_found' || c.medioPagoStatus === 'disabled');
          const el = document.createElement(actionable ? 'button' : 'span');
          el.className = `plx-hab ${yes ? 'plx-hab-yes' : 'plx-hab-no'}`;
          el.textContent = yes ? 'Sí' : 'No';
          if (actionable) {
            el.type = 'button';
            el.classList.add('plx-hab-action');
            el.title = c.medioPagoStatus === 'not_found'
              ? 'No existe el medio de pago. Click para copiar el INSERT de SQL Server.'
              : 'El medio de pago existe pero está deshabilitado. Click para copiar el UPDATE de SQL Server.';
            el.addEventListener('click', () => copyFixSql(c, el));
          } else if (!yes) {
            el.title = c.medioPagoStatus === 'no_issuer' ? 'Sin issuer: no se puede generar SQL.'
              : c.medioPagoStatus === 'no_tipo' ? 'Tipo de tarjeta no determinado: no se puede generar SQL.'
              : c.medioPagoStatus === 'unchecked' ? 'No se pudo validar contra la BD.'
              : 'No habilitado.';
          }
          td.appendChild(el);
        } else {
          if (cell.mono) td.className = 'mono';
          td.textContent = cell.v;
          td.title = cell.title || cell.v;
        }
        tr.appendChild(td);
      });

      const tdAct = document.createElement('td');
      tdAct.className = 'plx-actions';

      const zoomBtn = document.createElement('button');
      zoomBtn.className = 'btn plx-zoom';
      zoomBtn.type = 'button';
      zoomBtn.title = 'Ver toda la info del instrumento';
      zoomBtn.setAttribute('aria-label', 'Ver más información');
      zoomBtn.textContent = '🔍';
      zoomBtn.addEventListener('click', () => openInfo(c));
      tdAct.appendChild(zoomBtn);

      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.type = 'button';
      btn.textContent = 'Eliminar';
      btn.addEventListener('click', () => openDelete(c));
      tdAct.appendChild(btn);

      tr.appendChild(tdAct);
      $tbody.appendChild(tr);
    });
  }

  /* ---------- Load ---------- */

  async function loadCards() {
    if (!isAdmin) {
      setStatus('error', 'Necesitas ejecutar la app como administrador.');
      return;
    }
    const doc = $document.value.trim();
    if (!doc) {
      setStatus('error', 'Ingresa un documento.');
      $document.focus();
      return;
    }

    clearStatus();
    $log.innerHTML = '';
    cards = [];
    currentDoc = '';
    currentEnvForList = null;
    renderRows();

    $load.disabled = true;
    $clearBtn.disabled = true;
    $spinner.classList.remove('hidden');
    setStatus('loading', 'Firmando y consultando Plexo...');

    const off = window.api.plexo.onLog((p) => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.plexo.list({ document: doc, documentType: Number($docType.value) || 0, env: currentEnv() });
      if (!r.ok) throw new Error(r.error);
      cards = Array.isArray(r.data.cards) ? r.data.cards : [];
      currentDoc = r.data.document;
      currentDocType = r.data.documentType;
      currentEnvForList = r.data.env;
      renderRows();
      setStatus('success', `${cards.length} tarjeta(s) para el documento ${currentDoc}.`);
    } catch (e) {
      setStatus('error', e.message);
      renderRows();
    } finally {
      off && off();
      $load.disabled = false;
      $clearBtn.disabled = false;
      $spinner.classList.add('hidden');
    }
  }

  /* ---------- Delete modal ---------- */

  function openDelete(card) {
    pendingDelete = card;
    $delDoc.textContent = currentDoc;
    $delBrand.textContent = card.issuerName || '(sin marca)';
    $delName.textContent = card.name || '(sin nombre)';
    $delToken.textContent = card.instrumentToken || '';
    clearDelStatus();
    $delConfirm.disabled = false;
    $modal.classList.remove('hidden');
    $modal.setAttribute('aria-hidden', 'false');
  }

  function closeDelete() {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
    pendingDelete = null;
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const card = pendingDelete;

    $delConfirm.disabled = true;
    setDelStatus('loading', 'Eliminando instrumento en Plexo...');

    const off = window.api.plexo.onLog((p) => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.plexo.delete({ token: card.instrumentToken, document: currentDoc, env: currentEnvForList || currentEnv() });
      if (!r.ok) throw new Error(r.error);
      // Quitar de la tabla local
      cards = cards.filter((c) => c.instrumentToken !== card.instrumentToken);
      renderRows();
      setDelStatus('success', 'Tarjeta eliminada.');
      setStatus('success', `Tarjeta eliminada. Quedan ${cards.length} tarjeta(s).`);
      setTimeout(closeDelete, 700);
    } catch (e) {
      setDelStatus('error', e.message);
      $delConfirm.disabled = false;
    } finally {
      off && off();
    }
  }

  /* ---------- SQL para habilitar el medio de pago ---------- */

  // tipo canónico -> Nombre exacto en TipoMedioPago (verificado en la BD APP).
  const TIPO_DB_NOMBRE = {
    credito: 'Tarjeta de Crédito',
    debito:  'Tarjeta de Débito',
    prepaga: 'Tarjeta Prepaga'
  };

  const sqlStr = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

  // Construye el INSERT (no existe) o el UPDATE (existe deshabilitado) que hace
  // que la tarjeta quede habilitada. Resuelve TipoMedioPagoId y PlexoMediosPagoId
  // por subconsulta para no depender de IDs hardcodeados.
  function buildFixSql(card) {
    const issuer = card.issuer || '';
    const tipoNombre = TIPO_DB_NOMBRE[card.tipoMedioPago];
    if (!issuer || !tipoNombre) return '';

    const marca = card.issuerName || issuer;
    const headComment =
      `-- Issuer Plexo (PlexoMediosPago.Codigo): ${issuer}  ->  ${marca}\n` +
      `-- Tipo: ${tipoNombre}\n` +
      `-- Base APP (SQL_SERVER).`;

    if (card.medioPagoStatus === 'disabled') {
      return [
        '-- ============================================================',
        '-- El medio de pago EXISTE pero está deshabilitado. Habilitarlo:',
        headComment,
        '-- ============================================================',
        'UPDATE mp',
        '  SET mp.Habilitado = 1',
        'FROM MediosPago mp',
        '  INNER JOIN TipoMedioPago tmp   ON tmp.TipoMedioPagoId = mp.TipoMedioPagoId',
        '  INNER JOIN PlexoMediosPago pmp ON pmp.Id              = mp.PlexoMediosPagoId',
        `WHERE pmp.Codigo = ${sqlStr(issuer)}`,
        `  AND tmp.Nombre = ${sqlStr(tipoNombre)}`,
        '  AND mp.Habilitado = 0;'
      ].join('\n');
    }

    // not_found -> INSERT. Nombre/Codigo son valores internos: se sugieren a
    // partir de la marca, revisar antes de ejecutar.
    const nombreSugerido = marca;
    const codigoSugerido = String(marca).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'REVISAR';
    return [
      '-- ============================================================',
      '-- Falta el MedioPago: la tarjeta no tiene correspondencia habilitada.',
      headComment,
      '-- Revisar Nombre / Codigo antes de ejecutar.',
      '-- ============================================================',
      'INSERT INTO MediosPago (PasarelaId, Nombre, Codigo, Habilitado, TipoMedioPagoId, PlexoMediosPagoId)',
      'SELECT',
      '    3,                     -- PasarelaId',
      `    ${sqlStr(nombreSugerido)},  -- Nombre (revisar)`,
      `    ${sqlStr(codigoSugerido)},  -- Codigo (revisar)`,
      '    1,                     -- Habilitado',
      '    tmp.TipoMedioPagoId,',
      '    pmp.Id',
      'FROM PlexoMediosPago pmp',
      'CROSS JOIN TipoMedioPago tmp',
      `WHERE pmp.Codigo = ${sqlStr(issuer)}`,
      `  AND tmp.Nombre = ${sqlStr(tipoNombre)};`
    ].join('\n');
  }

  async function copyFixSql(card, el) {
    const sql = buildFixSql(card);
    if (!sql) {
      setStatus('error', 'No se puede generar el SQL (falta issuer o tipo de tarjeta).');
      return;
    }
    try {
      await navigator.clipboard.writeText(sql);
      const prev = el.textContent;
      el.textContent = '¡Copiado!';
      el.classList.add('plx-hab-copied');
      setStatus('success', card.medioPagoStatus === 'disabled'
        ? 'UPDATE copiado al portapapeles. Pegalo en SQL Server (base APP).'
        : 'INSERT copiado al portapapeles. Pegalo en SQL Server (base APP).');
      setTimeout(() => { el.textContent = prev; el.classList.remove('plx-hab-copied'); }, 1200);
    } catch (e) {
      setStatus('error', 'No se pudo copiar al portapapeles: ' + e.message);
    }
  }

  /* ---------- Info modal (zoom) ---------- */

  const TIPO_LABELS_FULL = { credito: 'Crédito', debito: 'Débito', prepaga: 'Prepaga' };

  // Aplana un objeto/array anidado a pares [ruta, valor] con rutas punteadas.
  function flatten(value, prefix, out) {
    if (value === null || value === undefined) {
      out.push([prefix, value === null ? 'null' : '']);
      return out;
    }
    if (Array.isArray(value)) {
      if (!value.length) { out.push([prefix, '[]']); return out; }
      value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
      return out;
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (!keys.length) { out.push([prefix, '{}']); return out; }
      keys.forEach((k) => flatten(value[k], prefix ? `${prefix}.${k}` : k, out));
      return out;
    }
    out.push([prefix, String(value)]);
    return out;
  }

  function addInfoGroup(title, pairs) {
    if (!pairs.length) return;
    const h = document.createElement('div');
    h.className = 'plx-info-group';
    h.textContent = title;
    $infoBody.appendChild(h);
    pairs.forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'plx-info-row';
      const dt = document.createElement('div');
      dt.className = 'plx-info-key';
      dt.textContent = k;
      const dd = document.createElement('div');
      dd.className = 'plx-info-val mono';
      dd.textContent = v;
      dd.title = v;
      row.appendChild(dt);
      row.appendChild(dd);
      $infoBody.appendChild(row);
    });
  }

  function openInfo(card) {
    $infoBody.innerHTML = '';

    // Campos calculados / validación (no vienen en el instrumento crudo).
    addInfoGroup('Validación', [
      ['Issuer (código Plexo)', card.issuer || '—'],
      ['Tipo medio pago', TIPO_LABELS_FULL[card.tipoMedioPago] || 'No determinado'],
      ['Tipo (crudo Plexo)', card.tipoMedioPagoRaw || '—'],
      ['Medio de pago habilitado', card.medioPagoHabilitado ? 'Sí' : 'No']
    ]);

    // Instrumento completo devuelto por Plexo.
    const raw = card.raw || {};
    addInfoGroup('Instrumento (Plexo)', flatten(raw, '', []));

    $infoModal.classList.remove('hidden');
    $infoModal.setAttribute('aria-hidden', 'false');
  }

  function closeInfo() {
    $infoModal.classList.add('hidden');
    $infoModal.setAttribute('aria-hidden', 'true');
  }

  /* ---------- Wire ---------- */

  $load.addEventListener('click', loadCards);
  $clearBtn.addEventListener('click', () => {
    cards = [];
    currentDoc = '';
    currentEnvForList = null;
    $document.value = '';
    renderRows();
    clearStatus();
    $log.innerHTML = '';
  });

  document.addEventListener('env:change', () => {
    renderEnvBadge();
    renderEnvSummary();
    if (cards.length && currentEnvForList !== currentEnv()) {
      setStatus('error', `Las tarjetas en pantalla son del ambiente "${currentEnvForList}". Apreta "Listar tarjetas" para refrescar con "${currentEnv()}".`);
    }
  });
  $document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); loadCards(); }
  });

  if ($relaunch) $relaunch.addEventListener('click', relaunchAsAdmin);

  $delConfirm.addEventListener('click', confirmDelete);
  $modal.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.dataset && t.dataset.plxClose) closeDelete();
  });

  $infoModal.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.dataset && t.dataset.plxInfoClose) closeInfo();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    // El modal de info está por encima: si está abierto, se cierra primero.
    if (!$infoModal.classList.contains('hidden')) { closeInfo(); return; }
    if (!$modal.classList.contains('hidden')) closeDelete();
  });

  bootstrapEnv();
  checkAdmin();
})();
