param(
  [string]$BridgeUrl = 'http://127.0.0.1:18731/wechat/message',
  [int]$PollMilliseconds = 1200,
  [int]$BridgeTimeoutSeconds = 900,
  [string]$SessionId = 'filehelper',
  [string]$DisplayName = '',
  [string]$ReplyPrefix = '[WCB]'
)

$ErrorActionPreference = 'Stop'
$FileHelperTitle = [string]::Concat([char]0x6587, [char]0x4EF6, [char]0x4F20, [char]0x8F93, [char]0x52A9, [char]0x624B)
$ImageLabel = [string]::Concat([char]0x56FE, [char]0x7247)
$ExpandLabel = [string]::Concat([char]0x5C55, [char]0x5F00)
$ForwardingText = ([string]::Concat(
  [char]0x5DF2, [char]0x6536, [char]0x5230, [char]0xFF0C,
  [char]0x6B63, [char]0x5728, [char]0x53D1, [char]0x9001, [char]0x5230
)) + ' Codex ' + ([string]::Concat([char]0x5904, [char]0x7406)) + '...'
$ImageSentPlaceholder = '[' + ([string]::Concat(
  [char]0x56FE, [char]0x7247, [char]0x5DF2, [char]0x4F5C, [char]0x4E3A,
  [char]0x6587, [char]0x4EF6, [char]0x53D1, [char]0x9001
)) + ']'
if ([string]::IsNullOrWhiteSpace($DisplayName)) {
  $DisplayName = $FileHelperTitle
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
$PidFile = Join-Path $ProjectRoot 'data\filehelper-gui.pid'
$StateFile = Join-Path $ProjectRoot 'data\filehelper-gui.state.json'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PidFile) | Out-Null
Set-Content -LiteralPath $PidFile -Value $PID -Encoding ASCII

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WcbFileHelperWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
'@

function Write-JsonLine($object) {
  $line = ($object | ConvertTo-Json -Compress -Depth 8)
  Add-Content -LiteralPath (Join-Path $LogDir 'filehelper-gui.log') -Value $line -Encoding UTF8
}

function Get-FileHelperProcess {
  $matches = New-Object System.Collections.Generic.List[object]
  $callback = [WcbFileHelperWin32+EnumWindowsProc]{
    param($hWnd, $lParam)
    if (-not [WcbFileHelperWin32]::IsWindowVisible($hWnd)) { return $true }
    [uint32]$windowPid = 0
    [void][WcbFileHelperWin32]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
    $proc = Get-Process -Id $windowPid -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -ne 'Weixin') { return $true }
    try {
      $element = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)
      if ($element -and ($element.Current.AutomationId -eq 'ChatSingleWindowfilehelper' -or $element.Current.Name -eq $DisplayName)) {
        $matches.Add([pscustomobject]@{
          Id = $proc.Id
          ProcessName = $proc.ProcessName
          MainWindowHandle = $hWnd
          MainWindowTitle = $element.Current.Name
        })
      }
    } catch {
    }
    return $true
  }
  [void][WcbFileHelperWin32]::EnumWindows($callback, [IntPtr]::Zero)
  return $matches | Select-Object -First 1
}

function Get-VisibleMessageTexts {
  param($Process)

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $items = New-Object System.Collections.Generic.List[object]

  function Walk-RawElement {
    param($Element, [int]$Depth)
    if (-not $Element -or $Depth -gt 10) { return }
    $type = $Element.Current.ControlType.ProgrammaticName
    if ($type -eq 'ControlType.ListItem') {
      $name = [string]$Element.Current.Name
      if (Test-MessageText $name) {
        $rect = $Element.Current.BoundingRectangle
        $items.Add([pscustomobject]@{
          Text = $name.Trim()
          X = [double]$rect.X
          Y = [double]$rect.Y
        })
      }
    }
    $child = $walker.GetFirstChild($Element)
    while ($child) {
      Walk-RawElement $child ($Depth + 1)
      $child = $walker.GetNextSibling($child)
    }
  }

  Walk-RawElement $root 0
  return @($items | Sort-Object Y, X | ForEach-Object { $_.Text })
}

