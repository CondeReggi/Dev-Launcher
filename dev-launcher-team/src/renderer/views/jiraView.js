'use strict';

/**
 * Solapa "Mis tareas (Jira)". Lista issues asignadas (JQL configurable), permite
 * abrir un detalle con cambio de estado (transitions), reasignacion (accountId)
 * y comentarios. Solo habla con el backend via window.api.jira; todo el HTTP a
 * Jira ocurre en el proceso main. Carga perezosa: recien al activar la vista.
 */
(function () {
  /* ---------- DOM refs ---------- */

  const $gate      = document.getElementById('jira-config-gate');
  const $openSett  = document.getElementById('jira-open-settings');
  const $main      = document.getElementById('jira-main');
  const $jql       = document.getElementById('jira-jql');
  const $refresh   = document.getElementById('jira-refresh');
  const $count     = document.getElementById('jira-count');
  const $spinner   = document.getElementById('jira-spinner');
  const $fCategory = document.getElementById('jira-f-category');
  const $viewsManageBtn = document.getElementById('jira-views-manage');
  const $viewsModal     = document.getElementById('jira-views-modal');
  const $viewsList      = document.getElementById('jira-views-list');
  const $viewsName      = document.getElementById('jira-views-name');
  const $viewsStatuses  = document.getElementById('jira-views-statuses');
  const $viewsAdd       = document.getElementById('jira-views-add');
  const $viewsStatus    = document.getElementById('jira-views-status');
  const $fStatus   = document.getElementById('jira-f-status');
  const $fProject  = document.getElementById('jira-f-project');
  const $fPriority = document.getElementById('jira-f-priority');
  const $fText     = document.getElementById('jira-f-text');
  const $fClear    = document.getElementById('jira-f-clear');
  const $envSum    = document.getElementById('jira-env-summary');
  const $status    = document.getElementById('jira-status');
  const $list      = document.getElementById('jira-list');
  const $log       = document.getElementById('jira-log');

  // Detail modal
  const $modal      = document.getElementById('jira-detail-modal');
  const $dLoading   = document.getElementById('jira-detail-loading');
  const $dBody      = document.getElementById('jira-detail-body');
  const $dKey       = document.getElementById('jira-d-key');
  const $dStatus    = document.getElementById('jira-d-status');
  const $dType      = document.getElementById('jira-d-type');
  const $dOpen      = document.getElementById('jira-d-open');
  const $dDelete    = document.getElementById('jira-d-delete');
  const $dCopyPrompt= document.getElementById('jira-d-copy-prompt');
  const $dSummary   = document.getElementById('jira-d-summary');
  const $dProject   = document.getElementById('jira-d-project');
  const $dPriority  = document.getElementById('jira-d-priority');
  const $dReporter  = document.getElementById('jira-d-reporter');
  const $dUpdated   = document.getElementById('jira-d-updated');
  const $dTransition      = document.getElementById('jira-d-transition');
  const $dTransitionApply = document.getElementById('jira-d-transition-apply');
  const $dAssigneeSearch  = document.getElementById('jira-d-assignee-search');
  const $dAssigneeUnassign= document.getElementById('jira-d-assignee-unassign');
  const $dAssigneeReporter= document.getElementById('jira-d-assignee-reporter');
  const $dAssignee        = document.getElementById('jira-d-assignee');
  const $dAssigneeAvatar  = document.getElementById('jira-d-assignee-avatar');
  const $dAssigneeResults = document.getElementById('jira-d-assignee-results');
  const $dDescription = document.getElementById('jira-d-description');
  const $dComments      = document.getElementById('jira-d-comments');
  const $dCommentsCount = document.getElementById('jira-d-comments-count');
  const $dStatusLine    = document.getElementById('jira-detail-status');
  const $dWorklogTime    = document.getElementById('jira-d-worklog-time');
  const $dWorklogComment = document.getElementById('jira-d-worklog-comment');
  const $dWorklogApply   = document.getElementById('jira-d-worklog-apply');
  const $dCommentText    = document.getElementById('jira-d-comment-text');
  const $dCommentAdd     = document.getElementById('jira-d-comment-add');
  const $dMentionResults = document.getElementById('jira-d-mention-results');
  const $dCommentHighlight = document.getElementById('jira-d-comment-highlight');

  // Vista Lista / Kanban
  const $viewListBtn   = document.getElementById('jira-view-list');
  const $viewKanbanBtn = document.getElementById('jira-view-kanban');
  const $kanban        = document.getElementById('jira-kanban');

  // Notificaciones de tareas nuevas (poll en segundo plano)
  const $notifyToggle = document.getElementById('jira-notify-toggle');

  if (!$main) return;

  /* ---------- State ---------- */

  let loaded        = false;   // lazy-load guard
  let publicConfig  = null;
  let allIssues     = [];
  let lastFiltered  = [];      // ultimo resultado filtrado (para re-render al cambiar de vista)
  let viewMode      = 'list';  // 'list' | 'kanban'
  let currentIssue  = null;    // issue abierta en el modal
  let currentComments = [];    // comentarios de la issue abierta (para el prompt)
  let userSearchTimer = null;
  let notifyTimer   = null;    // interval del poll de notificaciones
  let customViews   = [];      // vistas por estado real definidas por el usuario (localStorage)
  let editingCommentId = null; // id del comentario propio en edicion, o null

  // Menciones "@" en el compositor de comentarios.
  let mentionTimer      = null;
  let mentionUsers      = [];  // resultados del dropdown actual
  let mentionActiveIndex = -1;
  let mentionStart       = -1; // indice del '@' que dispara la busqueda actual, en $dCommentText
  let mentionAccountIds  = new Map(); // displayName -> accountId, solo para menciones elegidas del autocomplete

  /* ---------- Helpers ---------- */

  const setStatus = (kind, msg) => {
    $status.className = `status show ${kind}`;
    $status.textContent = msg;
  };
  const clearStatus = () => { $status.className = 'status'; $status.textContent = ''; };

  const setDStatus = (kind, msg) => {
    $dStatusLine.className = `status show ${kind}`;
    $dStatusLine.textContent = msg;
  };
  const clearDStatus = () => { $dStatusLine.className = 'status'; $dStatusLine.textContent = ''; };

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

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  // Clase de color para el pill segun statusCategory + nombre (Blocked).
  function pillClass(issue) {
    const name = (issue.status || '').toLowerCase();
    if (name.includes('block')) return 'jira-pill-blocked';
    switch (issue.statusCategory) {
      case 'done':          return 'jira-pill-done';
      case 'indeterminate': return 'jira-pill-progress';
      case 'new':           return 'jira-pill-todo';
      default:              return 'jira-pill-todo';
    }
  }

  function openExternal(url) {
    if (url) window.api.openExternal(url);
  }

  // Arma el prompt para pasarle a una IA generadora de prompts (Claude Code, etc).
  // Rellena titulo (summary), descripcion y contexto adicional (comentarios) de la card.
  function buildPrompt(issue, comments) {
    const titulo = (issue.summary || '').trim() || '(sin titulo)';
    const descripcion = (issue.description || '').trim() || '(sin descripcion)';
    let contexto = '';
    if (Array.isArray(comments) && comments.length) {
      contexto = comments
        .map(c => `- ${c.author ? c.author.displayName : 'Anon'}: ${(c.body || '').trim()}`)
        .filter(Boolean)
        .join('\n');
    }
    if (!contexto) contexto = '(sin contexto adicional)';

    return [
      'Sos un analista funcional/técnico senior especializado en transformar cards ambiguas en prompts claros para agentes de código como Claude Code.',
      '',
      'Voy a pasarte una card con:',
      '',
      `Título - ${titulo}`,
      `Descripción - ${descripcion}`,
      `Contexto adicional opcional - ${contexto}`,
      '',
      'Tu tarea es convertir esa card en un prompt técnico claro, conciso y accionable para que Claude Code pueda implementar la funcionalidad con el menor contexto posible.',
      '',
      'No implementes código.',
      'No inventes funcionalidades grandes.',
      'No agregues arquitectura innecesaria.',
      'Si falta información, hacé supuestos razonables y marcalos claramente.',
      'Solo hacé preguntas abiertas si realmente bloquean la implementación.',
      '',
      'La salida debe estar en español y debe ser un prompt técnico accionable.',
      '',
      'COSAS A TENER EN CUENTA:',
      '',
      'Si es algo sobre el proyecto "API/BO - B2C" y la card dice algo de "BO" se debe trabajar sobre App.BackOffice.Admin.',
      'Si la card dice algo como "ecommerce" hay que trabajar sobre los controller de la carpeta de Magento.'
    ].join('\n');
  }

  // Copia texto al portapapeles y da feedback visual en el boton (✓ Copiado).
  async function copyPrompt(text, btn) {
    const orig = btn ? btn.innerHTML : '';
    try {
      await navigator.clipboard.writeText(text || '');
      if (btn) {
        btn.innerHTML = '&#x2713; Copiado';
        btn.classList.add('copied');
      }
    } catch (e) {
      if (btn) btn.innerHTML = '&#x2717; Error';
    } finally {
      if (btn) setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1500);
    }
  }

  // Genera el JQL para cada preset de la "Vista". statusCategory por id (locale-
  // independiente): 2 = Por hacer (To Do), 4 = En curso (In Progress), 3 = Finalizadas.
  // Las vistas personalizadas ("custom:<id>") filtran por nombre real de estado
  // (ej. "Pending Test", "Deployado TST"), definido por el usuario.
  // Orden fijo: prioridad desc, luego fecha de creacion asc.
  function buildJql(category) {
    const base = 'assignee = currentUser()';
    let clause = '';
    if (category && category.indexOf('custom:') === 0) {
      const view = customViews.find(v => `custom:${v.id}` === category);
      if (view && view.statuses.length) clause = ` AND status in (${view.statuses.map(quoteJql).join(', ')})`;
    } else if (category === 'active')             clause = ' AND statusCategory in (2, 4)';
    else if (category === 'new')           clause = ' AND statusCategory = 2';
    else if (category === 'indeterminate') clause = ' AND statusCategory = 4';
    else if (category === 'done')          clause = ' AND statusCategory = 3';
    // '' (Todas) => sin clausula de estado.
    return `${base}${clause} ORDER BY priority DESC, created ASC`;
  }

  function quoteJql(s) {
    return `"${String(s).replace(/"/g, '\\"')}"`;
  }

  /* ---------- Vistas personalizadas por estado (localStorage) ---------- */

  const CUSTOM_VIEWS_KEY = 'devlauncher.jira.customViews';

  function loadCustomViews() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_VIEWS_KEY) || '[]'); }
    catch (_) { return []; }
  }
  function saveCustomViews() {
    try { localStorage.setItem(CUSTOM_VIEWS_KEY, JSON.stringify(customViews)); }
    catch (_) { /* ignore */ }
  }

  // Reconstruye las options "custom:*" del select "Vista" a partir de customViews,
  // preservando la seleccion actual si sigue existiendo.
  function populateCategorySelect() {
    const prev = $fCategory.value;
    [...$fCategory.querySelectorAll('option[value^="custom:"]')].forEach(o => o.remove());
    customViews.forEach(v => {
      const o = document.createElement('option');
      o.value = `custom:${v.id}`;
      o.textContent = v.name;
      $fCategory.appendChild(o);
    });
    if ([...$fCategory.options].some(o => o.value === prev)) $fCategory.value = prev;
  }

  function setViewsStatus(kind, msg) {
    $viewsStatus.className = `status show ${kind}`;
    $viewsStatus.textContent = msg;
  }

  function renderViewsList() {
    $viewsList.innerHTML = '';
    if (!customViews.length) {
      const empty = document.createElement('div');
      empty.className = 'jira-empty';
      empty.textContent = 'Sin vistas personalizadas todavia.';
      $viewsList.appendChild(empty);
      return;
    }
    customViews.forEach(v => {
      const row = document.createElement('div');
      row.className = 'jira-views-row';

      const text = document.createElement('div');
      text.className = 'jira-views-row-text';
      const name = document.createElement('strong');
      name.textContent = v.name;
      const statuses = document.createElement('span');
      statuses.className = 'jira-views-row-statuses';
      statuses.textContent = v.statuses.join(', ');
      text.appendChild(name);
      text.appendChild(statuses);

      const del = document.createElement('button');
      del.className = 'btn mini danger';
      del.type = 'button';
      del.textContent = '\u{1F5D1}';
      del.title = 'Eliminar vista';
      del.addEventListener('click', () => deleteCustomView(v.id));

      row.appendChild(text);
      row.appendChild(del);
      $viewsList.appendChild(row);
    });
  }

  function addCustomView() {
    const name = ($viewsName.value || '').trim();
    const statuses = ($viewsStatuses.value || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!name) { setViewsStatus('error', 'Ingresa un nombre para la vista.'); $viewsName.focus(); return; }
    if (!statuses.length) { setViewsStatus('error', 'Ingresa al menos un estado.'); $viewsStatuses.focus(); return; }

    const id = `v${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    customViews.push({ id, name, statuses });
    saveCustomViews();
    populateCategorySelect();
    renderViewsList();
    $viewsName.value = '';
    $viewsStatuses.value = '';
    setViewsStatus('success', `Vista "${name}" agregada.`);
  }

  function deleteCustomView(id) {
    const view = customViews.find(v => v.id === id);
    if (!view) return;
    if (!window.confirm(`¿Eliminar la vista "${view.name}"?`)) return;

    const wasSelected = $fCategory.value === `custom:${id}`;
    customViews = customViews.filter(v => v.id !== id);
    saveCustomViews();
    populateCategorySelect();
    renderViewsList();
    if (wasSelected) {
      $fCategory.value = 'active';
      $jql.value = buildJql('active');
      loadIssues();
    }
  }

  function openViewsModal() {
    renderViewsList();
    $viewsName.value = '';
    $viewsStatuses.value = '';
    $viewsStatus.className = 'status';
    $viewsStatus.textContent = '';
    $viewsModal.classList.remove('hidden');
    $viewsModal.setAttribute('aria-hidden', 'false');
  }
  function closeViewsModal() {
    $viewsModal.classList.add('hidden');
    $viewsModal.setAttribute('aria-hidden', 'true');
  }

  /* ---------- Bootstrap / config gate ---------- */

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    await bootstrap();
  }

  async function bootstrap() {
    try {
      const r = await window.api.jira.config();
      if (!r.ok) throw new Error(r.error);
      publicConfig = r.data;
    } catch (e) {
      loaded = false; // permitir reintento
      setStatus('error', 'Error leyendo configuracion: ' + e.message);
      return;
    }

    renderEnvSummary();

    if (!publicConfig.configured) {
      $gate.classList.remove('hidden');
      $main.classList.add('hidden');
      return;
    }
    $gate.classList.add('hidden');
    $main.classList.remove('hidden');

    if ($jql && !$jql.value) $jql.value = publicConfig.jql || '';

    // Notificaciones: reactivar el poll de fondo si el usuario lo habia dejado
    // prendido en una sesion anterior (preferencia persistida en localStorage).
    setNotifyEnabled(loadNotifyPref());

    await loadIssues();
  }

  function renderEnvSummary() {
    if (!publicConfig) { $envSum.textContent = ''; return; }
    const parts = [
      `baseUrl: ${publicConfig.baseUrl || '(falta)'}`,
      `email: ${publicConfig.email || '(falta)'}`,
      publicConfig.hasToken ? '[token OK]' : '[falta token]'
    ];
    $envSum.textContent = parts.join(' · ');
    $envSum.classList.toggle('gu-env-summary-missing', !publicConfig.configured);
  }

  /* ---------- Cargar issues ---------- */

  async function loadIssues() {
    clearStatus();
    $log.innerHTML = '';
    $refresh.disabled = true;
    $spinner.classList.remove('hidden');
    setStatus('loading', 'Consultando Jira...');

    const off = window.api.jira.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const jql = ($jql.value || '').trim();
      const r = await window.api.jira.myIssues(jql ? { jql } : {});
      if (!r.ok) throw new Error(r.error);
      allIssues = Array.isArray(r.data.issues) ? r.data.issues : [];
      populateFilters();
      applyFilter();
      if (!allIssues.length) setStatus('info', 'Sin issues para el JQL actual.');
      else setStatus('success', `Issues cargadas: ${allIssues.length}.`);
    } catch (e) {
      allIssues = [];
      renderIssues([]);
      setStatus('error', e.message);
    } finally {
      off && off();
      $refresh.disabled = false;
      $spinner.classList.add('hidden');
    }
  }

  /* ---------- Filtros (locales) ---------- */

  function populateFilters() {
    const fill = (sel, values, allLabel) => {
      const prev = sel.value;
      sel.innerHTML = '';
      const optAll = document.createElement('option');
      optAll.value = '';
      optAll.textContent = allLabel;
      sel.appendChild(optAll);
      [...new Set(values.filter(Boolean))].sort().forEach(v => {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        sel.appendChild(o);
      });
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    };
    fill($fStatus,   allIssues.map(i => i.status),   'Todos');
    fill($fProject,  allIssues.map(i => i.project),  'Todos');
    fill($fPriority, allIssues.map(i => i.priority), 'Todas');
  }

  function applyFilter() {
    const st = $fStatus.value;
    const pr = $fProject.value;
    const pri = $fPriority.value;
    const txt = ($fText.value || '').trim().toLowerCase();

    const filtered = allIssues.filter(i => {
      if (st && i.status !== st) return false;
      if (pr && i.project !== pr) return false;
      if (pri && i.priority !== pri) return false;
      if (txt) {
        const hay = `${i.key} ${i.summary} ${i.description}`.toLowerCase();
        if (!hay.includes(txt)) return false;
      }
      return true;
    });
    renderIssues(filtered);
  }

  /* ---------- Render lista / kanban (cards) ---------- */

  function emptyMessage() {
    return allIssues.length
      ? 'Sin coincidencias para los filtros actuales.'
      : 'Sin issues. Apreta "Refrescar" o ajusta el JQL.';
  }

  // Punto unico de render: decide lista plana vs. columnas por estado segun viewMode.
  function renderIssues(issues) {
    lastFiltered = issues;
    $count.textContent = String(issues.length);
    if (viewMode === 'kanban') renderKanban(issues);
    else renderList(issues);
  }

  function renderList(issues) {
    $list.innerHTML = '';
    if (!issues.length) {
      const empty = document.createElement('div');
      empty.className = 'jira-empty';
      empty.textContent = emptyMessage();
      $list.appendChild(empty);
      return;
    }
    issues.forEach(issue => $list.appendChild(createIssueCard(issue)));
  }

  // Orden de columnas: por hacer -> en curso -> finalizadas; alfabetico dentro de cada categoria.
  const STATUS_CATEGORY_ORDER = { new: 0, indeterminate: 1, done: 2 };
  // Mapea statusCategory de Jira -> token de color local (--jira-cat-*).
  const STATUS_CATEGORY_TOKEN = { new: 'todo', indeterminate: 'progress', done: 'done' };

  function renderKanban(issues) {
    $kanban.innerHTML = '';
    if (!issues.length) {
      const empty = document.createElement('div');
      empty.className = 'jira-empty';
      empty.textContent = emptyMessage();
      $kanban.appendChild(empty);
      return;
    }

    const groups = new Map(); // status name -> { statusCategory, issues[] }
    issues.forEach(i => {
      const key = i.status || '(sin estado)';
      if (!groups.has(key)) groups.set(key, { statusCategory: i.statusCategory, issues: [] });
      groups.get(key).issues.push(i);
    });

    [...groups.entries()]
      .sort((a, b) => {
        const oa = STATUS_CATEGORY_ORDER[a[1].statusCategory] ?? 1;
        const ob = STATUS_CATEGORY_ORDER[b[1].statusCategory] ?? 1;
        return oa !== ob ? oa - ob : a[0].localeCompare(b[0]);
      })
      .forEach(([status, group]) => {
        const col = document.createElement('div');
        col.className = 'jira-kanban-col';

        const head = document.createElement('div');
        head.className = 'jira-kanban-col-head';
        const dot = document.createElement('span');
        dot.className = 'jira-kanban-col-head-dot';
        dot.style.background = `var(--jira-cat-${STATUS_CATEGORY_TOKEN[group.statusCategory] || 'todo'})`;
        const title = document.createElement('span');
        title.className = 'jira-kanban-col-head-title';
        title.textContent = status;
        const count = document.createElement('span');
        count.className = 'badge';
        count.textContent = String(group.issues.length);
        head.appendChild(dot);
        head.appendChild(title);
        head.appendChild(count);

        const body = document.createElement('div');
        body.className = 'jira-kanban-col-body';
        group.issues.forEach(issue => body.appendChild(createIssueCard(issue)));

        col.appendChild(head);
        col.appendChild(body);
        $kanban.appendChild(col);
      });
  }

  function setViewMode(mode) {
    if (viewMode === mode) return;
    viewMode = mode;
    try { localStorage.setItem('devlauncher.jira.viewMode', mode); } catch (_) { /* ignore */ }
    $viewListBtn.classList.toggle('active', mode === 'list');
    $viewListBtn.setAttribute('aria-selected', String(mode === 'list'));
    $viewKanbanBtn.classList.toggle('active', mode === 'kanban');
    $viewKanbanBtn.setAttribute('aria-selected', String(mode === 'kanban'));
    $list.classList.toggle('hidden', mode !== 'list');
    $kanban.classList.toggle('hidden', mode !== 'kanban');
    renderIssues(lastFiltered);
  }

  // Transicion rapida a "En curso" desde la card, sin abrir el detalle: busca entre
  // las transiciones disponibles la que lleve a un estado con statusCategory
  // "indeterminate" (el bucket de Jira para "En curso") y la aplica directo.
  async function quickStartProgress(issueKey, btn) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Moviendo...';
    try {
      const rt = await window.api.jira.transitions(issueKey);
      if (!rt.ok) throw new Error(rt.error);
      const target = (rt.data.transitions || []).find(t => t.toCategory === 'indeterminate');
      if (!target) throw new Error(`${issueKey} no tiene una transicion directa a "En curso" en su flujo actual.`);
      const r = await window.api.jira.transition(issueKey, target.id);
      if (!r.ok) throw new Error(r.error);
      mergeIssueIntoList(r.data.issue);
      setStatus('success', `${issueKey} -> ${r.data.issue.status}.`);
    } catch (e) {
      setStatus('error', `${issueKey}: ${e.message}`);
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function createIssueCard(issue) {
      const card = document.createElement('div');
      card.className = 'jira-card';
      card.tabIndex = 0;
      card.dataset.cat = issue.statusCategory || 'new';

      const head = document.createElement('div');
      head.className = 'jira-card-head';

      const key = document.createElement('span');
      key.className = 'jira-key';
      key.textContent = issue.key;

      const pill = document.createElement('span');
      pill.className = `jira-pill ${pillClass(issue)}`;
      pill.textContent = issue.status || '—';

      head.appendChild(key);
      head.appendChild(pill);
      if (issue.priority) {
        const prio = document.createElement('span');
        prio.className = 'jira-card-prio';
        prio.textContent = issue.priority;
        head.appendChild(prio);
      }
      card.appendChild(head);

      const summary = document.createElement('div');
      summary.className = 'jira-card-summary';
      summary.textContent = issue.summary || '(sin titulo)';
      card.appendChild(summary);

      if (issue.description) {
        const desc = document.createElement('div');
        desc.className = 'jira-card-desc';
        desc.textContent = issue.description.slice(0, 160);
        card.appendChild(desc);
      }

      const meta = document.createElement('div');
      meta.className = 'jira-card-meta';

      const addChip = (content) => {
        const chip = document.createElement('span');
        chip.className = 'jira-card-meta-chip';
        if (content instanceof Node) chip.appendChild(content);
        else {
          const s = document.createElement('span');
          s.textContent = content;
          chip.appendChild(s);
        }
        meta.appendChild(chip);
      };
      const addSep = () => {
        const sep = document.createElement('span');
        sep.className = 'jira-card-meta-sep';
        sep.textContent = '·';
        meta.appendChild(sep);
      };

      const assigneeFrag = document.createDocumentFragment();
      const avatar = document.createElement('span');
      avatar.className = 'jira-card-avatar';
      avatar.style.background = avatarColor(issue.assignee && (issue.assignee.accountId || issue.assignee.displayName));
      avatar.textContent = issue.assignee ? initialsOf(issue.assignee.displayName) : '?';
      const assigneeName = document.createElement('span');
      assigneeName.textContent = issue.assignee ? issue.assignee.displayName : 'Sin asignar';
      assigneeFrag.appendChild(avatar);
      assigneeFrag.appendChild(assigneeName);

      let wroteAny = false;
      if (issue.project) { addChip(issue.project); wroteAny = true; }
      if (wroteAny) addSep();
      addChip(assigneeFrag);
      if (issue.updated) { addSep(); addChip(`🕒 ${fmtDate(issue.updated)}`); }
      card.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'jira-card-actions';

      // Transicion rapida a "En curso", sin abrir el detalle (solo si no lo esta ya).
      if (issue.statusCategory !== 'indeterminate') {
        const quickBtn = document.createElement('button');
        quickBtn.className = 'btn mini';
        quickBtn.type = 'button';
        quickBtn.textContent = '▶ En curso';
        quickBtn.title = 'Pasar a "En curso" sin abrir el detalle';
        quickBtn.addEventListener('click', (ev) => { ev.stopPropagation(); quickStartProgress(issue.key, quickBtn); });
        actions.appendChild(quickBtn);
      }

      const openBtn = document.createElement('button');
      openBtn.className = 'btn mini';
      openBtn.type = 'button';
      openBtn.textContent = 'Abrir en Jira ↗';
      openBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openExternal(issue.url); });
      const detailBtn = document.createElement('button');
      detailBtn.className = 'btn mini primary';
      detailBtn.type = 'button';
      detailBtn.textContent = 'Detalle';
      detailBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openDetail(issue.key); });
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn mini';
      copyBtn.type = 'button';
      copyBtn.innerHTML = '\u{1F4CB} Copiar prompt';
      copyBtn.title = 'Copiar prompt para IA (titulo + descripcion de la card)';
      copyBtn.addEventListener('click', (ev) => { ev.stopPropagation(); copyPrompt(buildPrompt(issue, []), copyBtn); });
      actions.appendChild(detailBtn);
      actions.appendChild(copyBtn);
      actions.appendChild(openBtn);
      card.appendChild(actions);

      card.addEventListener('click', () => openDetail(issue.key));
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') openDetail(issue.key);
      });
      return card;
  }

  /* ---------- Detalle (modal) ---------- */

  function openModal() {
    $modal.classList.remove('hidden');
    $modal.setAttribute('aria-hidden', 'false');
  }
  function closeModal() {
    $modal.classList.add('hidden');
    $modal.setAttribute('aria-hidden', 'true');
    currentIssue = null;
    currentComments = [];
    editingCommentId = null;
    $dAssigneeResults.classList.add('hidden');
    $dAssigneeResults.innerHTML = '';
    hideMentionDropdown();
    mentionAccountIds.clear();
    renderCommentHighlight();
  }

  async function openDetail(issueKey) {
    openModal();
    clearDStatus();
    $dLoading.classList.remove('hidden');
    $dBody.classList.add('hidden');

    const off = window.api.jira.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.jira.issue(issueKey);
      if (!r.ok) throw new Error(r.error);
      currentIssue = r.data.issue;
      currentComments = r.data.comments || [];
      renderDetail(r.data.issue, currentComments);
      $dLoading.classList.add('hidden');
      $dBody.classList.remove('hidden');
      loadTransitions(issueKey);
    } catch (e) {
      $dLoading.classList.add('hidden');
      $dBody.classList.remove('hidden');
      setDStatus('error', e.message);
    } finally {
      off && off();
    }
  }

  function renderDetail(issue, comments) {
    $dKey.textContent = issue.key;
    $dStatus.textContent = issue.status || '—';
    $dStatus.className = `jira-pill ${pillClass(issue)}`;
    $dType.textContent = issue.issueType || '';
    $dSummary.textContent = issue.summary || '';
    $dProject.textContent = issue.project || '';
    $dPriority.textContent = issue.priority || '';
    $dReporter.textContent = issue.reporter ? issue.reporter.displayName : '—';
    $dUpdated.textContent = fmtDate(issue.updated);
    $dDescription.textContent = issue.description || '(sin descripcion)';
    updateAssigneeDisplay(issue.assignee);
    updateReporterBtn();
    $dOpen.onclick = () => openExternal(issue.url);

    // Solo mostramos "Eliminar" si la issue la reporto el usuario logueado
    // (mismo email que la config de Jira). Jira igual valida permisos server-side.
    const myEmail = (publicConfig && publicConfig.email || '').trim().toLowerCase();
    const reporterEmail = (issue.reporter && issue.reporter.emailAddress || '').trim().toLowerCase();
    const isMine = Boolean(myEmail && reporterEmail && myEmail === reporterEmail);
    $dDelete.classList.toggle('hidden', !isMine);
    $dAssigneeSearch.value = '';
    $dAssigneeResults.classList.add('hidden');
    $dAssigneeResults.innerHTML = '';
    $dWorklogTime.value = '';
    $dWorklogComment.value = '';
    $dCommentText.value = '';
    editingCommentId = null;
    hideMentionDropdown();
    mentionAccountIds.clear();
    renderCommentHighlight();

    renderComments(comments);
  }

  // Heuristica "es mio": mismo email que la config de Jira logueada (igual
  // que el criterio ya usado para mostrar "Eliminar" en la issue). Jira
  // igual valida permisos server-side ante un intento de editar/borrar ajeno.
  function isOwnComment(c) {
    const myEmail = (publicConfig && publicConfig.email || '').trim().toLowerCase();
    const authorEmail = (c.author && c.author.emailAddress || '').trim().toLowerCase();
    return Boolean(myEmail && authorEmail && myEmail === authorEmail);
  }

  function renderComments(comments) {
    $dCommentsCount.textContent = String(comments.length);
    $dComments.innerHTML = '';
    if (!comments.length) {
      const none = document.createElement('div');
      none.className = 'jira-empty';
      none.textContent = 'Sin comentarios.';
      $dComments.appendChild(none);
      return;
    }
    comments.forEach(c => $dComments.appendChild(createCommentItem(c)));
  }

  function createCommentItem(c) {
    const item = document.createElement('div');
    item.className = 'jira-comment';

    const head = document.createElement('div');
    head.className = 'jira-comment-head';
    const meta = document.createElement('span');
    const editedTag = (c.updated && c.updated !== c.created) ? ' (editado)' : '';
    meta.textContent = `${c.author ? c.author.displayName : 'Anon'} · ${fmtDate(c.created)}${editedTag}`;
    head.appendChild(meta);

    if (isOwnComment(c) && editingCommentId !== c.id) {
      const actions = document.createElement('span');
      actions.className = 'jira-comment-own-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn mini';
      editBtn.textContent = '✎ Editar';
      editBtn.addEventListener('click', () => { editingCommentId = c.id; renderComments(currentComments); });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn mini danger';
      delBtn.textContent = '\u{1F5D1}';
      delBtn.title = 'Eliminar comentario';
      delBtn.addEventListener('click', () => deleteComment(c.id));
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      head.appendChild(actions);
    }
    item.appendChild(head);

    if (editingCommentId === c.id) {
      const editArea = document.createElement('textarea');
      editArea.className = 'jira-comment-edit-textarea';
      editArea.rows = 3;
      editArea.value = c.body || '';
      item.appendChild(editArea);

      const row = document.createElement('div');
      row.className = 'jira-comment-edit-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn mini primary';
      saveBtn.textContent = 'Guardar';
      saveBtn.addEventListener('click', () => submitEditComment(c.id, editArea.value));
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn mini';
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.addEventListener('click', () => { editingCommentId = null; renderComments(currentComments); });
      row.appendChild(saveBtn);
      row.appendChild(cancelBtn);
      item.appendChild(row);
    } else {
      const body = document.createElement('div');
      body.className = 'jira-comment-body';
      body.textContent = c.body || '';
      item.appendChild(body);
    }

    return item;
  }

  async function submitEditComment(commentId, text) {
    if (!currentIssue) return;
    const body = (text || '').trim();
    if (!body) { setDStatus('error', 'El comentario no puede quedar vacio.'); return; }

    setDStatus('loading', 'Guardando comentario...');
    const off = window.api.jira.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.jira.editComment(currentIssue.key, commentId, body, []);
      if (!r.ok) throw new Error(r.error);
      currentComments = currentComments.map(c => (c.id === commentId ? r.data.comment : c));
      editingCommentId = null;
      renderComments(currentComments);
      setDStatus('success', 'Comentario actualizado.');
    } catch (e) {
      setDStatus('error', e.message);
    } finally {
      off && off();
    }
  }

  async function deleteComment(commentId) {
    if (!currentIssue) return;
    if (!window.confirm('¿Eliminar este comentario? Esta accion no se puede deshacer.')) return;

    setDStatus('loading', 'Eliminando comentario...');
    const off = window.api.jira.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.jira.deleteComment(currentIssue.key, commentId);
      if (!r.ok) throw new Error(r.error);
      currentComments = currentComments.filter(c => c.id !== commentId);
      renderComments(currentComments);
      setDStatus('success', 'Comentario eliminado.');
    } catch (e) {
      setDStatus('error', e.message);
    } finally {
      off && off();
    }
  }

  /* ---------- Agregar comentario ---------- */

  async function submitComment() {
    if (!currentIssue) return;
    const text = ($dCommentText.value || '').trim();
    if (!text) { setDStatus('error', 'Escribi un comentario primero.'); $dCommentText.focus(); return; }

    $dCommentAdd.disabled = true;
    setDStatus('loading', 'Agregando comentario...');
    const off = window.api.jira.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      // Solo mandamos como mencion real (nodo ADF `mention`) los nombres que
      // el usuario efectivamente elegio del autocomplete Y que siguen presentes
      // en el texto (si los borro, ya no corresponde etiquetar a nadie).
      const mentions = [...mentionAccountIds]
        .filter(([name]) => text.includes('@' + name))
        .map(([displayName, accountId]) => ({ accountId, displayName }));

      const r = await window.api.jira.addComment(currentIssue.key, text, mentions);
      if (!r.ok) throw new Error(r.error);
      currentComments = [...currentComments, r.data.comment];
      renderComments(currentComments);
      $dCommentText.value = '';
      mentionAccountIds.clear();
      renderCommentHighlight();
      setDStatus('success', 'Comentario agregado.');
    } catch (e) {
      setDStatus('error', e.message);
    } finally {
      off && off();
      $dCommentAdd.disabled = false;
    }
  }

  /* ---------- Menciones "@" en el compositor de comentarios ---------- */

  // Si el caret esta pegado a un "@..." sin espacios (y ese "@" es el
  // primer caracter del texto o esta precedido por un espacio), devuelve
  // el query tipeado y la posicion del "@" que lo dispara.
  function getMentionTrigger() {
    const val = $dCommentText.value;
    const caret = $dCommentText.selectionStart;
    const upToCaret = val.slice(0, caret);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(upToCaret);
    if (!m) return null;
    return { query: m[1], start: caret - m[1].length - 1 };
  }

  function hideMentionDropdown() {
    mentionUsers = [];
    mentionActiveIndex = -1;
    mentionStart = -1;
    $dMentionResults.classList.add('hidden');
    $dMentionResults.innerHTML = '';
  }

  function renderMentionDropdown() {
    $dMentionResults.innerHTML = '';
    if (!mentionUsers.length) {
      const none = document.createElement('div');
      none.className = 'jira-user-empty';
      none.textContent = 'Sin usuarios para esa busqueda.';
      $dMentionResults.appendChild(none);
    } else {
      mentionUsers.forEach((u, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'jira-user-row' + (i === mentionActiveIndex ? ' active' : '');
        row.appendChild(makeAvatar(u));

        const text = document.createElement('span');
        text.className = 'jira-user-text';
        const name = document.createElement('span');
        name.className = 'jira-user-name';
        name.textContent = u.displayName || '(sin nombre)';
        text.appendChild(name);
        if (u.emailAddress) {
          const email = document.createElement('span');
          email.className = 'jira-user-email';
          email.textContent = u.emailAddress;
          text.appendChild(email);
        }
        row.appendChild(text);

        // mousedown (no click) + preventDefault: evita que el textarea pierda
        // el foco/caret antes de que leamos la seleccion actual en insertMention.
        row.addEventListener('mousedown', (ev) => { ev.preventDefault(); insertMention(u); });
        $dMentionResults.appendChild(row);
      });
    }
    $dMentionResults.classList.remove('hidden');
  }

  async function searchMentionUsers(query, triggerStart) {
    if (!currentIssue) return;
    try {
      const r = await window.api.jira.searchUsers(query, currentIssue.key);
      if (!r.ok) throw new Error(r.error);
      // El fetch es async: si el usuario siguio tipeando y el trigger cambio, descartamos esta respuesta.
      if (mentionStart !== triggerStart) return;
      mentionUsers = r.data.users || [];
      mentionActiveIndex = mentionUsers.length ? 0 : -1;
      renderMentionDropdown();
    } catch (e) {
      hideMentionDropdown();
    }
  }

  function insertMention(user) {
    const val = $dCommentText.value;
    const caret = $dCommentText.selectionStart;
    const before = val.slice(0, mentionStart);
    const after = val.slice(caret);
    const inserted = `@${user.displayName} `;
    $dCommentText.value = before + inserted + after;
    const newCaret = before.length + inserted.length;
    $dCommentText.focus();
    $dCommentText.setSelectionRange(newCaret, newCaret);
    mentionAccountIds.set(user.displayName, user.accountId);
    hideMentionDropdown();
    renderCommentHighlight();
  }

  function onCommentInput() {
    renderCommentHighlight();
    const trigger = getMentionTrigger();
    if (!trigger) { hideMentionDropdown(); return; }
    mentionStart = trigger.start;
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(() => searchMentionUsers(trigger.query, trigger.start), 250);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeRegExpMention(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Repinta el backdrop detras del textarea (transparente) marcando con un
  // fondo cada "@DisplayName" que corresponde a una mencion real elegida del
  // autocomplete (mentionAccountIds) — asi se distingue de un "@algo" tipeado
  // a mano, que queda sin resaltar.
  function renderCommentHighlight() {
    const text = $dCommentText.value;
    const names = [...mentionAccountIds.keys()].sort((a, b) => b.length - a.length);
    let html;
    if (!names.length) {
      html = escapeHtml(text);
    } else {
      const re = new RegExp(`(${names.map(n => escapeRegExpMention('@' + n)).join('|')})`, 'g');
      html = text.split(re).filter(part => part !== '').map(part => {
        const stripped = part[0] === '@' ? part.slice(1) : null;
        if (stripped !== null && mentionAccountIds.has(stripped)) {
          return `<span class="mention-tag">${escapeHtml(part)}</span>`;
        }
        return escapeHtml(part);
      }).join('');
    }
    // Un "\n" final no genera una linea visible extra por si solo en un div;
    // agregamos un espacio para que el backdrop mida el mismo alto que el textarea.
    if (text.endsWith('\n')) html += ' ';
    $dCommentHighlight.innerHTML = html;
    $dCommentHighlight.scrollTop = $dCommentText.scrollTop;
  }

  function onCommentKeydown(ev) {
    if (!$dMentionResults.classList.contains('hidden') && mentionUsers.length) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); mentionActiveIndex = (mentionActiveIndex + 1) % mentionUsers.length; renderMentionDropdown(); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); mentionActiveIndex = (mentionActiveIndex - 1 + mentionUsers.length) % mentionUsers.length; renderMentionDropdown(); return; }
      if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); insertMention(mentionUsers[mentionActiveIndex]); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); hideMentionDropdown(); return; }
    }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitComment(); }
  }

  /* ---------- Transiciones (cambio de estado) ---------- */

  async function loadTransitions(issueKey) {
    $dTransition.innerHTML = '<option value="">Cargando transiciones...</option>';
    $dTransitionApply.disabled = true;
    try {
      const r = await window.api.jira.transitions(issueKey);
      if (!r.ok) throw new Error(r.error);
      const transitions = r.data.transitions || [];
      $dTransition.innerHTML = '';
      if (!transitions.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = 'Sin transiciones disponibles';
        $dTransition.appendChild(o);
        return;
      }
      const ph = document.createElement('option');
      ph.value = ''; ph.textContent = 'Elegi un estado destino...';
      $dTransition.appendChild(ph);
      transitions.forEach(t => {
        const o = document.createElement('option');
        o.value = t.id;
        o.textContent = t.to ? `${t.name} → ${t.to}` : t.name;
        $dTransition.appendChild(o);
      });
    } catch (e) {
      $dTransition.innerHTML = '<option value="">Error cargando transiciones</option>';
      setDStatus('error', e.message);
    }
  }

  async function applyTransition() {
    if (!currentIssue) return;
    const transitionId = $dTransition.value;
    if (!transitionId) { setDStatus('error', 'Elegi un estado destino.'); return; }

    $dTransitionApply.disabled = true;
    setDStatus('loading', 'Aplicando transicion...');
    const off = window.api.jira.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.jira.transition(currentIssue.key, transitionId);
      if (!r.ok) throw new Error(r.error);
      currentIssue = r.data.issue;
      $dStatus.textContent = currentIssue.status || '—';
      $dStatus.className = `jira-pill ${pillClass(currentIssue)}`;
      mergeIssueIntoList(currentIssue);
      setDStatus('success', `Estado actualizado a "${currentIssue.status}".`);
      loadTransitions(currentIssue.key);
    } catch (e) {
      setDStatus('error', e.message);
    } finally {
      off && off();
      $dTransitionApply.disabled = false;
    }
  }

  /* ---------- Reasignacion ---------- */

  // Chip de assignee actual (avatar + nombre) arriba del buscador.
  function updateAssigneeDisplay(user) {
    $dAssignee.textContent = user ? user.displayName : 'Sin asignar';
    $dAssigneeAvatar.style.background = user ? avatarColor(user.accountId || user.displayName) : 'var(--jira-surface-strong)';
    $dAssigneeAvatar.textContent = user ? initialsOf(user.displayName) : '?';
  }

  // Habilita/etiqueta el boton "Asignar al reporter" segun la issue abierta.
  function updateReporterBtn() {
    const rep = currentIssue && currentIssue.reporter;
    const sameAsAssignee = rep && currentIssue.assignee && rep.accountId === currentIssue.assignee.accountId;
    $dAssigneeReporter.disabled = !rep || sameAsAssignee;
    $dAssigneeReporter.textContent = rep
      ? `↩ Asignar al reporter (${rep.displayName})`
      : '↩ Sin reporter';
  }

  // Iniciales (max 2) a partir del displayName.
  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2);
    return parts[0][0] + parts[parts.length - 1][0];
  }

  // Color de avatar determinístico a partir de un string (hash -> hue).
  function avatarColor(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return `hsl(${h}, 55%, 45%)`;
  }

  function makeAvatar(user) {
    const av = document.createElement('span');
    av.className = 'jira-user-avatar';
    av.style.background = avatarColor(user && (user.accountId || user.displayName));
    av.textContent = initialsOf(user && user.displayName);
    return av;
  }

  function renderUserResults(users) {
    $dAssigneeResults.innerHTML = '';
    if (!users.length) {
      const none = document.createElement('div');
      none.className = 'jira-user-empty';
      none.textContent = 'Sin usuarios para esa busqueda.';
      $dAssigneeResults.appendChild(none);
    } else {
      users.forEach(u => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'jira-user-row';

        row.appendChild(makeAvatar(u));

        const text = document.createElement('span');
        text.className = 'jira-user-text';
        const name = document.createElement('span');
        name.className = 'jira-user-name';
        name.textContent = u.displayName || '(sin nombre)';
        text.appendChild(name);
        if (u.emailAddress) {
          const email = document.createElement('span');
          email.className = 'jira-user-email';
          email.textContent = u.emailAddress;
          text.appendChild(email);
        }
        row.appendChild(text);

        row.addEventListener('click', () => assignTo(u));
        $dAssigneeResults.appendChild(row);
      });
    }
    $dAssigneeResults.classList.remove('hidden');
  }

  async function searchUsers(query) {
    if (!currentIssue) return;
    try {
      const r = await window.api.jira.searchUsers(query, currentIssue.key);
      if (!r.ok) throw new Error(r.error);
      renderUserResults(r.data.users || []);
    } catch (e) {
      setDStatus('error', e.message);
    }
  }

  async function assignTo(user) {
    if (!currentIssue) return;
    const accountId = user ? user.accountId : null;
    setDStatus('loading', user ? `Asignando a ${user.displayName}...` : 'Quitando asignacion...');
    $dAssigneeResults.classList.add('hidden');
    const off = window.api.jira.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.jira.assign(currentIssue.key, accountId);
      if (!r.ok) throw new Error(r.error);
      currentIssue.assignee = user || null;
      updateAssigneeDisplay(currentIssue.assignee);
      $dAssigneeSearch.value = '';
      updateReporterBtn();
      mergeIssueIntoList(currentIssue);
      setDStatus('success', user ? `Reasignada a ${user.displayName}.` : 'Issue sin asignar.');
    } catch (e) {
      setDStatus('error', e.message);
    } finally {
      off && off();
    }
  }

  // Refleja en la lista (cache local) los cambios hechos en el modal sin re-query.
  function mergeIssueIntoList(updated) {
    const idx = allIssues.findIndex(i => i.key === updated.key);
    if (idx >= 0) {
      allIssues[idx] = { ...allIssues[idx], ...updated };
      populateFilters();
      applyFilter();
    }
  }

  /* ---------- Eliminar (solo issues creadas por el usuario) ---------- */

  async function deleteCurrentIssue() {
    if (!currentIssue) return;
    const key = currentIssue.key;
    if (!window.confirm(`¿Eliminar la issue ${key} - "${currentIssue.summary || ''}"? Esta accion no se puede deshacer.`)) return;

    $dDelete.disabled = true;
    setDStatus('loading', `Eliminando ${key}...`);
    const off = window.api.jira.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.jira.deleteIssue(key);
      if (!r.ok) throw new Error(r.error);
      allIssues = allIssues.filter(i => i.key !== key);
      populateFilters();
      applyFilter();
      closeModal();
      setStatus('success', `${key} eliminada.`);
    } catch (e) {
      setDStatus('error', e.message);
    } finally {
      off && off();
      $dDelete.disabled = false;
    }
  }

  /* ---------- Worklog rapido (sin salir de la app) ---------- */

  async function submitWorklog() {
    if (!currentIssue) return;
    const timeSpent = ($dWorklogTime.value || '').trim();
    if (!timeSpent) { setDStatus('error', 'Ingresa el tiempo trabajado (ej: 1h 30m).'); $dWorklogTime.focus(); return; }
    const comment = ($dWorklogComment.value || '').trim();

    $dWorklogApply.disabled = true;
    setDStatus('loading', 'Registrando worklog...');
    const off = window.api.jira.onLog(p => appendLog(p.kind, p.message, p.ts));
    try {
      const r = await window.api.jira.addWorklog(currentIssue.key, timeSpent, comment);
      if (!r.ok) throw new Error(r.error);
      setDStatus('success', `Worklog registrado: ${timeSpent}${comment ? ' — ' + comment : ''}.`);
      $dWorklogTime.value = '';
      $dWorklogComment.value = '';
    } catch (e) {
      setDStatus('error', e.message);
    } finally {
      off && off();
      $dWorklogApply.disabled = false;
    }
  }

  /* ---------- Notificaciones de tareas nuevas (poll en segundo plano) ----------
     Usa siempre el JQL configurado por defecto (no el JQL/filtros que este mirando
     el usuario), para no disparar falsos "nueva tarea" al solo cambiar de vista.
     La primera corrida (o cuando nunca hubo nada guardado) solo "siembra" el set de
     keys conocidas sin notificar; desde la segunda, notifica las que aparecen nuevas. */

  const NOTIFY_PREF_KEY = 'devlauncher.jira.notifyEnabled';
  const SEEN_KEYS_KEY   = 'devlauncher.jira.seenKeys';
  const NOTIFY_POLL_MS  = 3 * 60 * 1000;

  function loadNotifyPref() {
    try { return localStorage.getItem(NOTIFY_PREF_KEY) === '1'; }
    catch (_) { return false; }
  }
  function saveNotifyPref(enabled) {
    try { localStorage.setItem(NOTIFY_PREF_KEY, enabled ? '1' : '0'); }
    catch (_) { /* ignore */ }
  }
  function loadSeenKeys() {
    try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEYS_KEY) || '[]')); }
    catch (_) { return new Set(); }
  }
  function saveSeenKeys(set) {
    try { localStorage.setItem(SEEN_KEYS_KEY, JSON.stringify(Array.from(set))); }
    catch (_) { /* ignore */ }
  }

  function notifyNewIssue(issue) {
    try {
      const n = new Notification('Jira: nueva tarea asignada', {
        body: `${issue.key} — ${issue.summary || '(sin titulo)'}`
      });
      n.onclick = () => {
        window.focus();
        if (window.__router) window.__router.setActive('jira');
        openDetail(issue.key);
      };
    } catch (_) { /* Notification no disponible en este entorno: no rompe el poll */ }
  }

  async function pollForNewIssues() {
    if (!publicConfig || !publicConfig.configured) return;
    try {
      const r = await window.api.jira.myIssues({});
      if (!r.ok) return;
      const issues = Array.isArray(r.data.issues) ? r.data.issues : [];
      const seen = loadSeenKeys();
      const isFirstRun = seen.size === 0;
      if (!isFirstRun) {
        issues.filter(i => !seen.has(i.key)).forEach(notifyNewIssue);
      }
      issues.forEach(i => seen.add(i.key));
      saveSeenKeys(seen);
    } catch (_) { /* poll de fondo: silencioso */ }
  }

  function startNotifyPolling() {
    if (notifyTimer) return;
    pollForNewIssues();
    notifyTimer = setInterval(pollForNewIssues, NOTIFY_POLL_MS);
  }
  function stopNotifyPolling() {
    if (notifyTimer) { clearInterval(notifyTimer); notifyTimer = null; }
  }
  function setNotifyEnabled(enabled) {
    saveNotifyPref(enabled);
    if ($notifyToggle) $notifyToggle.checked = enabled;
    if (enabled) startNotifyPolling();
    else stopNotifyPolling();
  }

  /* ---------- Wire ---------- */

  $openSett.addEventListener('click', () => {
    const btn = document.getElementById('btn-settings');
    if (btn) btn.click();
  });

  $refresh.addEventListener('click', loadIssues);
  $jql.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); loadIssues(); }
  });

  // La "Vista" reconstruye el JQL y re-consulta a Jira (asi puedo ver tambien
  // estados que no estaban cargados, ej. Finalizadas).
  $fCategory.addEventListener('change', () => {
    $jql.value = buildJql($fCategory.value);
    loadIssues();
  });

  $fStatus.addEventListener('change', applyFilter);
  $fProject.addEventListener('change', applyFilter);
  $fPriority.addEventListener('change', applyFilter);
  $fText.addEventListener('input', applyFilter);
  $fClear.addEventListener('click', () => {
    $fStatus.value = ''; $fProject.value = ''; $fPriority.value = ''; $fText.value = '';
    applyFilter();
  });

  $dCopyPrompt.addEventListener('click', () => {
    if (currentIssue) copyPrompt(buildPrompt(currentIssue, currentComments), $dCopyPrompt);
  });
  $dDelete.addEventListener('click', deleteCurrentIssue);

  $dTransitionApply.addEventListener('click', applyTransition);
  $dTransition.addEventListener('change', () => { $dTransitionApply.disabled = !$dTransition.value; });

  $dAssigneeUnassign.addEventListener('click', () => assignTo(null));
  $dAssigneeReporter.addEventListener('click', () => {
    if (currentIssue && currentIssue.reporter) assignTo(currentIssue.reporter);
  });
  $dAssigneeSearch.addEventListener('input', () => {
    clearTimeout(userSearchTimer);
    const q = $dAssigneeSearch.value.trim();
    if (q.length < 2) { $dAssigneeResults.classList.add('hidden'); return; }
    userSearchTimer = setTimeout(() => searchUsers(q), 350);
  });

  $modal.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.dataset && t.dataset.jiraClose) closeModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$modal.classList.contains('hidden')) closeModal();
  });

  $dWorklogApply.addEventListener('click', submitWorklog);
  $dWorklogTime.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); submitWorklog(); }
  });

  $dCommentAdd.addEventListener('click', submitComment);
  $dCommentText.addEventListener('input', onCommentInput);
  $dCommentText.addEventListener('keydown', onCommentKeydown);
  $dCommentText.addEventListener('scroll', () => { $dCommentHighlight.scrollTop = $dCommentText.scrollTop; });
  $dCommentText.addEventListener('blur', () => { setTimeout(hideMentionDropdown, 0); });

  $viewListBtn.addEventListener('click', () => setViewMode('list'));
  $viewKanbanBtn.addEventListener('click', () => setViewMode('kanban'));
  if (localStorage.getItem('devlauncher.jira.viewMode') === 'kanban') setViewMode('kanban');

  customViews = loadCustomViews();
  populateCategorySelect();

  $viewsManageBtn.addEventListener('click', openViewsModal);
  $viewsAdd.addEventListener('click', addCustomView);
  $viewsModal.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.dataset && t.dataset.jiraViewsClose) closeViewsModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$viewsModal.classList.contains('hidden')) closeViewsModal();
  });

  if ($notifyToggle) {
    $notifyToggle.checked = loadNotifyPref();
    $notifyToggle.addEventListener('change', () => setNotifyEnabled($notifyToggle.checked));
  }

  /* ---------- Lazy-load: recien al activar la vista ---------- */

  document.addEventListener('view:change', (ev) => {
    if (ev.detail && ev.detail.view === 'jira') ensureLoaded();
  });
  // Defensivo: si la vista ya estuviera activa al cargar.
  if (document.getElementById('view-jira').classList.contains('active')) ensureLoaded();
})();
