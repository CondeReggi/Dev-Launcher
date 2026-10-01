'use strict';

/**
 * Plexo card management (listar / eliminar instrumentos de un cliente).
 *
 * Port del flujo C# `App.Payments.Plexo.PlexoExportedServices` usado por el endpoint
 * `POST api/MediosPago/Eliminar/Tarjeta/Plexo` del backoffice (DeletePlexoCoso):
 *   - ListClientCardsAsync(Type, MetaReference)  -> POST {baseUrl}/Instruments
 *   - DeleteInstrumentAsync(InstrumentToken, MetaReference) -> POST {baseUrl}/Instruments/Delete
 *
 * Cada request se firma DOS veces con la clave privada del certificado del store de Windows
 * (LocalMachine\My, thumbprint en config):
 *   1) Firma del cuerpo: SignedObject { Fingerprint, Object, UTCUnixTimeExpiration } se
 *      canonicaliza (sin nulls, claves ordenadas ordinal, compacto) y se firma RSA-SHA512/PKCS1.
 *      El base64 va en el campo `Signature` del wrapper enviado.
 *   2) Firma del header `Digital-Sign`: el JSON final completo se firma RSA-SHA1/PKCS1.
 *
 * Como Node no accede al store de Windows ni a la clave privada (que suele ser no exportable),
 * la firma se delega a powershell.exe via -EncodedCommand (mismo patron que utils/adminLauncher.js).
 * Esto reproduce exactamente SignatureHelper.SignWithCertificate y CertificateProcessor.SignData.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const configService = require('./configService');
const mediosPago = require('./mediosPagoService');

/* ----------------------------- Config ----------------------------- */

// Config por ambiente (mismo patron que b2bCredentialsService/graphUsersService): cada
// ambiente vive en configService.getEffective().plexo[env], con forma
// { certificateThumbprint, netId, baseUrl, commerceId }. `Testing` puede estar incompleto
// (DUCSA no tiene hoy un ambiente de pruebas de Plexo provisionado) -> listEnvs() lo marca
// como no configurado en vez de caer silenciosamente en credenciales de Produccion.

function getConfig(env) {
  const all = configService.getEffective().plexo || {};
  const p = all[env];
  if (!p) throw new Error(`Ambiente desconocido: ${env}. Esperado 'Testing' o 'Produccion'.`);
  return {
    certificateThumbprint: p.certificateThumbprint || '',
    netId: p.netId || '',
    baseUrl: (p.baseUrl || '').replace(/\/+$/, ''),
    commerceId: p.commerceId != null ? p.commerceId : ''
  };
}

function maskThumb(tp) {
  const s = String(tp || '');
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function listEnvs() {
  const all = configService.getEffective().plexo || {};
  const envs = Object.keys(all).filter(k => k !== 'defaultEnv');
  return {
    envs,
    defaultEnv: all.defaultEnv || envs[0] || 'Produccion',
    summaries: envs.reduce((acc, e) => {
      const c = all[e] || {};
      const configured = !!(c.certificateThumbprint && c.netId && c.baseUrl && c.commerceId !== '' && c.commerceId != null);
      acc[e] = {
        netId: c.netId || '',
        baseUrl: c.baseUrl || '',
        commerceId: c.commerceId != null ? c.commerceId : '',
        thumbprintMasked: maskThumb(c.certificateThumbprint),
        configured
      };
      return acc;
    }, {})
  };
}

/* ----------------------- JSON canonicalization ----------------------- */
/* Reproduce App.Payments.Plexo.Utils.JsonCanonicalizer:
 *   NullValueHandling.Ignore + claves ordenadas alfabeticamente (ordinal) recursivo + compacto. */

/**
 * Marca un valor como `decimal` de C# (Newtonsoft) para que se serialice igual que el
 * JsonCanonicalizer del backoffice. Ese canonicalizer hace
 * `JsonConvert.SerializeObject(typed)` -> `JObject.Parse` (el numero pasa a double) ->
 * `SerializeObject`, asi que un decimal entero queda como "1440.0" y uno fraccionario con
 * la representacion mas corta del double (igual que JS). Sin esto JS serializa 1440 como
 * "1440" y la firma RSA-SHA512 del cuerpo NO coincide (el server espera "Amount":1440.0).
 * Solo aplica a campos decimal (ej. RefundRequestDetail.Amount); los int/long (Type,
 * UTCUnixTimeExpiration) van sin ".0".
 */
class PlexoDecimal {
  constructor(value) { this.value = Number(value); }
}
function decimal(value) { return new PlexoDecimal(value); }

function formatDecimal(n) {
  if (!Number.isFinite(n)) throw new Error(`Valor decimal invalido para Plexo: ${n}`);
  // Newtonsoft serializa el double: entero -> "x.0"; no entero -> shortest round-trip
  // (mismo algoritmo que Number.prototype.toString en JS para el mismo IEEE754).
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * Serializa `value` a JSON canonico identico al JsonCanonicalizer del backoffice:
 * NullValueHandling.Ignore (se filtran null/undefined en objetos) + claves ordenadas
 * ordinal (recursivo) + compacto, con los PlexoDecimal emitidos como numero crudo.
 */
function canonicalStringify(value) {
  if (value instanceof PlexoDecimal) return formatDecimal(value.value);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const parts = Object.keys(value)
      .filter((k) => value[k] !== null && value[k] !== undefined)
      .sort() // code unit UTF-16 == ordinal para claves ASCII
      .map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k]));
    return '{' + parts.join(',') + '}';
  }
  if (typeof value === 'number') return String(value); // int/long: sin ".0"
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value); // strings (escaping identico a JSON)
}

