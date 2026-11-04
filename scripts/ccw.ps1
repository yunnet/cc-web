# ccw.ps1 - start / stop / restart / status for cc-web on Windows.
#
#   .\scripts\ccw.ps1 start   [stable|dev|all|<port>] [-Port 32352] [-Open]
#   .\scripts\ccw.ps1 stop    [stable|dev|all|<port>]
#   .\scripts\ccw.ps1 restart [stable|dev|all|<port>]
#   .\scripts\ccw.ps1 status  [stable|dev|all|<port>]
#   .\scripts\ccw.ps1 logs    [stable|dev|<port>]
#   .\scripts\ccw.ps1 token   [stable|dev|<port>]
#
# The Windows counterpart of scripts/ccw (bash, Linux and macOS), with the same
# instance names: stable is 32352, dev is 32353, and with no name it is 32352
# (or -Port). Everything lives under %USERPROFILE%\.cc-web, the layout
# src/utils/data-dir.js resolves:
#   token-<port>          made on first start; reaches the server through
#                         CCWEB_AUTH, not argv, so it survives restarts
#   cc-web-<port>.log     stdout + stderr
#   data\                 32352's data (the server's own default)
#   data-<port>\          any other port (CCW_DATA_DIR), because two servers
#                         sharing one refuse to start
# A token from the old %USERPROFILE%\.ccweb-token-<port> is moved in once.

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'token', 'help')]
  [string]$Action = 'start',
  [Parameter(Position = 1)]
  [string]$Target = '',
  [int]$Port = 32352,
  [switch]$Open
)

$ErrorActionPreference = 'Stop'
if ($Action -eq 'help') {
  Get-Content $PSCommandPath -TotalCount 12 | ForEach-Object { $_ -replace '^# ?', '' }
  exit 0
}
$Root = Split-Path -Parent $PSScriptRoot
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$BaseDir = Join-Path $HomeDir '.cc-web'

$Ports = @(switch -Regex ($Target) {
  '^$'       { @($Port) }
  '^stable$' { @(32352) }
  '^dev$'    { @(32353) }
  '^all$'    { @(32352, 32353) }
  '^\d+$'    { @([int]$Target) }
  default    { Write-Host "Unknown instance '$Target' (use: stable | dev | all | <port>)"; exit 1 }
})
if ($Ports.Count -gt 1 -and $Action -in @('logs', 'token')) { $Ports = @($Ports[0]) }

function Get-TokenFile($p) { Join-Path $BaseDir "token-$p" }
# 32352 sets no CCW_DATA_DIR and lets the server pick (and migrate) its default.
function Get-DataDir($p) { if ($p -eq 32352) { Join-Path $BaseDir 'data' } else { Join-Path $BaseDir "data-$p" } }
function Get-LogFile($p) { Join-Path $BaseDir "cc-web-$p.log" }

function Get-ListenerPid($p) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

# Would killing $target's tree kill this script? True when we run in a Claude
# session inside that very server.
function Test-Ancestor($target) {
  $parents = @{}
  Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId |
    ForEach-Object { $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId }
  $p = $PID
  for ($i = 0; $i -lt 64 -and $p; $i++) {
    if ($p -eq $target) { return $true }
    $p = $parents[$p]
  }
  return $false
}

function Get-Token($p) {
  $tokenFile = Get-TokenFile $p
  $legacy = Join-Path $HomeDir ".ccweb-token-$p"
  New-Item -ItemType Directory -Force $BaseDir | Out-Null
  if (-not (Test-Path $tokenFile) -and (Test-Path $legacy)) {
    Move-Item $legacy $tokenFile
  }
  if (-not (Test-Path $tokenFile)) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLower()
    [System.IO.File]::WriteAllText($tokenFile, $token)
  }
  return ([System.IO.File]::ReadAllText($tokenFile)).Trim()
}

