# ccw.ps1 - start / stop / restart / status for cc-web on Windows.
#
#   .\scripts\ccw.ps1 start   [-Port 32352] [-Open]
#   .\scripts\ccw.ps1 stop    [-Port 32352]
#   .\scripts\ccw.ps1 restart [-Port 32352]
#   .\scripts\ccw.ps1 status  [-Port 32352]
#   .\scripts\ccw.ps1 logs    [-Port 32352]
#   .\scripts\ccw.ps1 token   [-Port 32352]
#
# The Windows counterpart of scripts/ccw (bash, Linux paths). Everything lives
# under %USERPROFILE%\.cc-web, the layout src/utils/data-dir.js resolves:
#   token-<port>          made on first start; reaches the server through
#                         CCWEB_AUTH, not argv, so it survives restarts
#   cc-web-<port>.log     stdout + stderr
#   data\                 32352's data (the server's own default)
#   data-<port>\          any other port (CCW_DATA_DIR), because two servers
#                         sharing one refuse to start
# A token from the old %USERPROFILE%\.ccweb-token-<port> is moved in once.

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'token')]
  [string]$Action = 'start',
  [int]$Port = 32352,
  [switch]$Open
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$BaseDir = Join-Path $env:USERPROFILE '.cc-web'
$TokenFile = Join-Path $BaseDir "token-$Port"
$LegacyTokenFile = Join-Path $env:USERPROFILE ".ccweb-token-$Port"
# 32352 sets no CCW_DATA_DIR and lets the server pick (and migrate) its default.
$DataDir = if ($Port -eq 32352) { Join-Path $BaseDir 'data' } else { Join-Path $BaseDir "data-$Port" }
$LogFile = Join-Path $BaseDir "cc-web-$Port.log"

function Get-ListenerPid {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

function Get-Token {
  New-Item -ItemType Directory -Force $BaseDir | Out-Null
  if (-not (Test-Path $TokenFile) -and (Test-Path $LegacyTokenFile)) {
    Move-Item $LegacyTokenFile $TokenFile
  }
  if (-not (Test-Path $TokenFile)) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLower()
    [System.IO.File]::WriteAllText($TokenFile, $token)
  }
  return ([System.IO.File]::ReadAllText($TokenFile)).Trim()
}

function Start-Server {
  $existing = Get-ListenerPid
  if ($existing) { Write-Host "cc-web already listening on port $Port (pid $existing)"; return }
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Host 'Installing dependencies...'
    Push-Location $Root; try { npm install } finally { Pop-Location }
  }
  # Only a CCW_DATA_DIR instance needs its directory made here; creating
  # data\ ahead of the server would skip its migration of ~/.claude-code-web.
  if ($Port -ne 32352) { New-Item -ItemType Directory -Force $DataDir | Out-Null }

  $env:CCWEB_AUTH = Get-Token
  if ($Port -ne 32352) { $env:CCW_DATA_DIR = $DataDir }
  $nodeArgs = @('bin/cc-web.js', '--port', "$Port")
  if (-not $Open) { $nodeArgs += '--no-open' }
  # Start-Process can't send stdout and stderr to one file, so cmd does the redirect.
  $cmdLine = "node $($nodeArgs -join ' ') >> `"$LogFile`" 2>&1"
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmdLine -WorkingDirectory $Root -WindowStyle Hidden | Out-Null

  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $listener = Get-ListenerPid
    if ($listener) {
      Write-Host "cc-web started on port $Port (pid $listener)"
      Write-Host "  URL:   http://localhost:$Port/?token=$($env:CCWEB_AUTH)"
      Write-Host "  Token: $TokenFile"
      Write-Host "  Log:   $LogFile"
      return
    }
  }
  Write-Host "cc-web did not start within 15s. Last log lines:"
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 }
  exit 1
}

function Stop-Server {
  $listener = Get-ListenerPid
  if (-not $listener) { Write-Host "Nothing listening on port $Port"; return }
  # /T takes the Claude processes the server spawned down with it.
  taskkill /PID $listener /T /F | Out-Null
  Write-Host "Stopped cc-web on port $Port (pid $listener)"
}

switch ($Action) {
  'start'   { Start-Server }
  'stop'    { Stop-Server }
  'restart' { Stop-Server; Start-Sleep -Seconds 1; Start-Server }
  'status'  {
    $listener = Get-ListenerPid
    if ($listener) { Write-Host "cc-web running on port $Port (pid $listener) - http://localhost:$Port" }
    else { Write-Host "cc-web not running on port $Port" }
  }
  'logs'    { if (Test-Path $LogFile) { Get-Content $LogFile -Tail 50 -Wait } else { Write-Host "No log at $LogFile" } }
  'token'   { Get-Token }
}
