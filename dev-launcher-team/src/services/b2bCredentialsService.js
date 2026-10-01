'use strict';

/**
 * B2B Credentials flow:
 *   1) ROPC token request to Azure AD B2C (tokenUrl)
 *      grant_type=password, scope, client_id, username, password
 *      If config.clientSecret is non-empty, send Basic Auth (confidential client).
 *   2) Decode the access_token, extract emails[0].
 *   3) POST to loginUrl with { user: <email>, token: <access_token> } -> returns
 *      { token, tokenQr, codigoVerificacion, usuarioAceptaTerminos }.
 *
 * Returns both raw tokens plus their decoded payloads for inspection in the UI.
 */
const configService = require('./configService');

function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function getEnvCfg(env) {
  const all = configService.getEffective().b2bCredentials;
  if (!all) throw new Error('Falta sendQr.config.js -> b2bCredentials.');
  const cfg = all[env];
  if (!cfg) throw new Error(`Ambiente desconocido: ${env}. Esperado 'Testing' o 'Produccion'.`);
  return cfg;
}

function listEnvs() {
  const all = configService.getEffective().b2bCredentials || {};
  const envs = Object.keys(all).filter(k => k !== 'defaultEnv');
  return {
    envs,
    defaultEnv: all.defaultEnv || envs[0] || 'Testing',
    summaries: envs.reduce((acc, e) => {
      const c = all[e];
      acc[e] = {
        tokenUrl: c.tokenUrl,
        loginUrl: c.loginUrl,
        clientId: c.clientId,
        username: c.username,
        password: c.password
      };
      return acc;
    }, {})
  };
}

async function getCredentials(opts, log) {
  const env = (opts && opts.env) || configService.getEffective().b2bCredentials.defaultEnv;
  const cfg = getEnvCfg(env);

  const username = (opts && opts.username) || cfg.username;
  const password = (opts && opts.password) || cfg.password;
  if (!username || !password) throw new Error('Usuario y password son requeridos.');

  /* ---------------- Step 1: B2C ROPC token ---------------- */

  const body = new URLSearchParams({
    grant_type: 'password',
    scope: cfg.scope,
    client_id: cfg.clientId,
    username,
    password
  });

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cfg.clientSecret && cfg.clientSecret.length) {
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  }

  log && log('info', `[1/2] POST ${cfg.tokenUrl} (B2C ROPC, env=${env}, user=${username})`);

  let tokRes;
  try {
    tokRes = await fetch(cfg.tokenUrl, { method: 'POST', headers, body });
  } catch (e) {
    throw new Error(`B2C network error: ${e.message}`);
  }
  const tokJson = await tokRes.json().catch(() => ({}));
  if (!tokRes.ok || !tokJson.access_token) {
    const desc = tokJson.error_description || tokJson.error || `HTTP ${tokRes.status}`;
    throw new Error(`B2C token fallo: ${desc}`);
  }
  const accessToken = tokJson.access_token;
  log && log('success', `B2C access_token recibido (len=${accessToken.length}).`);

  const b2cPayload = decodeJwt(accessToken);
  const emails = b2cPayload && Array.isArray(b2cPayload.emails) ? b2cPayload.emails : [];
  const email = emails[0];
  if (!email) {
    throw new Error('El access_token no contiene "emails" o esta vacio.');
  }
  log && log('info', `Email extraido del JWT: ${email}`);

  /* ---------------- Step 2: Auth/login ---------------- */

  log && log('info', `[2/2] POST ${cfg.loginUrl} (Auth/login, user=${email})`);

  let loginRes;
  try {
    loginRes = await fetch(cfg.loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: email, token: accessToken })
    });
  } catch (e) {
    throw new Error(`Login network error: ${e.message}`);
  }
  const loginText = await loginRes.text();
  let loginJson;
  try { loginJson = JSON.parse(loginText); } catch { loginJson = null; }

  if (!loginRes.ok) {
    throw new Error(`Auth/login fallo: HTTP ${loginRes.status} - ${loginText.slice(0, 200)}`);
  }
  if (!loginJson) {
    throw new Error(`Auth/login: respuesta no es JSON. Body: ${loginText.slice(0, 200)}`);
  }

  log && log('success', 'Auth/login exitoso.');

  return {
    env,
    email,
    b2c: {
      accessToken,
      payload: b2cPayload,
      tokenType: tokJson.token_type || null,
      expiresIn: tokJson.expires_in || null,
      idToken: tokJson.id_token || null,
      refreshToken: tokJson.refresh_token || null
    },
    api: {
      token: loginJson.token || null,
      payload: decodeJwt(loginJson.token),
      tokenQr: loginJson.tokenQr || null,
      codigoVerificacion: loginJson.codigoVerificacion || null,
      usuarioAceptaTerminos: loginJson.usuarioAceptaTerminos
    },
    raw: { tokJson, loginJson }
  };
}

module.exports = { getCredentials, listEnvs, decodeJwt };
