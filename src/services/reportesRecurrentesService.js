'use strict';

/**
 * Reportes recurrentes: solapa que agrupa reportes ad-hoc contra bases de DUCSA,
 * exportables a Excel. Cada reporte declara su propia query/armado de datos; el
 * ambiente (Testing/Produccion) es el selector global de la app (envSelector.js),
 * igual que Credenciales B2B / Usuarios B2C / Plexo.
 *
 * Reportes contra la base SQL Server IdentityServer (Users/UserTypes/UserClaims con
 * ClaimType='role'/ApplicationRoles), con las features de cada rol resueltas directo
 * (RoleFeatures) o via grupo (RoleFeatureGroups + FeatureGroupFeatures). Solo lectura:
 * nunca escribe en la base.
 *
 * - "Generar usuarios internos DUCSA con roles y features": filtra por UserTypeId
 *   (ej. 1 = "Interno - Ducsa"), elegido en la UI; `getParams()` trae los tipos
 *   disponibles desde UserTypes.
 * - "Comparar features entre roles (1 vs 1)": elegis Rol A y, opcionalmente, Rol B
 *   (`getParams()` trae los nombres desde ApplicationRoles). Con un solo rol arma
 *   solo el listado de sus features (no hay nada que comparar); con los dos arma la
 *   comparativa (features en ambos / solo en cada uno).
 *
 * Cada reporte declara `buildSheets(data)` -> { nombreHoja: filas[] }, que
 * `exportReport()` usa para armar el .xlsx generico (sin volver a consultar la base).
 */

const configService = require('./configService');
const logger = require('../utils/logger');

const ENVS = ['Testing', 'Produccion'];

let sql = null;
function loadSqlModule() {
  if (!sql) sql = require('mssql');
  return sql;
}

function getReportesConfig() {
  let cfg = {};
  try { cfg = configService.getEffective() || {}; } catch (_) { cfg = {}; }
  return cfg.reportesRecurrentes || {};
}

/* ------------------------------ Pool SQL Server (por ambiente) ------------------------------ */

const pools = {}; // env -> { pool, key }

async function getPool(env) {
  const cfg = getReportesConfig().identityServer || {};
  const envCfg = cfg[env] || {};
  const cs = envCfg.connectionString;
  if (!cs) {
    throw new Error(
      `No hay connection string configurada para IdentityServer en el ambiente ${env} ` +
      '(Configuracion -> pestaña "Reportes").'
    );
  }
  const entry = pools[env];
  if (entry && entry.key === cs) return entry.pool;
  if (entry) {
    try { await entry.pool.close(); } catch (_) { /* ignore */ }
  }
  const m = loadSqlModule();
  const pool = await new m.ConnectionPool(cs).connect();
  pool.on('error', (e) => logger.error(`mssql (reportes/${env}) pool error:`, e && e.message));
  pools[env] = { pool, key: cs };
  return pool;
}

/* ------------------------------ Config publica (para el resumen de la vista) ------------------------------ */

function parseCsField(cs, keys) {
  const s = String(cs || '');
  for (const k of keys) {
    const rx = new RegExp(`(?:^|;)\\s*${k}\\s*=\\s*([^;]*)`, 'i');
    const mm = s.match(rx);
    if (mm) return mm[1].trim();
  }
  return '';
}

function listEnvs() {
  const cfg = getReportesConfig().identityServer || {};
  return {
    envs: ENVS,
    defaultEnv: ENVS.includes(cfg.defaultEnv) ? cfg.defaultEnv : 'Produccion',
    summaries: ENVS.reduce((acc, e) => {
      const cs = (cfg[e] || {}).connectionString || '';
      acc[e] = {
        configured: !!cs,
        server: parseCsField(cs, ['Server', 'Data Source']),
        database: parseCsField(cs, ['Database', 'Initial Catalog'])
      };
      return acc;
    }, {})
  };
}

/* ------------------------------ Reporte: usuarios internos DUCSA ------------------------------ */

const QUERY_USER_TYPES = `SELECT UserTypeId, Name FROM UserTypes ORDER BY Name;`;

