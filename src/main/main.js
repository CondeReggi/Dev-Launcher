'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain } = require('electron');
const ipcHandlers = require('./ipcHandlers');
const environment = require('../services/environmentService');
const elevation = require('../utils/elevation');
const logger = require('../utils/logger');

const ICON_PATH = path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let balloonShown = false;
let closeDialogOpen = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Dev Launcher',
    backgroundColor: '#0f172a',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // La X pregunta que hacer (en vez de cerrar u ocultar directo). El dialogo es
  // propio de la app (renderer, `closeConfirmView.js`), no el nativo de Electron
  // (asi respeta el tema/diseno): se le avisa al renderer por IPC y la decision
  // vuelve por 'app:closeDecision'. "Salir" desde el menu del tray marca
  // isQuitting antes de llamar app.quit() y evita este flujo (ver mas abajo).
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    if (closeDialogOpen) return;
    closeDialogOpen = true;
    mainWindow.webContents.send('app:confirmClose');
  });
}

function applyCloseDecision(decision) {
  closeDialogOpen = false;
  if (decision === 'quit') {
    isQuitting = true;
    app.quit();
  } else if (decision === 'restart') {
    isQuitting = true;
    app.relaunch();
    app.quit();
  } else if (decision === 'minimize') {
    mainWindow.hide();
    if (!balloonShown && tray) {
      tray.displayBalloon({
        title: 'Dev Launcher',
        content: 'Sigue corriendo en la bandeja. Click derecho en el icono para salir.'
      });
      balloonShown = true;
    }
  }
  // decision === 'cancel' (o cualquier otra cosa): no hacemos nada, sigue abierta.
}

function showAndNavigate(view) {
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('tray:navigate', view);
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('Dev Launcher');

  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar Dev Launcher', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Proyectos', click: () => showAndNavigate('projects') },
    { label: 'Mis tareas (Jira)', click: () => showAndNavigate('jira') },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => {
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

// Respuesta del modal propio de "cerrar" (closeConfirmView.js), separado del
// registro generico de ipcHandlers.js porque depende de estado local a este
// modulo (mainWindow/tray/isQuitting), igual que 'tray:navigate' mas arriba.
ipcMain.handle('app:closeDecision', (_evt, decision) => {
  applyCloseDecision(decision);
});

app.whenReady().then(async () => {
  ipcHandlers.register();

  // Auto-elevacion: si la app NO corre como admin, relanzarla elevada (dispara UAC).
  // Si el usuario acepta, relaunchAsAdmin() abre la instancia elevada y cierra esta.
  // Si cancela el UAC (throw), seguimos en modo normal (el panel ofrece un boton
  // para reintentar). Solo en Windows.
  if (process.platform === 'win32') {
    try {
      if (!(await elevation.isElevated())) {
        await elevation.relaunchAsAdmin();
        return; // esta instancia se esta cerrando; la elevada toma el control
      }
    } catch (e) {
      logger.warn('Auto-elevacion no completada (se sigue sin admin):', e.message);
    }
  }

  createWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Matar los dev servers en segundo plano al cerrar (evita huerfanos con puertos ocupados).
app.on('before-quit', () => {
  isQuitting = true;
  try { environment.killAllSync(); }
  catch (e) { logger.error('killAllSync:', e); }
});

process.on('uncaughtException', err => logger.error('Uncaught:', err));
