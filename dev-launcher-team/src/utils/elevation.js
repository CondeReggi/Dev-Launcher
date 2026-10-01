'use strict';

/**
 * Deteccion de privilegios de administrador (Windows) y relanzado elevado de la app.
 *
 * La seccion "Tarjetas Plexo" firma con la clave privada de un certificado del store
 * LocalMachine\My; para garantizar el acceso a esa clave en cualquier maquina, la app
 * debe correr elevada. Estas utilidades permiten: (a) saber si el proceso actual es admin,
 * (b) relanzar la app con UAC.
 */

const { spawn } = require('child_process');
const { openAsAdmin } = require('./adminLauncher');
const logger = require('./logger');

let _cached = null; // null = sin determinar; el estado de elevacion no cambia en la vida del proceso.

/**
 * Resuelve true si el proceso actual corre como Administrador.
 * Resultado cacheado: el token de elevacion no cambia mientras el proceso vive.
 * @returns {Promise<boolean>}
 */
function isElevated() {
  if (_cached !== null) return Promise.resolve(_cached);

  return new Promise((resolve) => {
    if (process.platform !== 'win32') { _cached = false; return resolve(false); }

    const ps = "[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())"
      + ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))";
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    );

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => {
      logger.error('isElevated: no se pudo invocar PowerShell:', e.message);
      _cached = false;
      resolve(false);
    });
    child.on('close', () => {
      _cached = /true/i.test(out.trim());
      resolve(_cached);
    });
  });
}

/**
 * Calcula el ejecutable y argumentos para relanzar la MISMA app.
 * - Empaquetada: el exe propio + los args actuales.
 * - Dev (electron .): el binario de electron + la ruta del app + flags extra.
 */
function getRelaunchArgs() {
  const { app } = require('electron');
  if (app.isPackaged) {
    return { exe: process.execPath, args: process.argv.slice(1) };
  }
  const extra = process.argv.slice(2); // flags despues de la ruta del app (ej: --devtools)
  return { exe: process.execPath, args: [app.getAppPath(), ...extra] };
}

/**
 * Relanza la app elevada (UAC). Si el usuario acepta, cierra la instancia actual.
 * Lanza error si el usuario cancela el UAC.
 * @returns {Promise<void>}
 */
async function relaunchAsAdmin() {
  const { app } = require('electron');
  const { exe, args } = getRelaunchArgs();
  logger.info('Relanzando elevado:', exe, args);
  await openAsAdmin(exe, args); // throws "UAC cancelado por el usuario." si se cancela
  // La nueva instancia ya arranco elevada; cerramos esta.
  app.quit();
}

module.exports = { isElevated, relaunchAsAdmin };
