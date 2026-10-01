'use strict';

/**
 * Vista "Generacion de Facturas" — port de DistMayoristaGlp.
 *
 * Flujo:
 *   1. Buscar pedidos por Direccion de entrega (grilla).
 *   2. Elegir un pedido y tocar "Generar script": abre un asistente (wizard) con
 *      barra de progreso que pide, paso a paso, el numero de factura y el tipo de
 *      redondeo (como la consola original), y al final muestra el SQL formateado.
 *
 * No modifica la base: solo genera los scripts. Toda la aritmetica y el formateo
 * del SQL corren en el backend (facturaService); aca solo se pinta.
 */

(function () {
  /* ---------- DOM refs: busqueda / grilla ---------- */
  const $search     = document.getElementById('fac-search');
  const $top        = document.getElementById('fac-top');
  const $searchBtn  = document.getElementById('fac-search-btn');
  const $searchClear = document.getElementById('fac-search-clear');
  const $count      = document.getElementById('fac-count');
  const $spinner    = document.getElementById('fac-spinner');
  const $summary    = document.getElementById('fac-config-summary');
  const $status     = document.getElementById('fac-status');
  const $gridBody   = document.getElementById('fac-grid-body');
  const $log        = document.getElementById('fac-log');

  /* ---------- DOM refs: wizard ---------- */
  const $modal      = document.getElementById('fac-wizard-modal');
  const $wzTitle    = document.getElementById('fac-wz-title');
  const $progress   = document.getElementById('fac-progress-fill');
  const $wzPedido   = document.getElementById('fac-wz-pedido');
  const $wzPrefijo  = document.getElementById('fac-wz-prefijo');
  const $wzNumero   = document.getElementById('fac-wz-numero');
  const $wzNumeroFull = document.getElementById('fac-wz-numero-full');
  const $wzRedActual = document.getElementById('fac-wz-red-actual');
  const $wzRedOpts  = document.getElementById('fac-wz-red-opts');
  const $calcBody   = document.getElementById('fac-calc-body');
  const $calcFoot   = document.getElementById('fac-calc-foot');
  const $updates    = document.getElementById('fac-updates');
  const $insert     = document.getElementById('fac-insert');
  const $estadoCard = document.getElementById('fac-estado-card');
  const $estado     = document.getElementById('fac-estado');
  const $wzStatus   = document.getElementById('fac-wz-status');
  const $wzBack     = document.getElementById('fac-wz-back');
  const $wzNext     = document.getElementById('fac-wz-next');
  const $wzCopyAll  = document.getElementById('fac-wz-copy-all');
  const $wzSaveSql  = document.getElementById('fac-wz-save-sql');

  /* ---------- DOM refs: historial ---------- */
  const $histBody   = document.getElementById('fac-hist-body');
  const $histCount  = document.getElementById('fac-hist-count');
  const $histClear  = document.getElementById('fac-hist-clear');

  if (!$searchBtn || !$modal) return;

  const $steps    = Array.from($modal.querySelectorAll('.fac-step'));
  const $stepPanes = Array.from($modal.querySelectorAll('.fac-wz-step'));

  /* ---------- Estado ---------- */
  let prefijo = '211 A ';
  let searchResults = [];  // ultimos pedidos de la grilla (para abrir el wizard por id)

  // Estado del wizard
  let wzPedido  = null;   // fila de la grilla
  let wzModel   = null;   // resultado de getPedido (calculos + totals)
  let wzStep    = 1;
  let wzNumero  = '';
  let wzRedondeo = '5';
  let wzBuilding = false;
  let lastBuildData = null; // ultimo resultado de build() (para sugerir nombre de archivo .sql)

  let historyCache = []; // ultimo historial cargado (para el "Copiar SQL" por fila)

  // Variantes de redondeo (deben coincidir 1:1 con REDONDEO_OPTIONS del backend).
  const REDONDEO_OPTIONS = [
    { id: '1', label: '1 - redondeo',           apply: (t) => 1 - t },
    { id: '2', label: '-(1 - redondeo)',        apply: (t) => -(1 - t) },
    { id: '3', label: '1 + redondeo',           apply: (t) => 1 + t },
    { id: '4', label: '-(1 + redondeo)',        apply: (t) => -(1 + t) },
    { id: '5', label: 'redondeo (sin cambios)', apply: (t) => t },
    { id: '6', label: '-redondeo',              apply: (t) => -t }
  ];

  /* ---------- Helpers ---------- */
  const setStatus = (kind, msg) => { $status.className = `status show ${kind}`; $status.textContent = msg; };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };
  const setWzStatus = (kind, msg) => { $wzStatus.className = `status show ${kind}`; $wzStatus.textContent = msg; };
  const clearWzStatus = () => { $wzStatus.className = 'status'; $wzStatus.textContent = ''; };

  // Mismo formato que MostrarCalculos del C# (ToString("F10", InvariantCulture)).
  const fmt = (v, dec = 10) => Number(v).toFixed(dec);

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

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

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = 'Copiado';
        setTimeout(() => { btn.textContent = prev; }, 1200);
      }
    } catch (_) { /* ignore */ }
  }

  /* ---------- Config summary ---------- */
  async function loadInfo() {
    try {
      const r = await window.api.factura.info();
      if (!r.ok) throw new Error(r.error);
      const i = r.data;
      prefijo = i.prefijoFactura || '211 A ';
      if (i.configured) {
        $summary.textContent = `Server: ${i.server || '—'} · DB: ${i.database || '—'} · Prefijo: "${prefijo}"`;
      } else {
        $summary.textContent = 'Sin connection string configurada (Configuracion -> Factura).';
      }
    } catch (e) {
      $summary.textContent = '';
    }
  }

  /* ---------- Busqueda + grilla ---------- */
  function renderGrid(pedidos) {
    if (!pedidos.length) {
      $gridBody.innerHTML = '<tr class="os-empty"><td colspan="5">Sin resultados para esa direccion.</td></tr>';
      return;
    }
    $gridBody.innerHTML = pedidos.map((p) => `
      <tr>
        <td class="fac-num">${p.id}</td>
        <td>${escapeHtml(p.direccionEntrega || '—')}</td>
        <td>${escapeHtml(p.estado || '—')}${p.estado === 'Anulado' ? ' <span class="fac-badge-anulado">Anulado</span>' : ''}</td>
        <td class="mono">${escapeHtml(p.fechaFinalizadoStr || '—')}</td>
        <td><button class="btn primary fac-gen-btn" type="button" data-id="${p.id}">Generar script</button></td>
      </tr>
    `).join('');
  }

  async function doSearch() {
    const term = $search.value.trim();
    if (!term) {
      setStatus('error', 'Ingresa un texto para buscar por Direccion de entrega.');
      $search.focus();
      return;
    }

    const top = $top ? Number($top.value) : 50;

    clearStatus();
    $log.innerHTML = '';
    $gridBody.innerHTML = '<tr class="os-empty"><td colspan="5">Buscando...</td></tr>';
    $searchBtn.disabled = true;
    $spinner.classList.remove('hidden');
    setStatus('loading', `Buscando pedidos con direccion "${term}" (TOP ${top})...`);

    const off = window.api.factura.onLog((p) => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.factura.search(term, top);
      if (!r.ok) throw new Error(r.error);
      const d = r.data;
      searchResults = d.pedidos;
      renderGrid(d.pedidos);
      $count.textContent = String(d.pedidos.length);
      if (!d.pedidos.length) {
        setStatus('error', `No se encontraron pedidos con direccion "${term}".`);
      } else if (d.truncated) {
        setStatus('success', `${d.pedidos.length} pedido(s) (limitado a ${d.top}, subi el limite o refina la busqueda).`);
      } else {
        setStatus('success', `${d.pedidos.length} pedido(s) encontrados.`);
      }
    } catch (e) {
      $gridBody.innerHTML = '<tr class="os-empty"><td colspan="5">Error en la busqueda.</td></tr>';
      setStatus('error', e.message);
    } finally {
      off && off();
      $searchBtn.disabled = false;
      $spinner.classList.add('hidden');
    }
  }

  /* ---------- Wizard ---------- */
  function openModal() { $modal.classList.remove('hidden'); $modal.setAttribute('aria-hidden', 'false'); }
  function closeModal() { $modal.classList.add('hidden'); $modal.setAttribute('aria-hidden', 'true'); }

  function renderPedidoMeta(p, model) {
    // Cuando el modelo ya cargo, el estado autoritativo es el de la base.
    const estado = (model && model.pedido) ? model.pedido.estado : p.estado;
    const rows = [
      ['PedidoId', p.id],
      ['Direccion de entrega', escapeHtml(p.direccionEntrega || '—')],
      ['Estado', escapeHtml(estado || '—')],
      ['Fecha finalizado', escapeHtml(p.fechaFinalizadoStr || '—')]
    ];
    if (model && model.pedido) {
      rows.push(['Cliente', `${escapeHtml(model.pedido.clienteNombre || '—')} (Id ${model.pedido.clienteId})`]);
      rows.push(['Descuento', `${model.pedido.descuento}%`]);
      rows.push(['Items facturables', String(model.items.length)]);
    }
    let html = rows.map(([k, v]) => `<div class="b2b-meta-row"><strong>${k}:</strong> <span>${v}</span></div>`).join('');
    if (estado === 'Anulado') {
      html += '<div class="b2b-meta-row fac-anulado"><strong></strong> <span>El pedido esta "Anulado": se generara ademas el UPDATE de Estado a "Facturado".</span></div>';
    }
    $wzPedido.innerHTML = html;
  }

  function updateNumeroFull() {
    $wzNumeroFull.textContent = prefijo + ($wzNumero.value || '');
  }

  function renderRedondeoOptions(totalRedondeo) {
    $wzRedActual.textContent = String(totalRedondeo);
    $wzRedOpts.innerHTML = REDONDEO_OPTIONS.map((o) => {
      const val = o.apply(totalRedondeo);
      const checked = o.id === wzRedondeo ? 'checked' : '';
      const neg = val < 0 ? 'fac-neg' : '';
      return `
        <label class="fac-redondeo-opt">
          <input type="radio" name="fac-wz-redondeo" value="${o.id}" ${checked} />
          <span class="fac-redondeo-optlabel">${o.id} &rarr; ${escapeHtml(o.label)}</span>
          <span class="fac-redondeo-optval mono ${neg}">${String(val)}</span>
        </label>`;
    }).join('');
  }

  function selectedRedondeo() {
    const el = $wzRedOpts.querySelector('input[name="fac-wz-redondeo"]:checked');
    return el ? el.value : '4';
  }

  function renderCalcs(model) {
    const items = model.items || [];
    $calcBody.innerHTML = items.map((it) => `
      <tr>
        <td>${escapeHtml(it.descripcion || ('Producto ' + it.productoId))}<br><span class="fac-sub">Id ${it.productoId} · Mat ${it.material}</span></td>
        <td class="fac-num">${it.cantidad}</td>
        <td class="fac-num">${fmt(it.importeAuxiliar)}</td>
        <td class="fac-num">${fmt(it.bonificacion)}</td>
        <td class="fac-num">${fmt(it.importeNeto)}</td>
        <td class="fac-num">${fmt(it.iva)}</td>
        <td class="fac-num">${fmt(it.percepcionIVA)}</td>
        <td class="fac-num">${fmt(it.percepcionURSEA)}</td>
        <td class="fac-num ${it.redondeo < 0 ? 'fac-neg' : ''}">${fmt(it.redondeo)}</td>
        <td class="fac-num">${fmt(it.total)}</td>
        <td class="fac-num">${fmt(it.totalSinRedondeo)}</td>
      </tr>
    `).join('');

    const t = model.totals;
    $calcFoot.innerHTML = `
      <tr class="fac-totrow">
        <td>TOTALES</td>
        <td class="fac-num"></td>
        <td class="fac-num">${fmt(t.totalImporteAuxiliar)}</td>
        <td class="fac-num">${fmt(t.totalBonificacion)}</td>
        <td class="fac-num">${fmt(t.totalImporteNeto)}</td>
        <td class="fac-num">${fmt(t.totalIva)}</td>
        <td class="fac-num">${fmt(t.totalPercepcionIva)}</td>
        <td class="fac-num">${fmt(t.totalPercepcionUrsea)}</td>
        <td class="fac-num ${t.totalRedondeo < 0 ? 'fac-neg' : ''}">${fmt(t.totalRedondeo)}</td>
        <td class="fac-num">${fmt(t.totalFinal)}</td>
        <td class="fac-num">${fmt(t.totalSinRedondeo)}</td>
      </tr>`;
  }

  function setStep(n) {
    wzStep = n;
    $stepPanes.forEach((el) => el.classList.toggle('hidden', Number(el.dataset.step) !== n));
    $steps.forEach((el) => {
      const s = Number(el.dataset.step);
      el.classList.toggle('active', s === n);
      el.classList.toggle('done', s < n);
    });
    $progress.style.width = `${(n / 3) * 100}%`;

    $wzBack.classList.toggle('hidden', n === 1);
    $wzNext.classList.toggle('hidden', n === 3);
    $wzCopyAll.classList.toggle('hidden', n !== 3);
    if ($wzSaveSql) $wzSaveSql.classList.toggle('hidden', n !== 3);
    $wzNext.textContent = n === 2 ? 'Generar scripts' : 'Siguiente';
  }

  function setNextEnabled(on) { $wzNext.disabled = !on; }

  async function openWizard(pedido) {
    wzPedido = pedido;
    wzModel = null;
    wzNumero = '';
    wzRedondeo = '5';
    wzBuilding = false;
    lastBuildData = null;

    // Reset UI del modal
    $wzTitle.textContent = `Generar factura — Pedido #${pedido.id}`;
    $wzPrefijo.textContent = prefijo;
    $wzNumero.value = '';
    updateNumeroFull();
    $wzRedOpts.innerHTML = '';
    $calcBody.innerHTML = '';
    $calcFoot.innerHTML = '';
    $updates.textContent = '';
    $insert.textContent = '';
    $estado.textContent = '';
    $estadoCard.classList.add('hidden');
    clearWzStatus();
    renderPedidoMeta(pedido, null);
    setStep(1);
    setNextEnabled(false);
    openModal();

    setWzStatus('loading', `Cargando pedido ${pedido.id}...`);
    const off = window.api.factura.onLog((p) => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.factura.getPedido(pedido.id);
      if (!r.ok) throw new Error(r.error);
      wzModel = r.data;
      renderPedidoMeta(pedido, wzModel);

      if (!wzModel.items.length) {
        setWzStatus('error', 'El pedido no tiene items facturables (Cantidad > 0 con producto valido).');
        setNextEnabled(false);
        return;
      }
      clearWzStatus();
      setNextEnabled(true);
      $wzNumero.focus();
    } catch (e) {
      setWzStatus('error', e.message);
      setNextEnabled(false);
    } finally {
      off && off();
    }
  }

  async function wizardNext() {
    if (!wzModel) return;

    if (wzStep === 1) {
      const numero = $wzNumero.value.trim();
      if (!numero) {
        setWzStatus('error', 'Ingresa el numero de la factura.');
        $wzNumero.focus();
        return;
      }
      wzNumero = numero;
      clearWzStatus();
      renderRedondeoOptions(wzModel.totals.totalRedondeo);
      setStep(2);
      return;
    }

    if (wzStep === 2) {
      if (wzBuilding) return;
      wzRedondeo = selectedRedondeo();
      wzBuilding = true;
      setNextEnabled(false);
      setWzStatus('loading', 'Generando SQL...');
      const off = window.api.factura.onLog((p) => appendLog(p.kind, p.message, p.ts));
      try {
        const r = await window.api.factura.build({
          pedidoId: wzPedido.id,
          numeroFactura: wzNumero,
          redondeoOption: wzRedondeo,
          // Solo para mostrar en el historial local: no participa del calculo.
          direccionEntrega: wzPedido.direccionEntrega || ''
        });
        if (!r.ok) throw new Error(r.error);
        const d = r.data;
        lastBuildData = d;

        // Fuente autoritativa: re-render de calculos desde la lectura fresca del build.
        wzModel = { pedido: d.pedido, items: d.items, skipped: d.skipped, totals: d.totals };
        renderPedidoMeta(wzPedido, wzModel);
        renderCalcs(wzModel);

        $updates.textContent = d.updates.join('\n');
        $insert.textContent = d.insertFactura;
        if (d.updateEstadoPedido) {
          $estado.textContent = d.updateEstadoPedido;
          $estadoCard.classList.remove('hidden');
        } else {
          $estado.textContent = '';
          $estadoCard.classList.add('hidden');
        }

        setStep(3);
        setWzStatus('success', `SQL generado para la factura "${d.numeroCompleto}" (redondeo aplicado: ${String(d.redondeoAplicado)}).`);
        loadHistory();
      } catch (e) {
        setWzStatus('error', e.message);
      } finally {
        off && off();
        wzBuilding = false;
        setNextEnabled(true);
      }
    }
  }

  function wizardBack() {
    if (wzStep === 2) { clearWzStatus(); setStep(1); }
    else if (wzStep === 3) { clearWzStatus(); setStep(2); }
  }

  /* ---------- Historial de scripts generados ---------- */

  function renderHistory(list) {
    if (!$histBody) return;
    $histCount.textContent = String(list.length);
    if (!list.length) {
      $histBody.innerHTML = '<tr class="os-empty"><td colspan="6">Todavia no generaste ningun script en esta maquina.</td></tr>';
      return;
    }
    $histBody.innerHTML = list.map((h) => `
      <tr>
        <td class="mono">${escapeHtml(new Date(h.ts).toLocaleString())}</td>
        <td class="fac-num">${h.pedidoId}</td>
        <td>${escapeHtml(h.clienteNombre || h.direccionEntrega || '—')}</td>
        <td class="mono">${escapeHtml(h.numeroCompleto || '—')}</td>
        <td class="fac-num">${fmt(h.totalFinal, 2)}</td>
        <td><button class="btn fac-hist-copy" type="button" data-id="${h.id}">Copiar SQL</button></td>
      </tr>
    `).join('');
  }

  async function loadHistory() {
    try {
      const r = await window.api.factura.history();
      if (r.ok) {
        historyCache = r.data || [];
        renderHistory(historyCache);
      }
    } catch (_) { /* ignore */ }
  }

  if ($histBody) {
    $histBody.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.fac-hist-copy');
      if (!btn) return;
      const entry = historyCache.find((h) => h.id === btn.dataset.id);
      if (entry) copyText(entry.sql || '', btn);
    });
  }

  if ($histClear) {
    $histClear.addEventListener('click', async () => {
      if (!historyCache.length) return;
      if (!confirm('¿Borrar el historial local de scripts generados? Esta accion no se puede deshacer.')) return;
      try {
        const r = await window.api.factura.clearHistory();
        if (r.ok) { historyCache = r.data || []; renderHistory(historyCache); }
      } catch (_) { /* ignore */ }
    });
  }

  function buildAllSql() {
    const parts = [];
    if ($updates.textContent) parts.push('-- UPDATES:\n' + $updates.textContent);
    if ($insert.textContent) parts.push('-- INSERT FACTURA:\n' + $insert.textContent);
    if (!$estadoCard.classList.contains('hidden') && $estado.textContent) {
      parts.push('-- UPDATE ESTADO PEDIDO:\n' + $estado.textContent);
    }
    return parts.join('\n\n');
  }

  /* ---------- Wire ---------- */
  $searchBtn.addEventListener('click', doSearch);
  $search.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doSearch(); } });
  $searchClear.addEventListener('click', () => {
    $search.value = '';
    $count.textContent = '0';
    clearStatus();
    $log.innerHTML = '';
    $gridBody.innerHTML = '<tr class="os-empty"><td colspan="5">Busca por direccion de entrega para listar pedidos.</td></tr>';
    $search.focus();
  });

  // Delegacion: boton "Generar script" en cada fila.
  $gridBody.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.fac-gen-btn');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const pedido = searchResults.find((p) => p.id === id) || { id, direccionEntrega: '', estado: '', fechaFinalizadoStr: '' };
    openWizard(pedido);
  });

  // Wizard
  $wzNext.addEventListener('click', wizardNext);
  $wzBack.addEventListener('click', wizardBack);
  $wzCopyAll.addEventListener('click', () => copyText(buildAllSql(), $wzCopyAll));
  if ($wzSaveSql) {
    $wzSaveSql.addEventListener('click', async () => {
      const content = buildAllSql();
      if (!content) return;
      const suggested = (lastBuildData ? `Factura ${lastBuildData.numeroCompleto}` : 'factura')
        .replace(/[\\/:*?"<>|]/g, '_') + '.sql';
      try {
        const r = await window.api.factura.saveSql(content, suggested);
        if (r.ok && r.data) setWzStatus('success', `Guardado en ${r.data.filePath}`);
      } catch (e) {
        setWzStatus('error', e.message || String(e));
      }
    });
  }
  $wzNumero.addEventListener('input', updateNumeroFull);
  $wzNumero.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); wizardNext(); } });
  document.getElementById('fac-copy-updates').addEventListener('click', (e) => copyText($updates.textContent, e.currentTarget));
  document.getElementById('fac-copy-insert').addEventListener('click', (e) => copyText($insert.textContent, e.currentTarget));
  document.getElementById('fac-copy-estado').addEventListener('click', (e) => copyText($estado.textContent, e.currentTarget));

  $modal.querySelectorAll('[data-fac-close]').forEach((el) => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$modal.classList.contains('hidden')) closeModal();
  });

  // Refresca el resumen de config (server/db/prefijo) e historial cada vez que se entra a la vista.
  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.view === 'factura') { loadInfo(); loadHistory(); }
  });

  loadHistory();
})();
