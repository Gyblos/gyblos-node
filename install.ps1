# Installs a Gyblos seller on Windows x64 (docs/running-a-node.md#windows): the packaged seller, checked
# against this release's checksum (and, with cosign, its signature), with the machine's own Ollama, run
# as a scheduled task at logon. No port is opened. Windows PowerShell 5.1 or PowerShell 7.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1             install or update the seller; in a
#                    console it then registers the seller and publishes it, asking before each step
#   powershell -ExecutionPolicy Bypass -File install.ps1 publish     list it in the discovery index
#   powershell -ExecutionPolicy Bypass -File install.ps1 unpublish   withdraw it; it keeps running
#   powershell -ExecutionPolicy Bypass -File install.ps1 update      download the latest installer, check it
#                    and run it here
#
# Environment (all optional):
#   GYBLOS_HOME         the seller's home, with gyblos.toml and seller.env (default: %USERPROFILE%\.gyblos)
#   GYBLOS_RELAY_TOKEN  the relay token; asked for without echo when unset
#   GYBLOS_REQUIRE_SIGNATURE=1  stop unless cosign verifies the seller as a Gyblos release
#   GYBLOS_GUIDED=0     only print the steps to start selling; never ask to register or publish
#   GYBLOS_MODIFY_PATH=0  do not add the gyblos command's folder to your user PATH
#   GYBLOS_RELEASE_URL  where releases are downloaded from (default: GitHub); the checksum still applies
#
# The program goes to %LOCALAPPDATA%\Gyblos; the home keeps gyblos.toml, seller.env and the keys, readable
# only by this account, SYSTEM and Administrators. Existing gyblos.toml and seller.env are kept: rerunning
# resumes a failed install and updates the seller. The relay token is written only to seller.env and never
# printed.
param([string]$Command = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

# Set by scripts/pin-installer-windows.sh when a release is published. Empty in the repository's copy.
$NativeVersion = ''
$NativeSha256 = ''
$Target = 'win32-x64'
$ReleaseIdentity = '^https://github\.com/Gyblos/gyblos-node/\.github/workflows/release-seller-image\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
$ReleaseIssuer = 'https://token.actions.githubusercontent.com'
$Releases = if ($env:GYBLOS_RELEASE_URL) { $env:GYBLOS_RELEASE_URL.TrimEnd('/') } else { 'https://github.com/Gyblos/gyblos-node/releases' }
# Devnet USDC (packages/config/src/network.ts DEVNET_USDC).
$Mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
$Model = 'qwen3:0.6b'
$Ollama = 'http://127.0.0.1:11434'
$CosignMajor = 3
# packages/transport-iroh/src/constants.ts RELAY_TOKEN_LENGTH.
$RelayTokenMin = 32
$RelayTokenMax = 512

$SellerHome = if ($env:GYBLOS_HOME) { $env:GYBLOS_HOME } else { Join-Path $env:USERPROFILE '.gyblos' }
$Program = Join-Path $env:LOCALAPPDATA 'Gyblos'
$App = Join-Path $Program 'app'
$BinDir = Join-Path $Program 'bin'
$Strict = $env:GYBLOS_REQUIRE_SIGNATURE -eq '1'
$Guided = $env:GYBLOS_GUIDED -ne '0'
$Self = if ($PSCommandPath) { $PSCommandPath } else { 'install.ps1' }
$Utf8 = New-Object System.Text.UTF8Encoding $false
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$Icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
# TLS 1.2 for Windows PowerShell 5.1, whose default may be older.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Say([string]$Text) { Write-Host $Text }
function Die([string]$Text) {
  [Console]::Error.WriteLine("gyblos install: $Text")
  exit 1
}

function Gyblos { & (Join-Path $App 'current\bin\gyblos.cmd') @args }
function Installer([string]$Arguments) {
  $prefix = if ($env:GYBLOS_HOME) { "`$env:GYBLOS_HOME='$SellerHome'; " } else { '' }
  "${prefix}powershell -ExecutionPolicy Bypass -File '$Self'$(if ($Arguments) { " $Arguments" })"
}
function Typed([string]$Arguments) {
  $prefix = if ($env:GYBLOS_HOME) { "`$env:GYBLOS_HOME='$SellerHome'; " } else { '' }
  "${prefix}gyblos $Arguments"
}

function Write-Text([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, $Utf8) }

function Check-Platform {
  if ($env:OS -ne 'Windows_NT') { Die 'install.ps1 is for Windows; on macOS and Linux use install.sh.' }
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($arch -ne 'AMD64') { Die "There is no packaged seller for Windows $arch yet; only x64." }
  if (-not (Test-Path $Tar)) { Die 'Windows 10 (1803) or later is needed: tar.exe is missing.' }
  if (-not $NativeVersion -or -not $NativeSha256) {
    Die 'This installer has no packaged seller (only a release installer does): download https://gyblos.com/install.ps1.'
  }
}

# The home, readable only by this account, SYSTEM and Administrators, as `gyblos setup` checks: also an
# existing one (a GYBLOS_HOME made by hand inherits its parent's access), before seller.env is written.
function Restrict-Home {
  if (-not (Test-Path -LiteralPath $SellerHome)) { New-Item -ItemType Directory -Path $SellerHome | Out-Null }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & $Icacls $SellerHome /reset /Q | Out-Null
  if ($LASTEXITCODE -eq 0) {
    & $Icacls $SellerHome /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { Die "Could not restrict $SellerHome to this account." }
  # What is inside follows the folder again, also a file someone gave its own access.
  if (Get-ChildItem -LiteralPath $SellerHome -Force | Select-Object -First 1) {
    & $Icacls (Join-Path $SellerHome '*') /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "Could not restrict the files in $SellerHome to this account." }
  }
}

function Download([string]$Url, [string]$Path) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
  } catch {
    Die "Could not download $Url; try again later."
  }
}

function Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Unchecked([string]$Text) {
  if ($Strict) { Die "$Text GYBLOS_REQUIRE_SIGNATURE=1 needs it; nothing was changed." }
  Say "Note: $Text"
}

# With cosign 3 or later, checks a downloaded file's release signature.
function Verify-Signature([string]$Path, [string]$What) {
  # Windows PowerShell stops at a native command's redirected error output under 'Stop'.
  $ErrorActionPreference = 'Continue'
  $cosign = Get-Command cosign -ErrorAction SilentlyContinue
  if (-not $cosign) { Unchecked "cosign is not installed, so the $What signature was not checked."; return }
  $version = (& $cosign.Source version 2>$null | Select-String -Pattern '^GitVersion:\s*v?(\d+)\.').Matches
  if (-not $version -or [int]$version[0].Groups[1].Value -lt $CosignMajor) {
    Unchecked "cosign $CosignMajor or later is needed to check the $What signature; it was not checked."
    return
  }
  & $cosign.Source verify-blob $Path --bundle "$Path.sigstore.json" --certificate-identity-regexp $ReleaseIdentity --certificate-oidc-issuer $ReleaseIssuer 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "The downloaded $What signature did not verify as a Gyblos release; nothing was changed." }
  Say "Verified the Gyblos release signature of the $What."
}

function New-Work { $path = Join-Path ([IO.Path]::GetTempPath()) ("gyblos-" + [Guid]::NewGuid()); New-Item -ItemType Directory -Path $path | Out-Null; $path }

