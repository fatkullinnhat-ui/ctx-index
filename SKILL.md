---
name: ctx-index
description: 磁盘态长对话上下文引擎：把长会话增量外化到项目 .ctx/（state.md 活状态机 + index.md 分层索引 + blocks 压缩块 + raw 逐字冷存档），上下文超阈值时按 5 轮一块分块压缩并归档原始轮次，回溯时走 index→blocks→raw 三级缓存精确复现原话。当对话累计超过 10 轮、任务跨多日、用户说 继续/上次/之前说过/压缩上下文/建索引，或任何信息量大的长任务时使用。
---

# ctx-index：磁盘是唯一真值，窗口只是缓存

模型窗口迟早清旧账，`.ctx/` 里的东西不会。你的职责：把对话状态**增量外化**成磁盘文件；恢复/回溯时从磁盘重建，不凭感觉。

引擎路径（两平台同一份）：
- bash：`node "$HOME/.pi/agent/bin/ctx.mjs"`
- PowerShell：`node "$env:USERPROFILE\.pi\agent\bin\ctx.mjs"`

下文简写 `<ctx>`。

## 启动协议（每次会话开头，做完再干活）
1. 项目有 `.ctx/state.md` → 先 read `.ctx/state.md` 和 `.ctx/index.md` 恢复状态机与索引，然后**直接继续**，不要问用户"要做什么"。
2. 没有 `.ctx/` 且本会话预计是长任务（10 轮以上/跨主题/多地引用） → 跑 `<ctx> init`，**并登记看护名单**：
   `echo "<项目绝对路径>" >> ~/.pi/agent/ctx-projects.conf`（Windows 同名文件在 `%USERPROFILE%\.pi\agent\`）。
3. `<ctx> status` 看当前轮次与占用，心里有数。

> 全局性：ctx-index 协议随**每一个**新会话注入（扩展全局注入分节）。init 过的项目自动满血；没 init 的项目在本会话变长任务时由你按上面第 2 步落闸。

## 每轮收尾协议（硬要求，3 条命令内完成）
1. 记增量：`<ctx> tick -m "本轮新事实/决策/产物，一行"`（重要产出加 `-n "下一步"`）
2. 出现值得长期记的事实/决策/约束/悬案/产物：
   `<ctx> index D "状态管理用 Zustand，否决 Redux" -a "zustand@T8,redux@T9"`
   层：F=事实 D=决策 C=约束 P=悬案 A=产物
3. 新决策推翻旧决策：`<ctx> index D "<新内容>" -s D03`（旧条目自动标 superseded，不删除）

## 压缩协议（status ≥ 阈值，或用户说 压缩/compact）
1. `<ctx> status` 确认轮次与占用。
2. 保留最近 5 轮原文不做任何动作；其余每 5 轮写一个块文件 `.ctx/blocks/T<起>-T<止>.md`（pack 会生成脚手架），块内四节必须填全：
   - 主题一句话
   - 要点（**引用 index 的 ID**，例如 "D04 确定鉴权用 JWT"）
   - 锚点（数字/版本/路径/用户原话**逐字**，禁止意译改写）
   - 丢弃说明（寒暄/重复/已被取代的讨论为何能丢——索引条目永不丢）
3. `<ctx> pack <起> <止>` 把原始轮次逐字归档到 `.ctx/raw/turns-T<起>-T<止>.jsonl`（搬走 ≠ 删除，这是回溯的最终底牌）。
4. 之后你的推理只依赖 state.md + index.md + blocks；细节按需从 raw 展开，**引文不回写窗口**。

## 回溯协议（窗口内信息不足时）
典型触发：用户问"我之前说过什么 / 当时为什么选 X / 上次那个文件在哪"。
1. 锚点匹配：read `.ctx/index.md`，按关键词找条目、轮次、块引用。
2. read 对应 `.ctx/blocks/T*.md` → 仍不足 → read `.ctx/raw/turns-*.jsonl` 逐字引。
3. 输出格式：`[回溯 T08] 用户原话：…`——引用必须能在 raw 里 Ctrl+F 命中。

## 固化协议（防污染/防漂移，自动生效，需要你做的只有配合）
引擎每次写入都会把 state.md/index.md 的哈希打进 `.ctx/chain.jsonl` 链锚；watch 每 15 分钟（本机每小时）跑 `<ctx> check` 巡逻。
- **禁止**用 write/edit 直接改 `.ctx/state.md`、`.ctx/index.md`、`.ctx/chain.jsonl` —— 一律走 `<ctx> tick/index/pack`。直改会被链锚当场标记为"外部改动"，下一轮 check 拉警报。
- 结构坏了（缺段头/坏行/重复检查点）→ `<ctx> check` 报告，`<ctx> repair` 一键修：坏块坏行隔离进 `.ctx/attic/`（原文不删），链重锚。
- 快照自动滚动保留在 `.ctx/snapshots/`（默认 20 份），服务器另有周日全量 → `/root/ctx-snapshots/`。
- 用户确认过的人工修改（比如你手动改了 GOAL 行）→ 修完跑 `<ctx> anchor` 合法化；之后 check 恢复安静。
- `.ctx/attic/` 是隔离区，不是真值来源，恢复时别读它。

## 铁则
- tick/index 永远 append，从不在位改写历史条目（superseded 用状态列表达）
- 数字、版本号、路径、用户原话逐字保留，禁止意译
- `.ctx/` 是项目内 git-tracked 资产；真值要版本化
- tick 失败（如 init 未做过）不是停手理由，跳过记账继续任务，下轮补
