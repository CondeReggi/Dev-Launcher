'use strict';

(async function () {
  const list = document.getElementById('ducsa-tools-list');
  if (!list) return;

  /* ---------- Operation registry ---------- */

  const TOOLS = [
    {
      id: 'qr',
      title: '1. Procesar QR',
      desc: 'Lee URLs/strings de QR de un Excel (columna F por defecto), obtiene token via password flow, y POSTea cada uno a /api/OrdenPago/v3/Qr.',
      env: 'PROD',
      buildFields: (d) => [
        { key: 'rutaExcel',       label: 'Ruta Excel',         value: d.qr.rutaExcel },
        { key: 'nombreArchivo',   label: 'Nombre archivo',     value: d.qr.nombreArchivo },
        { key: 'columnaQr',       label: 'Columna',            value: d.qr.columnaQr, size: 6 },
        { key: 'urlBaseServices', label: 'URL base services',  value: d.qr.urlBaseServices, full: true },
        { key: 'delaySeconds',    label: 'Delay (s)',          value: d.qr.delaySeconds, type: 'number', size: 6 }
      ],
      summary: (opts) => `Procesa QRs leidos de "${opts.rutaExcel}\\${opts.nombreArchivo}" (col ${opts.columnaQr}) y los POSTea a ${opts.urlBaseServices}api/OrdenPago/v3/Qr.`
    },
    {
      id: 'entidades',
      title: '2. Procesar Entidades',
      desc: 'Lee un .txt con entidades separadas por coma y POSTea a urlIntegrador/api/EntidadGenerica/agregarEntidades. ATENCION: el C# original solo envia la ULTIMA entidad por bug; activa "Enviar todas" para llamar a cada una.',
      env: 'INTEGRADOR',
      buildFields: (d) => [
        { key: 'rutaWord',         label: 'Ruta TXT',           value: d.entidades.rutaWord },
        { key: 'nombreArchivoTxt', label: 'Nombre archivo',     value: d.entidades.nombreArchivoTxt },
        { key: 'urlIntegrador',    label: 'URL integrador',     value: d.entidades.urlIntegrador, full: true },
        { key: 'endpoint',         label: 'Endpoint',           value: d.entidades.endpoint, full: true },
        { key: 'tipoEntidadId',    label: 'TipoEntidadId',      value: d.entidades.tipoEntidadId, type: 'number', size: 6 },
        { key: 'eliminado',        label: 'Eliminado',          value: d.entidades.eliminado, type: 'number', size: 6 },
        { key: 'sendAll',          label: 'Enviar TODAS (corrige bug del C#)', value: false, type: 'checkbox', full: true },
        { key: 'delaySeconds',     label: 'Delay (s)',          value: d.entidades.delaySeconds, type: 'number', size: 6 }
      ],
      summary: (opts) => `Lee "${opts.rutaWord}\\${opts.nombreArchivoTxt}", ${opts.sendAll ? 'envia CADA entidad' : 'envia SOLO la ultima entidad (legacy)'} a ${opts.urlIntegrador}${opts.endpoint}.`
    },
    {
      id: 'convenios',
      title: '3. Procesar Convenios por Cedula',
      desc: 'Lee cedulas de Excel (columna A), obtiene un test-token y por cada cedula consulta convenios. Marca cuales tienen registros.',
      env: 'TEST',
      buildFields: (d) => [
        { key: 'rutaExcelCedula',             label: 'Ruta Excel',         value: d.convenios.rutaExcelCedula },
        { key: 'nombreArchivoCedula',         label: 'Nombre archivo',     value: d.convenios.nombreArchivoCedula },
        { key: 'columnaCedula',               label: 'Columna',            value: d.convenios.columnaCedula, size: 6 },
        { key: 'urlBaseServicesTransaccional',label: 'URL services',       value: d.convenios.urlBaseServicesTransaccional, full: true },
        { key: 'tokenUrl',                    label: 'Token URL',          value: d.convenios.tokenUrl, full: true },
        { key: 'delaySeconds',                label: 'Delay (s)',          value: d.convenios.delaySeconds, type: 'number', size: 6 }
      ],
      summary: (opts) => `Lee cedulas de "${opts.rutaExcelCedula}\\${opts.nombreArchivoCedula}" (col ${opts.columnaCedula}) y consulta ${opts.urlBaseServicesTransaccional}.`
    },
    {
      id: 'usuarios',
      title: '4. Procesar Usuarios (Azure Concentrador)',
      desc: 'Lee usuarios de Excel y los crea en /Usuarios/Create/Azure. Usa Bearer + apiClientSecret hardcoded. Si el Bearer esta vencido, edita src/config/sendQr.config.js.',
      env: 'PROD',
      buildFields: (d) => [
        { key: 'rutaExcelUsuarios',     label: 'Ruta Excel',          value: d.usuarios.rutaExcelUsuarios },
        { key: 'nombreArchivoUsuarios', label: 'Nombre archivo',      value: d.usuarios.nombreArchivoUsuarios },
        { key: 'urlBaseConcentrador',   label: 'URL concentrador',    value: d.usuarios.urlBaseConcentrador, full: true },
        { key: 'endpoint',              label: 'Endpoint',            value: d.usuarios.endpoint, full: true },
        { key: 'tenantUsuarioChofer',   label: 'TenantId chofer',     value: d.usuarios.tenantUsuarioChofer, size: 6 },
        { key: 'defaultPassword',       label: 'Password default',    value: d.usuarios.defaultPassword, size: 6 },
        { key: 'delaySeconds',          label: 'Delay (s)',           value: d.usuarios.delaySeconds, type: 'number', size: 6 }
      ],
      summary: (opts) => `Lee usuarios de "${opts.rutaExcelUsuarios}\\${opts.nombreArchivoUsuarios}" y los crea via ${opts.urlBaseConcentrador}${opts.endpoint}. Bearer hardcoded en config.`,
      extraNote: 'Bearer Token preview: comprueba en src/config/sendQr.config.js si esta vencido.'
    },
    {
      id: 'identity',
      title: '5. Validar Credenciales Transaccional - Identity',
      desc: 'Pide token via client_credentials e invoca /connect/introspect para validar.',
      env: null,
      buildFields: (d) => [
        { key: 'env', label: 'Ambiente', value: d.identity.defaultEnv, type: 'select', options: d.identity.envs, full: true }
      ],
      summary: (opts) => `client_credentials + introspect contra ambiente "${opts.env}".`
    },
    {
      id: 'magento',
      title: '6. Validar Token Magento - Introspect',
      desc: 'Valida un token YA emitido contra /connect/introspect con Basic scope:apiSecret (los datos de Magento). No pide token nuevo: pega el token a validar. El log muestra el curl equivalente. El token es valido si la respuesta trae active=true.',
      env: 'TEST',
      buildFields: (d) => [
        { key: 'issuer',    label: 'Issuer',                value: d.magento.issuer, full: true },
        { key: 'scope',     label: 'Scope (usuario Basic)', value: d.magento.scope, full: true },
        { key: 'apiSecret', label: 'ApiSecret (pass Basic)',value: d.magento.apiSecret, full: true },
        { key: 'token',     label: 'Token a validar',       value: '', full: true }
      ],
      summary: (opts) => `introspect del token contra ${opts.issuer}/connect/introspect (Basic ${opts.scope}:***).`
    }
  ];

  /* ---------- Helpers ---------- */

  const ENV_LABELS = {
    PROD:       { label: 'PROD',       cls: 'env-prod' },
    TEST:       { label: 'TEST',       cls: 'env-test' },
    INTEGRADOR: { label: 'INTEGRADOR', cls: 'env-int' }
  };

  function makeField(field, container) {
    const wrap = document.createElement('div');
    wrap.className = `dt-field ${field.full ? 'full' : ''}`;
    if (field.size) wrap.style.maxWidth = `${field.size}rem`;

    const label = document.createElement('label');
    label.textContent = field.label;
    wrap.appendChild(label);

    let input;
    if (field.type === 'checkbox') {
      wrap.classList.add('checkbox');
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!field.value;
    } else if (field.type === 'select') {
      input = document.createElement('select');
      (field.options || []).forEach(o => {
        const op = document.createElement('option');
        op.value = o; op.textContent = o;
        if (o === field.value) op.selected = true;
        input.appendChild(op);
      });
    } else {
      input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      input.value = field.value == null ? '' : String(field.value);
    }
    input.dataset.key = field.key;
    if (field.type === 'number') input.dataset.numeric = '1';
    if (field.type === 'checkbox') input.dataset.bool = '1';
    wrap.appendChild(input);
    container.appendChild(wrap);
    return input;
  }

  function readValues(form) {
    const out = {};
    form.querySelectorAll('[data-key]').forEach(el => {
      const k = el.dataset.key;
      let v;
      if (el.dataset.bool) v = el.checked;
      else if (el.dataset.numeric) v = el.value === '' ? null : Number(el.value);
      else v = el.value;
      out[k] = v;
    });
    return out;
  }

  function appendLog(logEl, kind, message, ts) {
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
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ---------- Render one tool card ---------- */

  function renderTool(tool, defaults) {
    const card = document.createElement('div');
    card.className = 'dt-card collapsed';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'dt-head';
    head.innerHTML = `
      <span class="dt-title"></span>
      ${tool.env ? `<span class="env-badge ${ENV_LABELS[tool.env].cls}">${ENV_LABELS[tool.env].label}</span>` : ''}
      <span class="dt-toggle">&#x25BC;</span>
    `;
    head.querySelector('.dt-title').textContent = tool.title;
    head.addEventListener('click', () => card.classList.toggle('collapsed'));
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'dt-body';

    const desc = document.createElement('p');
    desc.className = 'dt-desc';
    desc.textContent = tool.desc;
    body.appendChild(desc);

    if (tool.extraNote) {
      const note = document.createElement('div');
      note.className = 'dt-note';
      note.textContent = tool.extraNote;
      body.appendChild(note);
    }

    const form = document.createElement('div');
    form.className = 'dt-form';
    tool.buildFields(defaults).forEach(f => makeField(f, form));
    body.appendChild(form);

    const actions = document.createElement('div');
    actions.className = 'dt-actions';
    const runBtn = document.createElement('button');
    runBtn.className = 'btn primary';
    runBtn.textContent = 'Ejecutar';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn';
    clearBtn.textContent = 'Limpiar log';
    actions.appendChild(runBtn);
    actions.appendChild(clearBtn);
    body.appendChild(actions);

    const status = document.createElement('div');
    status.className = 'status';
    body.appendChild(status);

    const log = document.createElement('div');
    log.className = 'dt-log';
    body.appendChild(log);

    card.appendChild(body);

    /* Wire actions */

    clearBtn.addEventListener('click', () => { log.innerHTML = ''; });

    runBtn.addEventListener('click', async () => {
      const opts = readValues(form);
      const summary = tool.summary(opts);
      const confirmed = confirm(`Vas a ejecutar: ${tool.title}\n\n${summary}\n\nConfirmar?`);
      if (!confirmed) return;

      runBtn.disabled = true;
      clearBtn.disabled = true;
      status.className = 'status show loading';
      status.textContent = 'Ejecutando...';

      // Subscribe to log channel for this op
      const off = window.api.sendQr.onLog((payload) => {
        if (payload && payload.op === tool.id) {
          appendLog(log, payload.kind, payload.message, payload.ts);
        }
      });

      try {
        const r = await window.api.sendQr.run(tool.id, opts);
        if (r.ok) {
          status.className = 'status show success';
          status.textContent = 'Operacion completada.';
        } else {
          status.className = 'status show error';
          status.textContent = r.error || 'Error desconocido.';
        }
      } catch (e) {
        status.className = 'status show error';
        status.textContent = e.message || String(e);
      } finally {
        off && off();
        runBtn.disabled = false;
        clearBtn.disabled = false;
      }
    });

    return card;
  }

  /* ---------- Boot ---------- */

  try {
    const r = await window.api.sendQr.defaults();
    if (!r.ok) throw new Error(r.error);
    const defaults = r.data;
    TOOLS.forEach(tool => list.appendChild(renderTool(tool, defaults)));
  } catch (e) {
    list.innerHTML = '';
    const err = document.createElement('p');
    err.style.color = 'var(--danger)';
    err.textContent = `Error inicializando DUCSA Tools: ${e.message}`;
    list.appendChild(err);
  }
})();
