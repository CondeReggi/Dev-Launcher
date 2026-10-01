# Dev Launcher

Dashboard local (Electron + Node.js) para Windows que:

- Abre proyectos en **Visual Studio 2022** y **VS Code** como **administrador** (UAC).
- Genera **codigos QR** desde un string y los descarga como PNG.
- Parsea un **QR string DGI/SUCIVE** (formato `cabecera|linea|linea`) y muestra cada valor mapeado a su clave de `QrDatos` y a la propiedad equivalente de `QrDatosValidado`.
- Es modular: agregar proyectos = editar un archivo, agregar secciones = montar otra view.

> ATENCION: esta app ejecuta procesos locales con elevacion. **No la expongas a internet** y no compartas tu `projects.config.js` sin revisarlo. Pensada para uso personal en tu equipo.

## Requisitos

- Windows 10/11
- Node.js >= 18 (probado en 20.x)
- Visual Studio 2022 (Community / Professional / Enterprise)
- Visual Studio Code

## Instalacion

```powershell
git clone https://github.com/CondeReggi/Dev-Launcher.git
cd Dev-Launcher
npm install
```

## Configuracion local (plantillas)

El repo **no** incluye credenciales ni datos reales. Cada archivo de config tiene una
plantilla committeada (`*.config.example.js`); la version real (`*.config.js`) esta en
`.gitignore`. Si el archivo real no existe, la app arranca usando la plantilla.

```powershell
cd src\config
copy projects.config.example.js projects.config.js   # tus proyectos y rutas
copy apps.config.example.js     apps.config.js       # rutas a devenv.exe / Code.exe
copy sendQr.config.example.js   sendQr.config.js     # DUCSA Tools / B2B / Graph / Plexo / Factura / Reportes
copy oneSignal.config.example.js oneSignal.config.js # OneSignal + SQL
```

| Archivo (gitignored) | Plantilla | Contenido |
|---|---|---|
| `src/config/projects.config.js` | `projects.config.example.js` | Proyectos, rutas locales, comandos, ambientes |
| `src/config/apps.config.js` | `apps.config.example.js` | Rutas a Visual Studio / VS Code |
| `src/config/sendQr.config.js` | `sendQr.config.example.js` | URLs, client ids/secrets, usuarios, connection strings, clave AES |
| `src/config/oneSignal.config.js` | `oneSignal.config.example.js` | App ID / REST API key de OneSignal, connection string |
| `src/config/*.overrides.json` | — | Lo que guarda el modal de Configuracion (Jira, cuenta, etc.) |

Lo mismo aplica a las subapps `dev-launcher-team/` y `onesignal-directo-app/`.
Los datos personales (deudas, gastos, calistenia) viven en `%APPDATA%` (`userData`), nunca en el repo.

## Ejecucion

```powershell
npm start
```

Para abrir DevTools en una ventana lateral:

```powershell
npm run dev
```

## Configurar las rutas de las apps

Editar `src/config/apps.config.js` (copiado de `apps.config.example.js`):

```js
module.exports = {
  visualStudio: {
    exePath: 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe'
  },
  vscode: {
    exePath: 'C:\\Users\\<USER>\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
  }
};
```

Variantes tipicas de Visual Studio:

- Community:    `...\2022\Community\Common7\IDE\devenv.exe`
- Professional: `...\2022\Professional\Common7\IDE\devenv.exe`
- Enterprise:   `...\2022\Enterprise\Common7\IDE\devenv.exe`

VS Code system-install:

- `C:\\Program Files\\Microsoft VS Code\\Code.exe`

VS Code user-install (default):

- `C:\\Users\\<USER>\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe`

## Agregar un proyecto nuevo

Editar `src/config/projects.config.js` (copiado de `projects.config.example.js`, que trae ejemplos de cada tipo de proyecto):

```js
module.exports = [
  {
    id: 'b2b-backoffice',
    name: 'B2B Backoffice',
    description: 'Backoffice B2B - solucion .NET con frontend asociado.',
    solutionPath: 'C:\\Users\\<USER>\\source\\repos\\B2B BO\\B2B-BO.sln',
    folderPath:   'C:\\Users\\<USER>\\source\\repos\\B2B BO\\backend\\B2B-BO.API\\frontend'
  },
  // Anadir aqui:
  {
    id: 'mi-otro-proyecto',
    name: 'Mi Otro Proyecto',
    description: 'Descripcion opcional',
    solutionPath: 'C:\\ruta\\a\\la.sln',
    folderPath:   'C:\\ruta\\al\\frontend'
  }
];
```

Reglas:

- `id` debe ser unico.
- `solutionPath` y `folderPath` son **opcionales**: si omites uno, no aparece el boton respectivo en la card.
- Reinicia la app (`Ctrl+R` o `npm start`) para que tome los cambios.