# Downloads, checks and unpacks this release beside earlier ones, renamed into place with a marker, so an
# interrupted run never leaves a release a rerun would trust.
function Install-Native {
  $name = "gyblos-$NativeVersion-$Target"
  New-Item -ItemType Directory -Force -Path $App | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $App "$name\.complete"))) {
    $work = New-Work
    try {
      Say "Downloading the Gyblos seller $NativeVersion for $Target..."
      $archive = Join-Path $work "$name.tar.gz"
      Download "$Releases/download/v$NativeVersion/$name.tar.gz" $archive
      Download "$Releases/download/v$NativeVersion/$name.tar.gz.sigstore.json" "$archive.sigstore.json"
      if ((Sha256 $archive) -ne $NativeSha256) { Die 'The downloaded seller does not match the checksum this installer pins; nothing was changed.' }
      Verify-Signature $archive 'seller'
      $unpack = Join-Path $App (".unpack-" + [Guid]::NewGuid())
      New-Item -ItemType Directory -Path $unpack | Out-Null
      & $Tar -xzf $archive -C $unpack $name
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $unpack "$name\bin\gyblos.cmd"))) {
        Remove-Item -Recurse -Force -LiteralPath $unpack
        Die 'The downloaded seller could not be unpacked; nothing was changed.'
      }
      New-Item -ItemType File -Path (Join-Path $unpack "$name\.complete") | Out-Null
      if (Test-Path -LiteralPath (Join-Path $App $name)) { Remove-Item -Recurse -Force -LiteralPath (Join-Path $App $name) }
      Move-Item -LiteralPath (Join-Path $unpack $name) -Destination (Join-Path $App $name)
      Remove-Item -Recurse -Force -LiteralPath $unpack
    } finally {
      Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
    }
  }
  $script:Name = $name
  $script:Release = Join-Path $App "$name\bin\gyblos.cmd"
}

# Once the release passed doctor: points app\current (a junction) at it, keeps only the release it replaced,
# and writes the gyblos command.
function Switch-Native {
  $current = Join-Path $App 'current'
  $previous = ''
  if (Test-Path -LiteralPath $current) {
    $previous = Split-Path -Leaf ((Get-Item -LiteralPath $current).Target | Select-Object -First 1)
    # Removes the junction, never what it points to.
    [IO.Directory]::Delete($current)
  }
  New-Item -ItemType Junction -Path $current -Target (Join-Path $App $Name) | Out-Null
  if ($previous -and $previous -ne $Name) {
    Get-ChildItem -LiteralPath $App -Directory -Filter 'gyblos-*' |
      Where-Object { $_.Name -ne $Name -and $_.Name -ne $previous } |
      ForEach-Object { Remove-Item -Recurse -Force -LiteralPath $_.FullName }
  }
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Write-Text (Join-Path $BinDir 'gyblos.cmd') "@echo off`r`n`"$current\bin\gyblos.cmd`" %*`r`n"
  Say "Installed the Gyblos seller $NativeVersion as $BinDir\gyblos.cmd"
  Add-UserPath
}

# Adds the gyblos command's folder to the user PATH as written in the registry, keeping its %VARIABLE%
# entries and value kind, then tells running programs, so a new terminal finds gyblos.
function Add-UserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (($raw -split ';') -contains $BinDir) { return }
    if ($env:GYBLOS_MODIFY_PATH -eq '0') { Say "Add $BinDir to your PATH to type gyblos."; return }
    $kind = if ($raw) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $key.SetValue('Path', (@($raw.TrimEnd(';'), $BinDir) | Where-Object { $_ }) -join ';', $kind)
  } finally {
    $key.Close()
  }
  # Setting and removing a user variable broadcasts the change to Explorer and new terminals.
  [Environment]::SetEnvironmentVariable('GYBLOS_PATH_CHANGED', '1', 'User')
  [Environment]::SetEnvironmentVariable('GYBLOS_PATH_CHANGED', $null, 'User')
  Say "Added $BinDir to your user PATH; open a new terminal to type gyblos."
}

function Write-Config {
  $path = Join-Path $SellerHome 'gyblos.toml'
  if (Test-Path -LiteralPath $path) { Say "Kept existing $path"; return }
  $text = @'
# The packaged seller: the pinned Qwen3 0.6B with reasoning off on this machine's Ollama, given away free
# within daily token caps. To charge, give an offer `price = {...}` instead of `free`
# (docs/configuration.md) and fund the fee payer `gyblos doctor` prints with devnet SOL.

version = 1

[node]
network = "devnet"

[discovery]
# Off so a test node is not listed by accident; set publish = true to appear in discovery.
publish = false

# Optional capacity limits; omitted keys keep these defaults (docs/configuration.md#seller-limits).
# [limits]
# max_connections = 8
# requests_per_minute = 30

[[offers]]
model = "qwen3:0.6b"
reasoning = ["off"]
engine = { kind = "ollama", url = "http://127.0.0.1:11434/" }
free = { daily_token_cap = 200000, per_buyer_cap = 50000 }
'@
  Write-Text $path ($text -replace "`r`n", "`n")
  Say "Wrote $path"
}

