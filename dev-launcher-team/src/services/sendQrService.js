'use strict';

/**
 * Port of C:\Users\YOUR_USER\source\repos\SendQrRequest\SendQrRequest\Program.cs + Helpers.
 *
 * Each operation accepts:
 *   options - per-call overrides (file paths, env, etc)
 *   log(kind, message) - streams progress messages back to the renderer
 *
 * All HTTP uses the global fetch() available in Node 18+.
 */
const path = require('path');
const configService = require('./configService');
const { decrypt } = require('../utils/aesCbc');
const { readColumn, readUsuarios, readTextFile } = require('../utils/excelReader');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Always pull the latest effective config (defaults + overrides) at each call.
const getCfg = () => configService.getEffective();

function pick(override, base) {
  return Object.assign({}, base, override || {});
}

/* ============================================================
 * Token flows
 * ============================================================ */

/**
 * Password flow. Replicates Startup.IdentityServerClient.GetTokenAsync().
 * Discovery -> POST /connect/token with grant_type=password.
 */
async function getAuthPasswordToken(log) {
  const auth = getCfg().auth;
  let clientSecret;
  try {
    clientSecret = decrypt(auth.clientSecretEncrypted);
  } catch (e) {
    throw new Error(`No se pudo descifrar auth.clientSecretEncrypted: ${e.message}`);
  }

  // Discovery (well-known)
  const discoUrl = auth.authority.replace(/\/+$/, '') + '/.well-known/openid-configuration';
  log && log('info', `GET ${discoUrl}`);
  const discoRes = await fetch(discoUrl);
  if (!discoRes.ok) throw new Error(`Discovery fallo: HTTP ${discoRes.status}`);
  const disco = await discoRes.json();
  const tokenEndpoint = disco.token_endpoint;
  if (!tokenEndpoint) throw new Error('Discovery sin token_endpoint');

  // Token request (password grant)
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: auth.clientId,
    client_secret: clientSecret,
    username: auth.username,
    password: auth.password,
    scope: auth.scopes
  });

  log && log('info', `POST ${tokenEndpoint} (password grant)`);
  const tokRes = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const tokJson = await tokRes.json().catch(() => ({}));
  if (!tokRes.ok || !tokJson.access_token) {
    throw new Error(`Token fallo: ${tokJson.error || tokRes.status} - ${tokJson.error_description || ''}`);
  }
  return tokJson.access_token;
}

/**
 * Test-token endpoint. Mirrors GetTokenToTransaccional().
 */
async function getTestTokenTransaccional(log, opts) {
  const url = (opts && opts.tokenUrl) || getCfg().convenios.tokenUrl;
  log && log('info', `GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token transaccional fallo: HTTP ${res.status}`);
  return (await res.text()).trim().replace(/^"|"$/g, '');
}

/**
 * Client credentials flow. Mirrors IdentityHelpers.ObtenerTokenAsync().
 */
async function getClientCredentialsToken(envCfg, log) {
  log && log('info', `POST ${envCfg.tokenUrl} (client_credentials)`);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: envCfg.clientId,
    client_secret: envCfg.clientSecret,
    scope: envCfg.scope
  });
  const res = await fetch(envCfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Token fallo: ${json.error || res.status} - ${json.error_description || ''}`);
  }
  return json.access_token;
}

/**
 * Construye el curl equivalente al request de introspect, para mostrarlo en el log.
 */
function buildIntrospectCurl(url, basic, token) {
  return [
    `curl --location '${url}'`,
    `--header 'Content-Type: application/x-www-form-urlencoded'`,
    `--header 'Authorization: Basic ${basic}'`,
    `--data-urlencode 'token=${token}'`
  ].join(' \\\n  ');
}

/**
 * Token introspection. Mirrors IdentityHelpers.ValidarTokenConIntrospectionAsync().
 */
async function introspectToken(token, envCfg, log) {
  const url = envCfg.issuer.replace(/\/+$/, '') + '/connect/introspect';
  log && log('info', `POST ${url} (introspect)`);

  const basic = Buffer.from(`${envCfg.scope}:${envCfg.apiSecret}`).toString('base64');
  log && log('info', `Curl equivalente:\n${buildIntrospectCurl(url, basic, token)}`);
  const body = new URLSearchParams({ token });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`
    },
    body
  });

  if (res.status === 401) {
    log && log('error', 'Introspect respondio 401 (Unauthorized).');
    return false;
  }
  const json = await res.json().catch(() => ({}));
  return json && json.active === true;
}

/* ============================================================
 * Operacion 1: Procesar QR
 * ============================================================ */

