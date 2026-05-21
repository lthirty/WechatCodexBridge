$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'data\bridge.pid'
$GuiPidFile = Join-Path $ProjectRoot 'data\filehelper-gui.pid'
$Port = 18731
$stopped = $false

if (Test-Path -LiteralPath $GuiPidFile) {
  $guiPidText = (Get-Content -LiteralPath $GuiPidFile -Raw).Trim()
  if ($guiPidText) {
    $guiProc = Get-CimInstance Win32_Process -Filter "ProcessId=$guiPidText" -ErrorAction SilentlyContinue
    if ($guiProc -and $guiProc.CommandLine -like "*filehelper-gui.ps1*") {
      Stop-Process -Id ([int]$guiPidText) -Force
      Write-Output "Stopped FileHelper GUI adapter. PID=$guiPidText"
      $stopped = $true
    }
  }
  Remove-Item -LiteralPath $GuiPidFile -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $PidFile) {
  $pidText = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($pidText) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidText" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -like "*20.WechatCodexBridge*") {
      Stop-Process -Id ([int]$pidText) -Force
      Write-Output "Stopped WechatCodexBridge. PID=$pidText"
      $stopped = $true
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine -like "*20.WechatCodexBridge*") {
    Stop-Process -Id $listener.OwningProcess -Force
    Write-Output "Stopped WechatCodexBridge listener. PID=$($listener.OwningProcess)"
    $stopped = $true
  }
}

if (-not $stopped) {
  Write-Output "WechatCodexBridge is not running."
}