async function getUserTypes(env) {
  const pool = await getPool(env);
  const req = pool.request();
  let result;
  try {
    result = await req.query(QUERY_USER_TYPES);
  } catch (e) {
    logger.error('SQL reportes getUserTypes fallo:', e && e.message);
    throw new Error('Consulta de UserTypes a IdentityServer fallo: ' + (e && e.message ? e.message : String(e)));
  }
  const rows = (result && result.recordset) || [];
  return rows.map((r) => ({ id: r.UserTypeId, name: r.Name }));
}

const QUERY_USUARIOS_INTERNOS_DUCSA = `
  SELECT DISTINCT
    u.UserId,
    u.Username,
    u.Mail,
    ut.Name  AS TipoUsuario,
    ar.Name  AS Rol,
    f.Code   AS FeatureCode,
    f.Description AS FeatureDescripcion
  FROM Users u
  INNER JOIN UserTypes ut
    ON ut.UserTypeId = u.UserTypeId
  INNER JOIN UserClaims rc
    ON rc.UserId = u.UserId
   AND rc.ClaimType = 'role'
  INNER JOIN ApplicationRoles ar
    ON ar.Name = rc.ClaimValue
  LEFT JOIN (
    -- features otorgadas directamente al rol
    SELECT rf.RoleId AS ApplicationRoleId, f.FeatureId, f.Code, f.Description
    FROM RoleFeatures rf
    INNER JOIN Features f ON f.FeatureId = rf.FeatureId
    UNION
    -- features otorgadas al rol via grupo de features
    SELECT rfg.ApplicationRoleId, f.FeatureId, f.Code, f.Description
    FROM RoleFeatureGroups rfg
    INNER JOIN FeatureGroupFeatures fgf ON fgf.FeatureGroupsId = rfg.FeatureGroupsId
    INNER JOIN Features f ON f.FeatureId = fgf.FeatureId
  ) f ON f.ApplicationRoleId = ar.ApplicationRoleId
  WHERE u.UserTypeId = @userTypeId
  ORDER BY u.Username, ar.Name, f.Code;
`;