async function processQr(opts, log) {
  const cfg = pick(opts, getCfg().qr);
  const filePath = path.join(cfg.rutaExcel, cfg.nombreArchivo);
  log('info', `Leyendo Excel: ${filePath} (columna ${cfg.columnaQr})`);
  const qrs = readColumn(filePath, cfg.columnaQr);
  log('info', `Encontrados ${qrs.length} QRs.`);

  let token;
  try {
    log('info', 'Obteniendo token (password flow)...');
    token = await getAuthPasswordToken(log);
    log('success', 'Token obtenido.');
  } catch (e) {
    log('error', `No se pudo obtener token: ${e.message}`);
    throw e;
  }

  const url = cfg.urlBaseServices.replace(/\/+$/, '') + '/api/OrdenPago/v3/Qr';
  let okCount = 0, errCount = 0;

  for (let i = 0; i < qrs.length; i++) {
    const parametro = qrs[i];
    log('info', `[${i + 1}/${qrs.length}] POST ${url} - param=${parametro}`);

    // The original C# wraps the body as a stringified JSON inside a string (double-encoded).
    // Replicating that exact behavior:
    const innerJson = JSON.stringify({ qr: `https://ducsa.uy/${parametro}/` });
    const wrappedBody = JSON.stringify(innerJson);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: wrappedBody
      });
    } catch (e) {
      log('error', `Excepcion: ${e.message}`);
      errCount++;
      await sleep(cfg.delaySeconds * 1000);
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      log('success', `OK: ${text.slice(0, 200)}`);
      okCount++;
    } else if (res.status === 401) {
      log('warn', '401 - refrescando token y reintentando...');
      try {
        token = await getAuthPasswordToken(log);
        const retry = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: wrappedBody
        });
        if (retry.ok) { okCount++; log('success', 'OK (retry)'); }
        else { errCount++; log('error', `Retry fallo: HTTP ${retry.status}`); }
      } catch (e) {
        errCount++;
        log('error', `Retry fallo: ${e.message}`);
      }
    } else {
      errCount++;
      log('error', `HTTP ${res.status}`);
    }

    await sleep(cfg.delaySeconds * 1000);
  }

  log('done', `Listo. OK=${okCount} ERR=${errCount} TOTAL=${qrs.length}`);
}

/* ============================================================
 * Operacion 2: Procesar Entidades
 *
 * NOTA: el C# original tiene un comportamiento extrano - reescribe `datos` en cada
 * iteracion del foreach pero el POST esta FUERA del loop. Es decir, solo envia la
 * ULTIMA entidad. Replicamos ese comportamiento por defecto. Si pasas opts.sendAll=true
 * enviamos cada entidad como una llamada (probablemente la intencion).
 * ============================================================ */

