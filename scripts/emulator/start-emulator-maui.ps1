<#
  Levanta el emulador Android y deja corriendo `dotnet build -t:Run` para un
  proyecto .NET MAUI (Android). Comparte los pasos de arranque/boot del AVD con
  start-emulator.ps1 (React Native/Expo), pero no hay .env que elegir: las apps
  MAUI de este repo hardcodean la URL de backend en un archivo de constantes
  (ver Helpers/AppEnvironment.cs o Constants/DataServiceConstants.cs).

  Emite las mismas lineas machine-parseables que start-emulator.ps1:

    @@PROGRESS@@ <pct> <mensaje>     -> avance 0..100 + etiqueta del paso
    @@LOG@@ <mensaje>                -> linea de log informativa
    @@DONE@@                         -> termino OK

  Los errores se escriben a stderr y el script sale con codigo != 0.

  Uso:
    powershell -ExecutionPolicy Bypass -File start-emulator-maui.ps1 `
      -ProjectDir "C:\...\Distribucion Mayorista GLP" `
      -CsprojPath "C:\...\Distribucion Mayorista GLP.csproj" `
      -Avd Pixel_6 -TargetFramework net8.0-android

  Pasos: lanza el AVD (con el fix de GPU swiftshader) -> espera boot -> geo fix
  Montevideo -> `dotnet build <csproj> -f <tfm> -t:Run` en una ventana nueva
  (compila, instala el APK y lo abre en el emulador).
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectDir,
  [Parameter(Mandatory = $true)]
  [string]$CsprojPath,
  [string]$Avd = 'Pixel_6',
  [string]$TargetFramework = 'net8.0-android'
)

# 'Continue' a proposito (no 'Stop'): adb escribe mensajes normales a stderr (ej.
# "* daemon not running; starting now") y en PowerShell 5.1, bajo 'Stop', el stderr
# de un .exe nativo se vuelve un error TERMINANTE que aborta el script. Igual
# cortamos donde importa con `throw` explicito (que termina y sale con codigo != 0).
$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8

function Emit-Progress([int]$pct, [string]$msg) { Write-Host "@@PROGRESS@@ $pct $msg" }
function Emit-Log([string]$msg)               { Write-Host "@@LOG@@ $msg" }

# Hay al menos un device en estado 'device' (online)? Durante el boot el emulador
# figura como 'offline', por eso distinguimos online de mera presencia.
function Test-DeviceOnline([string]$adbPath) {
  $lines = & $adbPath devices 2>$null
  return [bool]($lines | Where-Object { $_ -match '^\S+\s+device(\s|$)' })
}

# --- 0. Validaciones de entorno ---
Emit-Progress 3 "Verificando proyecto y Android SDK..."
if (-not (Test-Path -LiteralPath $ProjectDir)) { throw "No existe la carpeta del proyecto: $ProjectDir" }
if (-not (Test-Path -LiteralPath $CsprojPath)) { throw "No existe el .csproj: $CsprojPath" }
Set-Location -LiteralPath $ProjectDir

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emu = Join-Path $sdk 'emulator\emulator.exe'
if (-not (Test-Path $adb)) { throw "No se encontro adb en $adb" }
if (-not (Test-Path $emu)) { throw "No se encontro emulator en $emu" }
Emit-Log "Proyecto: $CsprojPath | TFM: $TargetFramework | AVD: $Avd"

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
    # Mapear las iteraciones a 20..70% para que la barra avance mientras bootea.
    $pct = 20 + [int](($i / [double]$maxTries) * 50)
    Emit-Progress $pct "Booteando emulador... ($($i + 1)/$maxTries)"
    Start-Sleep -Seconds 3
  }
}
if ($booted -ne '1') { throw 'El emulador no termino de bootear a tiempo. Revisa la ventana del emulador.' }
Emit-Progress 75 "Emulador booteado."
Emit-Log "Emulador listo (sys.boot_completed=1)."

# --- 3. Ubicacion de dev (Montevideo), util para apps que piden GPS (rutas/pedidos) ---
Emit-Progress 80 "Fijando ubicacion (Montevideo)..."
& $adb shell settings put secure location_mode 3 | Out-Null
& $adb shell cmd location set-location-enabled true | Out-Null
& $adb emu geo fix -56.214240 -34.871751 | Out-Null
Emit-Log "Geo fix fijado (Montevideo)."

# --- 4. `dotnet build -t:Run` en una terminal nueva (compila, instala y abre la app) ---
Emit-Progress 90 "Abriendo dotnet build -t:Run en una terminal nueva..."
$csprojEsc = $CsprojPath -replace "'", "''"
$dirEsc = $ProjectDir -replace "'", "''"
$runCmd = "Set-Location -LiteralPath '$dirEsc'; Write-Host 'dotnet build -t:Run -- TFM: $TargetFramework' -ForegroundColor Cyan; dotnet build '$csprojEsc' -f $TargetFramework -t:Run"
# Sin -Verb RunAs a proposito: dotnet/adb no necesitan admin, y asi la ventana
# queda al mismo nivel de integridad que Dev Launcher, que puede despues cerrarla
# por PID desde "Detener todo" sin pedir un segundo UAC (un proceso elevado no se
# puede terminar desde uno no elevado).
$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-NoProfile', '-Command', $runCmd -PassThru
Emit-Log "@@TERMPID@@ $($proc.Id)"
Emit-Log "dotnet build -t:Run lanzado en otra ventana: compila, instala el APK y abre la app en el emulador."

Emit-Progress 100 "Listo. Emulador arriba y dotnet build -t:Run corriendo."
Write-Host "@@DONE@@"
exit 0
