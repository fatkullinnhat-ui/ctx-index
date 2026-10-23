#!/bin/bash
# ctx-index · Linux 服务器端安装（由 remote-deploy.ps1 调起，也可手动跑）
# 姿态: pi 全局安装; 配置目录 $HOME/.pi/agent (PI_CODING_AGENT_DIR 可覆盖)
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
PI="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"

mkdir -p "$PI/skills/ctx-index/scripts" "$PI/bin" "$PI/extensions/ctx-tick"
cp "$SRC/SKILL.md"                "$PI/skills/ctx-index/SKILL.md"
cp "$SRC/scripts/ctx.mjs"          "$PI/skills/ctx-index/scripts/ctx.mjs"
cp "$SRC/scripts/ctx.mjs"          "$PI/bin/ctx.mjs"
cp "$SRC/extension/index.js"       "$PI/extensions/ctx-tick/index.js"
cp "$SRC/extension/package.json"   "$PI/extensions/ctx-tick/package.json"

# 看护: 每 15 分钟巡检所有登记项目的 .ctx 占用 + 周日快照
install -m 0755 "$SRC/us141/ctx-watch.sh" "$PI/ctx-watch.sh"
[ -f "$PI/ctx-projects.conf" ] || { echo "# 每行一个启用 ctx-index 的项目绝对路径" > "$PI/ctx-projects.conf"; }
if [ -d /etc/systemd/system ]; then
    cp "$SRC/us141/ctx-check.service" "$SRC/us141/ctx-check.timer" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now ctx-check.timer
    echo "[install] timer: $(systemctl is-active ctx-check.timer) / $(systemctl list-timers ctx-check.timer --no-pager | tail -1 | awk '{print $2}')"
fi

node --check "$PI/extensions/ctx-tick/index.js"
node "$PI/bin/ctx.mjs" help | head -3
echo "[install] 完成: engine=$PI/bin/ctx.mjs skill=$PI/skills/ctx-index extension=$PI/extensions/ctx-tick"
echo "[install] 项目启用: echo \$HOME/<项目> >> $PI/ctx-projects.conf && cd \$HOME/<项目> && node $PI/bin/ctx.mjs init"
