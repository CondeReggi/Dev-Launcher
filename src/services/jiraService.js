'use strict';

/**
 * Jira Cloud REST API v3 client (runs in the Electron MAIN process).
 *
 * Auth: Basic auth con `email:apiToken` en Base64. El token vive en la config
 * en capas (sendQr.config.js baseline gitignored + sendQr.overrides.json escrito
 * por el modal de Configuracion -> tab "Jira"). NUNCA se devuelve el token al
 * renderer; `getPublicConfig()` expone solo baseUrl/email/jql/maxResults + flag.
 *
 * Todo el HTTP se hace aca (main) porque el renderer tiene CSP connect-src 'none'
 * y porque el token no debe salir del proceso Node. Mismo patron que graphUsers /
 * b2bCredentials / oneSignal.
 *
 * Endpoints usados (Jira Cloud, API v3):
 *   POST /rest/api/3/search/jql              -> busqueda por JQL (token pagination)
 *   GET  /rest/api/3/issue/{key}             -> detalle (con expand=renderedFields)
 *   GET  /rest/api/3/issue/{key}/transitions -> transiciones disponibles
 *   POST /rest/api/3/issue/{key}/transitions -> ejecutar transicion (cambia estado)
 *   GET  /rest/api/3/user/assignable/search  -> usuarios asignables a la issue
 *   PUT  /rest/api/3/issue/{key}/assignee    -> reasignar (Jira Cloud usa accountId)
 */

const configService = require('./configService');

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory in (2, 4) ORDER BY priority DESC, created ASC';
const ISSUE_FIELDS = [
  'summary', 'description', 'status', 'priority', 'project',
  'assignee', 'reporter', 'updated', 'created', 'issuetype'
];

/* ---------------- Config ---------------- */

function getConfig() {
  const cfg = (configService.getEffective() || {}).jira || {};
  const baseUrl = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
  return {
    baseUrl,
    email: String(cfg.email || '').trim(),
    apiToken: String(cfg.apiToken || '').trim(),
    jql: String(cfg.jql || '').trim() || DEFAULT_JQL,
    maxResults: Number(cfg.maxResults) > 0 ? Number(cfg.maxResults) : 50
  };
}

function isConfigured(c) {
  return Boolean(c.baseUrl && c.email && c.apiToken);
}

// Lo que SI puede ver el renderer (sin token).
function getPublicConfig() {
  const c = getConfig();
  return {
    baseUrl: c.baseUrl,
    email: c.email,
    jql: c.jql,
    maxResults: c.maxResults,
    configured: isConfigured(c),
    hasToken: Boolean(c.apiToken)
  };
}

function requireConfig() {
  const c = getConfig();
  if (!isConfigured(c)) {
    throw new Error('Jira no esta configurado. Completa baseUrl, email y apiToken en Configuracion -> tab "Jira".');
  }
  return c;
}

/* ---------------- HTTP ---------------- */