# The relay token goes straight from the prompt or the environment into seller.env.
function Write-Environment {
  $path = Join-Path $SellerHome 'seller.env'
  if (Test-Path -LiteralPath $path) { Say "Kept existing $path"; return }
  $token = $env:GYBLOS_RELAY_TOKEN
  if (-not $token) {
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { Die 'No console to ask for the relay token: set GYBLOS_RELAY_TOKEN.' }
    Say 'The relay token is the private key to the Gyblos relay. It is not the gyb_ invite code,'
    Say 'which you enter later with `gyblos seller register`.'
    $secure = Read-Host -AsSecureString 'Relay token (not shown)'
    $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
  if ($token.StartsWith('gyb_')) { Die 'That is the gyb_ invite code, not the relay token. Enter the invite code later with `gyblos seller register`; rerun this with the relay token.' }
  if ($token -notmatch '^[\x21-\x7e]+$' -or $token -match '["''`$\\#;|<>&(){}~]') { Die 'The relay token is empty or has characters a relay token never has.' }
  if ($token.Length -lt $RelayTokenMin -or $token.Length -gt $RelayTokenMax) { Die "The relay token must have $RelayTokenMin to $RelayTokenMax characters." }
  Write-Text $path "GYBLOS_RELAY_TOKEN=$token`n"
  $token = $null
  Say "Wrote $path (readable only by you)"
}

# The machine's own Ollama must answer; this script never installs it.
function Check-Ollama {
  try { Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri "$Ollama/api/version" | Out-Null; return } catch {}
  Say "The seller serves its model with Ollama, which is not running here ($Ollama)."
  Say '  Install Ollama for Windows from https://ollama.com/download/windows and open it.'
  Die 'Run this script again once Ollama is running; it continues where it stopped.'
}

function Pull-Model {
  # PowerShell names ignore case: the command is $cli, never $ollama, which would replace the $Ollama URL.
  $ErrorActionPreference = 'Continue'
  Say "Pulling $Model into Ollama..."
  $cli = Get-Command ollama -ErrorAction SilentlyContinue
  if ($cli) {
    & $cli.Source pull $Model
    if ($LASTEXITCODE -ne 0) { Die "Ollama ($($cli.Source)) could not pull $Model; run: ollama pull $Model" }
  } else {
    try {
      Invoke-RestMethod -UseBasicParsing -Method Post -ContentType 'application/json' -Uri "$Ollama/api/pull" -Body "{`"model`":`"$Model`",`"stream`":false}" -ErrorAction Stop | Out-Null
    } catch { Die "Ollama could not pull $Model ($($_.Exception.Message)); run: ollama pull $Model" }
  }
}

# Runs gyblos with seller.env's variables, as its service does.
function With-SellerEnv([scriptblock]$Block) {
  $ErrorActionPreference = 'Continue'
  $path = Join-Path $SellerHome 'seller.env'
  $names = @()
  if (Test-Path -LiteralPath $path) {
    foreach ($line in [IO.File]::ReadAllLines($path)) {
      if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.+)$') {
        Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
        $names += $Matches[1]
      }
    }
  }
  try { & $Block } finally { foreach ($name in $names) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue } }
}

