#!/usr/bin/env node
/**
 * ctx-index engine · 磁盘态长对话上下文引擎
 * 跨平台(Windows/Linux) · Node>=18 · 零依赖
 *
 * 设计原则:
 *   1. 磁盘(.ctx/)是唯一真值, 模型窗口只是缓存 => 压缩只动窗口, raw/ 逐字冷存档永不删
 *   2. 每轮增量 append => O(1), 永不全量重建, 永不漂移
 *   3. 锚点(数字/版本/路径/用户原话)逐字进索引 => 回溯精准命中
 *
 * 命令:
 *   init                       建骨架 .ctx/{state.md,index.md,config.json,chain.jsonl,blocks/,raw/,snapshots/,attic/}
 *   status                     测量当前项目会话: 轮次/估算tokens/窗口占比/阈值告警
 *   auto                       静默巡检(供扩展每轮回调): 越阈才输出, 5%阶梯防刷屏
 *   tick -m "<增量一行>" [-n "<下一步>"]                    追加检查点 state.md (自动链锚)
 *   index <F|D|C|P|A> "<内容>" [-t N] [-a "k1@T8,k2@T9"]
 *          [-s D03] [-b T006-T010] [-st active|closed]      增量索引条目 (自动链锚)
 *   pack <from> <to>           把会话第from..to轮逐字归档到 raw/, 建压缩块脚手架 (自动链锚)
 *   report                     状态+索引+块+冷存档盘点
 *   check                      结构固化校验: state/index/config/chain 完整性 + 外部改动检测
 *   repair                     修复结构: 坏块/坏行隔离到 attic/ (原文不删), 重建骨架, 重打链锚
 *   snapshot [-k N]             快照 state/index/config/chain → .ctx/snapshots/<ts>/, 滚动留N份(默认20)
 *   anchor                     手动重打链锚(用户确认过的人工修改后使用; 之前保留检测追踪)
 *
 * 固化层(freeze):
 *   chain.jsonl 哈希链: 每次引擎写入追加 sha256(state.md),sha256(index.md) → 外部绕过引擎的
 *   直改/污染在 check 时当场暴露(报出上次合法写入时间); 并发写入用 .wlock 文件锁互斥。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, openSync, writeSync, closeSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { parseArgs } from "node:util";

const CLI = parseArgs({
	args: process.argv.slice(2),
	options: {
		root: { type: "string" },
		session: { type: "string" },
		window: { type: "string" },
		threshold: { type: "string" },
		m: { type: "string" },
		n: { type: "string" },
		t: { type: "string" },
		a: { type: "string" },
		s: { type: "string" },
		st: { type: "string" },
		b: { type: "string" },
		k: { type: "string" },
	},
	allowPositionals: true,
	strict: false,
});
const V = CLI.values;
const [cmdRaw, ...rest] = CLI.positionals;
const cmd = cmdRaw || "help";

const ROOT = resolve(V.root || process.cwd());
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || join(AGENT_DIR, "sessions");
const CTX = join(ROOT, ".ctx");
const STATE = join(CTX, "state.md");
const INDEX = join(CTX, "index.md");
const BLOCKS = join(CTX, "blocks");
const RAW = join(CTX, "raw");
const CONFIG = join(CTX, "config.json");
const CHAIN = join(CTX, "chain.jsonl");
const SNAPS = join(CTX, "snapshots");
const ATTIC = join(CTX, "attic");
const WLOCK = join(CTX, ".wlock");

const DEFAULTS = { threshold: 0.7, ratio: 3.0, keepRecent: 5, alertStep: 0.05, windowFallback: 131072, freezeVersion: 1, snapshotKeep: 20 };
function loadConfig() {
	if (!existsSync(CONFIG)) return { ...DEFAULTS };
	try { return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG, "utf8")) }; } catch { return { ...DEFAULTS }; }
}
const cfg = loadConfig();

// ---------- 固化层: 哈希链 / 结构校验 / 写锁 ----------
const sha256Buf = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
function sha256File(p) { return sha256Buf(readFileSync(p)); }
function chainLast() {
	if (!existsSync(CHAIN)) return null;
	let out = null;
	for (const ln of readFileSync(CHAIN, "utf8").split(/\r?\n/)) {
		if (!ln.trim()) continue;
		try { out = JSON.parse(ln); } catch {}
	}
	return out;
}
function anchor(op, extra = {}) {
	if (!existsSync(CTX)) return;
	const rec = { t: new Date().toISOString(), op, ...extra };
	try { rec.sh_state = sha256File(STATE); } catch {}
	try { rec.sh_index = sha256File(INDEX); } catch {}
	try { appendFileSync(CHAIN, JSON.stringify(rec) + "\n"); } catch {}
}
function acquireLock() {
	for (let i = 0; i < 4; i++) {
		try {
			const fd = openSync(WLOCK, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }));
			closeSync(fd);
			return true;
		} catch {
			try {
				const st = statSync(WLOCK);
				if (Date.now() - st.mtimeMs > 30000) { rmSync(WLOCK, { force: true }); continue; } // 陈旧锁接管
			} catch { return true; }
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
		}
	}
	return false;
}
function releaseLock() { try { rmSync(WLOCK, { force: true }); } catch {} }
function parseEntry(ln) {
	const f = ln.split("|");
	if (!/^([FDCPA]\d{2,})$/.test(f[0] || "")) return null;
	if (!/^T\d+$/.test(f[1] || "")) return null;
	let si = -1;
	for (let i = 3; i < f.length; i++) {
		if (f[i] === "active" || /^superseded by [FDCPA]\d{2,}$/.test(f[i])) { si = i; break; }
	}
	if (si < 0) return null;
	const content = f.slice(2, si).join("|").trim();
	if (!content) return null;
	for (const x of f.slice(si + 1)) {
		if (x !== "" && !x.startsWith("锚:") && !x.startsWith("取代:") && !x.startsWith("块:")) return null;
	}
	return { id: f[0], turn: f[1], content, status: f[si], extras: f.slice(si + 1).filter(Boolean) };
}
function collectIssues() {
	const issues = [], warnings = [];
	if (!existsSync(CTX)) { issues.push(".ctx 未 init"); return { issues, warnings }; }
	// state.md
	if (!existsSync(STATE)) issues.push("state.md 缺失");
	else {
		const txt = readFileSync(STATE, "utf8");
		const lines = txt.split(/\r?\n/);
		if (!/^# ctx-index state/.test(lines[0] || "")) issues.push("state.md:1 首行非骨架标识");
		for (const h of ["# GOAL", "# WORKING SET", "# CHECKPOINTS"]) {
			const hit = lines.some((l) => { const t = l.trim(); return t === h || t.startsWith(h + " ") || t.startsWith(h + "("); });
			if (!hit) issues.push(`state.md 段缺失: ${h}`);
		}
		const seenT = new Set();
		for (const b of txt.split(/^## /m).slice(1)) {
			const head = (b.split(/\r?\n/)[0] || "").trim();
			const m = head.match(/^\[T(\d+)\] (.+)$/);
			if (!m) { issues.push(`state.md 检查点头坏: "## ${head.slice(0, 40)}"`); continue; }
			const n = m[1];
			if (seenT.has(n)) issues.push(`state.md T${n} 重复检查点`);
			seenT.add(n);
			if (Number.isNaN(Date.parse(m[2]))) warnings.push(`state.md T${n} 时间戳不可解析`);
			if (!/^[-*] Δ:/m.test(b)) warnings.push(`state.md T${n} 缺 Δ 行`);
		}
	}
	// index.md
	const blockRefs = [];
	if (!existsSync(INDEX)) issues.push("index.md 缺失");
	else {
		const ids = new Map();
		const sup = [];
		let lnNo = 0;
		for (const ln of readFileSync(INDEX, "utf8").split(/\r?\n/)) {
			lnNo++;
			if (!ln.trim() || ln.startsWith("#")) continue;
			if (!/^[FDCPA]\d{2,}\|/.test(ln)) { issues.push(`index.md:${lnNo} 非条目行 "${ln.slice(0, 50)}"`); continue; }
			const p = parseEntry(ln);
			if (!p) { issues.push(`index.md:${lnNo} 条目结构不完整 "${ln.slice(0, 50)}"`); continue; }
			if (ids.has(p.id)) issues.push(`index.md:${lnNo} 重复 ${p.id}`);
			ids.set(p.id, lnNo);
			if (p.status.startsWith("superseded")) sup.push({ t: p.status.replace("superseded by ", ""), lnNo });
			if (!p.extras.some((e) => e.startsWith("锚:"))) warnings.push(`index.md:${lnNo} ${p.id} 无锚点`);
			for (const e of p.extras) if (e.startsWith("块:")) blockRefs.push({ ref: e.slice(2), lnNo });
		}
		for (const { t, lnNo } of sup) if (!ids.has(t)) issues.push(`index.md:${lnNo} supersede 目标 ${t} 不存在`);
		for (const { ref, lnNo } of blockRefs) if (!existsSync(join(BLOCKS, `${ref}.md`))) issues.push(`index.md:${lnNo} 引用块 T${ref} 不存在`);
	}
	// config.json
	if (!existsSync(CONFIG)) warnings.push("config.json 缺失(用默认值)");
	else {
		try {
			const c = JSON.parse(readFileSync(CONFIG, "utf8"));
			if (!(c.threshold > 0 && c.threshold <= 1)) warnings.push("config.json threshold 越界(0-1)");
			if (!c.freezeVersion) warnings.push("config.json 无 freezeVersion(旧项目, 已兼容)");
		} catch { issues.push("config.json 不可解析"); }
	}
	// 链锚: 外部改动检测
	const last = chainLast();
	if (!last) warnings.push("chain.jsonl 未建立(旧项目): 下次引擎写入或 anchor 后生效");
	else {
		try {
			if (last.sh_state && last.sh_state !== sha256File(STATE)) issues.push(`state.md 与链锚不符 → 上次合法写入 ${last.t}(外部改动/绕过引擎)`);
		} catch { issues.push("state.md 缺失但链锚有记录"); }
		try {
			if (last.sh_index && last.sh_index !== sha256File(INDEX)) issues.push(`index.md 与链锚不符 → 上次合法写入 ${last.t}(外部改动/绕过引擎)`);
		} catch {}
	}
	return { issues, warnings };
}


// ---------- session 定位与解析 ----------
// pi 会话目录命名: "--" + cwd把 [:\/] 换成"-" + "--"，实测吻合:
//   C:\Users\Milk\Desktop\poj  ->  --C--Users-Milk-Desktop-poj--
// pi 实测命名: 内部分隔符→"-", 开头分隔符不产 dash(POSIX /root -> --root--), 点号保留, 前后包 "--"
function munge(p) {
	let s = String(p).replace(/[:\\\/]/g, "-");
	if (s.startsWith("-")) s = s.replace(/^-+/, "");
	return "--" + s + "--";
}
function newestJsonl(dir) {
	let best = null;
	try {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".jsonl")) continue;
			const full = join(dir, f);
			const st = statSync(full);
			if (!best || st.mtimeMs > best.ms) best = { full, ms: st.mtimeMs };
		}
	} catch {}
	return best?.full || null;
}
function findSession() {
	if (V.session) return V.session;
	const projDir = join(SESSIONS_DIR, munge(ROOT));
	let f = newestJsonl(projDir);
	if (f) return f;
	// 兜底: 归一比较(塌缩连续'-')，覆盖特殊字符路径
	const want = munge(ROOT).replace(/-+/g, "-");
	try {
		for (const d of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
			if (!d.isDirectory()) continue;
			if (d.name.replace(/-+/g, "-") !== want) continue;
			f = newestJsonl(join(SESSIONS_DIR, d.name));
			if (f) return f;
		}
	} catch {}
	return null;
}
function readRecords(path) {
	const out = [];
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try { out.push({ rec: JSON.parse(line), line }); } catch {}
	}
	return out;
}
// 估算文本量: 核对过的字段族(text/thinking/content字符串/output/command/toolCall输入)
function textLen(msg) {
	if (!msg) return 0;
	let s = 0;
	const c = msg.content;
	if (typeof c === "string") s += c.length;
	else if (Array.isArray(c)) {
		for (const it of c) {
			if (!it) continue;
			if (typeof it.text === "string") s += it.text.length;
			if (typeof it.thinking === "string") s += it.thinking.length;
			if (typeof it.output === "string") s += it.output.length;
			if (it.input !== undefined) { try { s += JSON.stringify(it.input).length / 2; } catch {} }
		}
	}
	if (typeof msg.output === "string") s += msg.output.length;
	if (typeof msg.command === "string") s += msg.command.length;
	return s;
}
function stats(records) {
	let turns = 0, chars = 0, modelRec = null;
	for (const { rec } of records) {
		if (rec.type === "model_change") modelRec = rec;
		if (rec.type !== "message") continue;
		const m = rec.message || {};
		chars += textLen(m);
		if (m.role === "user" && !m.excludeFromContext) turns++;
	}
	const tokens = Math.ceil(chars / (cfg.ratio || 3));
	let window = Number(V.window) || cfg.windowFallback;
	if (modelRec) {
		try {
			const models = JSON.parse(readFileSync(join(AGENT_DIR, "models.json"), "utf8"));
			const pm = models.providers?.[modelRec.provider]?.models?.find((x) => x.id === modelRec.modelId || x.name === modelRec.modelId);
			if (pm?.contextWindow) window = pm.contextWindow;
		} catch {}
	} else {
		try {
			const models = JSON.parse(readFileSync(join(AGENT_DIR, "models.json"), "utf8"));
			const first = Object.values(models.providers || {})[0]?.models?.[0];
			if (first?.contextWindow) window = Number(V.window) || first.contextWindow;
		} catch {}
	}
	const threshold = V.threshold ? Number(V.threshold) : cfg.threshold;
	return { turns, chars, tokens, window, pct: window ? tokens / window : 0, threshold, model: modelRec };
}
function ctxCounts() {
	if (!existsSync(INDEX)) return null;
	const per = { F: 0, D: 0, C: 0, P: 0, A: 0 };
	for (const ln of readFileSync(INDEX, "utf8").split(/\r?\n/)) {
		const m = ln.match(/^([FDCPA])(\d+)\|/);
		if (m) per[m[1]]++;
	}
	let blocks = 0, raws = 0, rawBytes = 0;
	try { for (const f of readdirSync(BLOCKS)) if (f.endsWith(".md")) blocks++; } catch {}
	try { for (const f of readdirSync(RAW)) { raws++; rawBytes += statSync(join(RAW, f)).size; } } catch {}
	return { per, blocks, raws, rawBytes };
}
const fmt = (n) => n.toLocaleString("en-US");
function statusLine(st, proj) {
	const pc = (st.pct * 100).toFixed(1);
	const warn = st.pct >= st.threshold ? " ⚠ 建议压缩(保留最近" + cfg.keepRecent + "轮, 其余分块 pack)" : "";
	return `[ctx] ${proj} · ${st.turns} 轮 · 约${fmt(st.tokens)} tok / 窗口${fmt(st.window)} (${pc}%) · 阈值${(st.threshold * 100).toFixed(0)}%${warn}`;
}

// ---------- 命令实现 ----------
function doInit() {
	for (const d of [CTX, BLOCKS, RAW]) mkdirSync(d, { recursive: true });
	if (!existsSync(STATE)) {
		writeFileSync(STATE, `# ctx-index state · ${basename(ROOT)} · ${new Date().toISOString()}
# GOAL
<一句话当前目标, 每次大目标变化时更新本行>

# WORKING SET
| 键 | 值 | 状态 |
|----|----|------|

# CHECKPOINTS (append-only, 每轮一条, 只增不改)
`);
	}
	if (!existsSync(INDEX)) {
		writeFileSync(INDEX, `# ctx-index 分层索引
# F=事实 D=决策 C=约束 P=悬案 A=产物
# 条目: <ID>|T轮|内容|状态|锚:...|取代:...|块:...
# 铁则: 只增不改(被推翻走状态列 superseded by Dxx); 数字/版本/路径/用户原话逐字
`);
	}
	if (!existsSync(CONFIG)) writeFileSync(CONFIG, JSON.stringify(DEFAULTS, null, 2) + "\n");
	mkdirSync(SNAPS, { recursive: true });
	mkdirSync(ATTIC, { recursive: true });
	if (!existsSync(CHAIN)) anchor("init");
	console.log(`[ctx] init OK → ${CTX}\n[ctx]   state.md=活状态机 index.md=分层索引 blocks/=压缩块 raw/=逐字冷存档\n[ctx]   chain.jsonl=固化哈希链 snapshots/=快照 attic/=隔离区`);
}

function lastTurnInState() {
	let n = 0;
	if (existsSync(STATE)) {
		for (const m of readFileSync(STATE, "utf8").matchAll(/^## \[T(\d+)\]/gm)) n = Math.max(n, Number(m[1]));
	}
	return n;
}
function sessionTurn(records) {
	let n = 0;
	for (const { rec } of records) if (rec.type === "message" && rec.message?.role === "user" && !rec.message.excludeFromContext) n++;
	return n;
}

function doTick() {
	if (!existsSync(CTX)) { console.error("[ctx] 先 init: node ctx.mjs init"); process.exit(1); }
	if (!acquireLock()) { console.error("[ctx] 引擎忙(.wlock), 稍候重试"); process.exit(2); }
	try {
		const t = Number(V.t) || lastTurnInState() + 1;
		const time = new Date().toISOString();
		const lines = [`## [T${t}] ${time}`, `- Δ: ${V.m || "(无增量记载)"}`];
		if (V.n) lines.push(`- →: ${V.n}`);
		appendFileSync(STATE, lines.join("\n") + "\n");
		anchor("tick", { turn: t });
		console.log(`[ctx] tick T${t} → state.md (append-only · chained)`);
	} finally { releaseLock(); }
}

function doIndex() {
	if (!existsSync(INDEX)) { console.error("[ctx] 先 init"); process.exit(1); }
	const layer = (rest[0] || "").toUpperCase();
	if (!"FDCPA".includes(layer) || layer.length !== 1) { console.error("[ctx] 用法: index <F|D|C|P|A> \"<内容>\" -t 轮 -a \"锚点\""); process.exit(1); }
	const text = rest[1] || "";
	if (!acquireLock()) { console.error("[ctx] 引擎忙(.wlock), 稍候重试"); process.exit(2); }
	try {
	// 当前轮: 显式 > 会话轮 > state轮
	let turn = V.t ? Number(V.t) : null;
	if (!turn) {
		const s = findSession();
		if (s) turn = sessionTurn(readRecords(s));
	}
	if (!turn) turn = lastTurnInState() + 1;
	// 该层最大编号 +1
	let max = 0;
	for (const ln of readFileSync(INDEX, "utf8").split(/\r?\n/)) {
		const m = ln.match(new RegExp(`^${layer}(\\d+)\\|`));
		if (m) max = Math.max(max, Number(m[1]));
	}
	const id = `${layer}${String(max + 1).padStart(2, "0")}`;
	const status = V.st || "active";
	const extras = [];
	if (V.s) extras.push(`取代:${V.s}`);
	if (V.b) extras.push(`块:${V.b}`);
	const entry = `${id}|T${turn}|${text}|${status}|锚:${V.a || ""}${extras.length ? "|" + extras.join("|") : ""}`;
	// 推翻旧条目: 旧条目状态列改 superseded by <新id>
	if (V.s) {
		const old = readFileSync(INDEX, "utf8").split(/\r?\n/);
		const nxt = old.map((ln) => ln.startsWith(V.s + "|") && ln.includes("|active|") ? ln.replace("|active|", `|superseded by ${id}|`) : ln);
		writeFileSync(INDEX, nxt.join("\n"));
	}
	appendFileSync(INDEX, entry + "\n");
	anchor("index", { id });
	console.log(`[ctx] index ${entry}`);
	} finally { releaseLock(); }
}

function doPack() {
	if (!existsSync(CTX)) { console.error("[ctx] 先 init"); process.exit(1); }
	const from = Number(rest[0]);
	let to = Number(rest[1]);
	if (!from || !to) { console.error("[ctx] 用法: pack <from> <to>  (会话轮次, 1-based)"); process.exit(1); }
	const ses = findSession();
	if (!ses) { console.error("[ctx] 找不到本项目 pi 会话, 可用 --session 指定"); process.exit(1); }
	const records = readRecords(ses);
	const total = sessionTurn(records);
	if (to > total) { to = total; console.error(`[ctx] 上限轮 ${total}，已收窄 to=${total}`); }
	// 逐字截取第 from..to 轮(以 user 开轮, 系统前导不计轮)
	const picked = [];
	let cur = 0;
	for (const { rec, line } of records) {
		if (rec.type === "message" && rec.message?.role === "user" && !rec.message.excludeFromContext) cur++;
		if (cur >= from && cur <= to && cur > 0) picked.push(line);
		if (cur > to) break;
	}
	if (!picked.length) { console.error(`[ctx] 轮 ${from}-${to} 无内容(共 ${total} 轮)`); process.exit(1); }
	const rawPath = join(RAW, `turns-T${from}-T${to}.jsonl`);
	const header = JSON.stringify({ type: "ctx_raw", range: [from, to], source: ses, created: new Date().toISOString(), records: picked.length }) + "\n";
	writeFileSync(rawPath, header + picked.join("\n") + "\n");
	// 压缩块脚手架(已存在不动)
	const blk = join(BLOCKS, `T${from}-T${to}.md`);
	if (!existsSync(blk)) {
		writeFileSync(blk, `# T${from}-T${to} <模型填: 主题一句话>

> 原始轮次(逐字): .ctx/raw/turns-T${from}-T${to}.jsonl (${picked.length} records)

## 要点(引用 index 的 ID)
- (模型填: 事实/决策/产物, 一条一行)

## 锚点(数字/版本/路径/用户原话, 逐字)
- (模型填)

## 丢弃说明
- (模型填: 寒暄/重复/已被取代的讨论, 为什么能丢)
`);
	}
	const st = stats(records);
	console.log(`[ctx] pack T${from}-T${to} OK`);
	console.log(`[ctx]   raw 逐字归档: ${rawPath} (${picked.length} 条 ${fmt(statSync(rawPath).size)}B)`);
	console.log(`[ctx]   blocks 脚手架: ${blk}`);
	console.log(`[ctx]   下一步: 依据当前窗口把这几轮压缩写进块文件, 要点对应索引 ID`);
	anchor("pack", { range: `T${from}-T${to}` });
}

function doStatus(mode) {
	const ses = findSession();
	if (!ses) {
		console.error(`[ctx] 未见本项目 pi 会话(${join(SESSIONS_DIR, munge(ROOT))}), 新会话开后再看`);
		process.exit(1);
	}
	const st = stats(readRecords(ses));
	const line = statusLine(st, basename(ROOT));
	const c = ctxCounts();
	if (mode === "auto") {
		// 扩展静默巡检: 只在越阈+新5%阶梯时说话, 防 20 轮刷 20 遍
		if (st.pct < st.threshold) return;
		const band = Math.floor((st.pct - st.threshold) / (cfg.alertStep || 0.05));
		const marker = join(CTX, ".alert");
		let last = -1;
		try { last = Number(readFileSync(marker, "utf8")); } catch {}
		if (band === last) return;
		writeFileSync(marker, String(band));
		console.log(`${line}\n[ctx] /ctx pack 或分块压缩后, 记得把重述检查点回写 state.md`);
		return;
	}
	console.log(`[ctx] 会话: ${basename(ses)}${st.model ? ` · 模型 ${st.model.provider}/${st.model.modelId}` : ""}`);
	console.log(line);
	if (c) {
		const idx = `F${c.per.F} D${c.per.D} C${c.per.C} P${c.per.P} A${c.per.A}`;
		console.log(`[ctx] .ctx 索引 ${idx} · blocks ${c.blocks} · raw ${c.raws}(${fmt(c.rawBytes)}B) · 最近检查点 T${lastTurnInState()}`);
	} else {
		console.log(`[ctx] .ctx 未 init — 长任务建议: node ctx.mjs init`);
	}
}

function doReport() {
	doStatus("status");
	if (!existsSync(CTX)) return;
	let idxLines = [];
	try { idxLines = readFileSync(INDEX, "utf8").split(/\r?\n/).filter((l) => /^[FDCPA]\d+\|/.test(l)).slice(-8); } catch {}
	if (idxLines.length) {
		console.log("[ctx] 最近索引:");
		for (const l of idxLines) console.log("  " + l);
	}
	if (existsSync(STATE)) {
		const cps = readFileSync(STATE, "utf8").split(/^## /m).slice(-2);
		for (let i = 1; i < cps.length; i++) console.log("[ctx] 检查点 " + cps[i].split("\n").slice(0, 3).join(" | "));
	}
}

function doCheck() {
	// 旧项目 config 自动补齐固化键(引擎自有文件, 非真值链成员, 补一次即静音)
	if (existsSync(CONFIG)) {
		try {
			const c = JSON.parse(readFileSync(CONFIG, "utf8"));
			if (!c.freezeVersion || c.snapshotKeep === undefined) {
				c.freezeVersion = 1;
				if (c.snapshotKeep === undefined) c.snapshotKeep = 20;
				writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
			}
		} catch {}
	}
	const { issues, warnings } = collectIssues();
	if (issues.length) {
		for (const x of issues) console.error(`[ctx] ✗ ${x}`);
		for (const x of warnings) console.error(`[ctx] ⚠ ${x}`);
		process.exit(1);
	}
	for (const x of warnings) console.log(`[ctx] ⚠ ${x}`);
	const last = chainLast();
	console.log(`[ctx] check OK · 结构完整${last ? ` · 链锚一致(末锚 ${last.t} op=${last.op})` : ""}`);
}

function doRepair() {
	if (!existsSync(CTX)) { console.error("[ctx] 先 init"); process.exit(1); }
	if (!acquireLock()) { console.error("[ctx] 引擎忙(.wlock), 稍候重试"); process.exit(2); }
	try {
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const attic = join(ATTIC, ts);
		mkdirSync(attic, { recursive: true });
		const quarantined = [];
		for (const f of ["state.md", "index.md", "config.json", "chain.jsonl"]) {
			try { copyFileSync(join(CTX, f), join(attic, `${f}.orig`)); } catch {}
		}
		// --- state.md: 段头重建 + 坏/重复检查点块隔离 ---
		if (existsSync(STATE)) {
			const txt = readFileSync(STATE, "utf8");
			const blocks = txt.split(/^## /m);
			const headLines = (blocks[0] || "").split(/\r?\n/);
			const goalIx = headLines.findIndex((l) => l.trim() === "# GOAL");
			const goalLine = (goalIx >= 0 ? headLines.slice(goalIx + 1).find((l) => l.trim() && !l.trim().startsWith("#")) : "") || "<一句话当前目标, 每次大目标变化时更新本行>";
			const wsIx = headLines.findIndex((l) => l.trim() === "# WORKING SET");
			const wsRows = [];
			if (wsIx >= 0) for (const l of headLines.slice(wsIx + 1)) { if (l.trim().startsWith("#")) break; if (l.trim().startsWith("|")) wsRows.push(l); }
			const seenT = new Set();
			const good = [];
			let badBlocks = 0;
			for (const b of blocks.slice(1)) {
				const head2 = (b.split(/\r?\n/)[0] || "").trim();
				const m = head2.match(/^\[T(\d+)\] (.+)$/);
				if (!m || seenT.has(m[1]) || Number.isNaN(Date.parse(m[2]))) {
					appendFileSync(join(attic, "state-badblocks.md"), "## " + b.replace(/\s+$/, "") + "\n");
					quarantined.push(`state坏块 "${head2.slice(0, 30)}"`);
					badBlocks++;
					continue;
				}
				seenT.add(m[1]);
				good.push("## " + b.replace(/\s+$/, "") + "\n");
			}
			const rows = wsRows.length ? wsRows : ["| 键 | 值 | 状态 |", "|----|----|------|"];
			writeFileSync(STATE, `# ctx-index state · ${basename(ROOT)} · 修复于 ${new Date().toISOString()}\n# GOAL\n${goalLine}\n\n# WORKING SET\n${rows.join("\n")}\n\n# CHECKPOINTS (append-only, 每轮一条, 只增不改)\n\n` + good.join("\n"));
		}
		// --- index.md: 坏行/重复ID隔离, 悬空推翻恢复active, 死块引用剥离 ---
		if (existsSync(INDEX)) {
			const lines = readFileSync(INDEX, "utf8").split(/\r?\n/);
			const ids = new Set();
			const parsed = lines.map((ln) => ({ ln, p: /^[FDCPA]\d{2,}\|/.test(ln) ? parseEntry(ln) : null }));
			for (const { p } of parsed) if (p) ids.add(p.id);
			const out = [];
			const badLines = [];
			for (const { ln, p } of parsed) {
				if (!ln.trim() || ln.startsWith("#")) { out.push(ln); continue; }
				if (!p) { badLines.push(ln); quarantined.push(`index坏行 "${ln.slice(0, 30)}"`); continue; }
				if (out.some((o) => o.startsWith(p.id + "|"))) { badLines.push(ln); quarantined.push(`index重复 ${p.id}`); continue; }
				let fixed = ln;
				if (p.status.startsWith("superseded by ")) {
					const t = p.status.replace("superseded by ", "");
					if (!ids.has(t)) { fixed = fixed.replace(`|${p.status}|`, "|active|"); quarantined.push(`index悬空推翻 ${p.id}(${t} 缺失)→恢复active`); }
				}
				for (const e of p.extras) {
					if (e.startsWith("块:") && !existsSync(join(BLOCKS, `${e.slice(2)}.md`))) { fixed = fixed.replace(`|${e}`, ""); quarantined.push(`index死块引用已剥 ${p.id}(${e})`); }
				}
				out.push(fixed);
			}
			if (badLines.length) writeFileSync(join(attic, "index-bad.lines"), badLines.join("\n") + "\n");
			if (!out.some((l) => l.startsWith("# ctx-index 分层索引"))) out.unshift("# ctx-index 分层索引");
			writeFileSync(INDEX, out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n");
		}
		// --- config.json: 不可解析则重置默认 ---
		if (existsSync(CONFIG)) {
			try { JSON.parse(readFileSync(CONFIG, "utf8")); } catch {
				writeFileSync(CONFIG, JSON.stringify(DEFAULTS, null, 2) + "\n");
				quarantined.push("config 不可解析→重置默认(原件在 attic)");
			}
		}
		anchor("repair", { attic: basename(attic) });
		for (const x of quarantined) console.log(`[ctx] ✂ ${x}`);
		const { issues } = collectIssues();
		if (issues.length) { for (const x of issues) console.error(`[ctx] ✗ 残留 ${x}`); console.error(`[ctx] 隔离原件与残留: ${attic}`); process.exit(1); }
		console.log(`[ctx] repair OK · 隔离原件: ${attic} · 链已重锚`);
	} finally { releaseLock(); }
}

function doSnapshot() {
	if (!existsSync(CTX)) { console.error("[ctx] 先 init"); process.exit(1); }
	const keep = Number(V.k) || cfg.snapshotKeep || 20;
	const dir = join(SNAPS, new Date().toISOString().replace(/[:.]/g, "-"));
	mkdirSync(dir, { recursive: true });
	for (const f of ["state.md", "index.md", "config.json", "chain.jsonl"]) {
		const src = join(CTX, f);
		if (existsSync(src)) copyFileSync(src, join(dir, f));
	}
	let all = [];
	try { all = readdirSync(SNAPS).filter((n) => !n.startsWith(".")).sort(); } catch {}
	for (const n of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(SNAPS, n), { recursive: true, force: true });
	anchor("snapshot", { dir: basename(dir) });
	console.log(`[ctx] snapshot → ${dir} (滚动留${keep}份)`);
}

function doAnchor() {
	if (!existsSync(CTX)) { console.error("[ctx] 先 init"); process.exit(1); }
	const last = chainLast();
	try {
		if (last && ((last.sh_state && last.sh_state !== sha256File(STATE)) || (last.sh_index && last.sh_index !== sha256File(INDEX))))
			console.log(`[ctx] 注意: 与上锚(${last.t} op=${last.op})不符 — 差异将被本次 anchor 合法化`);
	} catch {}
	anchor("anchor", { manual: true });
	let s = "-", i = "-";
	try { s = sha256File(STATE); } catch {}
	try { i = sha256File(INDEX); } catch {}
	console.log(`[ctx] anchor OK · state=${s} index=${i}`);
}

function doHelp() {
	console.log(`ctx-index engine · 用法: node ctx.mjs <命令> [参数]
  init                                  骨架 ${CTX.replace(/\\/g, "/").split("/.ctx")[0] + "/.ctx"}
  status / report                       测量与盘点
  auto                                  静默巡检(供扩展轮回调)
  tick -m "本轮增量" [-n "下一步"]       state.md 追加检查点
  index <F|D|C|P|A> "内容" [-t 轮] [-a "锚@T轮"] [-s 旧ID] [-b 块] [-st 状态]
  pack <from> <to> [--session 文件]     raw 逐字归档 + 块脚手架
  check                                固化校验: 结构/链锚/外部改动检测 (exit 1=有问题)
  repair                               修复: 坏块坏行隔离 attic/, 链重锚
  snapshot [-k 份数]                    快照 → .ctx/snapshots/, 滚动留份
  anchor                               人工修改后重打链锚(合情改动须手动执行)
全局: --root <项目目录>  --window <tokens>  --threshold <0-1>
目录约定(pi home ${AGENT_DIR.replace(/\\/g, "/")})`);
}

switch (cmd) {
	case "init": doInit(); break;
	case "tick": doTick(); break;
	case "index": doIndex(); break;
	case "pack": doPack(); break;
	case "status": case "report": cmd === "status" ? doStatus("status") : doReport(); break;
	case "auto": doStatus("auto"); break;
	case "check": doCheck(); break;
	case "repair": doRepair(); break;
	case "snapshot": doSnapshot(); break;
	case "anchor": doAnchor(); break;
	default: doHelp(); break;
}
