chcp 65001 > $null
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'

$wscript = 'C:\Windows\System32\wscript.exe'
$launcher = 'D:\Askme\start-askme-hidden.vbs'
$powershell = 'C:\Users\Chen\AppData\Local\Microsoft\WindowsApps\pwsh.exe'
$taskName = 'Askme Local AI'
$arguments = '"D:\Askme\start-askme-hidden.vbs" //B //NoLogo'

if (-not (Test-Path -LiteralPath $wscript)) {
    throw "找不到 Windows Script Host：$wscript"
}

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "找不到 Askme 隐藏启动器：$launcher"
}

if (-not (Test-Path -LiteralPath $powershell)) {
    throw "找不到 PowerShell 7：$powershell"
}

# 单个计划任务同时负责登录启动和五分钟巡检，避免 Run 项与登录触发器并发启动。
# wscript 通过 VBS 隐藏启动 PowerShell 7；start-askme.ps1 具有幂等检查，
# 服务健康时会立即退出，不会重复启动模型或显示终端窗口。
$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory 'D:\Askme'
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Settings $settings -Description '保持 Askme 本机 AI 与文档解析服务可用。' -Force | Out-Null

$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if (-not $registered.Settings.Enabled -or $registered.Actions.Execute -ne $wscript -or $registered.Actions.Arguments -ne $arguments -or
    $registered.Triggers.Count -ne 2 -or [string]$registered.Settings.MultipleInstances -ne 'IgnoreNew') {
    throw 'Askme scheduled task verification failed.'
}

# 清理早期版本的重复 HKCU Run 启动项，只保留上面经过回读验证的单任务。
$runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runPath -Name 'AskmeLocalAI' -ErrorAction SilentlyContinue

Start-ScheduledTask -TaskName $taskName
Write-Output "ScheduledTask=$taskName"
