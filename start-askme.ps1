chcp 65001 > $null
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'

# 发布后位于 Askme 根目录；只启动 ChatGPT 套餐中转和本机文档解析。
$askmeRoot = $PSScriptRoot
$extensionId = 'hmabehbhopolggfbmglhojehbjijcifi'
$expectedVersion = '2026.10.04.chatgpt-plan.13'
$entry = Join-Path $askmeRoot 'server\start.mjs'
$previousEntry = Join-Path $askmeRoot 'server\index.mjs'
$headers = @{ 'x-askme-extension-id' = $extensionId }
$nodePath = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $entry)) { throw '缺少 Askme ChatGPT 服务文件，未启动任何模型。' }
if (-not (Test-Path -LiteralPath (Join-Path $askmeRoot 'server\node_modules\jose\package.json'))) { throw '缺少已锁定的登录依赖，请先在 Askme/server 目录执行 npm ci。' }

$service = $null
try { $service = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/health' -Headers $headers -TimeoutSec 3 } catch {}
# 同一版本的后续修复也必须加载，不能只比较版本字符串。
$latestServiceSource = Get-ChildItem -LiteralPath (Join-Path $askmeRoot 'server') -Recurse -File |
    Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' -and $_.Extension -in @('.mjs', '.ps1', '.py') -and $_.Name -notmatch '\.test\.mjs$' } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$sourceLoaded = $service.startedAt -and $latestServiceSource -and [double]$service.startedAt -ge ([DateTimeOffset]$latestServiceSource.LastWriteTimeUtc).ToUnixTimeMilliseconds()
if ($service.provider -eq 'chatgpt-plan' -and $service.serviceVersion -eq $expectedVersion -and $sourceLoaded) {
    Write-Output 'Askme ChatGPT 服务已运行。登录状态请在学习面板查看。'
    exit 0
}
$listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $allowed = @($entry, $previousEntry) | Where-Object {
        $pattern = '(?i)(?:^|[\s"''])' + [regex]::Escape($_) + '(?:[\s"'']|$)'
        $owner.CommandLine -match $pattern
    }
    if (-not $owner -or $owner.Name -ne 'node.exe' -or -not $allowed -or -not $service.serviceVersion) { throw '4317 端口被未确认的进程占用，未自动结束。' }
    Stop-Process -Id $owner.ProcessId -Force
    Start-Sleep -Milliseconds 400
}

$logDirectory = Join-Path $askmeRoot 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$identityPath = Join-Path $askmeRoot '.work\chatgpt-integration\.runtime'
# 复用注册身份目录；新登录凭据保存在其 credentials 子目录并由 Windows 当前用户加密。
if (-not (Test-Path -LiteralPath $identityPath)) { $identityPath = Join-Path $askmeRoot '.runtime' }
$environmentNames = @('STUDY_EXTENSION_ID', 'STUDY_AI_PROVIDER', 'STUDY_PORT', 'ASKME_IDENTITY_DIR', 'ASKME_POWERSHELL')
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:STUDY_EXTENSION_ID = $extensionId
    $env:STUDY_AI_PROVIDER = 'chatgpt-plan'
    $env:STUDY_PORT = '4317'
    $env:ASKME_IDENTITY_DIR = $identityPath
    $env:ASKME_POWERSHELL = (Get-Command pwsh -ErrorAction Stop).Source
    Start-Process -FilePath $nodePath -ArgumentList @('"' + $entry + '"') -WorkingDirectory $askmeRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory 'chatgpt-service.log') `
        -RedirectStandardError (Join-Path $logDirectory 'chatgpt-service-error.log') | Out-Null
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $service = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/health' -Headers $headers -TimeoutSec 2
        # 尚未登录是正常在线状态，不能误判启动失败并反复重启。
        if ($service.provider -eq 'chatgpt-plan' -and $service.serviceVersion -eq $expectedVersion) {
            Write-Output 'Askme ChatGPT 服务已启动。请在面板连接 ChatGPT 并选择模型。'
            exit 0
        }
    } catch {}
}
throw 'Askme ChatGPT 服务启动失败。请查看 logs/chatgpt-service-error.log。'