function Focus-FileHelperInput {
  param($Process)

  [WcbFileHelperWin32]::ShowWindow($Process.MainWindowHandle, 9) | Out-Null
  [WcbFileHelperWin32]::SetForegroundWindow($Process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 350

  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
    $condition = New-Object System.Windows.Automation.PropertyCondition `
      ([System.Windows.Automation.AutomationElement]::AutomationIdProperty), 'chat_input_field'
    $input = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($input) {
      $rect = $input.Current.BoundingRectangle
      $x = [int]($rect.X + ($rect.Width / 2))
      $y = [int]($rect.Y + ($rect.Height / 2))
      [WcbFileHelperWin32]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 100
      [WcbFileHelperWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 50
      [WcbFileHelperWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 250
      return
    }
  } catch {
    Write-JsonLine @{ event = 'input_focus_fallback'; message = $_.Exception.Message; time = (Get-Date).ToString('o') }
  }

  $rect = New-Object WcbFileHelperWin32+RECT
  [WcbFileHelperWin32]::GetWindowRect($Process.MainWindowHandle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $x = $rect.Left + [int]($width * 0.45)
  $y = $rect.Bottom - 95
  [WcbFileHelperWin32]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 100
  [WcbFileHelperWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [WcbFileHelperWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 250
}

function Test-MessageText {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  $value = $Text.Trim()
  if ($value -eq $ImageLabel) { return $false }
  if ($value -eq $ExpandLabel) { return $false }
  if ($value -match '^\d{1,2}:\d{2}$') { return $false }
  if ($value -match '^\d{4}[-/]\d{1,2}[-/]\d{1,2}') { return $false }
  if ($value -match '\[WCB\]') { return $false }
  if ($value -match '^\s*/?\[WCB\]') { return $false }
  if ($value.StartsWith($ReplyPrefix)) { return $false }
  return $true
}

function ConvertTo-Counts {
  param([string[]]$Texts)
  $counts = @{}
  foreach ($text in $Texts) {
    if (-not $counts.ContainsKey($text)) { $counts[$text] = 0 }
    $counts[$text]++
  }
  return $counts
}

function Get-NewVisibleTexts {
  param([string[]]$Texts, $PreviousCounts)

  $seenCounts = @{}
  $newTexts = New-Object System.Collections.Generic.List[string]
  foreach ($text in $Texts) {
    if (-not $seenCounts.ContainsKey($text)) { $seenCounts[$text] = 0 }
    $seenCounts[$text]++
    $oldCount = if ($PreviousCounts.ContainsKey($text)) { [int]$PreviousCounts[$text] } else { 0 }
    if ([int]$seenCounts[$text] -gt $oldCount) {
      $newTexts.Add($text)
    }
  }
  return @($newTexts)
}

function Send-FileHelperText {
  param($Process, [string]$Text)

  Focus-FileHelperInput -Process $Process
  Set-Clipboard -Value $Text
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

function Send-FileHelperFile {
  param($Process, [string]$FilePath)

  if (-not (Test-Path -LiteralPath $FilePath)) {
    Write-JsonLine @{ event = 'file_missing'; file = $FilePath; time = (Get-Date).ToString('o') }
    return
  }

  Focus-FileHelperInput -Process $Process

  $files = New-Object System.Collections.Specialized.StringCollection
  [void]$files.Add((Resolve-Path -LiteralPath $FilePath).Path)
  [System.Windows.Forms.Clipboard]::SetFileDropList($files)
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 800
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-JsonLine @{ event = 'file_sent'; file = $FilePath; time = (Get-Date).ToString('o') }
}

function Get-LocalFilesFromText {
  param([string]$Text)

  $files = New-Object System.Collections.Generic.List[string]
  $pattern = '!\[[^\]]*\]\((?<path>[A-Za-z]:[/\\][^)]+)\)'
  foreach ($match in [regex]::Matches($Text, $pattern)) {
    $path = $match.Groups['path'].Value -replace '/', '\'
    if (Test-Path -LiteralPath $path) {
      $files.Add($path)
    }
  }
  return @($files)
}

function Remove-LocalImageMarkdown {
  param([string]$Text)
  return ([regex]::Replace($Text, '!\[[^\]]*\]\([A-Za-z]:[/\\][^)]+\)', $ImageSentPlaceholder)).Trim()
}

function Invoke-Bridge {
  param([string]$Text)
  $body = @{
    sessionId = $SessionId
    displayName = $DisplayName
    text = $Text
  } | ConvertTo-Json
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  Invoke-RestMethod $BridgeUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec $BridgeTimeoutSeconds
}

Write-JsonLine @{ event = 'started'; pid = $PID; bridgeUrl = $BridgeUrl; time = (Get-Date).ToString('o') }

$previousCounts = @{}
$recentProcessed = @{}
$seeded = $false

while ($true) {
  try {
    $process = Get-FileHelperProcess
    if (-not $process) {
      Write-JsonLine @{ event = 'window_missing'; time = (Get-Date).ToString('o') }
      Start-Sleep -Milliseconds $PollMilliseconds
      continue
    }

    $texts = Get-VisibleMessageTexts -Process $process
    $currentCounts = ConvertTo-Counts $texts

    if (-not $seeded) {
      $previousCounts = $currentCounts
      $seeded = $true
      Set-Content -LiteralPath $StateFile -Value (@{ seededAt = (Get-Date).ToString('o'); visibleCount = $texts.Count } | ConvertTo-Json) -Encoding UTF8
      Write-JsonLine @{ event = 'seeded'; visibleCount = $texts.Count; time = (Get-Date).ToString('o') }
      Start-Sleep -Milliseconds $PollMilliseconds
      continue
    }

    $handledMessage = $false
    $newTexts = @(Get-NewVisibleTexts -Texts $texts -PreviousCounts $previousCounts)
    if ($newTexts.Count -gt 0) {
      $text = [string]$newTexts[$newTexts.Count - 1]
      $nowMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
      $lastProcessedMs = if ($recentProcessed.ContainsKey($text)) { [int64]$recentProcessed[$text] } else { 0 }
      if (($nowMs - $lastProcessedMs) -lt 30000) {
        Write-JsonLine @{ event = 'deduped'; text = $text; time = (Get-Date).ToString('o') }
        $handledMessage = $true
      } else {
        $recentProcessed[$text] = $nowMs
        foreach ($key in @($recentProcessed.Keys)) {
          if (($nowMs - [int64]$recentProcessed[$key]) -gt 300000) {
            $recentProcessed.Remove($key)
          }
        }
        Write-JsonLine @{ event = 'incoming'; text = $text; time = (Get-Date).ToString('o') }
        if (-not $text.StartsWith('/')) {
          Send-FileHelperText -Process $process -Text "$ReplyPrefix $ForwardingText"
        }
        try {
          $result = Invoke-Bridge -Text $text
          $reply = "$ReplyPrefix $($result.reply)"
        } catch {
          $message = $_.Exception.Message
          if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            try {
              $errorBody = $_.ErrorDetails.Message | ConvertFrom-Json
              if ($errorBody.error) {
                $message = $errorBody.error
              }
            } catch {
              $message = $_.ErrorDetails.Message
            }
          }
          $reply = "$ReplyPrefix error: $message"
        }
        $files = Get-LocalFilesFromText -Text $reply
        $textReply = Remove-LocalImageMarkdown -Text $reply
        if (-not [string]::IsNullOrWhiteSpace($textReply)) {
          Send-FileHelperText -Process $process -Text $textReply
        }
        foreach ($file in $files) {
          Send-FileHelperFile -Process $process -FilePath $file
        }
        Write-JsonLine @{ event = 'reply_sent'; sourceText = $text; reply = $reply; time = (Get-Date).ToString('o') }
        $handledMessage = $true
      }
    }

    if ($handledMessage) {
      Start-Sleep -Milliseconds 700
      $previousCounts = ConvertTo-Counts (Get-VisibleMessageTexts -Process $process)
    } else {
      $previousCounts = $currentCounts
    }
  } catch {
    Write-JsonLine @{ event = 'error'; message = $_.Exception.Message; time = (Get-Date).ToString('o') }
  }
  Start-Sleep -Milliseconds $PollMilliseconds
}
