# ctx-index · 本机 Windows 看护（计划任务 pi-ctx-watch 每小时调起）
# 职责: 1) 固化巡逻 check, 坏了落 ALERT-BROKEN + registry 日志
#       2) 占用巡检 status 记 registry
#       3) 每 24 小时 .ctx 内部快照(snapshot 滚动留 20)
# 用法: pwsh -NoProfile -File ctx-watch.ps1   (项目清单: %USERPROFILE%\.pi\agent\ctx-projects.conf)
$ErrorActionPreference = "Continue"
$PI = Join-Path $env:USERPROFILE ".pi\agent"
$ENG = Join-Path $PI "bin\ctx.mjs"
$CONF = Join-Path $PI "ctx-projects.conf"
$LOG = Join-Path $PI "ctx-registry.log"
if (-not (Test-Path $ENG)) { return }
New-Item -ItemType Directory -Path $PI -Force | Out-Null
$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# 全局发现: conf 名单 ∪ Desktop/Documents 深度3内所有 .ctx
$projects = @()
if (Test-Path $CONF) { $projects += @(Get-Content $CONF) }
foreach ($rootDir in @((Join-Path $env:USERPROFILE "Desktop"), (Join-Path $env:USERPROFILE "Documents"))) {
    if (Test-Path $rootDir) {
        $projects += (Get-ChildItem $rootDir -Recurse -Depth 3 -Force -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq ".ctx" } |
            ForEach-Object { $_.Parent.FullName })
    }
}
$projects = @($projects | Where-Object { $_ -and -not "$_".TrimStart().StartsWith("#") } | Sort-Object -Unique)

foreach ($p in $projects) {
    if (-not (Test-Path (Join-Path $p ".ctx"))) { continue }
    # 1) 固化巡逻
    $chk = & node $ENG check --root $p 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Add-Content $LOG "$now  $p  ::  CHECK-FAIL  $((($chk -split "`r?`n") | Select-Object -First 4) -join ' ')"
        New-Item -ItemType File (Join-Path $p ".ctx\ALERT-BROKEN") -Force | Out-Null
        continue
    }
    # 2) 占用巡检
    $out = (& node $ENG status --root $p 2>&1 | Out-String).Trim() -replace "`r?`n", " "
    Add-Content $LOG "$now  $p  ::  $out"
    # 3) 24h 节流快照
    $marker = Join-Path $p ".ctx\.snap24h"
    $stale = $true
    if (Test-Path $marker) { $stale = (Get-Item $marker).LastWriteTime -lt (Get-Date).AddHours(-24) }
    if ($stale) {
        & node $ENG snapshot --root $p 2>&1 | Out-Null
        New-Item -ItemType File $marker -Force | Out-Null
    }
}
# registry 轮转: 保留最近 200 行
if (Test-Path $LOG) {
    $lines = @(Get-Content $LOG)
    if ($lines.Count -gt 200) { $lines | Select-Object -Last 200 | Set-Content $LOG }
}