async function jiraFetch(cfg, method, pathAndQuery, body, log) {
  const url = `${cfg.baseUrl}${pathAndQuery}`;
  const basic = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${basic}`,
    'Accept': 'application/json'
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  log && log('info', `${method} ${pathAndQuery}`);

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`Error de red contra Jira: ${e.message}`);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    let msg;
    if (res.status === 401) msg = 'Credenciales invalidas (401). Verifica email y API token.';
    else if (res.status === 403) msg = 'Permisos insuficientes (403) para esta operacion.';
    else if (res.status === 404) msg = 'No encontrado (404).';
    else if (res.status === 503 || (json && json.errorCode === 'MAINTENANCE')) {
      // Esto lo devuelve el propio Atlassian (no es un error de la app): el sitio
      // esta en mantenimiento o momentaneamente caido del lado de Jira Cloud.
      msg = 'El sitio de Jira esta en mantenimiento o momentaneamente no disponible (Atlassian, no un error de la app). Reintenta en unos minutos.';
    }
    else {
      const apiMsg = json && (
        (Array.isArray(json.errorMessages) && json.errorMessages.join(' ')) ||
        (json.errors && Object.values(json.errors).join(' ')) ||
        json.message
      );
      msg = apiMsg || `HTTP ${res.status}: ${text.slice(0, 200)}`;
    }
    throw new Error(`Jira ${res.status}: ${msg}`);
  }
  return json;
}

/* ---------------- ADF -> texto plano ----------------
   La description y los comentarios en API v3 son ADF (Atlassian Document Format),
   un arbol JSON. No renderizamos rich text en la UI sandboxeada, asi que lo
   aplanamos a texto legible. */

function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');

  let out = '';
  if (node.type === 'text') out += node.text || '';
  if (node.type === 'hardBreak') out += '\n';
  if (node.type === 'mention') out += '@' + ((node.attrs && node.attrs.text) || 'user').replace(/^@/, '');
  if (node.type === 'emoji') out += (node.attrs && (node.attrs.text || node.attrs.shortName)) || '';

  if (Array.isArray(node.content)) {
    if (node.type === 'listItem') out += '• ';
    out += node.content.map(adfToText).join('');
  }

  // Bloques que separan parrafo.
  if (['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type)) {
    out += '\n';
  }
  return out;
}

function descriptionToText(desc) {
  if (!desc) return '';
  if (typeof desc === 'string') return desc;
  return adfToText(desc).replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------------- Mapeo de issue a forma plana para la UI ---------------- */

function mapUser(u) {
  if (!u) return null;
  return {
    accountId: u.accountId || '',
    displayName: u.displayName || '',
    emailAddress: u.emailAddress || '',
    avatarUrl: (u.avatarUrls && (u.avatarUrls['24x24'] || u.avatarUrls['48x48'])) || ''
  };
}

function mapIssue(issue, baseUrl) {
  const f = issue.fields || {};
  const status = f.status || {};
  const cat = status.statusCategory || {};
  return {
    key: issue.key,
    id: issue.id,
    summary: f.summary || '',
    description: descriptionToText(f.description),
    status: status.name || '',
    statusCategory: cat.key || '',           // 'new' | 'indeterminate' | 'done'
    priority: (f.priority && f.priority.name) || '',
    priorityIcon: (f.priority && f.priority.iconUrl) || '',
    project: (f.project && (f.project.name || f.project.key)) || '',
    projectKey: (f.project && f.project.key) || '',
    issueType: (f.issuetype && f.issuetype.name) || '',
    assignee: mapUser(f.assignee),
    reporter: mapUser(f.reporter),
    updated: f.updated || '',
    created: f.created || '',
    url: `${baseUrl}/browse/${issue.key}`
  };
}

/* ---------------- Operaciones ---------------- */

async function getMyIssues(opts, log) {
  const cfg = requireConfig();
  const jql = (opts && String(opts.jql || '').trim()) || cfg.jql;
  const pageSize = (opts && Number(opts.maxResults) > 0) ? Number(opts.maxResults) : cfg.maxResults;

  log && log('info', `Buscando issues. JQL: ${jql}`);

  const issues = [];
  let nextPageToken = null;
  let page = 0;
  const MAX_PAGES = 20; // techo de seguridad (~ pageSize * 20 issues)

  do {
    page++;
    const body = {
      jql,
      fields: ISSUE_FIELDS,
      maxResults: pageSize
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const data = await jiraFetch(cfg, 'POST', '/rest/api/3/search/jql', body, page === 1 ? log : null);
    const batch = Array.isArray(data && data.issues) ? data.issues : [];
    batch.forEach(i => issues.push(mapIssue(i, cfg.baseUrl)));
    nextPageToken = (data && !data.isLast && data.nextPageToken) ? data.nextPageToken : null;
  } while (nextPageToken && page < MAX_PAGES);

  log && log('success', `Issues recuperadas: ${issues.length} (paginas=${page}).`);
  return { issues, total: issues.length, jql, baseUrl: cfg.baseUrl };
}

async function getIssueDetail(issueKey, log) {
  const cfg = requireConfig();
  if (!issueKey) throw new Error('issueKey requerido.');

  const fields = [...ISSUE_FIELDS, 'comment'].join(',');
  const data = await jiraFetch(
    cfg, 'GET',
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`,
    undefined, log
  );

  const issue = mapIssue(data, cfg.baseUrl);
  const commentField = (data.fields && data.fields.comment) || {};
  const comments = (Array.isArray(commentField.comments) ? commentField.comments : []).map(c => ({
    id: c.id,
    author: mapUser(c.author),
    body: descriptionToText(c.body),
    created: c.created || '',
    updated: c.updated || ''
  }));

  log && log('success', `Detalle de ${issueKey} OK (${comments.length} comentarios).`);
  return { issue, comments };
}