function Reinstall-Service {
  # Windows PowerShell may stop at a native command's error output under 'Stop'; exit codes decide here.
  $ErrorActionPreference = 'Continue'
  # Removing the service stops the seller first (it withdraws within 120 s); installing starts this release.
  Gyblos seller service uninstall | Out-Null
  Gyblos seller service install
  if ($LASTEXITCODE -ne 0) { Die 'The background service could not be installed; fix what it says, then run this script again.' }
}

function Publishing {
  $path = Join-Path $SellerHome 'gyblos.toml'
  [bool](Select-String -LiteralPath $path -Pattern '^\s*publish\s*=\s*true\s*(#.*)?$' -Quiet)
}

function Next-Steps {
  Say ''
  Say 'Next steps, to start selling:'
  Say "  1. Send about 0.02 devnet SOL to the seller's owner $script:Owner"
  Say '     (https://faucet.solana.com, choose devnet). It pays the one-time registration, about 0.01 SOL.'
  Say '  2. Register with the gyb_ invite code from your invitation (asked for, not the relay token):'
  Say "       $(Typed 'seller register')"
  Say '  3. Publish to the discovery index:'
  Say "       $(Installer 'publish')"
}

function Confirm([string]$Question) {
  $answer = Read-Host "$Question [Y/n]"
  return $answer -eq '' -or $answer -match '^(y|yes)$'
}

# In a console, registers the seller (the command asks for the invite and confirms before signing), then
# publishes it once the operator agrees. Called as a statement, never inside an expression, so the
# register command's questions reach the console.
function Can-Guide { $Guided -and -not [Console]::IsInputRedirected -and [Environment]::UserInteractive }

function Guided-Setup {
  Say ''
  Say 'Next: register this seller and publish it, so buyers can find it.'
  Say 'Each step asks before it does anything. Press Ctrl+C at any time; run this script again to continue.'
  Say ''
  Say 'Step 1 of 2: register, with the gyb_ invite code from your invitation (not the relay token).'
  Say "  The owner $script:Owner pays about 0.01 devnet SOL once; registration waits for it if needed."
  Gyblos seller register
  if ($LASTEXITCODE -ne 0) {
    Say ''
    Say 'Registration did not finish. Fix what it says, then run this script again to continue:'
    Say "  $(Installer '')"
    return
  }
  Say ''
  if (-not (Confirm 'Step 2 of 2: publish this seller to the discovery index now?')) {
    Say 'Not published. When you are ready:'
    Say "  $(Installer 'publish')"
    return
  }
  Set-Publish 'true'
  Say ''
  Say 'Done: this seller is registered and published. Buyers can find it within about two minutes.'
}

# Turns publishing on or off in gyblos.toml, checks the result with the seller and restarts it; an invalid
# result restores the original.
function Set-Publish([string]$Value) {
  $path = Join-Path $SellerHome 'gyblos.toml'
  if (-not (Test-Path -LiteralPath $path) -or -not (Test-Path -LiteralPath (Join-Path $App 'current'))) {
    Die "No packaged seller in ${SellerHome}: run install.ps1 first (GYBLOS_HOME names another home)."
  }
  $original = [IO.File]::ReadAllText($path)
  $lines = [regex]::Matches($original, '(?m)^publish = (true|false)\r?$')
  if ($lines.Count -ne 1) { Die 'gyblos.toml has no single "publish = true" or "publish = false" line under [discovery]; set it by hand.' }
  Write-Text $path ([regex]::Replace($original, '(?m)^publish = (true|false)(\r?)$', "publish = $Value`$2"))
  $ErrorActionPreference = 'Continue'
  $report = Gyblos config validate --config $path 2>&1
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) {
    Write-Text $path $original
    $report | ForEach-Object { [Console]::Error.WriteLine($_) }
    Die 'gyblos.toml is not valid with that change; it was left as it was.'
  }
  Reinstall-Service
  if ($Value -eq 'true') {
    Say 'Publishing is on: the index lists this seller within about two minutes, once it is registered.'
    Say "  Check: $(Typed 'seller status --online')"
  } else {
    Say 'Publishing is off: the index withdraws this seller within about two minutes. It keeps running.'
  }
}

