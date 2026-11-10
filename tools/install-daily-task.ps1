# tools/install-daily-task.ps1
# Registers a Windows scheduled task that runs "node tools/toss-sync.mjs all" on weekdays at 16:10
# (after the Korean market closes). If the PC was off at that time, it runs the next time the PC is on.
# Output goes to tools/.toss-data/daily.log (not uploaded to GitHub).
#
# Install:   powershell -ExecutionPolicy Bypass -File tools\install-daily-task.ps1
# Remove:    Unregister-ScheduledTask -TaskName 'LEDGER Toss data' -Confirm:$false
# Run now:   Start-ScheduledTask -TaskName 'LEDGER Toss data'
# (This file is ASCII only on purpose: Windows PowerShell 5 misreads Korean in scripts saved without BOM.)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$logDir = Join-Path $root 'tools\.toss-data'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'daily.log'

$cmd = "Set-Location -LiteralPath '$root'; & '$node' tools\toss-sync.mjs all *>> '$log'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At '16:10'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName 'LEDGER Toss data' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'LEDGER: download Toss minute bars, rankings, warnings and holidays, then upload to the site (tools/toss-sync.mjs all)' -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'LEDGER Toss data'
Write-Output ("Registered: " + $t.TaskName + " / next run: " + (Get-ScheduledTaskInfo -TaskName 'LEDGER Toss data').NextRunTime)
Write-Output ("Log file: " + $log)