async function getIssueTransitions(issueKey, log) {
  const cfg = requireConfig();
  if (!issueKey) throw new Error('issueKey requerido.');
  const data = await jiraFetch(
    cfg, 'GET',
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    undefined, log
  );
  const transitions = (Array.isArray(data && data.transitions) ? data.transitions : []).map(t => ({
    id: t.id,
    name: t.name,
    to: (t.to && t.to.name) || '',
    toCategory: (t.to && t.to.statusCategory && t.to.statusCategory.key) || ''
  }));
  return { transitions };
}

async function transitionIssue(issueKey, transitionId, log) {
  const cfg = requireConfig();
  if (!issueKey) throw new Error('issueKey requerido.');
  if (!transitionId) throw new Error('transitionId requerido.');

  // Jira no permite setear `status` directo: se ejecuta una transition.
  await jiraFetch(
    cfg, 'POST',
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    { transition: { id: String(transitionId) } },
    log
  );
  log && log('success', `Transicion ${transitionId} aplicada a ${issueKey}.`);

  // Refrescamos la issue para devolver el estado nuevo.
  const fields = ISSUE_FIELDS.join(',');
  const data = await jiraFetch(
    cfg, 'GET',
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`,
    undefined, null
  );
  return { issue: mapIssue(data, cfg.baseUrl) };
}

async function searchUsers(query, issueKey, log) {
  const cfg = requireConfig();
  const q = String(query || '').trim();

  // Si tenemos issueKey, pedimos solo usuarios ASIGNABLES a esa issue (respeta permisos).
  let path;
  if (issueKey) {
    path = `/rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}&maxResults=50`;
    if (q) path += `&query=${encodeURIComponent(q)}`;
  } else {
    path = `/rest/api/3/user/search?maxResults=50&query=${encodeURIComponent(q)}`;
  }

  const data = await jiraFetch(cfg, 'GET', path, undefined, log);
  const users = (Array.isArray(data) ? data : [])
    .filter(u => u && u.accountId && u.accountType !== 'app')
    .map(mapUser);
  return { users };
}

async function addWorklog(issueKey, timeSpent, comment, log) {
  const cfg = requireConfig();
  if (!issueKey) throw new Error('issueKey requerido.');
  const spent = String(timeSpent || '').trim();
  if (!spent) throw new Error('Ingresa el tiempo trabajado (ej: "1h 30m").');

  const body = { timeSpent: spent };
  const text = String(comment || '').trim();
  if (text) {
    // API v3 requiere el comentario en ADF (Atlassian Document Format).
    body.comment = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
    };
  }

  const data = await jiraFetch(
    cfg, 'POST',
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`,
    body, log
  );
  log && log('success', `Worklog registrado en ${issueKey}: ${spent}.`);
  return { worklogId: data && data.id, timeSpent: spent };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Convierte texto plano a ADF, reconociendo "@DisplayName" como nodos `mention`
