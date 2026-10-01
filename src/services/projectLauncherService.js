'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const projects = require('../utils/localConfig').loadConfig('projects');
const apps = require('../utils/localConfig').loadConfig('apps');
const { openAsAdmin } = require('../utils/adminLauncher');
const { pathExists } = require('../utils/pathValidator');

// Un proyecto puede declarar varias .sln (monorepo). `solutions[]` gana; si no,
// se cae al `solutionPath` unico. Siempre devuelve un array (vacio si no hay .sln).
function resolveSolutions(p) {
  if (Array.isArray(p.solutions) && p.solutions.length) {
    return p.solutions
      .filter(s => s && s.path)
      .map(s => ({ label: s.label || path.basename(s.path), path: s.path }));
  }
  if (p.solutionPath) return [{ label: path.basename(p.solutionPath), path: p.solutionPath }];
  return [];
}

function resolveCmdPath(p) {
  // Override explicito: util en monorepos donde la consola va en la raiz y no
  // en la carpeta de una .sln puntual.
  if (p.cmdPath) return p.cmdPath;
  const sols = resolveSolutions(p);
  if (sols.length) {
    // La ruta normalmente es un .sln, asi que la consola va en su carpeta.
    // Pero si por error apunta a una carpeta, usarla tal cual (no subir al padre).
    const first = sols[0].path;
    try {
      if (fs.statSync(first).isDirectory()) return first;
    } catch { /* no existe: caemos a dirname igual */ }
    return path.dirname(first);
  }
  if (p.folderPath)   return p.folderPath;
  return null;
}

function getProjects() {
  return projects.map(p => {
    const solutions = resolveSolutions(p);
    return {
    id: p.id,
    name: p.name,
    description: p.description || '',
    category: p.category || 'dev',
    group: p.group || null,
    // Primera .sln: sigue siendo la "principal" (la que abre "Abrir todo").
    solutionPath: solutions.length ? solutions[0].path : null,
    solutions,
    folderPath: p.folderPath || null,
    cmdPath: resolveCmdPath(p),
    hasSolution: solutions.length > 0,
    hasFolder: Boolean(p.folderPath),
    emulator: p.emulator && p.emulator.projectDir ? {
      type: p.emulator.type || 'expo',
      projectDir: p.emulator.projectDir,
      csprojPath: p.emulator.csprojPath || null,
      targetFramework: p.emulator.targetFramework || null,
      // Los proyectos MAUI no tienen .env que elegir (URL hardcodeada en un
      // archivo de constantes); solo el flujo Expo tiene un default de 2 ambientes.
      envs: Array.isArray(p.emulator.envs) && p.emulator.envs.length
        ? p.emulator.envs
        : (p.emulator.type === 'maui' ? [] : ['testing', 'production']),
      defaultEnv: p.emulator.defaultEnv || null,
      avds: Array.isArray(p.emulator.avds) ? p.emulator.avds : [],
      defaultAvd: p.emulator.defaultAvd || null
    } : null,
    // Solo id/label de cada ambiente: el baseUrl real (URLs internas de red) se
    // resuelve server-side en apkBuildService a partir del id elegido, no hace
    // falta exponerlo al renderer.
    apkBuild: p.apkBuild && p.apkBuild.csprojPath ? {
      targetFramework: p.apkBuild.targetFramework || 'net8.0-android',
      configuration: p.apkBuild.configuration || 'Release',
      environments: Array.isArray(p.apkBuild.environments)
        ? p.apkBuild.environments.map(e => ({ id: e.id, label: e.label || e.id }))
        : [],
      defaultEnv: p.apkBuild.defaultEnv || null
    } : null,
    // Solo info de display: el servicio real (environmentService) relee la config
    // cruda por id, asi que aca alcanza con el label y los titulos de cada paso.
    environment: p.environment && Array.isArray(p.environment.terminals) && p.environment.terminals.length ? {
      label: p.environment.label || 'Levantar ambiente',
      openUrl: p.environment.openUrl || null,
      terminals: p.environment.terminals.map(t => ({ title: t.title || '', port: t.port || null }))
    } : null,
    warning: p.warning || '',
    commands: Array.isArray(p.commands) ? p.commands.map(c => ({
      label: c.label || '',
      command: c.command || '',
      description: c.description || ''
    })) : []
    };
  });
}

function getProject(id) {
  return projects.find(p => p.id === id);
}

async function openVisualStudio(solutionPath) {
  const exe = apps.visualStudio.exePath;
  if (!pathExists(exe)) {
    throw new Error(`No se encontro devenv.exe en: ${exe}. Editá src/config/apps.config.js.`);
  }
  if (!solutionPath) {
    throw new Error('Este proyecto no tiene solutionPath configurado.');
  }
  if (!pathExists(solutionPath)) {
    throw new Error(`No se encontro la solucion: ${solutionPath}`);
  }
  await openAsAdmin(exe, [solutionPath]);
}

