'use strict';

/**
 * Mirrors the legacy SendQrRequest Utilities/AesEncryption.cs.
 * AES-256-CBC with fixed key/IV. The same key/IV is used to decrypt secrets stored in the
 * legacy appsettings.json (e.g. Auth.ClientSecret).
 *
 * Key/IV are NOT hardcoded: they live in the gitignored sendQr.config.js under
 * `aes: { keyBase64, ivBase64 }` (see sendQr.config.example.js).
 */
const crypto = require('crypto');

function keyMaterial() {
  // Lazy require: configService -> localConfig, no circular dependency at load time.
  const cfg = require('../services/configService').getEffective();
  const aes = cfg.aes || {};
  if (!aes.keyBase64 || !aes.ivBase64) {
    throw new Error('Falta aes.keyBase64 / aes.ivBase64 en src/config/sendQr.config.js.');
  }
  return {
    key: Buffer.from(aes.keyBase64, 'base64'),
    iv:  Buffer.from(aes.ivBase64, 'base64')
  };
}

function encrypt(plainText) {
  const { key, iv } = keyMaterial();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]).toString('base64');
}

function decrypt(cipherTextBase64) {
  const { key, iv } = keyMaterial();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const buf = Buffer.from(cipherTextBase64, 'base64');
  return Buffer.concat([decipher.update(buf), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
