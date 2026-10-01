'use strict';

/**
 * PLANTILLA committeada. Copia este archivo a `projects.config.js` (gitignored) y
 * reemplaza los proyectos de ejemplo por los tuyos. Mientras no exista
 * projects.config.js, la app usa esta plantilla.
 */

/**
 * Add new projects to this array. Required: id, name. Optional: description, solutionPath, folderPath, commands.
 *   id            unique identifier (no spaces)
 *   name          display name
 *   description   shown on the card
 *   category      'dev' (default) o 'mobile' - determina en que vista del sidebar aparece
 *   group         opcional - agrupa proyectos dentro de la misma vista bajo un separador
 *                 (hr + titulo). Sin group van en el grupo principal (arriba). Los proyectos
 *                 con el mismo group deben ir consecutivos en este array.
 *   solutionPath  full path to .sln (omit to hide the "Open Visual Studio" button)
 *   solutions     array of { label, path } - para monorepos con varias .sln: renderiza un boton
 *                 "Abrir VS: <label>" por cada una. Si esta, ignora solutionPath. La primera es
 *                 la principal (la que abre "Abrir todo").
 *   folderPath    full path to the folder VS Code should open (omit to hide the "Open VS Code" button)
 *   cmdPath       full path para "Abrir CMD (admin)". Default: la carpeta de la .sln principal,
 *                 o folderPath si no hay .sln. Util en monorepos (consola en la raiz).
 *   commands      array of { label, command, description? } - shown in the detail panel with a Copy button
 *   warning       optional string - rendered as a highlighted warning box in the detail panel
 *   emulator      ver services/emulatorService.js - boton "Iniciar emulador" (mobile)
 *   apkBuild      ver services/apkBuildService.js - boton "Generar APK" (mobile, MAUI):
 *                 { projectDir, csprojPath, targetFramework?, configuration?,
 *                   constantsFile?, environments?: [{id,label,baseUrl}], defaultEnv? }.
 *                 constantsFile/environments[].baseUrl son opcionales - solo hacen
 *                 falta si el proyecto hardcodea la URL de backend en un archivo de
 *                 constantes (en vez de un .env por ambiente).
 */
