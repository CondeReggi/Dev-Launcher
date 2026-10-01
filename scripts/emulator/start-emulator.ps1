<#
  Levanta el emulador Android de un proyecto React Native / Expo y deja el dev
  server de Expo corriendo en una terminal aparte. Portado de
  "APP Mobile/scripts/dev-start.ps1" pero parametrizado por -ProjectDir para
  poder dispararlo desde Dev Launcher contra cualquier proyecto.

  A diferencia del original, emite lineas de progreso machine-parseables para que
  la UI de Electron pinte una barra de progreso y muestre en que paso va:

    @@PROGRESS@@ <pct> <mensaje>     -> avance 0..100 + etiqueta del paso
    @@LOG@@ <mensaje>                -> linea de log informativa
    @@DONE@@                         -> termino OK

  Los errores se escriben a stderr y el script sale con codigo != 0.

  Uso:
    powershell -ExecutionPolicy Bypass -File start-emulator.ps1 `
      -ProjectDir "C:\Users\YOUR_USER\source\repos\APP Mobile" -Env testing -Avd Pixel_6

  Pasos: lanza el AVD (con el fix de GPU swiftshader) -> espera boot -> geo fix
  Montevideo -> selecciona el .env del ambiente -> abre `npx expo start` en una
  ventana nueva (ahi se presiona 'a' para abrir la app o se escanea el QR).
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectDir,
  [ValidateSet('testing', 'production')]
  [string]$Env = 'testing',
  [string]$Avd = 'Pixel_6',
  # Carpeta de node/npx resuelta por Electron (donde el filesystem no miente).
  # Se antepone al PATH para que `npx expo start` funcione aunque el PATH heredado
  # venga recortado (caso tipico cuando la app corre elevada).
  [string]$NodeDir = ''
)

# 'Continue' a proposito (no 'Stop'): adb escribe mensajes normales a stderr (ej.
# "* daemon not running; starting now") y en PowerShell 5.1, bajo 'Stop', el stderr
# de un .exe nativo se vuelve un error TERMINANTE que aborta el script. Igual
# cortamos donde importa con `throw` explicito (que termina y sale con codigo != 0).
$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8

# Electron suele spawnear PowerShell con un PATH recortado donde no estan node/npx.
# Reconstruimos el PATH real desde el registro (Machine + User) -> lo mismo que ve
# una consola normal. La ventana de Expo (proceso hijo) hereda este PATH arreglado.
$machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = (@($NodeDir, $machinePath, $userPath) | Where-Object { $_ }) -join ';'

function Emit-Progress([int]$pct, [string]$msg) { Write-Host "@@PROGRESS@@ $pct $msg" }
function Emit-Log([string]$msg)               { Write-Host "@@LOG@@ $msg" }

# Hay al menos un device en estado 'device' (online)? Durante el boot el emulador
# figura como 'offline', por eso distinguimos online de mera presencia.
function Test-DeviceOnline([string]$adbPath) {
  $lines = & $adbPath devices 2>$null
  return [bool]($lines | Where-Object { $_ -match '^\S+\s+device(\s|$)' })
}

# Ubica npx.cmd por su cuenta (sin depender de que Electron pase -NodeDir). El
# script se lee del disco en cada corrida, asi que esto siempre esta vigente aunque
# el servicio en memoria sea viejo. npx.cmd encuentra su propio node.exe al lado,
# por lo que invocarlo por ruta absoluta funciona aun con el PATH recortado.
function Resolve-NpxCmd([string]$NodeDir) {
  $cands = @()
  if ($NodeDir) { $cands += (Join-Path $NodeDir 'npx.cmd') }
  if ($env:ProgramFiles)         { $cands += (Join-Path $env:ProgramFiles 'nodejs\npx.cmd') }
  if (${env:ProgramFiles(x86)})  { $cands += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\npx.cmd') }
  if ($env:LOCALAPPDATA)         { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\npx.cmd') }
  foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  # Ultimo intento: el PATH reconstruido del registro.
  $cmd = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# --- 0. Validaciones de entorno ---
Emit-Progress 3 "Verificando proyecto y Android SDK..."
if (-not (Test-Path -LiteralPath $ProjectDir)) { throw "No existe la carpeta del proyecto: $ProjectDir" }
Set-Location -LiteralPath $ProjectDir

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emu = Join-Path $sdk 'emulator\emulator.exe'
if (-not (Test-Path $adb)) { throw "No se encontro adb en $adb" }
if (-not (Test-Path $emu)) { throw "No se encontro emulator en $emu" }
Emit-Log "Proyecto: $ProjectDir | Ambiente: $Env | AVD: $Avd"

# --- 1. Hay un device/emulador online ya conectado? ---
Emit-Progress 8 "Chequeando devices conectados..."
if (Test-DeviceOnline $adb) {
  Emit-Progress 18 "Ya hay un device conectado, reuso."
  Emit-Log "Device ya online: no se lanza un emulador nuevo."
} else {
  $avds = & $emu -list-avds
  if ($avds -notcontains $Avd) {
    throw "El AVD '$Avd' no existe. Disponibles: $($avds -join ', ')"
  }
  # Limpieza: restos de crashes previos (crashpad_handler) dejan a adb confundido.
  $stale = Get-Process crashpad_handler -ErrorAction SilentlyContinue
  if ($stale) {
    Emit-Log "Limpiando $($stale.Count) proceso(s) crashpad_handler de arranques previos."
    $stale | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Emit-Progress 12 "Reiniciando servidor adb..."
  & $adb kill-server  2>$null | Out-Null
  & $adb start-server 2>$null | Out-Null

  Emit-Progress 15 "Lanzando emulador $Avd (cold boot)..."
  Emit-Log "Lanzando AVD ${Avd}: -no-snapshot-load (arranque limpio) + -gpu swiftshader_indirect."
  # -no-snapshot-load: arranca en frio. Un snapshot guardado corrupto hace que el
  #   emulador crashee al instante (solo queda crashpad_handler) y el wait cuelgue.
  # -gpu swiftshader_indirect: render por software (el de hardware crashea aca con
  #   "GPU emulation failed to initialize").
  Start-Process -FilePath $emu -ArgumentList '-avd', $Avd, '-no-snapshot-load', '-gpu', 'swiftshader_indirect', '-no-boot-anim', '-netdelay', 'none', '-netspeed', 'full' -WindowStyle Minimized
}

# --- 2. Esperar el boot (un cold boot puede tardar ~2 min) ---
Emit-Progress 20 "Esperando boot del emulador..."
$booted = ''
$maxTries = 60          # 60 * 3s = 180s tope
$recovered = $false
for ($i = 0; $i -lt $maxTries -and $booted -ne '1'; $i++) {
  if (Test-DeviceOnline $adb) {
    $booted = (& $adb shell getprop sys.boot_completed 2>$null)
    if ($booted) { $booted = $booted.Trim() }
  }
  if ($booted -ne '1') {
    # Recuperacion unica (~30s) si el device ni siquiera aparece: reiniciar adb.
    if (-not $recovered -and $i -ge 10 -and -not (Test-DeviceOnline $adb)) {
      Emit-Log "El device no aparece todavia; reiniciando adb server (recuperacion)."
      & $adb kill-server  2>$null | Out-Null
      & $adb start-server 2>$null | Out-Null
      $recovered = $true
    }
    # Mapear las iteraciones a 20..75% para que la barra avance mientras bootea.
    $pct = 20 + [int](($i / [double]$maxTries) * 55)
    Emit-Progress $pct "Booteando emulador... ($($i + 1)/$maxTries)"
    Start-Sleep -Seconds 3
  }
}
if ($booted -ne '1') { throw 'El emulador no termino de bootear a tiempo. Revisa la ventana del emulador.' }
Emit-Progress 80 "Emulador booteado."
Emit-Log "Emulador listo (sys.boot_completed=1)."

# --- 3. Ubicacion de dev (Montevideo) para expo-location ---
Emit-Progress 85 "Fijando ubicacion (Montevideo)..."
& $adb shell settings put secure location_mode 3 | Out-Null
& $adb shell cmd location set-location-enabled true | Out-Null
& $adb emu geo fix -56.214240 -34.871751 | Out-Null
Emit-Log "Geo fix fijado (Montevideo)."

# --- 4. Seleccionar el .env del ambiente ---
# Equivale a use-env.js: copia .env.<env> -> .env (lo que Expo lee). Lo hacemos en
# PS para no depender de node aca; node/npx solo se usan ya para `expo start`.
Emit-Progress 92 "Seleccionando ambiente .env ($Env)..."
$envSrc = Join-Path $ProjectDir ".env.$Env"
if (-not (Test-Path -LiteralPath $envSrc)) { throw "No existe el archivo .env.$Env en el proyecto." }
Copy-Item -LiteralPath $envSrc -Destination (Join-Path $ProjectDir '.env') -Force
Emit-Log "Ambiente activo: $Env (.env <- .env.$Env)."

# --- 5. Dev server de Expo en una terminal nueva ---
Emit-Progress 97 "Abriendo Expo en una terminal nueva..."
$dirEsc = $ProjectDir -replace "'", "''"
# La ventana nueva NO hereda confiablemente el $env:Path que arreglamos arriba
# (Start-Process no siempre propaga las modificaciones de sesion), asi que la
# obligamos a reconstruir el PATH: primero la carpeta de node que nos paso Electron
# (lo mas confiable), luego Machine + User del registro.
# El script resuelve npx por su cuenta (no depende de -NodeDir / del servicio).
# `expo start --android` abre la app sola en el emulador (= presionar 'a'); instala
# Expo Go si falta y la lanza apenas Metro esta listo.
$npxCmd = Resolve-NpxCmd $NodeDir
if ($npxCmd) {
  $npxDir = Split-Path -Parent $npxCmd
  $npxInvoke = "& '$($npxCmd -replace "'", "''")' expo start --android"
  Emit-Log "Usando npx por ruta absoluta: $npxCmd"
} else {
  $npxDir = $NodeDir
  $npxInvoke = 'npx expo start --android'
  Emit-Log "No se ubico npx.cmd; se intentara 'npx' desde el PATH del sistema."
}

# Anteponer la carpeta de npx/node al PATH de la ventana de Expo (por si expo o
# metro shellean a node/git/etc.), ademas de Machine + User del registro.
$npxDirEsc = $npxDir -replace "'", "''"
$pathFix = "`$env:Path = '$npxDirEsc;' + [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')"

$expoCmd = "$pathFix; Set-Location -LiteralPath '$dirEsc'; Write-Host 'Expo dev server -- ambiente: $Env. Presiona ''a'' para abrir en Android.' -ForegroundColor Cyan; $npxInvoke"
# Sin -Verb RunAs a proposito (el dev-start.ps1 original tampoco elevaba, y expo/adb
# no lo necesitan): asi la ventana queda al mismo nivel de integridad que Dev
# Launcher, que puede despues cerrarla por PID desde "Detener todo" sin pedir un
# segundo UAC (un proceso elevado no se puede terminar desde uno no elevado).
$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-NoProfile', '-Command', $expoCmd -PassThru
Emit-Log "@@TERMPID@@ $($proc.Id)"
Emit-Log "Expo abierto en otra ventana. Presiona 'a' alli para abrir la app, o escanea el QR."

Emit-Progress 100 "Listo. Emulador arriba y Expo corriendo."
Write-Host "@@DONE@@"
exit 0