function canonicalize(obj) {
  return canonicalStringify(obj);
}

/* --------------------------- Firma (PowerShell) --------------------------- */

const psEscape = (s) => String(s).replace(/'/g, "''");

/**
 * Firma `dataBuffer` con la clave privada RSA del certificado (LocalMachine\My) usando
 * el algoritmo indicado ('SHA1' | 'SHA512') y padding PKCS1. Devuelve el base64.
 */
function signWithCert(dataBuffer, algo, thumbprint) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(
      os.tmpdir(),
      `plexo-sign-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`
    );

    try {
      fs.writeFileSync(tmpFile, dataBuffer);
    } catch (e) {
      return reject(new Error(`No se pudo escribir el archivo temporal de firma: ${e.message}`));
    }

    const psCommand = `
$ErrorActionPreference = 'Stop'
try {
  $tp = ('${psEscape(thumbprint)}' -replace '\\W','').ToUpperInvariant()
  $cert = Get-ChildItem Cert:\\LocalMachine\\My | Where-Object { $_.Thumbprint -eq $tp }
  if (-not $cert) { throw "No se encontro un certificado con thumbprint: $tp en LocalMachine\\My" }
  if (-not $cert.HasPrivateKey) { throw "El certificado $tp no tiene clave privada." }
  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
  if ($rsa -eq $null) { throw "No se pudo obtener la clave privada RSA del certificado." }
  $bytes = [System.IO.File]::ReadAllBytes('${psEscape(tmpFile)}')
  $hash = [System.Security.Cryptography.HashAlgorithmName]::${algo}
  $sig = $rsa.SignData($bytes, $hash, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  [Console]::Out.Write([Convert]::ToBase64String($sig))
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`.trim();

    const encoded = Buffer.from(psCommand, 'utf16le').toString('base64');

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ } };

    child.on('error', (err) => {
      cleanup();
      reject(new Error(`No se pudo invocar PowerShell para firmar: ${err.message}`));
    });
    child.on('close', (code) => {
      cleanup();
      if (code === 0 && stdout.trim()) return resolve(stdout.trim());
      reject(new Error(`Fallo la firma (${algo}): ${stderr.trim() || `PowerShell salio con codigo ${code}`}`));
    });
  });
}

/* ------------------------------ HTTP POST ------------------------------ */