// A partir de las filas planas (Usuario x Rol x Feature) arma las 3 grillas del
// export: usuarios unicos, pares Usuario-Rol unicos y pares Rol-Feature unicos
// (un rol sin ninguna feature asociada igual aparece una vez, con Feature "(sin features)").
function buildSheetsData(rows) {
  const usuarios = new Map();
  const usuariosRoles = new Map();
  const rolesFeatures = new Map();

  for (const r of rows) {
    if (!usuarios.has(r.UserId)) {
      usuarios.set(r.UserId, {
        UserId: r.UserId,
        Usuario: r.Username,
        Mail: r.Mail,
        TipoUsuario: r.TipoUsuario
      });
    }

    const urKey = `${r.UserId}|${r.Rol}`;
    if (!usuariosRoles.has(urKey)) {
      usuariosRoles.set(urKey, {
        Usuario: r.Username,
        Mail: r.Mail,
        TipoUsuario: r.TipoUsuario,
        Rol: r.Rol
      });
    }

    const rfKey = `${r.Rol}|${r.FeatureCode || ''}`;
    if (!rolesFeatures.has(rfKey)) {
      rolesFeatures.set(rfKey, {
        Rol: r.Rol,
        FeatureCode: r.FeatureCode || '(sin features)',
        FeatureDescripcion: r.FeatureDescripcion || ''
      });
    }
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  return {
    usuarios: Array.from(usuarios.values()).sort((a, b) => cmp(a.Usuario, b.Usuario)),
    usuariosRoles: Array.from(usuariosRoles.values()).sort((a, b) => cmp(a.Usuario, b.Usuario) || cmp(a.Rol, b.Rol)),
    rolesFeatures: Array.from(rolesFeatures.values()).sort((a, b) => cmp(a.Rol, b.Rol) || cmp(a.FeatureCode, b.FeatureCode))
  };
}

function buildSheetsUsuariosInternosDucsa(data) {
  return {
    'Usuarios': (data && data.usuarios) || [],
    'Usuarios con roles': (data && data.usuariosRoles) || [],
    'Roles y features': (data && data.rolesFeatures) || []
  };
}

async function runUsuariosInternosDucsa(env, opts, log) {
  const userTypeId = opts && opts.userTypeId;
  if (userTypeId === undefined || userTypeId === null || userTypeId === '') {
    throw new Error('Selecciona un tipo de usuario.');
  }

  const cfg = getReportesConfig().identityServer || {};
  const timeout = cfg.requestTimeoutMs || 30000;

  log && log('info', `Conectando a IdentityServer (${env})...`);
  const pool = await getPool(env);
  const m = loadSqlModule();

  log && log('info', `Ejecutando query de usuarios (UserTypeId = ${userTypeId})...`);
  const req = pool.request();
  req.timeout = timeout;
  req.input('userTypeId', m.Int, Number(userTypeId));

  let result;
  try {
    result = await req.query(QUERY_USUARIOS_INTERNOS_DUCSA);
  } catch (e) {
    logger.error('SQL reportes usuariosInternosDucsa fallo:', e && e.message);
    throw new Error('Consulta a IdentityServer fallo: ' + (e && e.message ? e.message : String(e)));
  }

  const rows = (result && result.recordset) || [];
  log && log('info', `${rows.length} fila(s) crudas obtenidas.`);

  const { usuarios, usuariosRoles, rolesFeatures } = buildSheetsData(rows);
  log && log('success',
    `Usuarios: ${usuarios.length} · Usuario-Rol: ${usuariosRoles.length} · Rol-Feature: ${rolesFeatures.length}.`);

  return {
    env,
    userTypeId: Number(userTypeId),
    counts: {
      'Filas crudas': rows.length,
      'Usuarios': usuarios.length,
      'Usuario-Rol': usuariosRoles.length,
      'Rol-Feature': rolesFeatures.length
    },
    usuarios,
    usuariosRoles,
    rolesFeatures
  };
}

/* ------------------------------ Reporte: comparar features entre roles ------------------------------ */

const QUERY_ROLES = `SELECT DISTINCT Name FROM ApplicationRoles ORDER BY Name;`;

async function getRoles(env) {
  const pool = await getPool(env);
  let result;
  try {
    result = await pool.request().query(QUERY_ROLES);
  } catch (e) {
    logger.error('SQL reportes getRoles fallo:', e && e.message);
    throw new Error('Consulta de roles a IdentityServer fallo: ' + (e && e.message ? e.message : String(e)));
  }
  const rows = (result && result.recordset) || [];
  return rows.map((r) => r.Name);
}

function buildRoleFeaturesQuery(hasRole2) {
  return `
    SELECT
      ar.Name AS Rol,
      rfc.Code AS FeatureCode,
      rfc.Description AS FeatureDescripcion
    FROM ApplicationRoles ar
    LEFT JOIN (
      -- features otorgadas directamente al rol
      SELECT rf.RoleId AS ApplicationRoleId, f.FeatureId, f.Code, f.Description
      FROM RoleFeatures rf
      INNER JOIN Features f ON f.FeatureId = rf.FeatureId
      UNION
      -- features otorgadas al rol via grupo de features
      SELECT rfg.ApplicationRoleId, f.FeatureId, f.Code, f.Description
      FROM RoleFeatureGroups rfg
      INNER JOIN FeatureGroupFeatures fgf ON fgf.FeatureGroupsId = rfg.FeatureGroupsId
      INNER JOIN Features f ON f.FeatureId = fgf.FeatureId
    ) rfc ON rfc.ApplicationRoleId = ar.ApplicationRoleId
    WHERE ar.Name IN (@r1${hasRole2 ? ', @r2' : ''})
    ORDER BY rfc.Code, ar.Name;
  `;
}

// Un solo rol -> listado simple de sus features (no arma comparativa).
// Dos roles -> comparativa: features en ambos / solo en cada uno.
async function runCompararRolesFeatures(env, opts, log) {
  const role1 = String((opts && opts.role1) || '').trim();
  const role2 = String((opts && opts.role2) || '').trim();
  if (!role1) throw new Error('Selecciona el Rol A.');
  if (role2 && role2 === role1) throw new Error('Rol A y Rol B no pueden ser el mismo rol.');

  const cfg = getReportesConfig().identityServer || {};
  const timeout = cfg.requestTimeoutMs || 30000;

  log && log('info', `Conectando a IdentityServer (${env})...`);
  const pool = await getPool(env);
  const m = loadSqlModule();

  log && log('info', role2
    ? `Comparando features: "${role1}" vs "${role2}"...`
    : `Listando features de "${role1}"...`);

  const req = pool.request();
  req.timeout = timeout;
  req.input('r1', m.NVarChar, role1);
  if (role2) req.input('r2', m.NVarChar, role2);

  let result;
  try {
    result = await req.query(buildRoleFeaturesQuery(!!role2));
  } catch (e) {
    logger.error('SQL reportes compararRolesFeatures fallo:', e && e.message);
    throw new Error('Consulta a IdentityServer fallo: ' + (e && e.message ? e.message : String(e)));
  }

  const rows = (result && result.recordset) || [];
  const rolesFound = new Set(rows.map((r) => r.Rol));
  if (!rolesFound.has(role1)) {
    throw new Error(`El rol "${role1}" no existe en ApplicationRoles (o no tiene ninguna fila).`);
  }
  if (role2 && !rolesFound.has(role2)) {
    throw new Error(`El rol "${role2}" no existe en ApplicationRoles (o no tiene ninguna fila).`);
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const featuresOf = (roleName) => {
    const map = new Map();
    for (const r of rows) {
      if (r.Rol !== roleName || !r.FeatureCode) continue;
      if (!map.has(r.FeatureCode)) {
        map.set(r.FeatureCode, { FeatureCode: r.FeatureCode, FeatureDescripcion: r.FeatureDescripcion || '' });
      }
    }
    return Array.from(map.values()).sort((a, b) => cmp(a.FeatureCode, b.FeatureCode));
  };

  const role1Features = featuresOf(role1);

  if (!role2) {
    log && log('success', `"${role1}": ${role1Features.length} feature(s).`);
    return {
      env,
      mode: 'single',
      role1,
      role2: null,
      counts: { [`Features (${role1})`]: role1Features.length },
      role1Features
    };
  }

  const role2Features = featuresOf(role2);
  const set1 = new Set(role1Features.map((f) => f.FeatureCode));
  const set2 = new Set(role2Features.map((f) => f.FeatureCode));
  const descByCode = new Map();
  [...role1Features, ...role2Features].forEach((f) => {
    if (!descByCode.has(f.FeatureCode)) descByCode.set(f.FeatureCode, f.FeatureDescripcion);
  });

  const ambos = [];
  const soloRole1 = [];
  const soloRole2 = [];
  const allCodes = Array.from(new Set([...set1, ...set2])).sort();
  for (const code of allCodes) {
    const entry = { FeatureCode: code, FeatureDescripcion: descByCode.get(code) || '' };
    if (set1.has(code) && set2.has(code)) ambos.push(entry);
    else if (set1.has(code)) soloRole1.push(entry);
    else soloRole2.push(entry);
  }

  log && log('success',
    `"${role1}": ${role1Features.length} · "${role2}": ${role2Features.length} · ` +
    `En ambos: ${ambos.length} · Solo "${role1}": ${soloRole1.length} · Solo "${role2}": ${soloRole2.length}.`);

  return {
    env,
    mode: 'compare',
    role1,
    role2,
    counts: {
      [`Features ${role1}`]: role1Features.length,
      [`Features ${role2}`]: role2Features.length,
      'En ambos': ambos.length,
      [`Solo ${role1}`]: soloRole1.length,
      [`Solo ${role2}`]: soloRole2.length
    },
    role1Features,
    role2Features,
    ambos,
    soloRole1,
    soloRole2
  };
}

function buildSheetsCompararRolesFeatures(data) {
  if (!data || data.mode !== 'compare') {
    const role1 = (data && data.role1) || 'Rol';
    return { [`Features - ${role1}`]: (data && data.role1Features) || [] };
  }
  return {
    'Resumen': [
      { Rol: data.role1, Features: data.role1Features.length },
      { Rol: data.role2, Features: data.role2Features.length },
      { Rol: 'En ambos', Features: data.ambos.length },
      { Rol: `Solo ${data.role1}`, Features: data.soloRole1.length },
      { Rol: `Solo ${data.role2}`, Features: data.soloRole2.length }
    ],
    'En ambos': data.ambos,
    [`Solo ${data.role1}`]: data.soloRole1,
    [`Solo ${data.role2}`]: data.soloRole2
  };
}

/* ------------------------------ Registro de reportes ------------------------------ */

const REPORTS = [
  {
    id: 'usuariosInternosDucsa',
    title: 'Generar usuarios internos DUCSA con roles y features',
    description:
      'Lista los usuarios de IdentityServer del tipo elegido (ej. "Interno - Ducsa") junto a sus roles y las ' +
      'features asociadas a cada rol (directas o via grupo de features). Exporta un Excel con 3 hojas: ' +
      'Usuarios, Usuarios con roles y Roles y features.',
    async getParams(env) {
      const userTypes = await getUserTypes(env);
      return { userTypes };
    },
    run: runUsuariosInternosDucsa,
    buildSheets: buildSheetsUsuariosInternosDucsa
  },
  {
    id: 'compararRolesFeatures',
    title: 'Comparar features entre roles (1 vs 1)',
    description:
      'Elegi un Rol A y, opcionalmente, un Rol B (ApplicationRoles de IdentityServer). Si dejas Rol B en ' +
      '"Ninguno" solo lista las features del Rol A; si elegis los dos arma la comparativa: features en ambos, ' +
      'solo en Rol A y solo en Rol B. Exporta un Excel con esas hojas.',
    async getParams(env) {
      const roles = await getRoles(env);
      return { roles };
    },
    run: runCompararRolesFeatures,
    buildSheets: buildSheetsCompararRolesFeatures
  }
];

function listReports() {
  return REPORTS.map(({ id, title, description }) => ({ id, title, description }));
}

// Parametros disponibles para elegir antes de ejecutar (hoy: lista de UserTypes).
// Reportes sin getParams devuelven {} (no requieren seleccion previa).
async function getReportParams(reportId, envRaw) {
  const report = REPORTS.find((r) => r.id === reportId);
  if (!report) throw new Error(`Reporte desconocido: ${reportId}`);
  const env = ENVS.includes(envRaw) ? envRaw : 'Produccion';
  if (!report.getParams) return {};
  return report.getParams(env);
}

async function runReport(reportId, envRaw, opts, log) {
  const report = REPORTS.find((r) => r.id === reportId);
  if (!report) throw new Error(`Reporte desconocido: ${reportId}`);
  const env = ENVS.includes(envRaw) ? envRaw : 'Produccion';
  return report.run(env, opts || {}, log);
}

// Nombre de hoja valido para Excel: sin caracteres prohibidos, <=31 chars, sin
// colisionar con uno ya usado en el mismo libro.
function sheetName(base, used) {
  let s = String(base || 'Hoja').replace(/[\\/*?[\]:]/g, ' ').trim() || 'Hoja';
  if (s.length > 31) s = s.slice(0, 31);
  let candidate = s;
  let i = 2;
  while (used.has(candidate)) {
    const suffix = ` ${i}`;
    candidate = s.slice(0, 31 - suffix.length) + suffix;
    i++;
  }
  used.add(candidate);
  return candidate;
}

// Arma el .xlsx a partir de las hojas que declara cada reporte (buildSheets),
// usando los datos ya obtenidos por runReport (no vuelve a consultar la base).
function exportReport(reportId, data, filePath) {
  const XLSX = require('xlsx');
  const report = REPORTS.find((r) => r.id === reportId);
  if (!report) throw new Error(`Reporte desconocido: ${reportId}`);

  const sheets = report.buildSheets(data || {});
  const wb = XLSX.utils.book_new();
  const used = new Set();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.json_to_sheet(rows || []);
    XLSX.utils.book_append_sheet(wb, ws, sheetName(name, used));
  }
  XLSX.writeFile(wb, filePath);
  return { path: filePath };
}

module.exports = {
  listReports,
  listEnvs,
  getReportParams,
  runReport,
  exportReport
};
