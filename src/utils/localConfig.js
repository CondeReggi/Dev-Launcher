'use strict';

/**
 * Resuelve un archivo de config local con fallback a su plantilla committeada:
 *   src/config/<name>.config.js          (gitignored, datos reales de esta maquina)
 *   src/config/<name>.config.example.js  (en el repo, valores de ejemplo)
 *
 * Asi un clon recien hecho arranca sin errores usando la plantilla; para usar
 * datos reales se copia el .example.js a .config.js y se completa.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.resolve(__dirname, '..', 'config');

function resolveConfigPath(name) {
  const real = path.join(CONFIG_DIR, `${name}.config.js`);
  if (fs.existsSync(real)) return real;
  const example = path.join(CONFIG_DIR, `${name}.config.example.js`);
  if (fs.existsSync(example)) return example;
  throw new Error(`Falta src/config/${name}.config.js (y no hay plantilla ${name}.config.example.js).`);
}

function loadConfig(name, { fresh = false } = {}) {
  const p = resolveConfigPath(name);
  if (fresh) delete require.cache[require.resolve(p)];
  return require(p);
}

module.exports = { resolveConfigPath, loadConfig };
