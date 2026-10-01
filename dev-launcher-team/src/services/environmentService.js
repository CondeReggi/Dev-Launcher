'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execSync, execFileSync } = require('child_process');
const { shell } = require('electron');
const projects = require('../utils/localConfig').loadConfig('projects');
const logger = require('../utils/logger');

// Ambiente activo (uno a la vez). Cada entry de `procs` describe una terminal:
//   { title, port, command, child, pid, owned, ready, exited, exitCode }
// `owned=false` -> el puerto ya estaba escuchando y NO lo spawneamos (no lo matamos).
let current = null;

function getProject(id) {
  return projects.find(p => p.id === id);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Dirs candidatos de node y dotnet (rutas absolutas conocidas). Se anteponen al
// PATH SIN condicionar a existsSync: un dir inexistente en el PATH es inofensivo,
// y uno existente hace que cmd.exe resuelva npm.cmd/dotnet.exe aunque el PATH
// heredado venga recortado (caso app elevada, donde node no aparece en el PATH).
function knownToolDirs() {
  const pf   = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad  = process.env.LOCALAPPDATA;
  const dirs = [];
  if (process.env.npm_node_execpath) dirs.push(path.dirname(process.env.npm_node_execpath));
  dirs.push(path.join(pf, 'nodejs'), 'C:\\Program Files\\nodejs', path.join(pf86, 'nodejs'));
  if (lad) dirs.push(path.join(lad, 'Programs', 'nodejs'));
  dirs.push(path.join(pf, 'dotnet'), 'C:\\Program Files\\dotnet');
  if (lad) dirs.push(path.join(lad, 'Microsoft', 'dotnet'));
  return [...new Set(dirs)];
}

// Info para el log: donde esta node realmente (o null). No condiciona el PATH.
function findNodeDir() {
  for (const dir of knownToolDirs()) {
    try { if (fs.existsSync(path.join(dir, 'npm.cmd')) || fs.existsSync(path.join(dir, 'node.exe'))) return dir; }
    catch (_) { /* ignore */ }
  }
  return null;
}

// powershell.exe por RUTA ABSOLUTA: con el PATH recortado de un proceso elevado,
// invocarlo por nombre puede fallar (y ahi perdiamos el PATH del registro).
function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const abs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.existsSync(abs)) return abs; } catch (_) { /* ignore */ }
  return 'powershell.exe';
}

// PATH "real" = dirs conocidos de node/dotnet (SIEMPRE primero) + registro
// Machine+User (lo que ve una consola normal) + el PATH del proceso como fallback.
function buildFullPath() {
  const parts = knownToolDirs();
  try {
    const reg = execFileSync(powershellExe(),
      ['-NoProfile', '-NonInteractive', '-Command',
        "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim();
    if (reg) parts.push(reg);
  } catch (_) { /* fallback abajo */ }
  if (process.env.PATH) parts.push(process.env.PATH);
  return parts.filter(Boolean).join(path.delimiter);
}

// Reescribe un comando que arranca con npm/npx/node/yarn/pnpm a su RUTA ABSOLUTA
// si la encontramos en disco. Cinturon y tiradores: aunque el PATH fallara, el
// comando resuelve igual. Si no lo ubicamos, se deja tal cual (cmd lo busca en PATH).
function resolveToolCommand(command) {
  const m = String(command).match(/^\s*(npm|npx|node|yarn|pnpm)\b(.*)$/i);
  if (!m) return command;
  const tool = m[1].toLowerCase();
  const rest = m[2];
  const exeNames = tool === 'node' ? ['node.exe'] : [tool + '.cmd', tool + '.exe'];
  for (const dir of knownToolDirs()) {
    for (const exe of exeNames) {
      const fp = path.join(dir, exe);
      try { if (fs.existsSync(fp)) return `"${fp}"${rest}`; } catch (_) { /* ignore */ }
    }
  }
  return command;
}

// Env para una terminal: process.env + PATH reconstruido + las env vars propias.
// Normalizamos la clave PATH (Windows la expone como 'Path') para no duplicarla.
function buildEnv(fullPath, extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) { if (k.toLowerCase() === 'path') delete env[k]; }
  env.Path = fullPath;
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) env[k] = String(v);
  }
  return env;
}

// Hay algo escuchando en 127.0.0.1:<port>? (cert-agnostico; sirve para https).
function probePort(port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(v); };
    sock.setTimeout(1000);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
    sock.connect(port, '127.0.0.1');
  });
}

async function waitForPort(port, timeoutSec, onTick, isAlive) {
  const deadline = Date.now() + timeoutSec * 1000;
  let waited = 0;
  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) return false;
    if (await probePort(port)) return true;
    await sleep(2000);
    waited += 2;
    if (onTick) onTick(waited);
  }
  return false;
}

