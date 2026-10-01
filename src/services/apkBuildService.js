'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const projects = require('../utils/localConfig').loadConfig('projects');
const logger = require('../utils/logger');

// Script PowerShell que compila el APK (dotnet build -c Release) y, si el
// proyecto lo requiere, parchea/restaura la constante BaseURL alrededor del build.
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'apk', 'build-apk.ps1');

// Corrida en curso: { child, backup: {file, content} | null }. Solo permitimos una a la vez.
let current = null;

function getProject(id) {
  return projects.find(p => p.id === id);
}

// Red de seguridad para cancel(): si se mata el proceso a la fuerza (taskkill /F),
// el `finally` del script no llega a correr y la constante quedaria parchada.
// Reescribimos el archivo desde el backup que tomamos antes de arrancar el build.
function restorePatchedFile() {
  const backup = current && current.backup;
  if (!backup) return;
  try {
    fs.writeFileSync(backup.file, backup.content, 'utf8');
    logger.info('apkBuild: BaseURL restaurada tras cancelar:', backup.file);
  } catch (e) {
    logger.error('apkBuild: no se pudo restaurar la constante tras cancelar:', e);
  }
}

/**
 * Compila un APK (Release) de un proyecto mobile con config apkBuild, emitiendo
 * progreso por `send`. No requiere elevacion (dotnet build no necesita UAC), asi
 * que se spawnea powershell.exe directo y se streamea su stdout.
 *
 * @param {{id:string, env?:string}} opts
 * @param {(kind:string, message:any)=>void} send
 */
async function start(opts, send) {
  const { id, env } = opts || {};
  const p = getProject(id);
  if (!p) throw new Error(`Proyecto no encontrado: ${id}`);
  const cfg = p.apkBuild;
  if (!cfg || !cfg.csprojPath) {
    throw new Error('Este proyecto no tiene configuracion de generacion de APK (apkBuild).');
  }
  if (current) {
    throw new Error('Ya hay una generacion de APK en curso.');
  }
  if (!fs.existsSync(SCRIPT_PATH)) {
    throw new Error(`No se encontro el script: ${SCRIPT_PATH}`);
  }
  if (!fs.existsSync(cfg.projectDir)) {
    throw new Error(`No existe la carpeta del proyecto: ${cfg.projectDir}`);
  }
  if (!fs.existsSync(cfg.csprojPath)) {
    throw new Error(`No se encontro el .csproj: ${cfg.csprojPath}`);
  }

  const envs = Array.isArray(cfg.environments) ? cfg.environments : [];
  const chosenEnv = (env && envs.find(e => e.id === env))
    || envs.find(e => e.id === cfg.defaultEnv)
    || envs[0]
    || null;

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT_PATH,
    '-ProjectDir', cfg.projectDir,
    '-CsprojPath', cfg.csprojPath,
    '-TargetFramework', cfg.targetFramework || 'net8.0-android',
    '-Configuration', cfg.configuration || 'Release'
  ];

  let backup = null;
  if (chosenEnv && cfg.constantsFile && chosenEnv.baseUrl) {
    if (!fs.existsSync(cfg.constantsFile)) {
      throw new Error(`No se encontro el archivo de constantes: ${cfg.constantsFile}`);
    }
    backup = { file: cfg.constantsFile, content: fs.readFileSync(cfg.constantsFile, 'utf8') };
    args.push('-ConstantsFile', cfg.constantsFile, '-ConstantName', cfg.constantName || 'BaseURL', '-BaseUrl', chosenEnv.baseUrl, '-EnvLabel', chosenEnv.label || chosenEnv.id);
  }

  return new Promise((resolve, reject) => {
    logger.info('Starting APK build:', { id, env: chosenEnv && chosenEnv.id, csprojPath: cfg.csprojPath });
    send && send('progress', { pct: 0, stage: `Iniciando build${chosenEnv ? ` (${chosenEnv.label || chosenEnv.id})` : ''}...` });

    const child = spawn('powershell.exe', args, { windowsHide: true });
    current = { child, backup };

    let stderr = '';
    let stdoutBuf = '';
    const apkFiles = [];
    let outDir = null;

    const handleLine = (raw) => {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) return;
      let m;
      if ((m = line.match(/^@@PROGRESS@@\s+(\d+)\s*(.*)$/))) {
        send && send('progress', { pct: parseInt(m[1], 10), stage: m[2] || '' });
        return;
      }
      if ((m = line.match(/^@@LOG@@\s*@@APKFILE@@\s+(.*)\|(\d+)\s*$/))) {
        apkFiles.push({ path: m[1].trim(), size: parseInt(m[2], 10) });
        return;
      }
      if ((m = line.match(/^@@LOG@@\s*@@OUTDIR@@\s+(.*)$/))) {
        outDir = m[1].trim();
        return;
      }
      if ((m = line.match(/^@@LOG@@\s?(.*)$/))) {
        send && send('info', m[1]);
        return;
      }
      if (line.trim() === '@@DONE@@') {
        send && send('progress', { pct: 100, stage: 'Listo.' });
        return;
      }
      send && send('info', line);
    };

    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        handleLine(stdoutBuf.slice(0, idx));
        stdoutBuf = stdoutBuf.slice(idx + 1);
      }
    });

    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      send && send('warn', text.replace(/\r?\n$/, ''));
    });

    child.on('error', (err) => {
      current = null;
      reject(new Error(`No se pudo invocar PowerShell: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf); // flush ultima linea sin \n
      const wasCancelled = child.cancelled;
      current = null;
      if (signal || (code !== 0 && wasCancelled)) {
        return reject(Object.assign(new Error('Generacion de APK cancelada.'), { cancelled: true }));
      }
      if (code === 0) {
        const result = { env: chosenEnv && chosenEnv.id, outputDir: outDir, apkFiles };
        send && send('done', result);
        return resolve(result);
      }
      reject(new Error(stderr.trim() || `El script termino con codigo ${code}.`));
    });
  });
}

/** Cancela el build en curso (si lo hay), matando todo el arbol de procesos (dotnet/MSBuild incluidos). */
function cancel() {
  if (!current) return false;
  const { child } = current;
  child.cancelled = true;
  try { execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }, () => {}); }
  catch (_) { /* ignore */ }
  restorePatchedFile();
  return true;
}

module.exports = { start, cancel };
