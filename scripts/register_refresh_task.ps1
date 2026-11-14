# HELIOS-SHIELD: register an hourly Windows Task Scheduler job that runs
#   .venv\Scripts\pythonw.exe -m helios.cli refresh
# (fresh NASA FIRMS NRT fires -> noise filter -> AI #1 -> alerts -> Supabase).
# Runs as the current user while logged on, no console window, 45 min time limit,
# never two copies at once; missed runs start when the PC wakes up.
#
# Register:   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register_refresh_task.ps1
# Remove:     Unregister-ScheduledTask -TaskName 'HELIOS-SHIELD NRT refresh' -Confirm:$false
# Run now:    Start-ScheduledTask -TaskName 'HELIOS-SHIELD NRT refresh'
# Log file:   data\logs\refresh.log

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pythonw = Join-Path $root '.venv\Scripts\pythonw.exe'
if (-not (Test-Path $pythonw)) { throw "pythonw.exe not found: $pythonw (create the venv first)" }

$taskName = 'HELIOS-SHIELD NRT refresh'
$action = New-ScheduledTaskAction -Execute $pythonw -Argument '-m helios.cli refresh' -WorkingDirectory $root
$now = Get-Date
$start = $now.Date.AddHours($now.Hour + 1).AddMinutes(7)   # every hour at :07
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force `
    -Description 'HELIOS-SHIELD: hourly NASA FIRMS NRT -> noise filter -> AI#1 alerts -> Supabase (log: data\logs\refresh.log)' | Out-Null

$t = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
"registered: $($t.TaskName) | state: $($t.State) | next run: $($info.NextRunTime) | repeat: $($t.Triggers[0].Repetition.Interval) for '$($t.Triggers[0].Repetition.Duration)'"
