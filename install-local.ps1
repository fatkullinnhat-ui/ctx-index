# ctx-index · 本机 pi 安装器 (Windows)
# 产物: ~/.pi/agent/skills/ctx-index/SKILL.md        <- pi 技能发现(目录含SKILL.md即根)
#       ~/.pi/agent/bin/ctx.mjs                      <- 引擎稳定入口(bash/pwsh 双形态可调)
#       ~/.pi/agent/extensions/ctx-tick/             <- 扩展自动发现, 注入协议+turn看护+/ctx
$ErrorActionPreference = "Stop"
$pkg = Split-Path -Parent $MyInvocation.MyCommand.Path
$AGENT = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME ".pi\agent" }

$skillDir = Join-Path $AGENT "skills\ctx-index"
New-Item -ItemType Directory -Force (Join-Path $skillDir "scripts") | Out-Null
Copy-Item (Join-Path $pkg "SKILL.md") (Join-Path $skillDir "SKILL.md") -Force
Copy-Item (Join-Path $pkg "scripts\ctx.mjs") (Join-Path $skillDir "scripts\ctx.mjs") -Force

New-Item -ItemType Directory -Force (Join-Path $AGENT "bin") | Out-Null
Copy-Item (Join-Path $pkg "scripts\ctx.mjs") (Join-Path $AGENT "bin\ctx.mjs") -Force

$extDir = Join-Path $AGENT "extensions\ctx-tick"
New-Item -ItemType Directory -Force $extDir | Out-Null
Copy-Item (Join-Path $pkg "extension\index.js") (Join-Path $extDir "index.js") -Force
Copy-Item (Join-Path $pkg "extension\package.json") (Join-Path $extDir "package.json") -Force

# 固化看护: ctx-watch.ps1 + 项目清单 + 每小时计划任务
Copy-Item (Join-Path $pkg "scripts\ctx-watch.ps1") (Join-Path $AGENT "ctx-watch.ps1") -Force
$conf = Join-Path $AGENT "ctx-projects.conf"
if (-not (Test-Path $conf)) {
    "# ctx-index 看护项目清单: 每行一个绝对路径" | Set-Content $conf
}
$sh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $sh) { $sh = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if ($sh) {
    $tr = '"' + $sh + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $AGENT "ctx-watch.ps1") + '"'
    schtasks.exe /Create /TN "pi-ctx-watch" /TR $tr /SC HOURLY /F | Out-Null
}

node --check (Join-Path $extDir "index.js")
node (Join-Path $AGENT "bin\ctx.mjs") help | Select-Object -First 3
Write-Host ""
Write-Host "[install] OK"
Write-Host "[install] 引擎      $AGENT\bin\ctx.mjs"
Write-Host "[install] 技能      $skillDir\SKILL.md"
Write-Host "[install] 扩展      $extDir"
Write-Host "[install] 固化看护  $AGENT\ctx-watch.ps1 · 计划任务 pi-ctx-watch(每小时) · 名单 $conf"
Write-Host "[install] 项目启用   cd <项目> ; node `"$AGENT\bin\ctx.mjs`" init"
Write-Host "[install] 卸载       Remove-Item -Recurse $skillDir, $extDir, (Join-Path $AGENT 'bin\ctx.mjs') ; schtasks /Delete /TN pi-ctx-watch /F"
