param(
    [string]$AghCli = '/home/drag0nm/agh/packages/cli/dist/local/agnes.mjs',
    [string]$Distro = 'Ubuntu-24.04',
    [string]$Profile = 'local-dev',
    [ValidateRange(1,65535)][int]$Port = 4177,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$taskProject = [IO.Path]::GetFullPath($PSScriptRoot)
if ($taskProject -notmatch '^([A-Za-z]):\\(.+)$') { throw '该入口需Windows本机盘符路径' }
$taskWslProject = '/mnt/' + $Matches[1].ToLowerInvariant() + '/' + $Matches[2].Replace('\','/')
foreach ($taskRelativeFile in @('agent.md','.agh/skills/pid-tuning/SKILL.md','docs/simulation-manual.md','tools/launch-agnes-web.mjs')) {
    $taskFile = Join-Path $taskProject $taskRelativeFile
    if (-not (Test-Path -LiteralPath $taskFile -PathType Leaf)) { throw "缺少项目文件 $taskRelativeFile；没有启动AGNES" }
    if ([string]::IsNullOrWhiteSpace((Get-Content -LiteralPath $taskFile -Raw -Encoding UTF8))) { throw "项目文件为空：$taskRelativeFile" }
    Write-Output "已加载 $taskRelativeFile，SHA256=$((Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash)"
}
if ($CheckOnly) {
    & wsl.exe -d $Distro --exec node $AghCli --cwd $taskWslProject --version
    if ($LASTEXITCODE -ne 0) { throw 'AGH只读版本检查失败' }
    Write-Output '只读检查完成；没有发起模型请求或运行仿真。'
    return
}
Write-Output "正在启动WSL中的AGNES网页端并初始化项目会话：http://127.0.0.1:$Port/"
Write-Output '首次初始化会请求一次模型回复；不会打开交互式CLI或运行仿真，请稍候。'
# --exec avoids shell expansion. Helper submits full files via UTF8 stdin to the
# installed WSL AGH, then returns its persisted session ID for the Web UI.
$taskResultLines = & wsl.exe -d $Distro --exec node "$taskWslProject/tools/launch-agnes-web.mjs" --cli $AghCli --project $taskWslProject --profile $Profile --port "$Port"
if ($LASTEXITCODE -ne 0) { throw 'AGNES网页会话初始化失败；请查看上面的日志路径，不要启动测试。' }
$taskResult = ($taskResultLines -join "`n") | ConvertFrom-Json
if ($taskResult.v -ne 'autotune-web-launch/1' -or $taskResult.sessionId -notmatch '^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$') { throw '网页初始化结果无效，未打开浏览器' }
$taskExpectedUrl = "http://127.0.0.1:$Port/?session=$([Uri]::EscapeDataString($taskResult.sessionId))"
if ($taskResult.url -cne $taskExpectedUrl) { throw '网页会话URL与已核验ID不匹配，未打开浏览器' }
Write-Output "项目文件已注入新会话：$($taskResult.sessionId)"
Write-Output "打开：$($taskResult.url)"
Start-Process -FilePath $taskResult.url
