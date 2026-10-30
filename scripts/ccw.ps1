# ccw.ps1 - start / stop / restart / status for cc-web on Windows.
#
#   .\scripts\ccw.ps1 start   [-Port 32352] [-Open]
#   .\scripts\ccw.ps1 stop    [-Port 32352]
#   .\scripts\ccw.ps1 restart [-Port 32352]
#   .\scripts\ccw.ps1 status  [-Port 32352]
#   .\scripts\ccw.ps1 logs    [-Port 32352]
#   .\scripts\ccw.ps1 token   [-Port 32352]
#
# The Windows counterpart of scripts/ccw (bash, Linux paths). The token lives in
# %USERPROFILE%\.ccweb-token-<port> (made on first start) and reaches the server
# through CCWEB_AUTH, not argv, so it stays the same across restarts. A port
# other than 32352 gets its own data directory (CCW_DATA_DIR), because two
# servers sharing one refuse to start.

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'token')]
  [string]$Action = 'start',
  [int]$Port = 32352,
  [switch]$Open
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TokenFile = Join-Path $env:USERPROFILE ".ccweb-token-$Port"
$DataDir = if ($Port -eq 32352) { Join-Path $env:USERPROFILE '.claude-code-web' } else { Join-Path $env:USERPROFILE ".claude-code-web-$Port" }
$LogFile = Join-Path $DataDir "cc-web-$Port.log"

function Get-ListenerPid {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

function Get-Token {
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
  New-Item -ItemType Directory -Force $DataDir | Out-Null

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
