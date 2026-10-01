# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install deps (Electron + qrcode + xlsx).
- `npm start` — launch the Electron app.
- `npm run dev` — launch with detached DevTools.
- No test, lint, or build scripts exist. The app runs directly from `src/` (no bundler).

## Platform

Windows-only. The elevation flow (`Start-Process -Verb RunAs`) and all configured paths are Windows-specific. Any change touching the launcher must keep the PowerShell + UAC contract intact.

## Architecture

Electron app split into the standard three layers, all in `src/`:

- **`main/`** — Node-side entry. `main.js` boots the `BrowserWindow` (sandboxed: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`), then `ipcHandlers.register()` wires every `ipcMain.handle()` channel. `preload.js` is the only bridge to the renderer; it exposes a curated `window.api` via `contextBridge`. **Adding a feature that needs Node access requires touching all three: a new handler in `ipcHandlers.js`, a new method on `preload.js`, and a renderer caller.**
- **`renderer/`** — Sandboxed UI. No bundler; `index.html` loads each view as a plain `<script>`. `app.js` is a tiny router that toggles `.active` on `<section>` elements based on sidebar buttons, and dispatches a `document` `CustomEvent('view:change', { detail: { view } })` on every switch. Views that should not hit the backend at startup listen for that event and lazy-load on first activation (e.g. `deudasView` shows a spinner and calls `deudas.get()` only the first time the Deudas section is opened, so app boot stays fast). Views are self-contained IIFEs (e.g. `views/projectsView.js`) that talk to the main process only through `window.api`. CSP is strict: no `unsafe-eval`, no remote sources except `data:` images for QR output.
- **`services/`** — Business logic, called from `ipcHandlers.js`. Each service owns one feature area:
  - `projectLauncherService` → reads `config/projects.config.js`, calls `utils/adminLauncher.openAsAdmin()` to launch VS / VS Code elevated.
  - `emulatorService` → boton "Iniciar emulador" de los proyectos mobile. Si un proyecto declara un bloque `emulator: { projectDir, envs[], defaultEnv, avds[], defaultAvd }`, la card mobile muestra un panel con selector de ambiente/AVD, barra de progreso y log. Spawnea **sin elevacion** `scripts/emulator/start-emulator.ps1` (portado de `APP Mobile/scripts/dev-start.ps1`, parametrizado por `-ProjectDir`/`-Env`/`-Avd`): lanza el AVD con `-gpu swiftshader_indirect`, espera boot, geo fix Montevideo, selecciona `.env.<env>` (via `scripts/use-env.js` del proyecto o copiando el archivo) y abre `npx expo start` en una terminal nueva. El script emite lineas `@@PROGRESS@@ <pct> <msg>` / `@@LOG@@ <msg>` / `@@DONE@@` que el servicio parsea y reenvia por `emulator:log` para pintar la barra. Ops IPC: `emulator:start` / `emulator:cancel`.
  - `qrParserService` → DGI/SUCIVE QR parser. The `HEADER_FIELDS` / `LINE_FIELDS` arrays are the source of truth for column ordering and mirror C# `QrDatos` / `QrDatosValidado` from the B2B BO `ValidarQr` flow. **If a real QR card disagrees with the parser, edit those arrays — order matters.**
  - `sendQrService` → port of the legacy C# `SendQrRequest` console app. Five operations (`qr`, `entidades`, `convenios`, `usuarios`, `identity`), each streaming progress back through `evt.sender.send('sendqr:log', …)`.
  - `b2bCredentialsService` → Azure AD B2C ROPC → decode JWT → POST `Auth/login`. Streams logs through `b2b:log`.
  - `configService` → layered config for sendQr (see below).
  - `deudasService` → personal debt tracker (debtors → debt line items, paid/unpaid toggle, auto audit `history`). Persists plain JSON to `app.getPath('userData')/deudas.json` (no secrets, not in repo). Every mutation returns `{ state, debtorId, ... }` where `state` is the fully computed view (per-debtor + global totals via `computeTotals`); the renderer re-renders from that single source of truth. Lives in the **Finanzas** sidebar group (workshop `personal`). Modeled after the desktop `Deudas_new.xlsx`. Extra ops:
    - `registerPayment(debtorId, amount, note, date)` → applies a payment by marking the **maximum number of unpaid debts** as paid (cheapest-first to maximize the item count); leftover becomes the debtor's `credit` ("saldo a favor") and is reused on the next payment. `netBalance = outstanding - credit` (>0 still owes, <0 overpaid).
    - `addSharedDebt({ description, totalAmount, date, debtorIds })` → adds the same debt line to N debtors at once with `amount = total / N` (rounded to 2 decimals; the last debtor absorbs the rounding remainder so the sum stays exact). Default `date` is today (ISO). Logs one `shared` history entry per debtor so it shows up in each one's per-debtor history.
    - `importFromXlsx(path)` → parses the `Deudas de los pibes` / `Deudas trabajo` sheets (5-column blocks per debtor: header `[name, '', total]`, then rows `[desc, amount, excelDate, 'X'?]`). Merges by name (skips existing). Verified: re-importing `Deudas_new.xlsx` reproduces its declared "Importe Total de Deudas" exactly.
    - `exportDebtor(debtorId, path)` → writes a per-debtor `.xlsx` (sheets Resumen / Deudas / Pagos) via the `xlsx` dep. The IPC handlers `deudas:import` / `deudas:export` own the open/save dialogs (default dir = `app.getPath('desktop')`).
    - `exportDebtors(debtorIds, path, { onlyPending })` → export selectivo: un `.xlsx` con una hoja `Resumen` (fila por deudor + fila TOTAL) y una hoja de detalle por deudor (deudas + pagos). Los nombres de hoja se sanean/desambiguan (`sheetName`, limite 31 chars de Excel). `onlyPending` omite las deudas ya cobradas del detalle, pero el Resumen siempre muestra los totales completos. Handler `deudas:exportMany`; el modal `#dd-export-modal` en el renderer elige los deudores (misma UI de checkboxes que el gasto compartido).
    - `exportBackup(path)` / `importBackup(path)` → dump/replace the whole `deudas.json` as a JSON backup. Restore validates shape (must have `debtors[]`) and copies the current file to `deudas.json.bak` before overwriting. Handlers `deudas:backup` / `deudas:restore`; the renderer confirms before restoring.
  - `gastosStatsService` → "Estadisticas de Gastos" (own sidebar item next to Deudas, not the "Mis Gastos" fixed-expenses tab). Imports a monthly bank statement export (`.xlsx`/`.xls`, one file per month, "AccountMovementsExtended"-style: `Fecha, Referencia, Tipo Movimiento`(=description)`, Debito, Credito, Saldo`), auto-categorizes every movement with an ordered list of keyword→category `categoryRules` (first match wins; seeded from real DUCSA-unrelated personal-banking descriptions), and computes per-month stats (gastos/ingresos/balance, spend by category, top merchants) plus a cross-month comparison array. Persists to `userData/gastosStats.json`. Movement `id` is a composite string `date|reference|amount|occurrence` (not a hash) so re-importing the same month's file matches existing rows and preserves any `categorySource: 'manual'` override instead of recalculating it; only `categorySource: 'auto'` rows get re-categorized on reimport. Editing `categoryRules`/`categories` (add/remove) only affects future imports, never retroactively recategorizes stored months. Handler `gastosStats:import` opens the file dialog defaulting to `app.getPath('downloads')`.

### Elevation contract (`utils/adminLauncher.js`)

Every "open in VS/VS Code" path goes through `openAsAdmin(exePath, args)`. The flow:

1. Build a PowerShell script that calls `Start-Process -FilePath '<exe>' -ArgumentList '<args>' -Verb RunAs`.
2. Encode it as UTF-16LE base64 and pass via `-EncodedCommand` — this avoids a shell-escaping layer and survives paths with spaces / quotes.
3. Inside the script, single-quoted PS strings escape `'` by doubling; the outer `ArgumentList` wraps each user arg in `"…"` (with internal `"` escaped as `\"`) so the target exe re-parses each arg as one token.
4. PowerShell exit code 0 → success. Non-zero stderr matching `cancel*` → `"UAC cancelado por el usuario."`; otherwise raw stderr.

Do not switch to `child_process.exec` or stringify the args differently — the encoding scheme is load-bearing for paths like `C:\Program Files\…` and project folders with spaces.

### Layered config for sendQr / DUCSA Tools / B2B

`configService.getEffective()` deep-merges `src/config/sendQr.config.js` (baseline, gitignored, contains real DUCSA secrets) with `src/config/sendQr.overrides.json` (gitignored, written by the Settings UI). **Both files are re-read on every call** — no app restart needed after Settings save. The Settings modal writes only the overrides file; the baseline is never mutated by the UI. `b2bCredentials` and the four sendQr operations all read from the same effective config, so changes in the modal apply immediately to the next Run.

`auth.clientSecretEncrypted` in `sendQr.config.js` is AES-256-CBC encrypted with the fixed key/IV in `utils/aesCbc.js` (mirrors C# `AesEncryption.cs`). To rotate: `node -e "console.log(require('./src/utils/aesCbc').encrypt('PLAINTEXT'))"`.

`configService.getEffective()` also normalizes a top-level `app` section (`ensureAppDefaults`) so general renderer preferences (currently `CUENTA_A_TRANSFERIR`, the bank account string copied by the icon next to the Deudas title) always exist as editable strings in the "App" tab of the Settings modal — even if the user's `sendQr.config.js` doesn't declare them. Overrides for the App tab go to the same `sendQr.overrides.json`.

### IPC response convention

Every handler returns `{ ok: true, data }` or `{ ok: false, error: string }`. The `ok()` / `fail()` helpers in `ipcHandlers.js` enforce this. Renderer code can rely on this shape uniformly.

## Adding a project

Edit `src/config/projects.config.js` (gitignored; copy of `projects.config.example.js`) and append an object: `{ id, name, description?, solutionPath?, solutions?, folderPath?, cmdPath?, commands?, warning? }`. `solutionPath` / `folderPath` are independently optional — omitting one hides the corresponding button. `commands[]` items render in the detail panel with a Copy button. Reload the renderer (`Ctrl+R`) to pick up changes.

For a monorepo with several `.sln` (e.g. `integrador`), declare `solutions: [{ label, path }]` instead of `solutionPath` — the detail panel renders one "Abrir VS: `<label>`" button per entry. `solutions[0]` is the primary: it's the only one "Abrir todo" launches (opening N solutions would mean N UAC prompts) and the one `resolveCmdPath()` falls back to. Set `cmdPath` to override where "Abrir CMD (admin)" lands — needed in monorepos, where the console belongs at the root rather than inside the primary solution's folder. `projectLauncherService.resolveSolutions()` normalizes both shapes into one array, so the rest of the code only ever sees `solutions[]`.

## Adding a sidebar section

1. Button in `index.html` `<nav>` with `data-view="<name>"`.
2. `<section id="view-<name>" class="view">` in `<main>`.
3. Add the section to the `views` map in `renderer/app.js`.
4. Create `renderer/views/<name>View.js` (IIFE pattern, talks only to `window.api`) and add a `<script>` tag at the bottom of `index.html`.
5. If backend access is needed: handler in `ipcHandlers.js` + method in `preload.js`'s `contextBridge.exposeInMainWorld('api', …)`.
6. Tag the enclosing `.nav-group` with `data-workshop="personal"` or `"trabajo"` (see Workshops). A group with no `data-workshop` only shows under "Todos" — it's hidden in both filtered workshops.

## Workshops

`renderer/workshop.js` filters which sidebar `.nav-group`s are visible based on a workshop preference stored in `localStorage` (`devlauncher.workshop`, default `todos`). Each group declares its workshop via `data-workshop` in `index.html`: `personal` → Media; `trabajo` → Dev / QR / DUCSA / Push; `todos` shows all. The switcher is a collapsible dropdown (`#workshop-switcher`) at the bottom of the sidebar (where "Solo uso local" used to be) — click the toggle to expand the three options. It applies instantly — no Save, no IPC, no app restart. If the active view's group gets hidden, the manager jumps to the first visible nav item. `window.__workshop` exposes `{ get, set, apply, WORKSHOPS }`; it depends on `window.__router` from `app.js`, so its `<script>` tag must load after `app.js`.

## Secrets / gitignore

`src/config/sendQr.config.js` and `src/config/sendQr.overrides.json` are gitignored — they hold real DUCSA prod and test credentials (Azure B2C, Identity Server, ROPC users, etc.). Never commit them, never paste their contents into PRs or logs.

The repo (remote `https://github.com/CondeReggi/Dev-Launcher.git`) only ships templates. Gitignored real files → committed template: `sendQr.config.js` → `sendQr.config.example.js`, `oneSignal.config.js` → `oneSignal.config.example.js`, `projects.config.js` → `projects.config.example.js`, `apps.config.js` → `apps.config.example.js` (same in `dev-launcher-team/` and `onesignal-directo-app/`). `utils/localConfig.js` (`loadConfig(name)` / `resolveConfigPath(name)`) loads the real file and falls back to the `.example.js`, so a fresh clone boots. **When adding a new config key, add it (with a placeholder) to the matching `.example.js` too.** The AES key/IV for `aesCbc.js` live in `sendQr.config.js` under `aes: { keyBase64, ivBase64 }` — never hardcode them back into the util.