function Start-Server($p) {
  $existing = Get-ListenerPid $p
  if ($existing) { Write-Host "cc-web already listening on port $p (pid $existing)"; return }
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Host 'Installing dependencies...'
    Push-Location $Root; try { npm install } finally { Pop-Location }
  }
  $dataDir = Get-DataDir $p
  $logFile = Get-LogFile $p
  # Only a CCW_DATA_DIR instance needs its directory made here; creating
  # data\ ahead of the server would skip its migration of ~/.claude-code-web.
  if ($p -ne 32352) { New-Item -ItemType Directory -Force $dataDir | Out-Null }

  $env:CCWEB_AUTH = Get-Token $p
  # Cleared for 32352 rather than left alone: a Claude inside another instance
  # inherits that instance's CCW_DATA_DIR, and stable must not pick it up.
  if ($p -ne 32352) { $env:CCW_DATA_DIR = $dataDir } else { Remove-Item Env:CCW_DATA_DIR -ErrorAction SilentlyContinue }
  $nodeArgs = @('bin/cc-web.js', '--port', "$p")
  if (-not $Open) { $nodeArgs += '--no-open' }
  # Start-Process can't send stdout and stderr to one file, so cmd does the redirect.
  $cmdLine = "node $($nodeArgs -join ' ') >> `"$logFile`" 2>&1"
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmdLine -WorkingDirectory $Root -WindowStyle Hidden | Out-Null

  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $listener = Get-ListenerPid $p
    if ($listener) {
      Write-Host "cc-web started on port $p (pid $listener)"
      Write-Host "  URL:   http://localhost:$p/?token=$($env:CCWEB_AUTH)"
      Write-Host "  Token: $(Get-TokenFile $p)"
      Write-Host "  Log:   $logFile"
      return
    }
  }
  Write-Host "cc-web did not start within 15s. Last log lines:"
  if (Test-Path $logFile) { Get-Content $logFile -Tail 20 }
  exit 1
}

function Stop-Server($p) {
  $listener = Get-ListenerPid $p
  if (-not $listener) { Write-Host "Nothing listening on port $p"; return }
  if (Test-Ancestor $listener) {
    Write-Host "Port $p (pid $listener) is running this shell - stopping it ends this session too"
  }
  # /T takes the Claude processes the server spawned down with it.
  taskkill /PID $listener /T /F | Out-Null
  Write-Host "Stopped cc-web on port $p (pid $listener)"
}

function Restart-Server($p) {
  $listener = Get-ListenerPid $p
  if ($listener -and (Test-Ancestor $listener)) {
    # taskkill /T would end this script half way, before the start. Hand the
    # whole restart to a process created through WMI: its parent is the WMI
    # host, so it is in nobody's tree here and outlives the kill.
    # Its own log: the running server's cmd.exe holds cc-web-<port>.log open,
    # and a second `>>` onto it fails with a sharing violation.
    $logFile = Join-Path $BaseDir "ccw-restart-$p.log"
    $inner ="powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" restart $p"
    if ($Open) { $inner += ' -Open' }
    $cmdLine = "cmd.exe /c $inner >> `"$logFile`" 2>&1"
    $startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = $cmdLine; CurrentDirectory = $Root; ProcessStartupInformation = $startup
    } | Out-Null
    Write-Host "Port $p (pid $listener) is running this shell - restart handed to a detached process."
    Write-Host "Sessions resume by id once it is back. Restart log: $logFile"
    return
  }
  Stop-Server $p
  Start-Sleep -Seconds 1
  Start-Server $p
}

foreach ($p in $Ports) {
  switch ($Action) {
    'start'   { Start-Server $p }
    'stop'    { Stop-Server $p }
    'restart' { Restart-Server $p }
    'status'  {
      $listener = Get-ListenerPid $p
      if ($listener) { Write-Host "cc-web running on port $p (pid $listener) - http://localhost:$p" }
      else { Write-Host "cc-web not running on port $p" }
    }
    'logs'    { $logFile = Get-LogFile $p; if (Test-Path $logFile) { Get-Content $logFile -Tail 50 -Wait } else { Write-Host "No log at $logFile" } }
    'token'   { Get-Token $p }
  }
}
