'use strict';

/**
 * Reportes recurrentes: solapa que agrupa reportes ad-hoc contra bases de DUCSA,
 * exportables a Excel. Cada reporte declara su propia query/armado de datos; el
 * ambiente (Testing/Produccion) es el selector global de la app (envSelector.js),
 * igual que Credenciales B2B / Usuarios B2C / Plexo.
 *
 * Primer reporte: "Generar usuarios internos DUCSA con roles y features", contra la
 * base SQL Server IdentityServer. Query provista por el usuario (fuente de verdad
 * del esquema real): Users/UserTypes/UserClaims(ClaimType='role')/ApplicationRoles,
 * con las features de cada rol resueltas directo (RoleFeatures) o via grupo
 * (RoleFeatureGroups + FeatureGroupFeatures). El filtro por tipo de usuario
 * (UserTypeId, ej. 1 = "Interno - Ducsa") lo elige el usuario en la UI antes de
 * ejecutar: `getParams()` trae los tipos disponibles desde la tabla UserTypes.
 * Solo lectura: nunca escribe en la base.
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
      rawRows: rows.length,
      usuarios: usuarios.length,
      usuariosRoles: usuariosRoles.length,
      rolesFeatures: rolesFeatures.length
    },
    usuarios,
    usuariosRoles,
    rolesFeatures
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
    run: runUsuariosInternosDucsa
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

// Arma el .xlsx con las 3 hojas a partir de los datos ya obtenidos por runReport
// (no vuelve a consultar la base).
function exportReport(reportId, data, filePath) {
  const XLSX = require('xlsx');
  const report = REPORTS.find((r) => r.id === reportId);
  if (!report) throw new Error(`Reporte desconocido: ${reportId}`);

  const wb = XLSX.utils.book_new();
  const wsUsuarios = XLSX.utils.json_to_sheet(data.usuarios || []);
  const wsUsuariosRoles = XLSX.utils.json_to_sheet(data.usuariosRoles || []);
  const wsRolesFeatures = XLSX.utils.json_to_sheet(data.rolesFeatures || []);
  XLSX.utils.book_append_sheet(wb, wsUsuarios, 'Usuarios');
  XLSX.utils.book_append_sheet(wb, wsUsuariosRoles, 'Usuarios con roles');
  XLSX.utils.book_append_sheet(wb, wsRolesFeatures, 'Roles y features');
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