// Bufferiza un stream y llama onLine por cada linea completa.
function pipeLines(stream, onLine) {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const l = buf.slice(0, idx).replace(/\r$/, '');
      if (l.trim()) onLine(l);
      buf = buf.slice(idx + 1);
    }
  });
  stream.on('end', () => { if (buf.trim()) onLine(buf.replace(/\r$/, '')); });
}

// Mata el arbol de un proceso (dotnet run / npm start spawnean nietos).
function treeKill(pid) {
  return new Promise(resolve => {
    try {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      k.on('exit', () => resolve());
      k.on('error', () => resolve());
    } catch (_) { resolve(); }
  });
}

/**
 * Levanta UNA terminal (dev server) en segundo plano y espera a que su puerto
 * escuche. Es el ladrillo compartido por `start()` (loop de N servicios) y por
 * `restartOne()` (reinicio puntual). Devuelve el `rec` que va a `run.procs[i]`.
 *
 * Si el puerto ya escucha, reusa (owned=false, no lo matamos luego). Si no,
 * spawnea oculto, bufferiza stdout/stderr al `send` y espera con `waitForPort`.
 *
 * @param {object} t      terminal de la config { title, cwd, env, command, port, waitTimeoutSec }
 * @param {string} tag    prefijo de log, p.ej. "[2]"
 * @param {string} fullPath  PATH reconstruido (buildFullPath())
 * @param {(kind:string,message:any)=>void} send
 * @param {{aborted?:()=>boolean, onProgress?:(waited:number)=>void}} [opts]
 */
async function launchTerminal(t, tag, fullPath, send, opts) {
  const aborted = (opts && opts.aborted) || (() => false);
  const onProgress = opts && opts.onProgress;

  // Si el puerto ya escucha, reusamos (no spawneamos ni lo matamos luego).
  if (t.port && await probePort(t.port)) {
    send && send('info', `${tag} Puerto ${t.port} ya escuchando; se reusa (no se inicia otro).`);
    return { title: t.title, port: t.port, command: t.command, owned: false, ready: true, exited: false };
  }

  const env = buildEnv(fullPath, t.env);
  // shell:true -> cmd.exe /c "<command>"; windowsHide -> sin ventana visible.
  // resolveToolCommand antepone la ruta absoluta de npm/node si la encuentra.
  const cmd = resolveToolCommand(t.command);
  const child = spawn(cmd, { cwd: t.cwd, env, windowsHide: true, shell: true });
  const rec = { title: t.title, port: t.port || null, command: t.command, child, pid: child.pid, owned: true, ready: false, exited: false, exitCode: null };

  pipeLines(child.stdout, (line) => send && send('info', `${tag} ${line}`));
  pipeLines(child.stderr, (line) => send && send('warn', `${tag} ${line}`));
  child.on('error', (err) => send && send('error', `${tag} Error al iniciar: ${err.message}`));
  child.on('exit', (code) => {
    rec.exited = true; rec.exitCode = code;
    if (!rec.ready) send && send('error', `${tag} El proceso termino (codigo ${code}) antes de escuchar el puerto.`);
    else send && send('warn', `${tag} El proceso "${t.title}" termino (codigo ${code}).`);
  });
  send && send('info', `${tag} Iniciado en segundo plano: ${t.command}`);

  if (t.port) {
    const timeout = t.waitTimeoutSec || 180;
    send && send('info', `${tag} Esperando el puerto ${t.port} (timeout ${timeout}s)...`);
    const okPort = await waitForPort(t.port, timeout, onProgress, () => !rec.exited && !aborted());
    if (okPort) { rec.ready = true; send && send('info', `${tag} Puerto ${t.port} OK.`); }
    else if (!rec.exited) send && send('warn', `${tag} Timeout esperando el puerto ${t.port}; el proceso sigue en segundo plano (puede estar compilando).`);
  } else {
    await sleep(1500);
  }
  return rec;
}

/**
 * Levanta el ambiente en SEGUNDO PLANO: spawnea cada dev server oculto
 * (sin ventanas), transmite su salida por `send` y espera a que cada puerto
 * escuche antes de arrancar el siguiente. Los procesos quedan vivos y trackeados
 * hasta `stop()` o hasta que se cierre la app.
 *
 * @param {{id:string}} opts
 * @param {(kind:string, message:any)=>void} send
 */