async function processEntidades(opts, log) {
  const cfg = pick(opts, getCfg().entidades);
  const filePath = path.join(cfg.rutaWord, cfg.nombreArchivoTxt);
  log('info', `Leyendo TXT: ${filePath}`);
  const contenido = readTextFile(filePath).trim();
  if (!contenido) {
    log('warn', 'Archivo vacio. Nada para procesar.');
    return;
  }
  const lista = contenido.split(',').map(s => s.trim()).filter(Boolean);
  log('info', `Entidades parseadas: ${lista.length}`);

  const url = cfg.urlIntegrador.replace(/\/+$/, '') + '/' + cfg.endpoint.replace(/^\/+/, '');
  const sendAll = !!opts.sendAll;

  if (!sendAll && lista.length > 1) {
    log('warn', `Modo legacy: solo se enviara la ULTIMA entidad ("${lista[lista.length - 1]}") replicando el bug del C# original. Activa "Enviar todas" si queres llamar a cada una.`);
  }

  const buildPayload = (entidad) => ({
    Entidades: [{
      TipoEntidadId: cfg.tipoEntidadId,
      Identificador: entidad,
      Codigo: entidad,
      FechaHoraCambioEnOrigen: new Date().toISOString().replace('T', ' ').slice(0, 19),
      Eliminado: cfg.eliminado,
      Datos: JSON.stringify(cfg.datosFijos)
    }],
    Concesionarios: []
  });

  const target = sendAll ? lista : [lista[lista.length - 1]];

  let ok = 0, err = 0;
  for (let i = 0; i < target.length; i++) {
    const entidad = target[i];
    const payload = buildPayload(entidad);
    log('info', `[${i + 1}/${target.length}] POST ${url} - entidad=${entidad}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const text = await res.text();
        log('success', `OK: ${text.slice(0, 200)}`);
        ok++;
      } else {
        const text = await res.text().catch(() => '');
        log('error', `HTTP ${res.status} - ${text.slice(0, 200)}`);
        err++;
      }
    } catch (e) {
      log('error', `Excepcion: ${e.message}`);
      err++;
    }
    if (i < target.length - 1) await sleep(cfg.delaySeconds * 1000);
  }

  log('done', `Listo. OK=${ok} ERR=${err} TOTAL=${target.length}`);
}

/* ============================================================
 * Operacion 3: Convenios por Cedula
 * ============================================================ */

async function processConvenios(opts, log) {
  const cfg = pick(opts, getCfg().convenios);
  const filePath = path.join(cfg.rutaExcelCedula, cfg.nombreArchivoCedula);
  log('info', `Leyendo Excel: ${filePath} (columna ${cfg.columnaCedula})`);
  const cedulas = readColumn(filePath, cfg.columnaCedula);
  log('info', `Cedulas encontradas: ${cedulas.length}`);

  log('info', 'Obteniendo token transaccional (test-token)...');
  let token;
  try {
    token = await getTestTokenTransaccional(log, cfg);
    log('success', `Token obtenido (len=${token.length})`);
  } catch (e) {
    log('error', `No se pudo obtener token: ${e.message}`);
    throw e;
  }

  const baseUrl = cfg.urlBaseServicesTransaccional.replace(/\/+$/, '');
  const conRegistros = [];

  for (let i = 0; i < cedulas.length; i++) {
    const cedula = cedulas[i];
    const url = `${baseUrl}/api.servicios/api/App-conv/ListarConveniosDocumento?TipoDocumento=CI&Documento=${encodeURIComponent(cedula)}&Empresa&idConvenio&Matricula`;
    log('info', `[${i + 1}/${cedulas.length}] GET cedula=${cedula}`);

    try {
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        const tiene = Array.isArray(json && json.tarjetVirtualCamion) && json.tarjetVirtualCamion.length > 0;
        log(tiene ? 'success' : 'info', `cedula ${cedula}: ${tiene ? 'Tiene registros' : 'Sin registros'}`);
        if (tiene) conRegistros.push(cedula);
      } else {
        log('error', `HTTP ${res.status}`);
      }
    } catch (e) {
      log('error', `Excepcion: ${e.message}`);
    }
    await sleep(cfg.delaySeconds * 1000);
  }

  log('done', `Listo. Con registros: ${conRegistros.length}/${cedulas.length}. ${conRegistros.length ? 'Cedulas: ' + conRegistros.join(', ') : ''}`);
}

/* ============================================================
 * Operacion 4: Usuarios Azure (Concentrador)
 * ============================================================ */

function obtenerNombreApellido(displayName) {
  if (!displayName || !displayName.trim()) return ['NombrePorDefecto', 'ApellidoPorDefecto'];
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ['NombrePorDefecto', 'ApellidoPorDefecto'];
  if (parts.length === 1) return [parts[0], 'ApellidoPorDefecto'];
  if (parts.length === 2) return [parts[0], parts[1]];
  if (parts.length % 2 === 0) {
    const m = parts.length / 2;
    return [parts.slice(0, m).join(' '), parts.slice(m).join(' ')];
  }
  return [parts[0], parts.slice(1).join(' ')];
}

function getUserDisplayName(u) {
  if (!u || (!u.Nombre && !u.Apellido)) return 'Unknown Player';
  return `${(u.Nombre || '').trim()} ${(u.Apellido || '').trim()}`.trim();
}

async function processUsuarios(opts, log) {
  const cfg = pick(opts, getCfg().usuarios);
  const filePath = path.join(cfg.rutaExcelUsuarios, cfg.nombreArchivoUsuarios);
  log('info', `Leyendo Excel: ${filePath}`);
  const usuarios = readUsuarios(filePath);
  log('info', `Usuarios con Mail: ${usuarios.length}`);

  const url = cfg.urlBaseConcentrador.replace(/\/+$/, '') + '/' + cfg.endpoint.replace(/^\/+/, '');
  let ok = 0, err = 0;

  for (let i = 0; i < usuarios.length; i++) {
    const u = usuarios[i];
    const nickname = (u.Mail.split('@')[0]) || 'usuario';
    const displayName = getUserDisplayName(u);
    const [nombre, apellido] = obtenerNombreApellido(displayName);

    const requestBody = {
      DisplayName: displayName,
      MailNickname: nickname,
      EmailContacto: u.Mail,
      TipoDocumento: '1',
      Name: u.Nombre || nombre,
      Surname: u.Apellido || apellido,
      UserPrincipalName: u.Documento,
      Password: cfg.defaultPassword,
      Document: u.Documento,
      Phone: '',
      TenantId: cfg.tenantUsuarioChofer,
      NroConcesionario: '',
      Pista: false,
      Chofer: true
    };

    log('info', `[${i + 1}/${usuarios.length}] POST ${url} - mail=${u.Mail}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.bearerToken}`,
          'apiClientSecret': cfg.apiClientSecret
        },
        body: JSON.stringify(requestBody)
      });
      if (res.ok) {
        log('success', `Usuario creado: ${u.Mail}`);
        ok++;
      } else {
        const text = await res.text().catch(() => '');
        log('error', `Error ${u.Mail} / HTTP ${res.status} - ${text.slice(0, 200)}`);
        err++;
      }
    } catch (e) {
      log('error', `Excepcion: ${e.message}`);
      err++;
    }

    await sleep(cfg.delaySeconds * 1000);
  }

  log('done', `Listo. OK=${ok} ERR=${err} TOTAL=${usuarios.length}`);
}

/* ============================================================
 * Operacion 5: Validar Credenciales Transaccional - Identity
 * ============================================================ */

async function validateIdentity(opts, log) {
  const config = getCfg();
  const env = (opts && opts.env) || config.identity.defaultEnv;
  const envCfg = config.identity[env];
  if (!envCfg) throw new Error(`Ambiente desconocido: ${env}. Esperado 'Testing' o 'Produccion'.`);

  log('info', `Ambiente: ${env} (${envCfg.issuer})`);

  let token;
  try {
    token = await getClientCredentialsToken(envCfg, log);
    log('success', `Token obtenido (len=${token.length}).`);
  } catch (e) {
    log('error', `No se pudo obtener token: ${e.message}`);
    throw e;
  }

  const valido = await introspectToken(token, envCfg, log);
  if (valido) {
    log('done', 'El token es VALIDO (active=true).');
  } else {
    log('done', 'El token NO es valido (active=false o introspect rechazo).');
  }
  return valido;
}

/* ============================================================
 * Operacion 6: Validar Token Magento - Introspect
 * ============================================================ */

async function validateMagento(opts, log) {
  const config = getCfg();
  const base = config.magento[config.magento.defaultEnv] || {};

  // Los tres datos son configurables per-run; si el campo viene vacio se usa el default de config.
  const envCfg = {
    issuer:    (opts && opts.issuer)    ? String(opts.issuer).trim()    : base.issuer,
    scope:     (opts && opts.scope)     ? String(opts.scope).trim()     : base.scope,
    apiSecret: (opts && opts.apiSecret) ? String(opts.apiSecret).trim() : base.apiSecret
  };
  const token = ((opts && opts.token) || '').trim();

  if (!envCfg.issuer)    throw new Error('Falta el issuer.');
  if (!envCfg.scope)     throw new Error('Falta el scope (usuario del Basic).');
  if (!envCfg.apiSecret) throw new Error('Falta el apiSecret (password del Basic).');
  if (!token)            throw new Error('Falta el token a validar.');

  log('info', `Magento introspect contra ${envCfg.issuer} (Basic ${envCfg.scope}:***).`);

  const valido = await introspectToken(token, envCfg, log);
  if (valido) {
    log('done', 'El token Magento es VALIDO (active=true).');
  } else {
    log('done', 'El token Magento NO es valido (active=false o introspect rechazo).');
  }
  return valido;
}

/* ============================================================
 * Public API
 * ============================================================ */

function getDefaults() {
  const config = getCfg();
  return {
    qr: config.qr,
    entidades: config.entidades,
    convenios: { ...config.convenios },
    usuarios: { ...config.usuarios,
      bearerTokenPreview: (config.usuarios.bearerToken || '').slice(0, 30) + '...',
      bearerToken: undefined
    },
    identity: {
      defaultEnv: config.identity.defaultEnv,
      envs: ['Testing', 'Produccion'],
      Testing: { issuer: config.identity.Testing.issuer, scope: config.identity.Testing.scope },
      Produccion: { issuer: config.identity.Produccion.issuer, scope: config.identity.Produccion.scope }
    },
    magento: {
      // Pre-carga los campos editables de la card con el ambiente por defecto.
      ...(config.magento[config.magento.defaultEnv] || {})
    }
  };
}

module.exports = {
  getDefaults,
  processQr,
  processEntidades,
  processConvenios,
  processUsuarios,
  validateIdentity,
  validateMagento
};
