#!/bin/bash
# ctx-index · Linux 看护（ctx-check.timer 每 15 分钟调起）
# 职责: 1) 结构固化巡逻(check), 坏了即报警+落 ALERT-BROKEN
#       2) 巡检登记项目占用, >85% 触发告警(tmux display)
#       3) 每 4 小时 .ctx 内部快照(snapshot 滚动留 20), 周日全量 tar → ~/ctx-snapshots
# 真值要快照: 磁盘是唯一真值, 但磁盘也会死, 真值+链锚+备份才叫固化.
set -u
PI="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
CONF="$PI/ctx-projects.conf"
LOG="$PI/ctx-registry.log"
[ -f "$CONF" ] || exit 0
touch "$LOG" 2>/dev/null || true
NOW="$(date -u +%FT%TZ)"

# 全局发现: conf 名单 ∪ 扫描 .ctx(扫描根 CTX_SCAN_ROOTS 可覆盖, 默认 $HOME + /home; 剪掉 node_modules/.git/.cache)
SCAN_ROOTS="${CTX_SCAN_ROOTS:-$HOME /home}"
DISC="$(mktemp)"
find $SCAN_ROOTS -maxdepth 5 \( -name node_modules -o -name .git -o -name .cache \) -prune -o -type d -name .ctx -print 2>/dev/null | sed 's|/\.ctx$||' > "$DISC"
{ cat "$CONF" 2>/dev/null; cat "$DISC"; } | sort -u > "$DISC.u" && mv "$DISC.u" "$DISC"

while read -r p; do
    case "$p" in ""|\#*) continue;; esac
    [ -d "$p/.ctx" ] || continue
    # 1) 固化巡逻: 结构 + 链锚
    chk="$(cd "$p" && node "$PI/bin/ctx.mjs" check 2>&1)"
    rc=$?
    if [ $rc -ne 0 ]; then
        echo "$NOW  $p  ::  CHECK-FAIL  $(echo "$chk" | head -4 | tr '\n' ' ')" >> "$LOG"
        tmux display-message -d 10 "ctx-index: $p 结构/链锚异常 — 看 ctx-registry.log" 2>/dev/null || true
        touch "$p/.ctx/ALERT-BROKEN"
        continue
    fi
    # 2) 占用巡检
    out="$(cd "$p" && node "$PI/bin/ctx.mjs" status 2>&1 | head -3 | tr '\n' ' ')"
    echo "$NOW  $p  ::  $out" >> "$LOG"
    pct="$(echo "$out" | grep -oE '\([0-9.]+%\)' | head -1 | tr -d '(%)')"
    if [ -n "${pct:-}" ]; then
        ipct="${pct%%.*}"
        if [ "${ipct:-0}" -ge 85 ]; then
            echo "$NOW  ALERT  $p  ${pct}%" >> "$LOG"
            tmux display-message -d 10 "ctx-index: $p 占用 ${pct}% — 需要压缩" 2>/dev/null || true
            touch "$p/.ctx/ALERT-NEEDS-COMPACT"
        fi
    fi
    # 3) 4 小时节流快照(引擎内部滚动留 20 份)
    if [ -z "$(find "$p/.ctx/.snap4h" -mmin -240 2>/dev/null)" ]; then
        (cd "$p" && node "$PI/bin/ctx.mjs" snapshot >> "$LOG" 2>&1) || true
        touch "$p/.ctx/.snap4h"
    fi
done < "$DISC"

# 周日全量快照, 保留 14 份 (外部 tar, 独立于 .ctx/snapshots) — 用同一份全局发现名单
if [ "$(date +%u)" = "7" ]; then
    mkdir -p "${HOME}/ctx-snapshots"
    while read -r p; do
        case "$p" in ""|\#*) continue;; esac
        [ -d "$p/.ctx" ] || continue
        tar czf "${HOME}/ctx-snapshots/$(basename "$p")-$(date +%F).tgz" -C "$p" .ctx 2>/dev/null || true
    done < "$DISC"
    ls -1t "${HOME}"/ctx-snapshots/*.tgz 2>/dev/null | tail -n +15 | xargs -r rm -f
fi
rm -f "$DISC"
tail -50 "$LOG" > "$LOG.tail" && mv "$LOG.tail" "$LOG"