async function start(opts, send) {
  const { id } = opts || {};
  const p = getProject(id);
  if (!p) throw new Error(`Proyecto no encontrado: ${id}`);

  const cfg = p.environment;
  if (!cfg || !Array.isArray(cfg.terminals) || !cfg.terminals.length) {
    throw new Error('Este proyecto no tiene configuracion de ambiente (environment.terminals).');
  }
  if (current) throw new Error('Ya hay un ambiente corriendo. Detenelo antes de levantar otro.');

  for (const t of cfg.terminals) {
    if (!t.cwd || !fs.existsSync(t.cwd)) {
      throw new Error(`No existe la carpeta del paso "${t.title || ''}": ${t.cwd}`);
    }
  }

  const nodeDir = findNodeDir();
  if (nodeDir) send && send('info', `node detectado en: ${nodeDir}`);
  else send && send('warn', 'No ubique node en las rutas conocidas; igual se antepone al PATH por las dudas.');
  const fullPath = buildFullPath();

  const run = { id, name: p.name, procs: [], startedAt: Date.now() };
  current = run;
  const aborted = () => current !== run;
  const cancelledErr = () => Object.assign(new Error('Levantado del ambiente cancelado.'), { cancelled: true });

  try {
    send && send('progress', { pct: 2, stage: `Preparando ambiente (${cfg.terminals.length} servicios en segundo plano)...` });

    // Chequeo de versiones (informativo).
    if (cfg.checkVersions) {
      const cenv = buildEnv(fullPath, null);
      // Solo advertimos si la version MAYOR instalada es MENOR a la esperada; un
      // SDK/runtime mas nuevo (ej. dotnet 10 vs 8) buildea/roll-forwardea igual.
      if (cfg.checkVersions.dotnet) {
        try {
          const v = execSync('dotnet --version', { env: cenv, windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim();
          send && send('info', `dotnet --version -> ${v}`);
          const want = parseInt(cfg.checkVersions.dotnet, 10), got = parseInt(v, 10);
          if (want && got && got < want) send && send('warn', `Se esperaba dotnet >= ${want}.x (tenes ${v}).`);
        } catch (e) { send && send('warn', `No se pudo verificar dotnet: ${e.message}`); }
      }
      if (cfg.checkVersions.node) {
        try {
          const v = execSync('node --version', { env: cenv, windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim();
          send && send('info', `node --version -> ${v}`);
          const want = parseInt(cfg.checkVersions.node, 10), got = parseInt(v.replace(/^v/, ''), 10);
          if (want && got && got < want) send && send('warn', `Se esperaba node >= ${want}.x (tenes ${v}).`);
        } catch (e) { send && send('warn', `No se pudo verificar node: ${e.message}`); }
      }
    }
    if (aborted()) throw cancelledErr();

    // Confiar el certificado HTTPS de dev (una sola vez).
    if (cfg.trustDevCert) {
      send && send('progress', { pct: 5, stage: 'Confiando certificado HTTPS de dev...' });
      try {
        execSync('dotnet dev-certs https --trust', { env: buildEnv(fullPath, null), windowsHide: true, timeout: 30000, stdio: 'ignore' });
        send && send('info', 'dotnet dev-certs https --trust ejecutado.');
      } catch (e) { send && send('warn', `No se pudo ejecutar dev-certs: ${e.message}`); }
    }
    if (aborted()) throw cancelledErr();

    const terms = cfg.terminals;
    const n = terms.length;

    for (let i = 0; i < n; i++) {
      if (aborted()) throw cancelledErr();
      const t = terms[i];
      const tag = `[${i + 1}]`;
      const baseP = 10 + Math.floor((i / n) * 85);
      send && send('progress', { pct: baseP, stage: `Iniciando ${i + 1}/${n}: ${t.title}` });

      const rec = await launchTerminal(t, tag, fullPath, send, {
        aborted,
        onProgress: (waited) => {
          const timeout = t.waitTimeoutSec || 180;
          const seg = 85 / n;
          let pct = baseP + Math.floor((waited / timeout) * seg);
          if (pct > 95) pct = 95;
          send && send('progress', { pct, stage: `Esperando ${t.title} (puerto ${t.port})... ${waited}s` });
        }
      });
      run.procs.push(rec);
      if (aborted()) throw cancelledErr();
    }

    if (cfg.openUrl) {
      send && send('progress', { pct: 98, stage: `Abriendo navegador (${cfg.openUrl})...` });
      try { await shell.openExternal(cfg.openUrl); } catch (e) { send && send('warn', `No se pudo abrir el navegador: ${e.message}`); }
    }

    logger.info('Environment up (background):', { id, terminals: n });
    send && send('progress', { pct: 100, stage: 'Ambiente corriendo en segundo plano.' });
    send && send('done', { terminals: n });
    return { terminals: n, running: true };
  } catch (e) {
    // Error real (no cancelacion): matar lo que se haya spawneado para no dejar
    // servidores huerfanos. Si fue cancelacion, stop() ya se encargo.
    if (!aborted()) { try { await stop(); } catch (_) {} }
    throw e;
  }
}

/** Detiene el ambiente: mata el arbol de cada proceso propio. */
async function stop() {
  if (!current) return { stopped: false };
  const run = current;
  current = null; // marca abort para un start() en curso
  const owned = run.procs.filter(p => p.owned && p.pid && !p.exited);
  for (const p of owned) { await treeKill(p.pid); }
  logger.info('Environment stopped:', { id: run.id, killed: owned.length });
  return { stopped: true, terminals: run.procs.length, killed: owned.length };
}

/**
 * Reinicia UN servicio puntual del ambiente sin tocar los demas. Logica separada
 * de start()/stop() a proposito: mata SOLO el arbol de ese proceso, espera a que
 * libere su puerto y lo relanza con `launchTerminal` (misma config), dejando el
 * resto del ambiente corriendo. Reemplaza el rec en el mismo indice de run.procs.
 *
 * @param {{id:string, index:number}} opts
 * @param {(kind:string,message:any)=>void} send
 */
async function restartOne(opts, send) {
  const { id, index } = opts || {};
  if (!current) throw new Error('No hay ningun ambiente corriendo.');
  if (current.id !== id) throw new Error('El ambiente que esta corriendo no corresponde a este proyecto.');

  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= current.procs.length) {
    throw new Error(`Servicio invalido (index: ${index}).`);
  }

  const p = getProject(id);
  const cfg = p && p.environment;
  const term = cfg && Array.isArray(cfg.terminals) ? cfg.terminals[i] : null;
  if (!term) throw new Error('No se encontro la configuracion del servicio a reiniciar.');

  const run = current;                 // ambiente vigente; si cambia -> alguien lo detuvo
  const tag = `[${i + 1}]`;
  const old = run.procs[i];

  // 1) Matar el proceso viejo (solo si lo spawneamos nosotros) y esperar a que
  //    libere el puerto, para no reusarlo por accidente al relanzar.
  if (old && old.owned && old.pid && !old.exited) {
    send && send('info', `${tag} Deteniendo "${old.title}" (pid ${old.pid})...`);
    await treeKill(old.pid);
    old.exited = true;
  } else if (old && !old.owned) {
    send && send('info', `${tag} "${old.title}" no fue iniciado por la app (puerto reusado); igual se reinicia.`);
  }
  if (term.port) {
    for (let w = 0; w < 6 && await probePort(term.port); w++) await sleep(2000);
    if (await probePort(term.port)) {
      send && send('warn', `${tag} El puerto ${term.port} sigue ocupado; al relanzar se reusara lo que este escuchando.`);
    }
  }
  if (current !== run) throw new Error('El ambiente se detuvo durante el reinicio.');

  // 2) Reconstruir el PATH (mismo criterio que start) y relanzar SOLO este servicio.
  send && send('info', `${tag} Reiniciando "${term.title}"...`);
  const fullPath = buildFullPath();
  const rec = await launchTerminal(term, tag, fullPath, send, { aborted: () => current !== run });

  // 3) Si el ambiente se detuvo mientras arrancaba, matar lo recien spawneado.
  if (current !== run) {
    if (rec.owned && rec.pid && !rec.exited) { try { await treeKill(rec.pid); } catch (_) {} }
    throw new Error('El ambiente se detuvo durante el reinicio.');
  }

  run.procs[i] = rec;
  logger.info('Environment service restarted:', { id, index: i, title: term.title });
  send && send('info', `${tag} "${term.title}" reiniciado.`);
  return { restarted: i, title: term.title, ready: !!rec.ready, listening: rec.port ? await probePort(rec.port) : null };
}

/** Estado actual del ambiente (para restaurar la UI al re-montar el panel). */
async function status() {
  if (!current) return { running: false };
  const terminals = [];
  for (const p of current.procs) {
    terminals.push({
      title: p.title,
      port: p.port || null,
      owned: !!p.owned,
      exited: !!p.exited,
      listening: p.port ? await probePort(p.port) : null
    });
  }
  return { running: true, id: current.id, name: current.name, startedAt: current.startedAt, terminals };
}

/** Limpieza sincrona para app.on('before-quit') (evita servidores huerfanos). */
function killAllSync() {
  if (!current) return;
  for (const p of current.procs) {
    if (p.owned && p.pid && !p.exited) {
      try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
      catch (_) { /* ignore */ }
    }
  }
  current = null;
}

module.exports = { start, stop, restartOne, status, killAllSync };