// reales (para que Jira notifique al usuario etiquetado) cuando ese nombre
// vino de una mencion elegida en el autocomplete del renderer. `mentions` es
// [{accountId, displayName}]; los nombres mas largos se prueban primero para
// que "Ana Garcia" no quede partido por un match parcial de "Ana".
function textToAdf(text, mentions) {
  const valid = (Array.isArray(mentions) ? mentions : []).filter(m => m && m.accountId && m.displayName);
  const byName = new Map(valid.map(m => [m.displayName, m.accountId]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);

  function paragraphContent(line) {
    if (!names.length || !line.includes('@')) {
      return line ? [{ type: 'text', text: line }] : [];
    }
    const re = new RegExp(`(${names.map(n => escapeRegExp('@' + n)).join('|')})`, 'g');
    return line.split(re).filter(part => part !== '').map(part => {
      if (part[0] === '@' && byName.has(part.slice(1))) {
        return { type: 'mention', attrs: { id: byName.get(part.slice(1)), text: part } };
      }
      return { type: 'text', text: part };
    });
  }

  return {
    type: 'doc', version: 1,
    content: String(text).split('\n').map(line => ({ type: 'paragraph', content: paragraphContent(line) }))
  };
}

async function addComment(issueKey, text, mentions, log) {
  const cfg = requireConfig();
  if (!issueKey) throw new Error('issueKey requerido.');
  const body = String(text || '').trim();
  if (!body) throw new Error('Ingresa un comentario.');

  // API v3 requiere el comentario en ADF (Atlassian Document Format).
  const adf = textToAdf(body, mentions);

  const data = await jiraFetch(
    cfg, 'POST',
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    { body: adf },
    log
  );
  log && log('success', `Comentario agregado a ${issueKey}.`);
  return {
    comment: {
      id: data.id,
      author: mapUser(data.author),
      body: descriptionToText(data.body),
      created: data.created || '',
      updated: data.updated || ''
    }
  };
}

async function editComment(issueKey, commentId, text, mentions, log) {
  const cfg = requireConfig();
  if (!issueKey) throw new Error('issueKey requerido.');
  if (!commentId) throw new Error('commentId requerido.');
  const body = String(text || '').trim();
  if (!body) throw new Error('El comentario no puede quedar vacio.');

  const adf = textToAdf(body, mentions);
  let data;
  try {
    data = await jiraFetch(
      cfg, 'PUT',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      { body: adf },
      log
    );
  } catch (e) {
    if (/\b403\b/.test(e.message)) {
      throw new Error('No tenes permisos para editar este comentario (solo quien lo escribio puede).');
    }
    throw e;
  }
  log && log('success', `Comentario ${commentId} actualizado en ${issueKey}.`);
  return {
    comment: {
      id: data.id,
      author: mapUser(data.author),
      body: descriptionToText(data.body),
      created: data.created || '',
      updated: data.updated || ''
    }
  };
}

async function deleteComment(issueKey, commentId, log) {
  const cfg = requireConfig();
  if (!issueKey) throw new Error('issueKey requerido.');
  if (!commentId) throw new Error('commentId requerido.');
  try {
    await jiraFetch(
      cfg, 'DELETE',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      undefined, log
    );
  } catch (e) {
    if (/\b403\b/.test(e.message)) {
      throw new Error('No tenes permisos para eliminar este comentario (solo quien lo escribio puede).');
    }
    throw e;
  }
  log && log('success', `Comentario ${commentId} eliminado de ${issueKey}.`);
  return { commentId };
}

async function deleteIssue(issueKey, log) {
  const cfg = requireConfig();
  if (!issueKey) throw new Error('issueKey requerido.');
  try {
    await jiraFetch(
      cfg, 'DELETE',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
      undefined, log
    );
  } catch (e) {
    if (/\b403\b/.test(e.message)) {
      throw new Error('No tenes permisos para eliminar esta issue (solo quien la creo o un admin del proyecto puede).');
    }
    throw e;
  }
  log && log('success', `Issue ${issueKey} eliminada.`);
  return { issueKey };
}

async function assignIssue(issueKey, accountId, log) {
  const cfg = requireConfig();
  if (!issueKey) throw new Error('issueKey requerido.');
  // accountId === null => "Sin asignar"; cualquier string => ese usuario.
  const body = { accountId: accountId || null };
  try {
    await jiraFetch(
      cfg, 'PUT',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`,
      body, log
    );
  } catch (e) {
    if (/\b403\b/.test(e.message)) {
      throw new Error('No tenes permisos para reasignar esta issue (se requiere "Assign Issues").');
    }
    throw e;
  }
  log && log('success', `Issue ${issueKey} reasignada.`);
  return { issueKey, accountId: accountId || null };
}

module.exports = {
  getPublicConfig,
  getMyIssues,
  getIssueDetail,
  getIssueTransitions,
  transitionIssue,
  searchUsers,
  assignIssue,
  deleteIssue,
  addWorklog,
  addComment,
  editComment,
  deleteComment,
  DEFAULT_JQL
};
