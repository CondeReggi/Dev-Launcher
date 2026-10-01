'use strict';

const { spawn } = require('child_process');
const logger = require('./logger');

// Escape any single quotes inside a PowerShell single-quoted string by doubling them.
const psEscape = (s) => String(s).replace(/'/g, "''");

/**
 * Builds the ArgumentList payload as a single PowerShell-escaped string in which
 * every argument is wrapped in double quotes. The target executable will re-parse
 * the string and treat each "..." token as one argument, so spaces are preserved.
 */
function buildArgumentString(args) {
  return args
    .filter(a => a !== undefined && a !== null && String(a).length > 0)
    .map(a => `"${String(a).replace(/"/g, '\\"')}"`)
    .join(' ');
}

/**
 * Launches an executable with elevation via PowerShell + Start-Process -Verb RunAs.
 * Resolves once PowerShell exits with code 0 (the elevated process is fire-and-forget).
 * Rejects with a descriptive error if UAC was cancelled, the path is bad, etc.
 *
 * @param {string} exePath  Full absolute path to the executable.
 * @param {string[]} [args] Argument list. Each entry is treated as one token.
 * @param {{cwd?: string}} [options]  Optional working directory for the elevated process.
 * @returns {Promise<void>}
 */
function openAsAdmin(exePath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    if (!exePath) return reject(new Error('exePath es requerido'));

    const exe = psEscape(exePath);
    const argString = buildArgumentString(args);
    const argClause = argString
      ? `-ArgumentList '${psEscape(argString)}'`
      : '';
    const cwdClause = options && options.cwd
      ? `-WorkingDirectory '${psEscape(options.cwd)}'`
      : '';

    const psCommand = `
$ErrorActionPreference = 'Stop'
try {
  Start-Process -FilePath '${exe}' ${argClause} ${cwdClause} -Verb RunAs
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`.trim();

    // -EncodedCommand expects UTF-16LE base64. This avoids any further shell-escaping layer.
    const encoded = Buffer.from(psCommand, 'utf16le').toString('base64');

    logger.info('Launching elevated:', exePath, args);

    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encoded
      ],
      { windowsHide: true }
    );

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('error', err => reject(new Error(`No se pudo invocar PowerShell: ${err.message}`)));
    child.on('close', code => {
      if (code === 0) return resolve();
      const msg = stderr.trim() || `PowerShell exited with code ${code}`;
      if (/operation was cancel/i.test(msg) || /el usuario ha cancelado/i.test(msg) || /cancelada por el usuario/i.test(msg)) {
        return reject(new Error('UAC cancelado por el usuario.'));
      }
      reject(new Error(msg));
    });
  });
}

module.exports = { openAsAdmin };
