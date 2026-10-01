'use strict';

/**
 * Factory para renderizar una vista de proyectos filtrada por categoria.
 * Se monta dos veces desde index.html: una para "dev" y otra para "mobile",
 * cada una con sus propios contenedores DOM. La data viene del mismo
 * projects.config.js via window.api.listProjects().
 */
window.__mountProjectsView = function (opts) {
  const list   = document.getElementById(opts.listId);
  const detail = document.getElementById(opts.detailId);
  const searchInput = opts.searchId ? document.getElementById(opts.searchId) : null;
  const filterCategory = opts.category;

  if (!list || !detail) return;

  if (window.__skeleton) window.__skeleton.render(list, 6);

  let projects = [];
  let selectedId = null;
  let searchTerm = '';
  // Referencias al panel del emulador actualmente montado (o null). Se actualiza
  // por los eventos 'emulator:log' del main. Solo hay uno visible a la vez.
  let emu = null;
  // Idem para el panel "Levantar ambiente" (eventos 'environment:log').
  let env = null;
  // Idem para el panel "Generar APK" (eventos 'apkBuild:log').
  let apk = null;

  /* ---------- Favoritos / recientes (localStorage, global a toda la app) ---------- */

  const FAV_KEY = 'devlauncher.projects.favorites';
  const RECENT_KEY = 'devlauncher.projects.recent';

  const loadFavorites = () => {
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); }
    catch (_) { return new Set(); }
  };
  const saveFavorites = () => {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(favorites))); }
    catch (_) { /* ignore */ }
  };
  const loadRecents = () => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '{}'); }
    catch (_) { return {}; }
  };
  const touchRecent = (id) => {
    try {
      const rec = loadRecents();
      rec[id] = Date.now();
      localStorage.setItem(RECENT_KEY, JSON.stringify(rec));
    } catch (_) { /* ignore */ }
  };

  let favorites = loadFavorites();

  // Favoritos primero (orden de config entre ellos), despues recientes por fecha
  // descendente, despues el resto en orden de config. El reordenamiento por "reciente"
  // solo se aplica al (re)renderizar la lista, no en cada click de selectProject, para
  // que la card no salte de lugar mientras el usuario esta navegando la sesion actual.
  function sortForDisplay(arr) {
    const recents = loadRecents();
    const orderIndex = new Map(arr.map((p, i) => [p.id, i]));
    return arr.slice().sort((a, b) => {
      const aFav = favorites.has(a.id), bFav = favorites.has(b.id);
      if (aFav !== bFav) return aFav ? -1 : 1;
      if (aFav && bFav) return orderIndex.get(a.id) - orderIndex.get(b.id);
      const aRec = recents[a.id] || 0, bRec = recents[b.id] || 0;
      if (aRec !== bRec) return bRec - aRec;
      return orderIndex.get(a.id) - orderIndex.get(b.id);
    });
  }

  /* ---------- Busqueda ---------- */

  const matchesSearch = (p) => {
    if (!searchTerm) return true;
    return `${p.name} ${p.description || ''}`.toLowerCase().includes(searchTerm);
  };

  const applyFilter = () => {
    list.querySelectorAll('.project-card').forEach((c) => {
      const p = projects.find((x) => x.id === c.dataset.id);
      c.style.display = (p && matchesSearch(p)) ? '' : 'none';
    });
    // Un separador de grupo se oculta si ningun proyecto de ese grupo quedo visible.
    list.querySelectorAll('.project-group-sep-wrap').forEach((sep) => {
      const g = sep.dataset.group;
      const anyVisible = Array.from(list.querySelectorAll(`.project-card[data-group="${g}"]`))
        .some((c) => c.style.display !== 'none');
      sep.style.display = anyVisible ? '' : 'none';
    });
  };

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchTerm = searchInput.value.trim().toLowerCase();
      applyFilter();
    });
  }

  /* ---------- Git status (badge de rama / cambios sin commitear) ---------- */

  const gitStatusCache = new Map(); // id -> data|null, evita re-consultar en cada re-render

  function escapeHtmlLocal(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderGitBadge(badge, data) {
    if (!data) { badge.classList.add('hidden'); return; }
    badge.classList.remove('hidden');
    badge.innerHTML =
      `<span class="card-git-branch" title="Rama actual">&#8981; ${escapeHtmlLocal(data.branch)}</span>` +
      (data.dirty
        ? `<span class="card-git-dirty" title="${data.dirtyCount} cambio(s) sin commitear">&#9679; ${data.dirtyCount}</span>`
        : '');
  }

  function loadGitBadge(card, projectId) {
    const badge = card.querySelector('.card-git-badge');
    if (!badge) return;
    if (gitStatusCache.has(projectId)) {
      renderGitBadge(badge, gitStatusCache.get(projectId));
      return;
    }
    if (!window.api.gitStatus) return;
    window.api.gitStatus(projectId).then((r) => {
      const data = (r && r.ok) ? r.data : null;
      gitStatusCache.set(projectId, data);
      renderGitBadge(badge, data);
    }).catch(() => { gitStatusCache.set(projectId, null); });
  }

  /* ---------- Card rendering ---------- */

  const renderCard = (project) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card project-card';
    card.dataset.id = project.id;
    card.dataset.group = project.group || '';

    // Carpeta a abrir con el iconito: folderPath si existe, sino la carpeta
    // resuelta del .sln (cmdPath). Ambos vienen del launcher service.
    const folderToOpen = project.folderPath || project.cmdPath;

    card.innerHTML = `
      <div class="card-title">
        <h3></h3>
        <div class="card-title-icons">
          <span class="card-fav-btn" role="button" tabindex="0" title="Marcar como favorito" aria-label="Marcar como favorito">&#9734;</span>
          ${project.warning ? '<span class="card-warn-badge" title="Tiene warning - ver detalle">&#9888;</span>' : ''}
          ${folderToOpen ? '<span class="card-folder-btn" role="button" tabindex="0" title="Abrir carpeta del proyecto" aria-label="Abrir carpeta del proyecto">&#128193;</span>' : ''}
        </div>
      </div>
      <div class="card-git-badge hidden"></div>
      <p class="desc"></p>
      <div class="paths">
        ${project.solutionPath ? '<div><strong>VS:</strong> <span class="vs-path"></span></div>' : ''}
        ${project.folderPath   ? '<div><strong>Code:</strong> <span class="code-path"></span></div>' : ''}
      </div>
      <div class="card-hint">Click para ver acciones y comandos &rarr;</div>
    `;
    card.querySelector('h3').textContent = project.name;
    card.querySelector('.desc').textContent = project.description || '';
    if (project.solutionPath) card.querySelector('.vs-path').textContent = project.solutionPath;
    if (project.folderPath)   card.querySelector('.code-path').textContent = project.folderPath;

    const favBtn = card.querySelector('.card-fav-btn');
    const applyFavState = () => {
      const isFav = favorites.has(project.id);
      favBtn.classList.toggle('is-fav', isFav);
      favBtn.innerHTML = isFav ? '&#9733;' : '&#9734;';
      favBtn.title = isFav ? 'Quitar de favoritos' : 'Marcar como favorito';
    };
    applyFavState();
    const toggleFav = (ev) => {
      ev.stopPropagation();
      if (favorites.has(project.id)) favorites.delete(project.id);
      else favorites.add(project.id);
      saveFavorites();
      applyFavState();
      renderList();
    };
    favBtn.addEventListener('click', toggleFav);
    favBtn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleFav(ev); }
    });

    loadGitBadge(card, project.id);

    const folderBtn = card.querySelector('.card-folder-btn');
    if (folderBtn) {
      const openFolder = async (ev) => {
        ev.stopPropagation(); // no seleccionar la card al abrir la carpeta
        try {
          const r = await window.api.openPath(folderToOpen);
          if (r && !r.ok) setDetailStatus('error', r.error || 'No se pudo abrir la carpeta.');
        } catch (e) {
          setDetailStatus('error', e.message || String(e));
        }
      };
      folderBtn.addEventListener('click', openFolder);
      folderBtn.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') openFolder(ev);
      });
    }

    card.addEventListener('click', () => selectProject(project.id));
    return card;
  };

  const updateCardSelection = () => {
    list.querySelectorAll('.project-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.id === selectedId);
    });
  };

  const groupLabel = (g) => g.charAt(0).toUpperCase() + g.slice(1);

  const renderGroupSeparator = (g) => {
    const wrap = document.createElement('div');
    wrap.className = 'project-group-sep-wrap';
    wrap.dataset.group = g;
    wrap.innerHTML = '<hr class="project-group-sep"><h4 class="project-group-title"></h4>';
    wrap.querySelector('.project-group-title').textContent = groupLabel(g);
    return wrap;
  };

  // (Re)pinta la grilla completa: favoritos arriba, despues recientes, respetando el
  // filtro de busqueda activo y la seleccion actual. Los proyectos con `group` se
  // pintan aparte, detras de un separador (hr + titulo), en el orden en que aparecen
  // en projects.config.js; el grupo principal (sin `group`) siempre va primero.
  const renderList = () => {
    list.innerHTML = '';
    const groupOrder = [];
    const byGroup = new Map();
    projects.forEach((p) => {
      const g = p.group || null;
      if (!byGroup.has(g)) { byGroup.set(g, []); groupOrder.push(g); }
      byGroup.get(g).push(p);
    });
    const orderedGroups = [null, ...groupOrder.filter((g) => g !== null)];
    orderedGroups.forEach((g) => {
      if (!byGroup.has(g)) return;
      if (g !== null) list.appendChild(renderGroupSeparator(g));
      sortForDisplay(byGroup.get(g)).forEach((p) => list.appendChild(renderCard(p)));
    });
    applyFilter();
    updateCardSelection();
  };

  /* ---------- Detail panel rendering ---------- */

  const setDetailStatus = (kind, msg) => {
    const s = detail.querySelector('.status');
    if (!s) return;
    s.className = `status show ${kind}`;
    s.textContent = msg;
  };

  const renderDetail = (project) => {
    detail.innerHTML = '';
    emu = null; // el panel anterior (si lo habia) quedo desmontado
    env = null;
    apk = null;

    const wrap = document.createElement('div');
    wrap.className = 'detail-content';

    // Header
    const head = document.createElement('div');
    head.className = 'detail-head';
    const h3 = document.createElement('h3');
    h3.textContent = project.name;
    const desc = document.createElement('p');
    desc.className = 'detail-desc';
    desc.textContent = project.description || '';
    head.appendChild(h3);
    if (project.description) head.appendChild(desc);
    wrap.appendChild(head);

    // Warning
    if (project.warning) {
      const warn = document.createElement('div');
      warn.className = 'detail-warning';
      const icon = document.createElement('span');
      icon.className = 'warn-icon';
      icon.textContent = '⚠';
      const text = document.createElement('span');
      text.textContent = project.warning;
      warn.appendChild(icon);
      warn.appendChild(text);
      wrap.appendChild(warn);
    }

    // Paths
    if (project.solutionPath || project.folderPath) {
      const pths = document.createElement('div');
      pths.className = 'detail-paths';
      (project.solutions || []).forEach(s => {
        const d = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = 'VS: ';
        const span = document.createElement('span');
        span.textContent = s.path;
        d.appendChild(strong);
        d.appendChild(span);
        pths.appendChild(d);
      });
      if (project.folderPath) {
        const d = document.createElement('div');
        d.innerHTML = '<strong>Code:</strong> ';
        const span = document.createElement('span');
        span.textContent = project.folderPath;
        d.appendChild(span);
        pths.appendChild(d);
      }
      wrap.appendChild(pths);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'detail-actions';

    const makeBtn = (cls, text, fn, loadingMsg) => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`;
      b.textContent = text;
      b.addEventListener('click', async () => {
        const all = wrap.querySelectorAll('button');
        all.forEach(x => x.disabled = true);
        setDetailStatus('loading', loadingMsg);
        try {
          const r = await fn();
          if (r && r.ok) setDetailStatus('success', 'Lanzado correctamente.');
          else           setDetailStatus('error', (r && r.error) || 'Error desconocido.');
        } catch (e) {
          setDetailStatus('error', e.message || String(e));
        } finally {
          all.forEach(x => x.disabled = false);
        }
      });
      return b;
    };

    if (project.cmdPath) {
      const cmdBtn = makeBtn('', 'Abrir CMD (admin)',
        () => window.api.openCmd(project.id),
        'Lanzando CMD... (aproba el UAC)');
      cmdBtn.title = `cmd.exe en ${project.cmdPath}`;
      actions.appendChild(cmdBtn);

      const termBtn = makeBtn('', 'Abrir Terminal aqui',
        () => window.api.openTerminal(project.id),
        'Abriendo terminal...');
      termBtn.title = `cmd.exe sin elevar en ${project.cmdPath}`;
      actions.appendChild(termBtn);
    }
    if (project.hasSolution && project.hasFolder) {
      actions.appendChild(makeBtn('primary', 'Abrir todo',
        () => window.api.openProject(project.id),
        'Lanzando VS y VS Code... (aproba el UAC para cada uno)'));
    }
    // Un boton por .sln: los monorepos declaran varias en `solutions[]`.
    const sols = project.solutions || (project.solutionPath ? [{ label: '', path: project.solutionPath }] : []);
    sols.forEach((s, i) => {
      const text = sols.length > 1 ? `Abrir VS: ${s.label}` : 'Abrir Visual Studio';
      const b = makeBtn('', text,
        () => window.api.openVisualStudio(project.id, i),
        'Lanzando Visual Studio... (aproba el UAC)');
      b.title = s.path;
      actions.appendChild(b);
    });
    if (project.hasFolder) {
      actions.appendChild(makeBtn('', 'Abrir VS Code',
        () => window.api.openVSCode(project.id),
        'Lanzando VS Code... (aproba el UAC)'));
    }
    wrap.appendChild(actions);

    // Status
    const status = document.createElement('div');
    status.className = 'status';
    status.setAttribute('aria-live', 'polite');
    wrap.appendChild(status);

    // Levantar ambiente (proyectos con config environment)
    if (project.environment) renderEnvironment(project, wrap);

    // Emulador (solo proyectos mobile con config emulator)
    if (project.emulator) renderEmulator(project, wrap);

    // Generar APK (solo proyectos mobile con config apkBuild)
    if (project.apkBuild) renderApkBuild(project, wrap);

    // Commands
    const cmdSection = document.createElement('div');
    cmdSection.className = 'detail-commands';
    const cmdH = document.createElement('h4');
    cmdH.textContent = 'Comandos';
    cmdSection.appendChild(cmdH);

    if (!project.commands || !project.commands.length) {
      const empty = document.createElement('p');
      empty.className = 'cmd-empty';
      empty.textContent = 'Sin comandos configurados. Edita src/config/projects.config.js para agregar.';
      cmdSection.appendChild(empty);
    } else {
      project.commands.forEach(c => {
        const item = document.createElement('div');
        item.className = 'cmd-item';

        const head = document.createElement('div');
        head.className = 'cmd-head';
        const lbl = document.createElement('span');
        lbl.className = 'cmd-label';
        lbl.textContent = c.label;
        const copy = document.createElement('button');
        copy.className = 'btn cmd-copy';
        copy.textContent = 'Copiar';
        copy.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try {
            await navigator.clipboard.writeText(c.command);
            copy.textContent = 'Copiado!';
            setTimeout(() => { copy.textContent = 'Copiar'; }, 1200);
          } catch (e) {
            setDetailStatus('error', 'No se pudo copiar: ' + e.message);
          }
        });
        head.appendChild(lbl);
        head.appendChild(copy);
        item.appendChild(head);

        const code = document.createElement('pre');
        code.className = 'cmd-code';
        code.textContent = c.command;
        item.appendChild(code);

        if (c.description) {
          const d = document.createElement('p');
          d.className = 'cmd-desc';
          d.textContent = c.description;
          item.appendChild(d);
        }

        cmdSection.appendChild(item);
      });
    }
    wrap.appendChild(cmdSection);

    detail.appendChild(wrap);
  };

  /* ---------- Levantar ambiente (dev servers) ---------- */

  const setEnvProgress = (pct, stage) => {
    if (!env) return;
    const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    env.fill.style.width = `${p}%`;
    env.pct.textContent = `${p}%`;
    if (typeof stage === 'string' && stage) env.stage.textContent = stage;
  };

  const appendEnvLog = (kind, message, ts) => {
    if (!env) return;
    const line = document.createElement('div');
    line.className = `log-line log-${kind}`;
    const time = new Date(ts || Date.now()).toLocaleTimeString();
    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = `[${time}] ${kind.toUpperCase()}`;
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = ' ' + (typeof message === 'string' ? message : JSON.stringify(message));
    line.appendChild(tag);
    line.appendChild(msg);
    env.log.appendChild(line);
    env.log.scrollTop = env.log.scrollHeight;
  };

  // phase: 'idle' | 'starting' | 'up' | 'stopping'
  const setEnvPhase = (phase) => {
    if (!env) return;
    env.phase = phase;
    env.startBtn.disabled = phase !== 'idle';
    env.stopBtn.disabled = !(phase === 'starting' || phase === 'up');
    env.startBtn.textContent = phase === 'up' ? '● Ambiente corriendo' : '▶ Levantar ambiente';
    // Reiniciar un servicio puntual solo tiene sentido con el ambiente arriba.
    (env.terminalRows || []).forEach(row => {
      // No re-habilitar una fila que esta reiniciandose ahora mismo.
      if (!row.restarting) row.btn.disabled = phase !== 'up';
    });
  };

  // Reinicia un servicio puntual del ambiente (canal separado del start/stop global).
  const restartService = async (project, idx, term, row) => {
    if (!env || env.phase !== 'up' || row.restarting) return;
    row.restarting = true;
    row.btn.disabled = true;
    row.status.textContent = 'reiniciando…';
    row.status.className = 'env-step-status is-working';
    appendEnvLog('info', `Reiniciando servicio ${idx + 1}: ${term.title}...`);
    try {
      const r = await window.api.environment.restart({ id: project.id, index: idx });
      if (!r.ok) throw new Error(r.error);
      const ok = r.data && (r.data.ready || r.data.listening);
      row.status.textContent = ok ? '✓ ok' : 'iniciado';
      row.status.className = 'env-step-status ' + (ok ? 'is-ok' : 'is-working');
      appendEnvLog('success', `Servicio ${idx + 1} reiniciado${term.port ? ` (puerto ${term.port})` : ''}.`);
    } catch (e) {
      row.status.textContent = '✗ error';
      row.status.className = 'env-step-status is-error';
      appendEnvLog('error', `No se pudo reiniciar el servicio ${idx + 1}: ${e.message}`);
    } finally {
      row.restarting = false;
      // Re-habilitar solo si el ambiente sigue arriba (stop pudo haber corrido).
      row.btn.disabled = !env || env.phase !== 'up';
    }
  };

  const renderEnvironment = (project, wrap) => {
    const cfg = project.environment;

    const panel = document.createElement('div');
    panel.className = 'emu-panel'; // reusa estilos del panel del emulador

    const title = document.createElement('h4');
    title.textContent = cfg.label || 'Levantar ambiente';
    panel.appendChild(title);

    // Lista de servicios. Cada uno con su boton "reiniciar" (solo activo con el
    // ambiente arriba) que reinicia ESE servicio sin tocar los demas.
    const terminalRows = [];
    if (Array.isArray(cfg.terminals) && cfg.terminals.length) {
      const steps = document.createElement('ul');
      steps.className = 'env-steps';
      cfg.terminals.forEach((t, idx) => {
        const li = document.createElement('li');
        li.className = 'env-step';

        const label = document.createElement('span');
        label.className = 'env-step-label';
        label.textContent = t.title + (t.port ? ` — puerto ${t.port}` : '');

        const status = document.createElement('span');
        status.className = 'env-step-status';

        const btn = document.createElement('button');
        btn.className = 'btn env-step-restart';
        btn.type = 'button';
        btn.title = 'Reiniciar solo este servicio';
        btn.textContent = '⟳';
        btn.disabled = true;

        const row = { li, btn, status, restarting: false };
        btn.addEventListener('click', () => restartService(project, idx, t, row));

        li.appendChild(label);
        li.appendChild(status);
        li.appendChild(btn);
        steps.appendChild(li);
        terminalRows.push(row);
      });
      panel.appendChild(steps);
    }

    const hint = document.createElement('p');
    hint.className = 'env-hint';
    hint.textContent = 'Corre los servicios en segundo plano (sin abrir terminales). El log aparece abajo; "Detener" los apaga.';
    panel.appendChild(hint);

    // Aviso + boton para reiniciar elevado (solo si la app no corre como admin).
    const adminNotice = document.createElement('div');
    adminNotice.className = 'env-admin-notice';
    adminNotice.style.display = 'none';
    panel.appendChild(adminNotice);
    if (window.api.admin && window.api.admin.status) {
      window.api.admin.status().then(r => {
        if (r && r.ok && r.data && !r.data.isAdmin) {
          adminNotice.style.display = '';
          const txt = document.createElement('span');
          txt.textContent = '⚠ La app no está como administrador.';
          const btn = document.createElement('button');
          btn.className = 'btn';
          btn.textContent = 'Reiniciar como administrador';
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            appendEnvLog('info', 'Solicitando reinicio como administrador (aproba el UAC)...');
            try {
              const rr = await window.api.admin.relaunch();
              if (rr && !rr.ok) { appendEnvLog('error', rr.error || 'No se pudo elevar.'); btn.disabled = false; }
              // Si ok, la app se relanza elevada y esta instancia se cierra sola.
            } catch (e) { appendEnvLog('error', e.message); btn.disabled = false; }
          });
          adminNotice.appendChild(txt);
          adminNotice.appendChild(btn);
        }
      }).catch(() => { /* ignore */ });
    }

    const controls = document.createElement('div');
    controls.className = 'emu-controls';

    const startBtn = document.createElement('button');
    startBtn.className = 'btn primary emu-start';
    startBtn.type = 'button';
    startBtn.textContent = '▶ Levantar ambiente';

    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn emu-cancel';
    stopBtn.type = 'button';
    stopBtn.textContent = '■ Detener ambiente';
    stopBtn.disabled = true;

    controls.appendChild(startBtn);
    controls.appendChild(stopBtn);
    panel.appendChild(controls);

    // Barra de progreso (reusa estilos vc-progress-* / emu-fill)
    const progWrap = document.createElement('div');
    progWrap.className = 'vc-progress-wrap';
    const bar = document.createElement('div');
    bar.className = 'vc-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'emu-fill';
    bar.appendChild(fill);
    const meta = document.createElement('div');
    meta.className = 'vc-progress-meta';
    const pct = document.createElement('span');
    pct.textContent = '0%';
    const stage = document.createElement('span');
    stage.className = 'emu-stage';
    stage.textContent = 'Listo para levantar.';
    meta.appendChild(pct);
    meta.appendChild(stage);
    progWrap.appendChild(bar);
    progWrap.appendChild(meta);
    panel.appendChild(progWrap);

    const log = document.createElement('div');
    log.className = 'dt-log emu-log';
    panel.appendChild(log);

    wrap.appendChild(panel);

    env = { phase: 'idle', fill, pct, stage, log, startBtn, stopBtn, terminalRows };
    setEnvPhase('idle');

    startBtn.addEventListener('click', async () => {
      if (env.phase !== 'idle') return;
      setEnvPhase('starting');
      setEnvProgress(0, 'Iniciando...');
      appendEnvLog('info', 'Levantando ambiente en segundo plano (no se abre ninguna ventana)...');
      try {
        const r = await window.api.environment.start({ id: project.id });
        if (!r.ok) throw new Error(r.error);
        setEnvProgress(100, 'Listo.');
        setEnvPhase('up');
        appendEnvLog('success', 'Ambiente corriendo en segundo plano.');
      } catch (e) {
        if (/cancel/i.test(e.message)) appendEnvLog('warn', 'Levantado cancelado.');
        else appendEnvLog('error', e.message);
        if (env) setEnvPhase('idle');
      }
    });

    stopBtn.addEventListener('click', async () => {
      if (!env || (env.phase !== 'starting' && env.phase !== 'up')) return;
      setEnvPhase('stopping');
      appendEnvLog('info', 'Deteniendo ambiente...');
      try {
        const r = await window.api.environment.stop();
        if (r && r.ok) appendEnvLog('success', `Ambiente detenido (${(r.data && r.data.killed) || 0} procesos).`);
        else if (r) appendEnvLog('error', r.error || 'No se pudo detener.');
      } catch (e) {
        appendEnvLog('error', e.message);
      }
      setEnvProgress(0, 'Detenido.');
      if (env) {
        (env.terminalRows || []).forEach(row => { row.status.textContent = ''; row.status.className = 'env-step-status'; });
        setEnvPhase('idle');
      }
    });

    // Restaurar estado si el ambiente ya estaba corriendo (al re-montar el panel).
    (async () => {
      try {
        const r = await window.api.environment.status();
        if (r && r.ok && r.data && r.data.running) {
          setEnvPhase('up');
          setEnvProgress(100, 'Ambiente corriendo en segundo plano.');
          appendEnvLog('info', 'Ambiente ya estaba corriendo:');
          (r.data.terminals || []).forEach((t, i) => {
            const st = t.port ? (t.listening ? `puerto ${t.port} escuchando` : `puerto ${t.port} sin responder`) : 'sin puerto';
            appendEnvLog(t.listening === false ? 'warn' : 'info', `· ${t.title}: ${st}${t.owned ? '' : ' (reusado)'}`);
            const row = env && env.terminalRows && env.terminalRows[i];
            if (row) {
              row.status.textContent = t.listening === false ? 'sin responder' : (t.listening ? '✓ ok' : '');
              row.status.className = 'env-step-status ' + (t.listening === false ? 'is-error' : (t.listening ? 'is-ok' : ''));
            }
          });
        }
      } catch (_) { /* ignore */ }
    })();
  };

  // Suscripcion unica a los eventos de "levantar ambiente"; enruta al panel montado.
  if (window.api.environment && window.api.environment.onLog) {
    window.api.environment.onLog((payload) => {
      if (!env) return;
      const { kind, message, ts } = payload || {};
      if (kind === 'progress' && message && typeof message === 'object') {
        setEnvProgress(message.pct, message.stage);
        return;
      }
      if (kind === 'done') { appendEnvLog('success', 'Proceso finalizado.', ts); return; }
      appendEnvLog(kind || 'info', message, ts);
    });
  }

  /* ---------- Emulador (mobile) ---------- */

  const setEmuProgress = (pct, stage) => {
    if (!emu) return;
    const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    emu.fill.style.width = `${p}%`;
    emu.pct.textContent = `${p}%`;
    if (typeof stage === 'string' && stage) emu.stage.textContent = stage;
  };

  const appendEmuLog = (kind, message, ts) => {
    if (!emu) return;
    const line = document.createElement('div');
    line.className = `log-line log-${kind}`;
    const time = new Date(ts || Date.now()).toLocaleTimeString();
    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = `[${time}] ${kind.toUpperCase()}`;
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = ' ' + (typeof message === 'string' ? message : JSON.stringify(message));
    line.appendChild(tag);
    line.appendChild(msg);
    emu.log.appendChild(line);
    emu.log.scrollTop = emu.log.scrollHeight;
  };

  const setEmuRunning = (running) => {
    if (!emu) return;
    emu.running = running;
    emu.startBtn.disabled = running;
    emu.cancelBtn.disabled = !running;
    if (emu.envSel) emu.envSel.disabled = running;
    if (emu.avdSel) emu.avdSel.disabled = running;
  };

  const renderEmulator = (project, wrap) => {
    const cfg = project.emulator;

    const panel = document.createElement('div');
    panel.className = 'emu-panel';

    const title = document.createElement('h4');
    title.textContent = 'Emulador Android';
    panel.appendChild(title);

    const controls = document.createElement('div');
    controls.className = 'emu-controls';

    // Selector de ambiente (solo si el proyecto declara envs; los MAUI no tienen)
    let envSel = null;
    if (cfg.envs && cfg.envs.length) {
      const envLabel = document.createElement('label');
      envLabel.className = 'emu-field';
      envLabel.innerHTML = '<span>Ambiente</span>';
      envSel = document.createElement('select');
      cfg.envs.forEach(e => {
        const o = document.createElement('option');
        o.value = e; o.textContent = e;
        if (e === (cfg.defaultEnv || cfg.envs[0])) o.selected = true;
        envSel.appendChild(o);
      });
      envLabel.appendChild(envSel);
      controls.appendChild(envLabel);
    }

    // Selector de AVD (opcional)
    let avdSel = null;
    if (cfg.avds && cfg.avds.length) {
      const avdLabel = document.createElement('label');
      avdLabel.className = 'emu-field';
      avdLabel.innerHTML = '<span>AVD</span>';
      avdSel = document.createElement('select');
      cfg.avds.forEach(a => {
        const o = document.createElement('option');
        o.value = a; o.textContent = a;
        if (a === (cfg.defaultAvd || cfg.avds[0])) o.selected = true;
        avdSel.appendChild(o);
      });
      avdLabel.appendChild(avdSel);
      controls.appendChild(avdLabel);
    }

    const startBtn = document.createElement('button');
    startBtn.className = 'btn primary emu-start';
    startBtn.type = 'button';
    startBtn.textContent = '▶ Iniciar emulador';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn emu-cancel';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.disabled = true;

    // Cierra TODO lo que haya quedado arriba (emulador + terminal del dev server),
    // no solo el script de arranque. Siempre habilitado: es un cleanup best-effort,
    // no molesta si no hay nada corriendo.
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn danger emu-stop';
    stopBtn.type = 'button';
    stopBtn.textContent = '■ Detener todo';

    controls.appendChild(startBtn);
    controls.appendChild(cancelBtn);
    controls.appendChild(stopBtn);
    panel.appendChild(controls);

    // Barra de progreso (reusa estilos vc-progress-*)
    const progWrap = document.createElement('div');
    progWrap.className = 'vc-progress-wrap';
    const bar = document.createElement('div');
    bar.className = 'vc-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'emu-fill';
    bar.appendChild(fill);
    const meta = document.createElement('div');
    meta.className = 'vc-progress-meta';
    const pct = document.createElement('span');
    pct.textContent = '0%';
    const stage = document.createElement('span');
    stage.className = 'emu-stage';
    stage.textContent = 'Listo para iniciar.';
    meta.appendChild(pct);
    meta.appendChild(stage);
    progWrap.appendChild(bar);
    progWrap.appendChild(meta);
    panel.appendChild(progWrap);

    const log = document.createElement('div');
    log.className = 'dt-log emu-log';
    panel.appendChild(log);

    wrap.appendChild(panel);

    emu = { running: false, fill, pct, stage, log, startBtn, cancelBtn, stopBtn, envSel, avdSel };

    startBtn.addEventListener('click', async () => {
      if (emu.running) return;
      setEmuRunning(true);
      setEmuProgress(0, 'Iniciando...');
      const parts = [envSel ? envSel.value : null, avdSel ? avdSel.value : null].filter(Boolean);
      appendEmuLog('info', `Iniciando emulador${parts.length ? ' (' + parts.join(' / ') + ')' : ''}...`);
      try {
        const r = await window.api.emulator.start({
          id: project.id,
          env: envSel ? envSel.value : undefined,
          avd: avdSel ? avdSel.value : undefined
        });
        if (!r.ok) throw new Error(r.error);
        setEmuProgress(100, 'Listo.');
        appendEmuLog('success', 'Emulador arriba y el proceso quedo corriendo en otra ventana.');
      } catch (e) {
        if (/cancel/i.test(e.message)) appendEmuLog('warn', 'Inicio cancelado.');
        else appendEmuLog('error', e.message);
      } finally {
        setEmuRunning(false);
      }
    });

    cancelBtn.addEventListener('click', async () => {
      if (!emu.running) return;
      cancelBtn.disabled = true;
      await window.api.emulator.cancel();
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      appendEmuLog('info', 'Deteniendo todo (emulador + terminal)...');
      try {
        const r = await window.api.emulator.stop();
        if (!r.ok) throw new Error(r.error);
      } catch (e) {
        appendEmuLog('error', e.message);
      } finally {
        stopBtn.disabled = false;
        if (!emu.running) setEmuProgress(0, 'Listo para iniciar.');
      }
    });
  };

  // Suscripcion unica a los eventos del emulador; enruta al panel montado.
  if (window.api.emulator && window.api.emulator.onLog) {
    window.api.emulator.onLog((payload) => {
      if (!emu) return;
      const { kind, message, ts } = payload || {};
      if (kind === 'progress' && message && typeof message === 'object') {
        setEmuProgress(message.pct, message.stage);
        return;
      }
      if (kind === 'done') { appendEmuLog('success', 'Proceso finalizado.', ts); return; }
      appendEmuLog(kind || 'info', message, ts);
    });
  }

  /* ---------- Generar APK (mobile) ---------- */

  const setApkProgress = (pct, stage) => {
    if (!apk) return;
    const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    apk.fill.style.width = `${p}%`;
    apk.pct.textContent = `${p}%`;
    if (typeof stage === 'string' && stage) apk.stage.textContent = stage;
  };

  const appendApkLog = (kind, message, ts) => {
    if (!apk) return;
    const line = document.createElement('div');
    line.className = `log-line log-${kind}`;
    const time = new Date(ts || Date.now()).toLocaleTimeString();
    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = `[${time}] ${kind.toUpperCase()}`;
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = ' ' + (typeof message === 'string' ? message : JSON.stringify(message));
    line.appendChild(tag);
    line.appendChild(msg);
    apk.log.appendChild(line);
    apk.log.scrollTop = apk.log.scrollHeight;
  };

  const setApkRunning = (running) => {
    if (!apk) return;
    apk.running = running;
    apk.startBtn.disabled = running;
    apk.cancelBtn.disabled = !running;
    if (apk.envSel) apk.envSel.disabled = running;
  };

  const formatBytes = (n) => {
    if (!Number.isFinite(n)) return '';
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  const renderApkResult = (result) => {
    if (!apk) return;
    apk.result.innerHTML = '';
    apk.result.classList.remove('hidden');
    if (Array.isArray(result.apkFiles) && result.apkFiles.length) {
      const list = document.createElement('ul');
      list.className = 'apk-file-list';
      result.apkFiles.forEach(f => {
        const li = document.createElement('li');
        const name = f.path.split(/[\\/]/).pop();
        li.textContent = `${name} (${formatBytes(f.size)})`;
        list.appendChild(li);
      });
      apk.result.appendChild(list);
    }
    if (result.outputDir) {
      const openBtn = document.createElement('button');
      openBtn.className = 'btn primary';
      openBtn.type = 'button';
      openBtn.textContent = '📁 Abrir carpeta con el APK';
      openBtn.addEventListener('click', async () => {
        try {
          const r = await window.api.openPath(result.outputDir);
          if (r && !r.ok) appendApkLog('error', r.error || 'No se pudo abrir la carpeta.');
        } catch (e) {
          appendApkLog('error', e.message || String(e));
        }
      });
      apk.result.appendChild(openBtn);
    }
  };

  const renderApkBuild = (project, wrap) => {
    const cfg = project.apkBuild;

    const panel = document.createElement('div');
    panel.className = 'emu-panel'; // reusa estilos del panel del emulador

    const title = document.createElement('h4');
    title.textContent = 'Generar APK';
    panel.appendChild(title);

    const controls = document.createElement('div');
    controls.className = 'emu-controls';

    // Selector de ambiente (solo si el proyecto declara environments)
    let envSel = null;
    if (cfg.environments && cfg.environments.length) {
      const envLabel = document.createElement('label');
      envLabel.className = 'emu-field';
      envLabel.innerHTML = '<span>Ambiente</span>';
      envSel = document.createElement('select');
      cfg.environments.forEach(e => {
        const o = document.createElement('option');
        o.value = e.id; o.textContent = e.label || e.id;
        if (e.id === (cfg.defaultEnv || cfg.environments[0].id)) o.selected = true;
        envSel.appendChild(o);
      });
      envLabel.appendChild(envSel);
      controls.appendChild(envLabel);
    }

    const startBtn = document.createElement('button');
    startBtn.className = 'btn primary emu-start';
    startBtn.type = 'button';
    startBtn.textContent = '▶ Generar APK';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn emu-cancel';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.disabled = true;

    controls.appendChild(startBtn);
    controls.appendChild(cancelBtn);
    panel.appendChild(controls);

    // Barra de progreso (reusa estilos vc-progress-*)
    const progWrap = document.createElement('div');
    progWrap.className = 'vc-progress-wrap';
    const bar = document.createElement('div');
    bar.className = 'vc-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'emu-fill';
    bar.appendChild(fill);
    const meta = document.createElement('div');
    meta.className = 'vc-progress-meta';
    const pct = document.createElement('span');
    pct.textContent = '0%';
    const stage = document.createElement('span');
    stage.className = 'emu-stage';
    stage.textContent = 'Listo para generar.';
    meta.appendChild(pct);
    meta.appendChild(stage);
    progWrap.appendChild(bar);
    progWrap.appendChild(meta);
    panel.appendChild(progWrap);

    const result = document.createElement('div');
    result.className = 'apk-result hidden';
    panel.appendChild(result);

    const log = document.createElement('div');
    log.className = 'dt-log emu-log';
    panel.appendChild(log);

    wrap.appendChild(panel);

    apk = { running: false, fill, pct, stage, log, result, startBtn, cancelBtn, envSel };

    startBtn.addEventListener('click', async () => {
      if (apk.running) return;
      setApkRunning(true);
      setApkProgress(0, 'Iniciando...');
      apk.result.classList.add('hidden');
      apk.result.innerHTML = '';
      const envName = envSel ? (envSel.options[envSel.selectedIndex] || {}).textContent : null;
      appendApkLog('info', `Generando APK${envName ? ' (' + envName + ')' : ''}...`);
      try {
        const r = await window.api.apkBuild.start({
          id: project.id,
          env: envSel ? envSel.value : undefined
        });
        if (!r.ok) throw new Error(r.error);
        setApkProgress(100, 'Listo.');
        appendApkLog('success', 'APK generado correctamente.');
        renderApkResult(r.data || {});
      } catch (e) {
        if (/cancel/i.test(e.message)) appendApkLog('warn', 'Generacion cancelada.');
        else appendApkLog('error', e.message);
      } finally {
        setApkRunning(false);
      }
    });

    cancelBtn.addEventListener('click', async () => {
      if (!apk.running) return;
      cancelBtn.disabled = true;
      await window.api.apkBuild.cancel();
    });
  };

  // Suscripcion unica a los eventos de "generar APK"; enruta al panel montado.
  if (window.api.apkBuild && window.api.apkBuild.onLog) {
    window.api.apkBuild.onLog((payload) => {
      if (!apk) return;
      const { kind, message, ts } = payload || {};
      if (kind === 'progress' && message && typeof message === 'object') {
        setApkProgress(message.pct, message.stage);
        return;
      }
      if (kind === 'done') { appendApkLog('success', 'Proceso finalizado.', ts); return; }
      appendApkLog(kind || 'info', message, ts);
    });
  }

  const renderPlaceholder = () => {
    detail.innerHTML = '<div class="placeholder">Selecciona un proyecto para ver acciones y comandos.</div>';
  };

  /* ---------- Selection ---------- */

  const selectProject = (id) => {
    if (selectedId === id) {
      selectedId = null;
      updateCardSelection();
      renderPlaceholder();
      return;
    }
    selectedId = id;
    touchRecent(id);
    updateCardSelection();
    const p = projects.find(x => x.id === id);
    if (p) renderDetail(p);
  };

  /* ---------- Boot ---------- */

  (async () => {
    try {
      const r = await window.api.listProjects();
      if (!r.ok) throw new Error(r.error);
      projects = r.data.filter(p => (p.category || 'dev') === filterCategory);
      if (!projects.length) {
        list.innerHTML = '<p style="color:var(--fg-dim)">No hay proyectos en esta categoria. Edita <code>src/config/projects.config.js</code>.</p>';
        return;
      }
      renderList();

      // Auto-select first project for convenience
      selectProject(projects[0].id);
    } catch (e) {
      list.innerHTML = '';
      const err = document.createElement('p');
      err.style.color = 'var(--danger)';
      err.textContent = `Error cargando proyectos: ${e.message}`;
      list.appendChild(err);
    } finally {
      // "dev" es la categoria de la vista activa al abrir la app: es la senal de
      // que ya hay algo util en pantalla, listo para ocultar el overlay de boot.
      if (filterCategory === 'dev' && window.__bootOverlay) window.__bootOverlay.done();
    }
  })();
};

// Montar las dos vistas (dev y mobile) leyendo del mismo config.
window.__mountProjectsView({
  listId: 'projects-list',
  detailId: 'project-detail',
  category: 'dev',
  searchId: 'projects-search'
});
window.__mountProjectsView({
  listId: 'projects-mobile-list',
  detailId: 'project-mobile-detail',
  category: 'mobile',
  searchId: 'projects-mobile-search'
});
