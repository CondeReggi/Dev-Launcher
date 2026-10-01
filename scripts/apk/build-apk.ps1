<#
  Genera un APK (Release) de un proyecto .NET MAUI Android. Si se pasan
  -ConstantsFile/-BaseUrl, parchea temporalmente la URL de backend del
  proyecto (las apps MAUI de este repo la hardcodean en un archivo de
  constantes/helper en vez de tener un .env por ambiente - ver
  Constants/DataServiceConstants.cs o Helpers/AppEnvironment.cs) para que el
  build salga apuntando al ambiente elegido, y la restaura al finalizar
  (exito o error).

  -ConstantName identifica el miembro a parchear (default: BaseURL) y acepta
  ambos estilos que existen en este repo:
    public const string BaseURL = "...";   (DistMayoristaGlp.Maui)
    public string UrlRoot => "...";        (Distribucion Mayorista GLP / AppEnvironment.cs)

  Emite las mismas lineas machine-parseables que start-emulator-maui.ps1:

    @@PROGRESS@@ <pct> <mensaje>        -> avance 0..100 + etiqueta del paso
    @@LOG@@ <mensaje>                   -> linea de log informativa
    @@LOG@@ @@APKFILE@@ <path>|<bytes>  -> un .apk encontrado en la carpeta de salida
    @@LOG@@ @@OUTDIR@@ <dir>            -> carpeta de salida (para el boton "Abrir carpeta")
    @@DONE@@                            -> termino OK

  Los errores se escriben a stderr y el script sale con codigo != 0.

  Uso:
    powershell -ExecutionPolicy Bypass -File build-apk.ps1 `
      -ProjectDir "C:\...\DistMayoristaGlp.Maui" `
      -CsprojPath "C:\...\DistMayoristaGlp.Maui.csproj" `
      -TargetFramework net8.0-android -Configuration Release `
      -ConstantsFile "C:\...\Constants\DataServiceConstants.cs" `
      -ConstantName BaseURL -BaseUrl "http://YOUR_TST_HOST:8580/api/v1/" -EnvLabel Testing
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectDir,
  [Parameter(Mandatory = $true)]
  [string]$CsprojPath,
  [string]$TargetFramework = 'net8.0-android',
  [string]$Configuration = 'Release',
  [string]$ConstantsFile = '',
  [string]$ConstantName = 'BaseURL',
  [string]$BaseUrl = '',
  [string]$EnvLabel = ''
)

# 'Continue' a proposito (no 'Stop'): en PowerShell 5.1, redirigir el stderr de un
# .exe nativo (dotnet build) con 2>&1 lo envuelve en un ErrorRecord y bajo 'Stop'
# se vuelve un error terminante que aborta el script apenas dotnet imprime un
# warning. Igual cortamos donde importa con `throw` explicito.
$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8

function Emit-Progress([int]$pct, [string]$msg) { Write-Host "@@PROGRESS@@ $pct $msg" }
function Emit-Log([string]$msg)               { Write-Host "@@LOG@@ $msg" }

# --- 0. Validaciones de entorno ---
Emit-Progress 2 "Verificando proyecto..."
if (-not (Test-Path -LiteralPath $ProjectDir)) { throw "No existe la carpeta del proyecto: $ProjectDir" }
if (-not (Test-Path -LiteralPath $CsprojPath)) { throw "No existe el .csproj: $CsprojPath" }
Set-Location -LiteralPath $ProjectDir
Emit-Log "Proyecto: $CsprojPath | TFM: $TargetFramework | Config: $Configuration"

# --- 1. Parchear temporalmente la constante BaseURL (si corresponde) ---
$originalContent = $null
$patchedFile = $false
$noBom = New-Object System.Text.UTF8Encoding($false)

if ($ConstantsFile) {
  if (-not $BaseUrl) { throw "Se especifico -ConstantsFile pero no -BaseUrl." }
  if (-not (Test-Path -LiteralPath $ConstantsFile)) { throw "No existe el archivo de constantes: $ConstantsFile" }

  Emit-Progress 6 "Fijando $ConstantName para $EnvLabel..."
  $originalContent = [System.IO.File]::ReadAllText($ConstantsFile)
  # Solo la linea ACTIVA (no comentada): las lineas de otros ambientes quedan
  # documentadas con `//` delante y no deben matchear. Cubre ambos estilos
  # presentes en el repo: "const string X = ..." y "string X => ...".
  # El grupo 2 corta en el ";" a proposito (sin ".*") para descartar cualquier
  # comentario viejo al final de la linea en vez de arrastrarlo a la nueva.
  $namePattern = [regex]::Escape($ConstantName)
  $match = [regex]::Match($originalContent, "(?m)^([ \t]*public\s+(?:const\s+string|string)\s+$namePattern\s*(?:=>|=)\s*)`"[^`"]*`"(\s*;).*$")
  if (-not $match.Success) { throw "No se encontro el miembro $ConstantName activo (sin comentar) en $ConstantsFile" }
  $oldLine = $match.Value
  $prefix = $match.Groups[1].Value
  $suffix = $match.Groups[2].Value
  $newLine = "$($prefix)`"$BaseUrl`"$suffix //$EnvLabel (temporal - Dev Launcher, se restaura al terminar el build)"
  $updatedContent = $originalContent.Replace($oldLine, $newLine)
  [System.IO.File]::WriteAllText($ConstantsFile, $updatedContent, $noBom)
  $patchedFile = $true
  Emit-Log "$ConstantName -> $BaseUrl ($EnvLabel)"
}

try {
  # --- 2. dotnet build (genera e instala-firma el APK) ---
  Emit-Progress 10 "Compilando APK ($Configuration / $TargetFramework)..."
  Emit-Log "dotnet build `"$CsprojPath`" -f $TargetFramework -c $Configuration"

  $lineCount = 0
  & dotnet build $CsprojPath -f $TargetFramework -c $Configuration 2>&1 | ForEach-Object {
    $text = $_.ToString()
    if ($text.Trim()) {
      Emit-Log $text
      $lineCount++
      $pct = 10 + [Math]::Min(75, [int]($lineCount / 2))
      Emit-Progress $pct "Compilando..."
    }
  }
  if ($LASTEXITCODE -ne 0) { throw "dotnet build fallo con codigo $LASTEXITCODE. Revisa el log de arriba." }

  # --- 3. Ubicar el/los .apk generados ---
  Emit-Progress 92 "Buscando APK generado..."
  $outDir = Join-Path $ProjectDir "bin\$Configuration\$TargetFramework"
  if (-not (Test-Path -LiteralPath $outDir)) { throw "El build termino OK pero no existe la carpeta de salida esperada: $outDir" }
  $apks = @(Get-ChildItem -LiteralPath $outDir -Filter *.apk -File -ErrorAction SilentlyContinue)
  if ($apks.Count -eq 0) { throw "El build termino OK pero no se encontro ningun .apk en $outDir" }
  foreach ($a in $apks) { Emit-Log "@@APKFILE@@ $($a.FullName)|$($a.Length)" }
  Emit-Log "@@OUTDIR@@ $outDir"

  Emit-Progress 100 "APK generado."
  Write-Host "@@DONE@@"
  exit 0
}
finally {
  # Se restaura siempre (exito, build fallido, o throw de mas arriba) para no
  # dejar el repo con la URL de otro ambiente commiteable por error.
  if ($patchedFile -and $null -ne $originalContent) {
    [System.IO.File]::WriteAllText($ConstantsFile, $originalContent, $noBom)
    Emit-Log "BaseURL original restaurada en $ConstantsFile."
  }
}
