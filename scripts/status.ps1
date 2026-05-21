$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'data\bridge.pid'
$GuiPidFile = Join-Path $ProjectRoot 'data\filehelper-gui.pid'
$Port = 18731

function Get-GuiStatus {
  if (-not (Test-Path -LiteralPath $GuiPidFile)) {
    return 'FileHelper GUI adapter is stopped.'
  }
  $guiPidText = (Get-Content -LiteralPath $GuiPidFile -Raw).Trim()
  if (-not $guiPidText) {
    return 'FileHelper GUI adapter is stopped.'
  }
  $guiProc = Get-CimInstance Win32_Process -Filter "ProcessId=$guiPidText" -ErrorAction SilentlyContinue
  if ($guiProc -and $guiProc.CommandLine -like "*filehelper-gui.ps1*") {
    return "FileHelper GUI adapter is running. PID=$guiPidText"
  }
  return 'FileHelper GUI adapter is stopped.'
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  Write-Output "WechatCodexBridge is stopped."
  Write-Output (Get-GuiStatus)
  exit 0
}

$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
if ($proc -and $proc.CommandLine -like "*20.WechatCodexBridge*") {
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5
  Write-Output "WechatCodexBridge is running. PID=$($listener.OwningProcess) dryRun=$($health.dryRun)"
  Write-Output (Get-GuiStatus)
  Set-Content -LiteralPath $PidFile -Value $listener.OwningProcess -Encoding ASCII
  exit 0
}

Write-Output "Port $Port is used by another process. PID=$($listener.OwningProcess)"
Write-Output (Get-GuiStatus)
