'use strict';

(function () {
  const SAMPLE = 'A;3783529;1;2115742600111013783529;8D79706055294BC98EC669613DABF21C;211574260011;01;101;20260311;1015;3;;UYU;2985.60;0.00;0.00;22;10;0.00;0.00;2985.60;32;Domingo Martínez;SI|202603111015;0001;38.835;2985.60;3168223;4;1;76.88';

  const $text         = document.getElementById('qrp-text');
  const $parse        = document.getElementById('qrp-parse');
  const $sample       = document.getElementById('qrp-sample');
  const $clear        = document.getElementById('qrp-clear');
  const $status       = document.getElementById('qrp-status');
  const $headerCount  = document.getElementById('qrp-header-count');
  const $headerTbody  = document.querySelector('#qrp-header-table tbody');
  const $linesWrap    = document.getElementById('qrp-lines-container');
  const $json         = document.getElementById('qrp-json');
  const $copyJson     = document.getElementById('qrp-copy-json');
  const $downloadJson = document.getElementById('qrp-download-json');
  const $sendGen      = document.getElementById('qrp-send-generator');

  // Add "New QR" + "Add line" buttons next to the existing actions
  const inputCard = document.querySelector('#view-qrParse .qr-input-card .actions');
  if (inputCard && !document.getElementById('qrp-new')) {
    const newBtn = document.createElement('button');
    newBtn.id = 'qrp-new';
    newBtn.className = 'btn';
    newBtn.textContent = 'Nuevo QR (vacio)';
    inputCard.appendChild(newBtn);
  }
  const $new = document.getElementById('qrp-new');

  /**
   * state shape:
   *   {
   *     header: [{ pos, qrDatosKey, validatedKey, type, note, value }],
   *     lines:  [[{...same fields...}], ...],
   *     lineSchema: [{...same fields with empty value...}]   // for "Add line"
   *   }
   */
  let state = null;
  let lastJson = null;

  /* ---------- Status helpers ---------- */

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  /* ---------- Rebuild from state ---------- */

  function rebuild() {
    if (!state) return;
    const headerStr = state.header.map(f => f.value == null ? '' : String(f.value)).join(';');
    const linesStr  = state.lines.map(line =>
      line.map(f => f.value == null ? '' : String(f.value)).join(';')
    ).join('|');

    const full = state.lines.length ? `${headerStr}|${linesStr}` : headerStr;
    if ($text.value !== full) $text.value = full;

    const qrDatos = {};
    state.header.forEach(f => { qrDatos[f.qrDatosKey] = f.value; });
    qrDatos.Lineas = state.lines.map(line => {
      const o = {};
      line.forEach(f => { o[f.qrDatosKey] = f.value; });
      return o;
    });
    lastJson = JSON.stringify(qrDatos, null, 2);
    $json.textContent = lastJson;
    $copyJson.disabled = false;
    $downloadJson.disabled = false;
  }

  /* ---------- Field row rendering (editable) ---------- */

  function makeFieldRow(field) {
    const tr = document.createElement('tr');

    const cells = [
      { cls: 'col-pos',       text: field.pos },
      { cls: 'col-key',       text: field.qrDatosKey },
      { cls: 'col-validated', text: field.validatedKey },
      { cls: 'col-type',      text: field.type }
    ];
    cells.forEach(c => {
      const td = document.createElement('td');
      td.className = c.cls;
      td.textContent = c.text == null ? '' : String(c.text);
      tr.appendChild(td);
    });

    // Editable value cell
    const valTd = document.createElement('td');
    valTd.className = 'col-value-edit';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = field.value == null ? '' : String(field.value);
    input.spellcheck = false;
    if (/[;|]/.test(input.value)) input.classList.add('invalid');
    input.addEventListener('input', () => {
      field.value = input.value;
      input.classList.toggle('invalid', /[;|]/.test(input.value));
      rebuild();
    });
    valTd.appendChild(input);
    tr.appendChild(valTd);

    if (field.note) tr.title = field.note;
    return tr;
  }

  /* ---------- Render whole sections ---------- */

  function renderHeader() {
    $headerTbody.innerHTML = '';
    state.header.forEach(f => $headerTbody.appendChild(makeFieldRow(f)));
    $headerCount.textContent = `${state.header.length} campos`;
  }

  function renderLines() {
    $linesWrap.innerHTML = '';

    state.lines.forEach((line, i) => {
      const card = document.createElement('div');
      card.className = 'parse-card';

      const head = document.createElement('div');
      head.className = 'parse-card-header';

      const title = document.createElement('h3');
      title.textContent = `Linea ${i + 1}`;

      const actions = document.createElement('div');
      actions.className = 'actions';

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `${line.length} campos`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-remove-line';
      removeBtn.textContent = 'Eliminar';
      removeBtn.addEventListener('click', () => {
        state.lines.splice(i, 1);
        renderLines();
        rebuild();
      });

      actions.appendChild(badge);
      actions.appendChild(removeBtn);
      head.appendChild(title);
      head.appendChild(actions);
      card.appendChild(head);

      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      wrap.innerHTML = '<table><thead><tr><th>#</th><th>QrDatos.Linea</th><th>QrLineaValidado</th><th>Tipo</th><th>Valor</th></tr></thead><tbody></tbody></table>';
      const tbody = wrap.querySelector('tbody');
      line.forEach(f => tbody.appendChild(makeFieldRow(f)));
      card.appendChild(wrap);

      $linesWrap.appendChild(card);
    });

    // "Add line" button (only if we have a schema to clone from)
    if (state.lineSchema && state.lineSchema.length) {
      const addBtn = document.createElement('button');
      addBtn.className = 'btn add-line-btn';
      addBtn.textContent = '+ Agregar linea';
      addBtn.addEventListener('click', () => {
        const newLine = state.lineSchema.map(f => ({ ...f, value: '' }));
        state.lines.push(newLine);
        renderLines();
        rebuild();
      });
      $linesWrap.appendChild(addBtn);
    }
  }

  /* ---------- Parse ---------- */

  async function doParse() {
    const text = $text.value.trim();
    if (!text) { setStatus('error', 'Pega el QR string primero (o usa Nuevo QR).'); return; }
    setStatus('loading', 'Parseando...');
    $parse.disabled = true;

    try {
      const r = await window.api.parseQR(text);
      if (!r.ok) throw new Error(r.error);

      state = {
        header: r.data.annotated.header.map(f => ({ ...f, value: f.rawValue == null ? '' : f.rawValue })),
        lines:  r.data.annotated.lineas.map(line =>
          line.map(f => ({ ...f, value: f.rawValue == null ? '' : f.rawValue }))
        ),
        lineSchema: r.data.annotated.lineas.length
          ? r.data.annotated.lineas[0].map(f => ({ ...f, value: '' }))
          : []
      };

      renderHeader();
      renderLines();
      rebuild();

      const warnings = [];
      if (r.data.raw.headerCount !== r.data.raw.headerSchemaCount) {
        warnings.push(`Cabecera con ${r.data.raw.headerCount} campos, esquema espera ${r.data.raw.headerSchemaCount}.`);
      }
      r.data.annotated.lineas.forEach((l, i) => {
        const known = l.filter(x => !x.qrDatosKey.startsWith('Unknown_')).length;
        if (known !== r.data.raw.lineSchemaCount) {
          warnings.push(`Linea ${i + 1} con ${l.length} campos, esquema espera ${r.data.raw.lineSchemaCount}.`);
        }
      });
      if (warnings.length) setStatus('error', warnings.join(' '));
      else setStatus('success', `Parseado. Edita cualquier valor: se sincroniza arriba (textarea) y abajo (JSON) en vivo.`);
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      $parse.disabled = false;
    }
  }

  /* ---------- Buttons ---------- */

  $parse.addEventListener('click', doParse);

  $sample.addEventListener('click', () => {
    $text.value = SAMPLE;
    clearStatus();
  });

  $new.addEventListener('click', async () => {
    // Schema-shaped empty QR: header (24 fields) + 1 line (8 fields)
    $text.value = ';'.repeat(23) + '|' + ';'.repeat(7);
    await doParse();
    setStatus('success', 'QR vacio creado. Editá los campos en la grilla para construirlo.');
  });

  $clear.addEventListener('click', () => {
    $text.value = '';
    state = null;
    lastJson = null;
    $headerTbody.innerHTML = '';
    $headerCount.textContent = '';
    $linesWrap.innerHTML = '';
    $json.textContent = '';
    $copyJson.disabled = true;
    $downloadJson.disabled = true;
    clearStatus();
  });

  $copyJson.addEventListener('click', async () => {
    if (!lastJson) return;
    try {
      await navigator.clipboard.writeText(lastJson);
      setStatus('success', 'JSON copiado.');
    } catch (e) {
      setStatus('error', 'No se pudo copiar: ' + e.message);
    }
  });

  $downloadJson.addEventListener('click', () => {
    if (!lastJson) return;
    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(lastJson);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qrDatos-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  $sendGen.addEventListener('click', () => {
    const text = $text.value.trim();
    if (!text) { setStatus('error', 'No hay texto para generar el QR.'); return; }
    const $genInput = document.getElementById('qr-text');
    if ($genInput) $genInput.value = text;
    if (window.__router) window.__router.setActive('qr');
    const $genBtn = document.getElementById('qr-generate');
    if ($genBtn) $genBtn.click();
  });
})();
