$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
$OutLog = Join-Path $LogDir 'bridge.out.log'
$ErrLog = Join-Path $LogDir 'bridge.err.log'
$GuiOutLog = Join-Path $LogDir 'filehelper-gui.out.log'
$GuiErrLog = Join-Path $LogDir 'filehelper-gui.err.log'
$PidFile = Join-Path $ProjectRoot 'data\bridge.pid'
$GuiPidFile = Join-Path $ProjectRoot 'data\filehelper-gui.pid'
$ServerScript = Join-Path $ProjectRoot 'src\server.js'
$GuiScript = Join-Path $ProjectRoot 'scripts\filehelper-gui.ps1'
$Port = 18731
$FileHelperTitle = [string]::Concat([char]0x6587, [char]0x4EF6, [char]0x4F20, [char]0x8F93, [char]0x52A9, [char]0x624B)

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PidFile) | Out-Null

function Write-PidFile {
  param([string]$Path, [int]$ProcessId)
  try {
    Set-Content -LiteralPath $Path -Value $ProcessId -Encoding ASCII
  } catch {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    [System.IO.File]::WriteAllText($Path, [string]$ProcessId, [System.Text.Encoding]::ASCII)
  }
}

function Start-FileHelperGui {
  if (Test-Path -LiteralPath $GuiPidFile) {
    $guiPidText = (Get-Content -LiteralPath $GuiPidFile -Raw).Trim()
    if ($guiPidText) {
      $guiProc = Get-CimInstance Win32_Process -Filter "ProcessId=$guiPidText" -ErrorAction SilentlyContinue
      if ($guiProc -and $guiProc.CommandLine -like "*filehelper-gui.ps1*") {
        Write-Output "FileHelper GUI adapter already running. PID=$guiPidText"
        return
      }
    }
  }

  $weixinProcess = Get-Process | Where-Object { $_.ProcessName -eq 'Weixin' } | Select-Object -First 1
  if (-not $weixinProcess) {
    Write-Output "FileHelper GUI adapter not started: Weixin process was not found."
    return
  }

  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$GuiScript`""
  )
  $guiProcess = Start-Process -FilePath 'powershell' -ArgumentList $args -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $GuiOutLog -RedirectStandardError $GuiErrLog -PassThru
  Write-PidFile -Path $GuiPidFile -ProcessId $guiProcess.Id
  Write-Output "FileHelper GUI adapter started. PID=$($guiProcess.Id)"
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing.OwningProcess)" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine -like "*20.WechatCodexBridge*") {
    Write-Output "WechatCodexBridge already running. PID=$($existing.OwningProcess)"
    Write-PidFile -Path $PidFile -ProcessId $existing.OwningProcess
    Start-FileHelperGui
    exit 0
  }
  throw "Port $Port is already used by another process: PID=$($existing.OwningProcess)"
}

Push-Location $ProjectRoot
try {
  npm run check
  $process = Start-Process -FilePath 'node' -ArgumentList "`"$ServerScript`"" -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
  Write-PidFile -Path $PidFile -ProcessId $process.Id
  Start-Sleep -Seconds 2
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5
  Write-Output "WechatCodexBridge started. PID=$($process.Id) dryRun=$($health.dryRun)"
  Start-FileHelperGui
}
finally {
  Pop-Location
}