## Como funciona la elevacion

`src/utils/adminLauncher.js` invoca PowerShell con un comando codificado en base64 (UTF-16LE) que ejecuta:

```powershell
Start-Process -FilePath '<exe>' -ArgumentList '"<arg con espacios>"' -Verb RunAs
```

`-Verb RunAs` dispara UAC. El uso de `-EncodedCommand` evita capas adicionales de escapado de shell que podrian romper rutas con caracteres especiales.

Manejo de paths con espacios:

- El `FilePath` se rodea de **comillas simples** PowerShell. Cualquier `'` interna se duplica.
- Cada argumento se rodea de **comillas dobles** dentro del string final, para que el ejecutable destino lo parsee como un unico token.
- Las `"` internas se escapan con `\"`.

Si el usuario cancela el UAC, PowerShell devuelve un exit code != 0 y el mensaje `"UAC cancelado por el usuario."` se muestra en la card.

## Estructura del proyecto

```
dev-launcher/
|-- package.json
|-- README.md
|-- .gitignore
|-- src/
|   |-- main/
|   |   |-- main.js              # Electron entry: BrowserWindow + IPC bootstrap
|   |   |-- preload.js           # contextBridge -> window.api
|   |   |-- ipcHandlers.js       # IPC handlers (projects:*, qr:*)
|   |-- services/
|   |   |-- projectLauncherService.js
|   |-- utils/
|   |   |-- adminLauncher.js     # Start-Process -Verb RunAs
|   |   |-- pathValidator.js
|   |   |-- logger.js
|   |-- config/
|   |   |-- projects.config.js
|   |   |-- apps.config.js
|   |-- renderer/
|       |-- index.html
|       |-- styles.css
|       |-- app.js               # router + sidebar
|       |-- views/
|           |-- projectsView.js
|           |-- qrGeneratorView.js
```

## Como agregar una nueva seccion al sidebar

1. En `src/renderer/index.html`, agregar un nuevo boton al `<nav>`:
   ```html
   <button class="nav-item" data-view="miSeccion">
     <span class="nav-icon">&#x2699;</span>
     <span>Mi Seccion</span>
   </button>
   ```
2. Agregar la `<section>` en el `<main>`:
   ```html
   <section id="view-miSeccion" class="view"> ... </section>
   ```
3. Registrar la view en `src/renderer/app.js` (objeto `views`):
   ```js
   miSeccion: document.getElementById('view-miSeccion')
   ```
4. Crear `src/renderer/views/miSeccionView.js` con la logica e incluirlo con un `<script>` al final del `index.html`.
5. Si necesita backend (ejecutar comandos, leer archivos, etc.), agrega un handler en `src/main/ipcHandlers.js` y exponé el metodo en `src/main/preload.js`.

## API expuesta al renderer

Disponible como `window.api`:

```js
window.api.listProjects();              // -> { ok, data: [...] }
window.api.openProject(id);             // -> { ok } | { ok:false, error }
window.api.openVisualStudio(id);
window.api.openVSCode(id);
window.api.generateQR(text);            // -> { ok, data: { dataUrl } }
window.api.parseQR(text);               // -> { ok, data: { qrDatos, derived, annotated, raw } }
```

Todas devuelven `{ ok: boolean, data?, error? }` para manejo uniforme en la UI.

## Seguridad

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` en el renderer.
- CSP estricta en `index.html` (sin `unsafe-eval`, sin remoto excepto imagenes data: para los QR).
- Sin servidor HTTP. Toda la comunicacion renderer <-> main es por IPC interno de Electron.
- Las rutas se validan con `fs.accessSync` antes de invocar PowerShell.
- El renderer **no** recibe acceso a `child_process`, `fs`, ni a Node APIs directamente.

## Limitaciones conocidas

- Lanzar como administrador siempre dispara UAC. No se puede evitar sin instalar la app como servicio elevado, lo cual no es recomendable.
- Si rechazas el UAC, veras "UAC cancelado por el usuario" en la card del proyecto.
- La app esta pensada para Windows; el codigo de elevacion (`Start-Process -Verb RunAs`) no funciona en Linux/macOS.

## Troubleshooting

| Sintoma | Solucion |
|---|---|
| `No se encontro devenv.exe en: ...` | Edita `src/config/apps.config.js` con tu edicion (Community/Professional/Enterprise) |
| `No se encontro VS Code en: ...` | Verifica si tienes user-install (`AppData\Local\Programs\...`) o system-install (`Program Files\...`) |
| `UAC cancelado por el usuario` | Aproba el UAC al lanzar |
| La ventana queda en blanco | `npm run dev` y revisa la consola DevTools |
| El QR no se genera | Verifica que el texto no este vacio; ver mensaje en el panel inferior |