module.exports = [
  // Proyecto simple: una .sln + carpeta para VS Code + comandos copiables.
  {
    id: 'mi-api',
    name: 'Mi API',
    description: 'Ejemplo: Web API .NET con frontend React.',
    solutionPath: 'C:\\Users\\YOUR_USER\\source\\repos\\MiApi\\MiApi.sln',
    folderPath:   'C:\\Users\\YOUR_USER\\source\\repos\\MiApi\\frontend',
    warning: 'Opcional: texto destacado en el panel de detalle.',
    // Boton "Levantar ambiente" (ver services/environmentService.js): corre los
    // procesos en segundo plano, en orden, esperando cada puerto.
    environment: {
      label: 'Levantar ambiente',
      trustDevCert: false,
      checkVersions: { dotnet: '8', node: '20' },
      openUrl: 'http://localhost:3000',
      terminals: [
        {
          title: '1) Backend (:5001)',
          cwd: 'C:\\Users\\YOUR_USER\\source\\repos\\MiApi\\backend',
          env: { ASPNETCORE_ENVIRONMENT: 'Development' },
          command: 'dotnet run --launch-profile https',
          port: 5001,
          waitTimeoutSec: 240
        },
        {
          title: '2) Frontend (:3000)',
          cwd: 'C:\\Users\\YOUR_USER\\source\\repos\\MiApi\\frontend',
          command: 'npm start',
          port: 3000,
          waitTimeoutSec: 300
        }
      ]
    },
    commands: [
      {
        label: 'Backend: restore',
        command: 'dotnet restore "C:\\Users\\YOUR_USER\\source\\repos\\MiApi\\MiApi.sln"',
        description: 'Restaura paquetes NuGet de la solucion.'
      },
      {
        label: 'Frontend: dev',
        command: 'cd "C:\\Users\\YOUR_USER\\source\\repos\\MiApi\\frontend"; npm start',
        description: 'Levanta el frontend en modo desarrollo.'
      }
    ]
  },

  // Monorepo con varias .sln: un boton "Abrir VS: <label>" por cada una.
  {
    id: 'mi-monorepo',
    name: 'Mi Monorepo',
    description: 'Ejemplo: monorepo con varias soluciones.',
    group: 'Monorepos',
    solutions: [
      { label: 'Api',     path: 'C:\\Users\\YOUR_USER\\source\\repos\\MiMonorepo\\Api\\Api.sln' },
      { label: 'Workers', path: 'C:\\Users\\YOUR_USER\\source\\repos\\MiMonorepo\\Workers\\Workers.sln' }
    ],
    folderPath: 'C:\\Users\\YOUR_USER\\source\\repos\\MiMonorepo',
    cmdPath:    'C:\\Users\\YOUR_USER\\source\\repos\\MiMonorepo'
  },

  // App mobile React Native / Expo con boton "Iniciar emulador".
  {
    id: 'mi-app-rn',
    name: 'Mi App (React Native)',
    description: 'Ejemplo: app Expo. Se abre en VS Code y se trabaja desde la consola.',
    category: 'mobile',
    folderPath: 'C:\\Users\\YOUR_USER\\source\\repos\\MiAppRN',
    emulator: {
      projectDir: 'C:\\Users\\YOUR_USER\\source\\repos\\MiAppRN',
      envs: ['testing', 'production'],
      defaultEnv: 'testing',
      avds: ['Pixel_6'],
      defaultAvd: 'Pixel_6'
    },
    commands: [
      { label: 'Install deps', command: 'cd "C:\\Users\\YOUR_USER\\source\\repos\\MiAppRN"; npm install' }
    ]
  },

  // App mobile .NET MAUI con emulador + "Generar APK".
  {
    id: 'mi-app-maui',
    name: 'Mi App (MAUI)',
    description: 'Ejemplo: app .NET MAUI.',
    category: 'mobile',
    solutionPath: 'C:\\Users\\YOUR_USER\\source\\repos\\MiAppMaui\\MiAppMaui.sln',
    folderPath:   'C:\\Users\\YOUR_USER\\source\\repos\\MiAppMaui',
    emulator: {
      type: 'maui',
      projectDir: 'C:\\Users\\YOUR_USER\\source\\repos\\MiAppMaui\\MiAppMaui',
      csprojPath: 'C:\\Users\\YOUR_USER\\source\\repos\\MiAppMaui\\MiAppMaui\\MiAppMaui.csproj',
      targetFramework: 'net8.0-android',
      avds: ['Pixel_6'],
      defaultAvd: 'Pixel_6'
    },
    apkBuild: {
      projectDir: 'C:\\Users\\YOUR_USER\\source\\repos\\MiAppMaui\\MiAppMaui',
      csprojPath: 'C:\\Users\\YOUR_USER\\source\\repos\\MiAppMaui\\MiAppMaui\\MiAppMaui.csproj',
      targetFramework: 'net8.0-android',
      configuration: 'Release',
      constantsFile: 'C:\\Users\\YOUR_USER\\source\\repos\\MiAppMaui\\MiAppMaui\\Constants\\DataServiceConstants.cs',
      constantName: 'BaseURL',
      environments: [
        { id: 'testing',    label: 'Testing',    baseUrl: 'http://YOUR_TST_HOST:8080/api/' },
        { id: 'production', label: 'Produccion', baseUrl: 'http://YOUR_PRD_HOST:8080/api/' }
      ],
      defaultEnv: 'testing'
    }
  },

  // Esta misma app.
  {
    id: 'dev-launcher',
    name: 'Dev Launcher',
    description: 'Esta misma app - Electron + Node. Solo se abre en VS Code (no hay .sln).',
    folderPath: 'C:\\Users\\YOUR_USER\\source\\repos\\dev-launcher',
    commands: [
      { label: 'Install deps', command: 'npm install' },
      { label: 'Start app', command: 'npm start' },
      { label: 'Start app (DevTools)', command: 'npm run dev' }
    ]
  }
];
