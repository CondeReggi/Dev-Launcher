'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const projects = require('../utils/localConfig').loadConfig('projects');
const logger = require('../utils/logger');

// Script PowerShell todo-en-uno (repo/scripts/emulator/start-emulator.ps1) para
// proyectos React Native/Expo, y su equivalente para proyectos .NET MAUI (sin
// .env que elegir; corre `dotnet build -t:Run` en vez de `npx expo start`).
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'emulator', 'start-emulator.ps1');
const SCRIPT_PATH_MAUI = path.join(__dirname, '..', '..', 'scripts', 'emulator', 'start-emulator-maui.ps1');

let current = null; // child process en curso (solo permitimos uno a la vez)

// Ultima sesion arrancada con exito (o cancelada a medias): lo que "Detener todo"
// necesita para poder cerrar la terminal del dev server sin depender de que el
// script de arranque siga vivo. Se pierde si Dev Launcher se reinicia (aceptable:
// es un cleanup best-effort, no un tracker persistente).
let lastSession = null; // { termPid } | null

function execFileAsync(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

function getProject(id) {
  return projects.find(p => p.id === id);
}

// Electron puede heredar un PATH sin node/npx (sobre todo si la app corre elevada,
// donde el HKCU del usuario no aplica). Resolvemos la carpeta real de node aca
// —donde el filesystem no miente— y se la pasamos al script para que la anteponga.
function findNodeDir() {
  const candidates = [];
  // 1. node con el que se lanzo via npm (npm setea esta env var)
  if (process.env.npm_node_execpath) candidates.push(path.dirname(process.env.npm_node_execpath));
  // 2. Lo que ya este en PATH (por si esta bien)
  (process.env.PATH || '').split(path.delimiter).forEach(d => { if (d) candidates.push(d); });
  // 3. Ubicaciones tipicas de instalacion en Windows
  if (process.env.ProgramFiles)        candidates.push(path.join(process.env.ProgramFiles, 'nodejs'));
  if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs'));
  if (process.env.LOCALAPPDATA)        candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'));
  candidates.push('C:\\Program Files\\nodejs');

  for (const dir of candidates) {
    try {
      if (dir && (fs.existsSync(path.join(dir, 'npx.cmd')) || fs.existsSync(path.join(dir, 'node.exe')))) {
        return dir;
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * Cierra todo lo que haya quedado de una corrida anterior: el script de arranque
 * en curso (si lo hay), la terminal del dev server (por PID) y el emulador
 * Android (via adb, con fallback a matar el proceso por nombre). Compartido por
 * start() (cuando hay que forzar una corrida limpia antes de arrancar de nuevo)
 * y por stop() ("Detener todo" desde la UI). Best-effort: cada paso ignora
 * errores individuales para que un fallo parcial no frene el resto.
 *
 * @param {(kind:string, message:any)=>void} send
 */
async function forceCleanup(send) {
  const emit = (kind, msg) => { send && send(kind, msg); logger.info('emulator cleanup:', msg); };

  if (current) {
    emit('info', 'Cortando el script de arranque en curso...');
    cancel();
    // Le damos un instante al proceso para que efectivamente termine (dispara
    // 'close' y limpia `current`) antes de seguir con el resto del cleanup.
    await new Promise((r) => setTimeout(r, 300));
  }

  const termPid = lastSession && lastSession.termPid;
  if (termPid) {
    emit('info', `Cerrando terminal del dev server (PID ${termPid})...`);
    const r = await execFileAsync('taskkill', ['/F', '/T', '/PID', String(termPid)]);
    if (r.err && !/no se encontr|not found/i.test(r.stdout + r.stderr)) {
      emit('warn', `No se pudo cerrar la terminal (PID ${termPid}): ${(r.stderr || r.stdout).trim()}`);
    }
  } else {
    emit('info', 'No hay terminal registrada de una corrida anterior (o ya se cerro).');
  }

  const sdk = path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const adb = path.join(sdk, 'platform-tools', 'adb.exe');
  if (fs.existsSync(adb)) {
    const devicesRes = await execFileAsync(adb, ['devices']);
    const serials = (devicesRes.stdout.match(/^emulator-\d+(?=\s+device)/gm) || []);
    if (serials.length) {
      for (const serial of serials) {
        emit('info', `Apagando emulador ${serial}...`);
        await execFileAsync(adb, ['-s', serial, 'emu', 'kill']);
      }
    } else {
      emit('info', 'No hay ningun emulador Android online.');
    }
  } else {
    emit('warn', `No se encontro adb en ${adb}; salteando el shutdown limpio.`);
  }

  emit('info', 'Verificando procesos colgados del emulador...');
  // qemu-system-* varia segun la arquitectura de la imagen del AVD; probamos las
  // variantes comunes. taskkill no-opea en silencio si el nombre no existe.
  await execFileAsync('taskkill', ['/F', '/IM', 'qemu-system-x86_64.exe']);
  await execFileAsync('taskkill', ['/F', '/IM', 'qemu-system-i386.exe']);
  await execFileAsync('taskkill', ['/F', '/IM', 'qemu-system-aarch64.exe']);
  await execFileAsync('taskkill', ['/F', '/IM', 'emulator.exe']);
  await execFileAsync('taskkill', ['/F', '/IM', 'crashpad_handler.exe']);

  lastSession = null;
}

/**
 * Lanza el emulador + Expo de un proyecto mobile, emitiendo progreso por `send`.
 * No requiere elevacion (adb/emulator no necesitan UAC), asi que se spawnea
 * powershell.exe directo y se streamea su stdout linea a linea.
 *
 * Si ya habia un arranque en curso (ej. quedo colgado y nunca disparo 'close'),
 * en vez de rechazar sin mas se fuerza un cleanup completo (forceCleanup) y se
 * continua con la corrida nueva.
 *
 * @param {{id:string, env?:string, avd?:string}} opts
 * @param {(kind:string, message:any)=>void} send
 */
async function start(opts, send) {
  const { id, env, avd } = opts || {};
  const p = getProject(id);
  if (!p) throw new Error(`Proyecto no encontrado: ${id}`);
  if (!p.emulator || !p.emulator.projectDir) {
    throw new Error('Este proyecto no tiene configuracion de emulador (emulator.projectDir).');
  }
  if (current) {
    send && send('warn', 'Habia un arranque anterior colgado; cerrando todo antes de arrancar de nuevo...');
    await forceCleanup(send);
  }

  return new Promise((resolve, reject) => {
    const cfg = p.emulator;
    const isMaui = cfg.type === 'maui';
    const scriptPath = isMaui ? SCRIPT_PATH_MAUI : SCRIPT_PATH;
    if (!fs.existsSync(scriptPath)) {
      return reject(new Error(`No se encontro el script: ${scriptPath}`));
    }

    const projectDir = cfg.projectDir;
    if (!fs.existsSync(projectDir)) {
      return reject(new Error(`No existe la carpeta del proyecto: ${projectDir}`));
    }

    const chosenAvd = avd || cfg.defaultAvd || 'Pixel_6';

    let args;
    let chosenEnv = null;
    let nodeDir = null;

    if (isMaui) {
      if (!cfg.csprojPath) {
        return reject(new Error('Este proyecto no tiene emulator.csprojPath configurado.'));
      }
      if (!fs.existsSync(cfg.csprojPath)) {
        return reject(new Error(`No se encontro el .csproj: ${cfg.csprojPath}`));
      }
      args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-ProjectDir', projectDir,
        '-CsprojPath', cfg.csprojPath,
        '-Avd', chosenAvd,
        '-TargetFramework', cfg.targetFramework || 'net8.0-android'
      ];
      logger.info('Starting emulator (MAUI):', { projectDir, csprojPath: cfg.csprojPath, avd: chosenAvd });
      send && send('progress', { pct: 0, stage: `Iniciando (${chosenAvd})...` });
    } else {
      const envs = Array.isArray(cfg.envs) && cfg.envs.length ? cfg.envs : ['testing', 'production'];
      chosenEnv = env && envs.includes(env) ? env : (cfg.defaultEnv || envs[0]);

      args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-ProjectDir', projectDir,
        '-Env', chosenEnv,
        '-Avd', chosenAvd
      ];

      nodeDir = findNodeDir();
      if (nodeDir) {
        args.push('-NodeDir', nodeDir);
        if (send) send('info', `node detectado en: ${nodeDir}`);
      } else if (send) {
        send('warn', 'No se pudo ubicar node/npx; Expo intentara resolverlo desde el PATH del sistema.');
      }

      logger.info('Starting emulator:', { projectDir, env: chosenEnv, avd: chosenAvd, nodeDir });
      send && send('progress', { pct: 0, stage: `Iniciando (${chosenEnv} / ${chosenAvd})...` });
    }

    const child = spawn('powershell.exe', args, { windowsHide: true });
    current = child;

    let stderr = '';
    let stdoutBuf = '';
    let termPid = null;

    const handleLine = (raw) => {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) return;
      let m;
      if ((m = line.match(/^@@PROGRESS@@\s+(\d+)\s*(.*)$/))) {
        send && send('progress', { pct: parseInt(m[1], 10), stage: m[2] || '' });
        return;
      }
      if ((m = line.match(/^@@LOG@@\s*@@TERMPID@@\s+(\d+)/))) {
        termPid = parseInt(m[1], 10);
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
      current = null;
      // Guardamos igual si quedo una terminal abierta (aunque el script haya sido
      // cancelado despues de abrirla), para que "Detener todo" la pueda cerrar.
      if (termPid) lastSession = { termPid };
      if (signal || (code !== 0 && child.cancelled)) {
        return reject(Object.assign(new Error('Inicio del emulador cancelado.'), { cancelled: true }));
      }
      if (code === 0) {
        send && send('done', { env: chosenEnv, avd: chosenAvd });
        return resolve({ env: chosenEnv, avd: chosenAvd });
      }
      reject(new Error(stderr.trim() || `El script termino con codigo ${code}.`));
    });
  });
}

/** Mata el proceso en curso (si lo hay). El emulador ya lanzado queda abierto. */
function cancel() {
  if (!current) return false;
  current.cancelled = true;
  try { current.kill(); } catch (_) { /* ignore */ }
  return true;
}

/**
 * "Detener todo": a diferencia de cancel() (que solo corta el script de arranque
 * mientras esta corriendo), esto cierra lo que haya quedado arriba de una corrida
 * anterior (script en curso, terminal del dev server, emulador Android). Es el
 * mismo cleanup que start() dispara automaticamente cuando encuentra un arranque
 * colgado, expuesto aca para que el usuario lo pueda pedir a mano desde la UI.
 *
 * @param {(kind:string, message:any)=>void} send
 */
async function stop(send) {
  await forceCleanup(send);
  send && send('done', 'Todo detenido: emulador y terminal cerrados.');
  return { stopped: true };
}

module.exports = { start, cancel, stop };