async function openVSCode(folderPath) {
  const exe = apps.vscode.exePath;
  if (!pathExists(exe)) {
    throw new Error(`No se encontro VS Code en: ${exe}. Editá src/config/apps.config.js.`);
  }
  if (!folderPath) {
    throw new Error('Este proyecto no tiene folderPath configurado.');
  }
  if (!pathExists(folderPath)) {
    throw new Error(`No se encontro la carpeta: ${folderPath}`);
  }
  await openAsAdmin(exe, [folderPath]);
}

async function openCmd(id) {
  const p = getProject(id);
  if (!p) throw new Error(`Proyecto no encontrado: ${id}`);
  const cwd = resolveCmdPath(p);
  if (!cwd) {
    throw new Error('Este proyecto no tiene solutionPath ni folderPath configurados.');
  }
  if (!pathExists(cwd)) {
    throw new Error(`No se encontro la carpeta: ${cwd}`);
  }
  // Bootstrap cmd through a tiny .cmd in TEMP that does the `cd /d` itself. Going via
  // `cmd /K cd /d "<path>"` directly is fragile: buildArgumentString wraps every arg in
  // quotes and escapes inner quotes as \" — cmd does not understand \" so paths with
  // spaces (e.g. "B2B BO") break. Reading the cd from a file sidesteps all of that.
  const tmpDir = path.join(os.tmpdir(), 'dev-launcher');
  fs.mkdirSync(tmpDir, { recursive: true });
  const batPath = path.join(tmpDir, `cd-${p.id}.cmd`);
  const batBody = `@echo off\r\ncd /d "${cwd.replace(/"/g, '""')}"\r\ncls\r\n`;
  fs.writeFileSync(batPath, batBody, 'utf8');

  await openAsAdmin('cmd.exe', ['/K', batPath]);
}

async function openProject(id) {
  const p = getProject(id);
  if (!p) throw new Error(`Proyecto no encontrado: ${id}`);

  const errors = [];
  // Solo la .sln principal: en un monorepo con 6 soluciones, "Abrir todo" no
  // debe disparar 6 instancias de VS (y 6 prompts de UAC).
  const sols = resolveSolutions(p);
  if (sols.length) {
    try { await openVisualStudio(sols[0].path); }
    catch (e) { errors.push(`Visual Studio: ${e.message}`); }
  }
  if (p.folderPath) {
    try { await openVSCode(p.folderPath); }
    catch (e) { errors.push(`VS Code: ${e.message}`); }
  }
  if (errors.length) throw new Error(errors.join(' | '));
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// Rama + estado sucio del repo del proyecto (badge de la card). No es un error si el
// proyecto no es un repo git o si git no esta en el PATH: simplemente no hay badge.
async function getGitStatus(id) {
  const p = getProject(id);
  if (!p) throw new Error(`Proyecto no encontrado: ${id}`);
  const cwd = p.folderPath || resolveCmdPath(p);
  if (!cwd || !pathExists(cwd)) return null;
  try {
    const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
    const status = await runGit(['status', '--porcelain'], cwd);
    const dirtyCount = status.split('\n').filter((l) => l.trim()).length;
    return { branch, dirty: dirtyCount > 0, dirtyCount };
  } catch (_) {
    return null;
  }
}

// Abre una terminal en la carpeta del proyecto SIN elevar (a diferencia de openCmd,
// pensado para admin). Reusa el mismo bootstrap .cmd en TEMP que openCmd() para no
// repetir el problema de comillas/espacios documentado ahi (ej. carpetas como "B2B BO").
//
// OJO: se probo primero preferir Windows Terminal (`wt.exe`) con fallback a cmd.exe,
// pero `wt.exe` vive en WindowsApps como App Execution Alias (reparse point) y el
// spawn sin shell de Node no siempre lo resuelve aunque `where wt` si lo encuentre
// desde una consola normal -> el fallback nunca se disparaba de forma confiable y a
// veces no se abria nada. cmd.exe siempre esta disponible, asi que se simplifico a
// solo eso.
async function openTerminal(id) {
  const p = getProject(id);
  if (!p) throw new Error(`Proyecto no encontrado: ${id}`);
  const cwd = resolveCmdPath(p);
  if (!cwd) {
    throw new Error('Este proyecto no tiene solutionPath ni folderPath configurados.');
  }
  if (!pathExists(cwd)) {
    throw new Error(`No se encontro la carpeta: ${cwd}`);
  }

  const tmpDir = path.join(os.tmpdir(), 'dev-launcher');
  fs.mkdirSync(tmpDir, { recursive: true });
  const batPath = path.join(tmpDir, `cd-term-${p.id}.cmd`);
  const batBody = `@echo off\r\ncd /d "${cwd.replace(/"/g, '""')}"\r\ncls\r\n`;
  fs.writeFileSync(batPath, batBody, 'utf8');

  await new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/K', batPath], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = {
  getProjects,
  getProject,
  resolveSolutions,
  openProject,
  openVisualStudio,
  openVSCode,
  openCmd,
  getGitStatus,
  openTerminal
};