# Downloads the latest release's installer, checks it, keeps it in place of this one and runs it.
function Update-Installer {
  if (-not (Test-Path -LiteralPath (Join-Path $App 'current'))) { Die 'No packaged seller here: run install.ps1 first.' }
  $work = New-Work
  try {
    foreach ($file in 'install.ps1', 'install.ps1.sha256', 'install.ps1.sigstore.json') {
      Download "$Releases/latest/download/$file" (Join-Path $work $file)
    }
    $downloaded = Join-Path $work 'install.ps1'
    $expected = ((Get-Content -LiteralPath "$downloaded.sha256" -Raw) -split '\s+')[0]
    if ((Sha256 $downloaded) -ne $expected) { Die 'The downloaded installer does not match its checksum; nothing was changed.' }
    Verify-Signature $downloaded 'installer'
    $latest = (Select-String -LiteralPath $downloaded -Pattern "^\`$NativeVersion = '([^']+)'$").Matches
    if (-not $latest) { Die 'The downloaded installer names no release; nothing was changed.' }
    $latest = $latest[0].Groups[1].Value
    $destination = if ($PSCommandPath) { $PSCommandPath } else { Join-Path $SellerHome 'install.ps1' }
    if ($latest -eq $NativeVersion) {
      Say "This installer already pins the latest release ($NativeVersion); running it again to apply it."
    } else {
      Say "Updating to $latest"
      Copy-Item -LiteralPath $downloaded -Destination $destination -Force
    }
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
  }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $destination
  exit $LASTEXITCODE
}

# Keys and tokenizer; exit codes decide, not error output.
function Prepare-Seller {
  $ErrorActionPreference = 'Continue'
  & $Release setup --role seller --mint $Mint | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'Creating the seller keys failed; fix what it says, then run this script again.' }
  & $Release tokenizer
  if ($LASTEXITCODE -ne 0) { Die 'Preparing the tokenizer failed; run this script again.' }
}

function Main {
  Check-Platform
  Restrict-Home
  Install-Native
  Write-Config
  Write-Environment
  Check-Ollama
  Pull-Model
  Say 'Creating the seller keys (kept if they exist)...'
  Prepare-Seller
  $doctor = With-SellerEnv { & $Release doctor 2>&1 }
  $ready = $LASTEXITCODE -eq 0
  $doctor | ForEach-Object { Say "$_" }
  if (-not $ready) { Die 'The seller is not ready; fix the failures above, then run this script again.' }
  $script:Owner = ''
  foreach ($line in $doctor) {
    if ("$line" -match '^  owner +([1-9A-HJ-NP-Za-km-z]{32,44})\s*$') { $script:Owner = $Matches[1]; break }
  }
  Switch-Native
  Reinstall-Service
  Say ''
  Say "The seller is running in the background. Its home is $SellerHome."
  Say "  $(Typed 'seller status')   is it serving?"
  Say "  Get-Content -Wait '$SellerHome\service.log'   follow it"
  Say "  $(Typed 'seller service uninstall')   stop it and remove the service"
  Say "  $(Installer 'update')   update it to the latest release"
  if (Publishing) {
    Say 'Publishing is on. Check that the index lists it:'
    Say "  $(Typed 'seller status --online')"
  } elseif (Can-Guide) {
    Guided-Setup
  } else {
    Next-Steps
  }
}

# The seller's commands find its home through GYBLOS_HOME like the service does.
$env:GYBLOS_HOME = $SellerHome
switch ($Command) {
  '' { Main }
  'publish' { Check-Platform; Set-Publish 'true' }
  'unpublish' { Check-Platform; Set-Publish 'false' }
  'update' { Check-Platform; Update-Installer }
  default { Die "Unknown command '$Command'. Usage: install.ps1 [publish|unpublish|update]" }
}
