# ctx-index · 磁盘态长对话上下文引擎

**Disk-state context engine for the [pi coding agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）。**

> 磁盘是唯一真值，模型窗口只是缓存。压缩只作用于窗口；`.ctx/raw/` 逐字冷存档永不删除——
> 所以永远不会"丢上下文"，只会"暂时折叠"。

LLM 长对话有两个死穴：**窗口装不下**（旧内容被静默截断）和**模型会撒谎**（声称记得/完成了其实没有）。
ctx-index 把两个问题都变成磁盘问题：

1. **状态外化** → 窗口清了也能从磁盘恢复，跨天跨会话接续。
2. **哈希链固化** → 每次引擎写入都锚定 sha256，agent 绕过引擎直改文件当场暴露
   （实测抓到过跑完六条命令却一个都没执行、纯文本裸演 "PASS" 的 flash 模型）。

## 架构

```
<项目>/.ctx/
├── state.md     活状态机: GOAL / WORKING SET / CHECKPOINTS (每轮 append-only)
├── index.md     分层索引: F事实 D决策 C约束 P悬案 A产物, 每条带 锚点@T轮
├── blocks/      压缩块(5轮一块): 主题 / 要点(引索引ID) / 锚点(逐字) / 丢弃说明
├── raw/         原始轮次逐字 JSONL —— 回溯的最终底牌 (搬走 ≠ 删除)
├── chain.jsonl  固化哈希链: 每次写入锚 sha256(state)+sha256(index)
├── snapshots/   滚动快照(默认 20 份): state/index/config/chain
├── attic/       修复隔离区: 坏块坏行搬进来, 原文不删
└── config.json  threshold=0.7 ratio=3.0 keepRecent=5 freezeVersion=1 snapshotKeep=20
```

**回溯三级缓存**：`index 锚点匹配 → blocks 读要点 → raw 逐字引原话`。
**固化闭环**：`check`(结构+链锚校验) → `repair`(隔离+重锚) → `anchor`(人工改动合法化) → `snapshot`(快照)，写并发由 `.wlock` 文件锁互斥。

索引条目长这样（`|` 分列，锚点逐字保留数字/版本/路径/用户原话）：

```
F01|T1|事实: paseo到pi到ctx-index全链真实打通|active|锚:gk@T1
D01|T1|临时决策: E2E目录用完即弃|superseded by D02|锚:tmp@T1
D02|T1|正式决策: ctx-e2e目录留作演示|active|锚:final@T1|取代:D01
```

## 组成

| 件 | 路径 | 作用 |
|---|---|---|
| 技能 | `SKILL.md` | pi 技能发现——模型侧协议：启动恢复 / 每轮收尾 / 越阈压缩 / 回溯引文 |
| 引擎 | `scripts/ctx.mjs` | 零依赖 CLI（Node ≥ 18, Windows/Linux）：init · status · auto · tick · index · pack · check · repair · snapshot · anchor · report |
| 扩展 | `extension/` | ctx-tick：`before_agent_start` **全局注入**协议分节（init 过=完整协议，没 init=init+登记引导）、`turn_start` 静默巡检越阈才叫、`/ctx` 斜杠命令直通 |
| 看护 | `scripts/ctx-watch.ps1` | Windows：计划任务每小时，固化巡逻 + 占用巡检 + 每日快照 |
| 看护 | `us141/` | Linux：`ctx-watch.sh` + systemd `ctx-check.service/.timer`（15 分钟巡逻 + 4h 快照 + 周日全量 tar）+ 安装器 |
| 安装 | `install-local.ps1` / `remote-deploy.ps1` | Windows 一键装 / ssh 推送到 Linux |

## 安装

**Windows（本机 pi）：**

```powershell
git clone https://github.com/fatkullinnhat-ui/ctx-index.git
cd ctx-index
.\install-local.ps1        # skills/ctx-index + bin/ctx.mjs + extensions/ctx-tick + 计划任务 pi-ctx-watch
```

**Linux（服务器 pi）：**

```bash
git clone https://github.com/fatkullinnhat-ui/ctx-index.git
cd ctx-index
bash us141/install-us141.sh    # PI_CODING_AGENT_DIR 可覆盖, 默认 $HOME/.pi/agent
```

> 非 root 用户：安装器检测到无 systemd 系统级权限时，会打印一条现成的 crontab 命令（15 分钟巡检），
> 复制执行即可。巡检扫描根默认 `$HOME` + `/home`，项目在别处时用环境变量覆盖：
> `export CTX_SCAN_ROOTS="/srv/projects /data/work"`（写入 watch 的运行环境即可）。

**项目启用（两条命令）：**

```bash
echo "$(pwd)" >> ~/.pi/agent/ctx-projects.conf   # 进看护名单(可选)
cd <项目> && node ~/.pi/agent/bin/ctx.mjs init
```

装完即全局生效：**每一个新开的 pi 会话**都会带 ctx_index 协议分节——init 过的项目自动满血
（恢复状态机 + 每轮记账 + 越阈压缩 + 定时巡逻）；没 init 的项目在对话变长任务时由 agent 按
SKILL.md 判据自己落闸。

## 日常（模型自己做，人只享福）

```bash
node ~/.pi/agent/bin/ctx.mjs tick -m "本轮增量一行"     # 每轮收尾, 自动打链锚
node ~/.pi/agent/bin/ctx.mjs index D "决策内容" -a "键@T8"  # 长期事实/决策
node ~/.pi/agent/bin/ctx.mjs pack 6 15                 # 越阈后: 原始轮次归档 raw + 压缩块脚手架
node ~/.pi/agent/bin/ctx.mjs check                     # 结构/链锚校验 (watch 自动巡逻)
node ~/.pi/agent/bin/ctx.mjs repair                    # 坏了一键修: 坏块隔离 attic/, 链重锚
```

回溯格式：`[回溯 T08] 用户原话：…`——引文必须能在 `.ctx/raw/` 里 Ctrl+F 命中。

## 固化层（防污染 / 防漂移）

- **chain.jsonl 哈希链**：tick/index/pack/repair/snapshot 每次写入追加
  `{t, op, sh_state, sh_index}`；绕过引擎的直改（人或模型用 write/edit 动 state.md/index.md）
  会在下一次 check 被标记为"与链锚不符 → 上次合法写入 <时间戳>"。
- **check**：骨架段完整、检查点 T 序唯一、索引行格式、supersede 引用闭环、块引用存在、config 合法。
- **repair**：坏块坏行隔离进 `attic/<时间戳>/`（原件保留），悬空推翻恢复 active，链重锚。
- **snapshot**：`.ctx/snapshots/<UTC>/` 滚动保留 20 份；Linux watch 另有周日全量 tar（留 14 份）。
- **写锁**：`.wlock` 独占文件锁互斥并发写，陈锁 30 秒自动接管。
- 人工改过真值文件且确认合法：`node ctx.mjs anchor` 合法化，之后 check 恢复安静。

## 与 pi-purge 的关系

pi-purge（pi 指令权威性清洗）的补丁锚点宇宙是 pi 安装目录的 `dist/bundle{,/chunks}`，
启动器 shim 只包 `pi`/`pi.cmd`/`pi.ps1`；ctx-index 的全部文件都在 `~/.pi/agent` 之下——
**结构性零交集**。pi 更新 → pi-purge guard 自愈重打 → ctx-index 文件哈希逐字节不变（实测）。

## 兼容性

- pi `@earendil-works/pi-coding-agent` **1.4.0**（会话 JSONL v3，`~/.pi/agent/sessions/<munged-cwd>/`；
  扩展 API 与会话格式随 pi 大版本可能变化，届时按 repo 更新）
- Node ≥ 18，零第三方依赖
- Windows 10/11 + PowerShell 5.1+（计划任务 pi-ctx-watch）；Linux + systemd（root）或 cron（非 root）+ tmux（可选，告警用）
- 窗口大小从 `~/.pi/agent/models.json` 读取；缺失时回退 131,072（占用百分比可能偏差，`--window` 可临时覆盖）
- 引擎/看护的输出信息为中文；协议文件 SKILL.md 亦为中文——不影响任何功能，英文用户可自行改写文案

## 卸载

```powershell
# Windows
Remove-Item -Recurse "$env:USERPROFILE\.pi\agent\skills\ctx-index", "$env:USERPROFILE\.pi\agent\extensions\ctx-tick"
Remove-Item "$env:USERPROFILE\.pi\agent\bin\ctx.mjs", "$env:USERPROFILE\.pi\agent\ctx-watch.ps1"
schtasks /Delete /TN pi-ctx-watch /F
```

```bash
# Linux
rm -rf ~/.pi/agent/skills/ctx-index ~/.pi/agent/extensions/ctx-tick ~/.pi/agent/bin/ctx.mjs \
       ~/.pi/agent/ctx-watch.sh ~/.pi/agent/ctx-projects.conf ~/.pi/agent/ctx-registry.log
sudo systemctl disable --now ctx-check.timer && sudo rm -f /etc/systemd/system/ctx-check.{service,timer} && sudo systemctl daemon-reload
```

（各项目 `.ctx/` 目录是数据，按需保留或删除。）

## License

[MIT](LICENSE)
