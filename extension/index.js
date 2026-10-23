/**
 * ctx-tick · pi 运行时扩展
 *
 *   · before_agent_start：全局注入 ctx-index 协议分节——有 .ctx 完整协议；没有则给 init+登记引导
 *     （复刻 pi-purge 的 sections 注入法，bundle 打补丁失败也有兜底）
 *   · turn_start：每轮回调 node ctx.mjs auto——静默巡检，越阈(70%)且跨 5% 阶梯才 notify
 *   · /ctx 命令：status | pack A B | report 直通引擎
 *
 * 事件面依据 @earendil-works/pi-coding-agent@1.4.0 dist/extensions/mcp/index.js
 * 所有钩子 try/catch 包死：ctx 坏了绝不拖累 pi。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CTX_BIN = join(AGENT_DIR, "bin", "ctx.mjs");

function projectCwd(event) {
	return (
		event?.cwd ||
		event?.session?.cwd ||
		(typeof event?.sessionManager?.getCwd === "function" ? event.sessionManager.getCwd() : undefined) ||
		process.cwd()
	);
}

export default function ctxTick(pi) {
	if (!existsSync(CTX_BIN)) return; // 引擎没装就完全隐身

	pi.on("before_agent_start", (event) => {
		try {
			const cwd = projectCwd(event);
			const bin = CTX_BIN.split("\\").join("/");
			// 全局注入: 有 .ctx 给完整协议; 没有 .ctx 给 init+登记引导(长任务自动落闸)
			const hasCtx = existsSync(join(cwd, ".ctx"));
			const block = hasCtx ? `
# ctx-index ACTIVE
本项目启用磁盘态上下文引擎。硬约定(收尾必做, 3条命令内):
1. node "${bin}" tick -m "<本轮增量一行>" [-n "下一步"]
2. 新决策/约束/产物: node "${bin}" index <F|D|C|P|A> "<内容>" -a "键@T轮"
3. 越阈报警后: 写 .ctx/blocks/T*.md 压缩块 + node "${bin}" pack <起> <止>
恢复/回溯一律先读 .ctx/state.md 与 .ctx/index.md; 细节逐字来源 .ctx/raw/。
` : `
# ctx-index GLOBAL
磁盘态上下文引擎全局生效, 本项目尚未 init。判据: 预计 10 轮以上 / 跨主题 / 用户说 继续·上次·压缩 → 立即:
1. node "${bin}" init
2. 登记看护: echo "${cwd}" >> ~/.pi/agent/ctx-projects.conf  (Windows 同名文件在 %USERPROFILE%\\.pi\\agent\\)
3. 之后每轮收尾必 tick; 纯短问答可不 init。
`;
			if (event.systemPromptOptions?.sections) {
				event.systemPromptOptions.sections.ctx_index = block;
				return undefined;
			}
			return { systemPrompt: `${event.systemPrompt || ""}\n${block}` };
		} catch {
			return undefined;
		}
	});

	pi.on("turn_start", async (event, ctx) => {
		try {
			const cwd = projectCwd(event);
			if (!existsSync(join(cwd, ".ctx"))) return;
			const r = spawnSync(process.execPath, [CTX_BIN, "auto", "--root", cwd], {
				encoding: "utf8",
				timeout: 8000,
				cwd,
			});
			const out = (r.stdout || "").trim();
			if (out && ctx?.ui?.notify) ctx.ui.notify(out.slice(0, 500), "warning");
		} catch {}
	});

	pi.registerCommand("ctx", {
		description: "ctx-index: status | pack <起> <止> | report | tick -m ...",
		handler: (args, ctx) => {
			try {
				const argv = String(args || "status").trim().split(/\s+/).filter(Boolean);
				const r = spawnSync(process.execPath, [CTX_BIN, ...argv], {
					encoding: "utf8",
					timeout: 30000,
					cwd: process.cwd(),
				});
				const out = ((r.stdout || "") + (r.stderr || "")).trim() || "(no output)";
				ctx?.ui?.notify(out.slice(0, 1800), "info");
			} catch (e) {
				ctx?.ui?.notify(`ctx 调用失败: ${e}`, "warning");
			}
		},
	});
}