async function post(urlSuffix, requestObject, cfg, log) {
  const signedObject = {
    Fingerprint: String(cfg.certificateThumbprint).toUpperCase(),
    Object: requestObject,
    UTCUnixTimeExpiration: Math.floor(Date.now() / 1000) + 300 // now + 5 min (igual que el C#)
  };

  const canonicalJson = canonicalize(signedObject);
  log && log('info', 'Firmando cuerpo (RSA-SHA512) con el certificado...');
  const signature = await signWithCert(Buffer.from(canonicalJson, 'utf8'), 'SHA512', cfg.certificateThumbprint);

  // El cuerpo embebe el MISMO canonicalJson que firmamos (asi el `Object` enviado es
  // byte-identico al firmado y los PlexoDecimal viajan como numero crudo, no como objeto).
  // El server re-parsea `Object` y re-canonicaliza para validar la firma RSA-SHA512.
  const jsonFinal = '{"Object":' + canonicalJson + ',"Signature":' + JSON.stringify(signature) + '}';

  log && log('info', 'Firmando header Digital-Sign (RSA-SHA1)...');
  const digitalSign = await signWithCert(Buffer.from(jsonFinal, 'utf8'), 'SHA1', cfg.certificateThumbprint);

  const url = `${cfg.baseUrl}${urlSuffix}`;
  log && log('info', `POST ${url}`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Digital-Sign': digitalSign },
      body: jsonFinal
    });
  } catch (e) {
    throw new Error(`Error de red contra Plexo: ${e.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Error en la solicitud a Plexo: HTTP ${res.status} - ${text.slice(0, 300)}`);
  }

  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Respuesta de Plexo no es JSON: ${text.slice(0, 300)}`); }

  return json;
}

/** Extrae el objeto interno { Response, ResultCode, ErrorMessage, I18NErrorMessages }. */
function inner(json) {
  return json && json.Object && json.Object.Object ? json.Object.Object : null;
}

function errorFrom(json) {
  const o = inner(json);
  if (!o) return 'Respuesta de Plexo sin objeto interno.';
  const i18n = o.I18NErrorMessages || {};
  return i18n.es || o.ErrorMessage || `ResultCode ${o.ResultCode}`;
}

function hasError(json) {
  const o = inner(json);
  if (!o) return true;
  if (o.ErrorMessage) return true;
  if (o.ResultCode !== 0 && o.ResultCode != null) return true;
  return false;
}

/* ------------------------------ Mapping ------------------------------ */

function fmtExpiration(unixSeconds) {
  if (!unixSeconds) return '';
  try {
    const d = new Date(Number(unixSeconds) * 1000);
    if (isNaN(d.getTime())) return '';
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yy = String(d.getUTCFullYear()).slice(-2);
    return `${mm}/${yy}`;
  } catch { return ''; }
}

/**
 * Detecta el tipo de medio de pago del instrumento: 'credito' | 'debito' | 'prepaga'.
 * Devuelve null si no se puede determinar (queda MedioPagoHabilitado = false).
 *
 * Plexo no expone un único campo estable para esto, así que probamos varios
 * candidatos y normalizamos (sin acentos, minúsculas) contra palabras conocidas.
 * El valor crudo se loguea en listCards para poder diagnosticar; si aparece una
 * representación nueva en los logs, agregala a TIPO_HINTS.
 */
const TIPO_HINTS = [
  { tipo: 'credito', needles: ['credit', 'credito'] },
  { tipo: 'debito',  needles: ['debit', 'debito'] },
  { tipo: 'prepaga', needles: ['prepaid', 'prepag', 'prepay'] }
];

function detectTipo(c) {
  c = c || {};
  const info = c.InstrumentInformation || {};
  // Campos donde Plexo puede indicar el tipo de tarjeta, en orden de preferencia.
  const candidates = [info.CardType, info.Type, c.Type, c.PaymentInstrumentType, info.PaymentType];
  let rawSeen = '';
  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    if (!rawSeen) rawSeen = String(raw);
    const s = String(raw).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const h of TIPO_HINTS) {
      if (h.needles.some((n) => s.includes(n))) return { tipo: h.tipo, raw: String(raw) };
    }
  }
  return { tipo: null, raw: rawSeen };
}

function mapInstrument(c) {
  c = c || {};
  const issuer = c.Issuer || {};
  const info = c.InstrumentInformation || {};
  const detected = detectTipo(c);
  return {
    instrumentToken: c.InstrumentToken || '',
    name: c.Name || '',
    status: c.Status,
    issuerId: issuer.Id,
    // En el modelo C# IssuerName tiene [JsonProperty("Issuer")], asi que en el JSON la marca
    // viene como Issuer.Issuer.
    issuerName: issuer.Issuer || issuer.IssuerName || '',
    bank: issuer.Bank || '',
    expirationUtc: c.InstrumentExpirationUTC,
    expiration: fmtExpiration(c.InstrumentExpirationUTC),
    cardType: info.CardType || '',
    cardIssuer: info.CardIssuer || '',
    firstName: info.FirstName || '',
    lastName: info.LastName || '',
    email: info.Email || '',
    // Issuer de Plexo (== PlexoMediosPago.Codigo). issuerId ya viene arriba; lo
    // exponemos también como string `issuer` para la grilla.
    issuer: issuer.Id != null ? String(issuer.Id) : '',
    // Tipo canónico detectado del instrumento ('credito'|'debito'|'prepaga'|null)
    // y el valor crudo que lo originó (para diagnóstico).
    tipoMedioPago: detected.tipo,
    tipoMedioPagoRaw: detected.raw || '',
    // Lo completa listCards tras validar contra la BD. Default seguro: false.
    medioPagoHabilitado: false,
    raw: c
  };
}

/* ------------------------------ API ------------------------------ */

/**
 * Lista las tarjetas (instrumentos) de un cliente en Plexo.
 * @param {{document: string, documentType?: number}} opts
 */
async function listCards(opts, log) {
  const env = (opts && opts.env) || configService.getEffective().plexo.defaultEnv;
  const cfg = getConfig(env);
  const document = (opts && opts.document || '').trim();
  if (!document) throw new Error('El documento es requerido.');
  const documentType = Number(opts && opts.documentType != null ? opts.documentType : 0) || 0;

  log && log('info', `Listando tarjetas Plexo para documento ${document} (Type=${documentType}, Client=${cfg.netId}, env=${env}).`);

  const requestObject = {
    Client: cfg.netId,
    Request: { Type: documentType, MetaReference: document }
  };

  const json = await post('/Instruments', requestObject, cfg, log);

  if (hasError(json)) {
    throw new Error(errorFrom(json));
  }

  const list = inner(json).Response;
  const cards = Array.isArray(list) ? list.map(mapInstrument) : [];
  log && log('success', `Plexo devolvio ${cards.length} tarjeta(s).`);

  await enrichWithMediosPago(cards, log);

  return { document, documentType, env, cards };
}

/**
 * Marca `medioPagoHabilitado` en cada tarjeta validando contra la BD APP
 * (MediosPago × TipoMedioPago × PlexoMediosPago). Una sola consulta para toda la
 * grilla; el match (issuer × tipo) se resuelve en memoria.
 *
 * No es fatal: si la BD no está disponible, las tarjetas igual se listan y quedan
 * con `medioPagoHabilitado = false` (se avisa en el log).
 *
 * Casos borde (todos -> medioPagoHabilitado = false):
 *   - issuer vacío/null o sin correspondencia en PlexoMediosPago.
 *   - tipo de tarjeta no determinable desde el instrumento.
 *   - medio de pago existe pero está deshabilitado.
 */
async function enrichWithMediosPago(cards, log) {
  if (!Array.isArray(cards) || !cards.length) return;

  let enabledMap = null;
  try {
    enabledMap = await mediosPago.getEnabledMap(log);
  } catch (e) {
    log && log('warn', `No se pudo validar medios de pago contra la BD: ${e.message}. Las tarjetas quedan como NO habilitadas.`);
  }

  for (const card of cards) {
    const issuer = card.issuer || '';
    const tipo = card.tipoMedioPago; // 'credito'|'debito'|'prepaga'|null
    let found = false;
    let enabled = false;

    if (enabledMap && issuer && tipo) {
      const key = `${issuer}|${tipo}`;
      found = enabledMap.has(key);
      enabled = found && enabledMap.get(key) === true;
    }
    card.medioPagoHabilitado = enabled;

    // Motivo del estado: el renderer lo usa para decidir si el "No" es accionable
    // (not_found -> INSERT, disabled -> UPDATE) o no (no_issuer / no_tipo / unchecked).
    let status;
    if (!enabledMap)   status = 'unchecked';
    else if (!issuer)  status = 'no_issuer';
    else if (!tipo)    status = 'no_tipo';
    else if (!found)   status = 'not_found';
    else               status = enabled ? 'enabled' : 'disabled';
    card.medioPagoStatus = status;

    const tipoTxt = tipo ? `${tipo} (crudo: "${card.tipoMedioPagoRaw || '∅'}")` : `no determinado (crudo: "${card.tipoMedioPagoRaw || '∅'}")`;
    let estado;
    if (status === 'unchecked')     estado = 'sin validar (BD no disponible)';
    else if (status === 'no_issuer') estado = 'issuer vacío -> no habilitado';
    else if (status === 'no_tipo')   estado = 'tipo no determinado -> no habilitado';
    else if (status === 'not_found') estado = 'sin correspondencia en MediosPago -> no habilitado';
    else                             estado = enabled ? 'HABILITADO' : 'existe pero deshabilitado';

    log && log('info',
      `Tarjeta "${card.issuerName || issuer || '?'}": issuer="${issuer || '∅'}", tipo=${tipoTxt}, ${estado}.`);
  }
}

/**
 * Elimina un instrumento (tarjeta) de Plexo.
 * @param {{token: string, document: string}} opts
 */
async function deleteCard(opts, log) {
  const env = (opts && opts.env) || configService.getEffective().plexo.defaultEnv;
  const cfg = getConfig(env);
  const token = (opts && opts.token || '').trim();
  const document = (opts && opts.document || '').trim();
  if (!token) throw new Error('El token del instrumento es requerido.');
  if (!document) throw new Error('El documento (MetaReference) es requerido.');

  log && log('info', `Eliminando instrumento ${token} (documento ${document})...`);

  const requestObject = {
    Client: cfg.netId,
    Request: { InstrumentToken: token, MetaReference: document, Type: 0 }
  };

  const json = await post('/Instruments/Delete', requestObject, cfg, log);

  if (hasError(json)) {
    throw new Error(errorFrom(json));
  }

  log && log('success', `Instrumento ${token} eliminado en Plexo.`);
  return { token, document, ok: true };
}

module.exports = {
  listEnvs,
  listCards,
  deleteCard,
  // Plumbing de gateway expuesto para que otros servicios Plexo (ej. devoluciones)
  // reutilicen la misma firma/canonicalizacion sin duplicarla.
  getConfig,
  post,
  inner,
  errorFrom,
  hasError,
  decimal
};
