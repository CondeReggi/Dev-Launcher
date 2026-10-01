'use strict';

/**
 * PLANTILLA committeada. Copia a apps.config.js (gitignored) y ajusta las rutas.
 * Paths to external applications.
 * Override these if your install differs (Community / Professional / Enterprise, custom VS Code path, etc.)
 */
module.exports = {
  visualStudio: {
    // Edition variants:
    //   C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe
    //   C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe
    //   C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe
    exePath: 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe'
  },
  vscode: {
    // Code.exe is the GUI launcher and detaches cleanly. code.cmd also works but opens a console window briefly.
    exePath: 'C:\\Users\\YOUR_USER\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
  }
};
