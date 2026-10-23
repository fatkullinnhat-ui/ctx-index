# ctx-index · 远程推送 (Windows -> Linux, ssh)
# 用法:  .\remote-deploy.ps1 -Target root@1.2.3.4
#        .\remote-deploy.ps1 -Target myserver -Port 22 -RemoteDir /opt/ctx-index
# 流程:  tar 打包 -> scp 推送 -> 远端 bash install-us141.sh -> systemd timer 生效
param(
    [Parameter(Mandatory=$true)][string]$Target,
    [int]$Port = 22,
    [string]$RemoteDir = "/opt/ctx-index"
)
$ErrorActionPreference = "Stop"
$pkg = Split-Path -Parent $MyInvocation.MyCommand.Path
$tgz = Join-Path $env:TEMP "ctx-index.tgz"
if (Test-Path $tgz) { Remove-Item $tgz -Force }

tar -czf $tgz -C $pkg SKILL.md scripts extension us141 README.md
ssh -p $Port $Target "mkdir -p $RemoteDir"
scp -P $Port $tgz "${Target}:${RemoteDir}.tgz"
ssh -p $Port $Target "tar xzf ${RemoteDir}.tgz -C $RemoteDir && bash ${RemoteDir}/us141/install-us141.sh && rm -f ${RemoteDir}.tgz"
Write-Host "[deploy] 完成: \$HOME/.pi/agent/{skills/ctx-index, bin/ctx.mjs, extensions/ctx-tick} + ctx-check.timer"
