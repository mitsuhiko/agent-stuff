/**
 * /context
 *
 * Small TUI view showing what's loaded/available:
 * - extensions (best-effort from registered extension slash commands)
 * - skills
 * - project context files (AGENTS.md / CLAUDE.md)
 * - current context window usage + session totals (tokens/cost)
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, Text, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

function formatUsd(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

function estimateTokens(text: string): number {
	// Deliberately fuzzy (good enough for “how big-ish is this”).
	return Math.max(0, Math.ceil(text.length / 4));
}

function normalizeReadPath(inputPath: string, cwd: string): string {
	// Similar to pi's resolveToCwd/resolveReadPath, but simplified.
	let p = inputPath;
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
	return path.resolve(p);
}

function getAgentDir(): string {
	// Mirrors pi's behavior reasonably well.
	const envCandidates = ["PI_CODING_AGENT_DIR", "TAU_CODING_AGENT_DIR"];
	let envDir: string | undefined;
	for (const k of envCandidates) {
		if (process.env[k]) {
			envDir = process.env[k];
			break;
		}
	}
	if (!envDir) {
		for (const [k, v] of Object.entries(process.env)) {
			if (k.endsWith("_CODING_AGENT_DIR") && v) {
				envDir = v;
				break;
			}
		}
	}

	if (envDir) {
		if (envDir === "~") return os.homedir();
		if (envDir.startsWith("~/")) return path.join(os.homedir(), envDir.slice(2));
		return envDir;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

async function readFileIfExists(filePath: string): Promise<{ path: string; content: string; bytes: number } | null> {
	if (!existsSync(filePath)) return null;
	try {
		const buf = await fs.readFile(filePath);
		return { path: filePath, content: buf.toString("utf8"), bytes: buf.byteLength };
	} catch {
		return null;
	}
}

async function loadProjectContextFiles(cwd: string): Promise<Array<{ path: string; tokens: number; bytes: number }>> {
	const out: Array<{ path: string; tokens: number; bytes: number }> = [];
	const seen = new Set<string>();

	const loadFromDir = async (dir: string) => {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const p = path.join(dir, name);
			const f = await readFileIfExists(p);
			if (f && !seen.has(f.path)) {
				seen.add(f.path);
				out.push({ path: f.path, tokens: estimateTokens(f.content), bytes: f.bytes });
				// pi loads at most one of those per dir
				return;
			}
		}
	};

	await loadFromDir(getAgentDir());

	// Ancestors: root → cwd (same order as pi)
	const stack: string[] = [];
	let current = path.resolve(cwd);
	while (true) {
		stack.push(current);
		const parent = path.resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}
	stack.reverse();
	for (const dir of stack) await loadFromDir(dir);

	return out;
}

function normalizeSkillName(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

type SkillIndexEntry = {
	name: string;
	skillFilePath: string;
	skillDir: string;
};

function buildSkillIndex(pi: ExtensionAPI, cwd: string): SkillIndexEntry[] {
	return pi
		.getCommands()
		.filter((c) => c.source === "skill")
		.map((c) => {
			const p = c.path ? normalizeReadPath(c.path, cwd) : "";
			return {
				name: normalizeSkillName(c.name),
				skillFilePath: p,
				skillDir: p ? path.dirname(p) : "",
			};
		})
		.filter((x) => x.name && x.skillDir);
}

const SKILL_LOADED_ENTRY = "context:skill_loaded";

type SkillLoadedEntryData = {
	name: string;
	path: string;
};

function getLoadedSkillsFromSession(ctx: ExtensionContext): Set<string> {
	const out = new Set<string>();
	for (const e of ctx.sessionManager.getEntries()) {
		if ((e as any)?.type !== "custom") continue;
		if ((e as any)?.customType !== SKILL_LOADED_ENTRY) continue;
		const data = (e as any)?.data as SkillLoadedEntryData | undefined;
		if (data?.name) out.add(data.name);
	}
	return out;
}

function extractCostTotal(usage: any): number {
	if (!usage) return 0;
	const c = usage?.cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	if (typeof c === "string") {
		const n = Number(c);
		return Number.isFinite(n) ? n : 0;
	}
	const t = c?.total;
	if (typeof t === "number") return Number.isFinite(t) ? t : 0;
	if (typeof t === "string") {
		const n = Number(t);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

function sumSessionUsage(ctx: ExtensionCommandContext): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalCost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if ((entry as any)?.type !== "message") continue;
		const msg = (entry as any)?.message;
		if (!msg || msg.role !== "assistant") continue;
		const usage = msg.usage;
		if (!usage) continue;
		input += Number(usage.inputTokens ?? 0) || 0;
		output += Number(usage.outputTokens ?? 0) || 0;
		cacheRead += Number(usage.cacheRead ?? 0) || 0;
		cacheWrite += Number(usage.cacheWrite ?? 0) || 0;
		totalCost += extractCostTotal(usage);
	}

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		totalCost,
	};
}

function shortenPath(p: string, cwd: string): string {
	const rp = path.resolve(p);
	const rc = path.resolve(cwd);
	if (rp === rc) return ".";
	if (rp.startsWith(rc + path.sep)) return "./" + rp.slice(rc.length + 1);
	return rp;
}

function renderUsageBar(
	theme: any,
	parts: { system: number; tools: number; convo: number; remaining: number },
	total: number,
	width: number,
): string {
	const w = Math.max(10, width);
	if (total <= 0) return "";

	const toCols = (n: number) => Math.round((n / total) * w);
	let sys = toCols(parts.system);
	let tools = toCols(parts.tools);
	let con = toCols(parts.convo);
	let rem = w - sys - tools - con;
	if (rem < 0) rem = 0;
	// adjust rounding drift
	while (sys + tools + con + rem < w) rem++;
	while (sys + tools + con + rem > w && rem > 0) rem--;

	const block = "█";
	const sysStr = theme.fg("accent", block.repeat(sys));
	const toolsStr = theme.fg("warning", block.repeat(tools));
	const conStr = theme.fg("success", block.repeat(con));
	const remStr = theme.fg("dim", block.repeat(rem));
	return `${sysStr}${toolsStr}${conStr}${remStr}`;
}

function joinComma(items: string[]): string {
	return items.join(", ");
}

function joinCommaStyled(items: string[], renderItem: (item: string) => string, sep: string): string {
	return items.map(renderItem).join(sep);
}

type ContextViewData = {
	usage:
		| {
			// message-based context usage estimate from ctx.getContextUsage()
			messageTokens: number;
			contextWindow: number;
			// effective usage incl. a rough tool-definition estimate
			effectiveTokens: number;
			percent: number;
			remainingTokens: number;
			systemPromptTokens: number;
			agentTokens: number;
			toolsTokens: number;
			activeTools: number;
		}
		| null;
	agentFiles: string[];
	extensions: string[];
	skills: string[];
	loadedSkills: string[];
	session: { totalTokens: number; totalCost: number };
};

class ContextView implements Component {
	private tui: TUI;
	private theme: any;
	private onDone: () => void;
	private data: ContextViewData;
	private container: Container;
	private body: Text;
	private cachedWidth?: number;

	constructor(tui: TUI, theme: any, data: ContextViewData, onDone: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.data = data;
		this.onDone = onDone;

		this.container = new Container();
		this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.container.addChild(
			new Text(
				theme.fg("accent", theme.bold("Context")) + theme.fg("dim", "  (Esc/q/Enter to close)"),
				1,
				0,
			),
		);
		this.container.addChild(new Text("", 1, 0));

		this.body = new Text("", 1, 0);
		this.container.addChild(this.body);

		this.container.addChild(new Text("", 1, 0));
		this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	private rebuild(width: number): void {
		const muted = (s: string) => this.theme.fg("muted", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const text = (s: string) => this.theme.fg("text", s);

		const lines: string[] = [];

		// Window + bar
		if (!this.data.usage) {
			lines.push(muted("Window: ") + dim("(unknown)"));
		} else {
			const u = this.data.usage;
			lines.push(
				muted("Window: ") +
					text(`~${u.effectiveTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()}`) +
					muted(`  (${u.percent.toFixed(1)}% used, ~${u.remainingTokens.toLocaleString()} left)`),
			);

			// bar width tries to fit within the viewport
			const barWidth = Math.max(10, Math.min(36, width - 10));

			// Prorate system prompt into current message context estimate, then add tools estimate.
			const sysInMessages = Math.min(u.systemPromptTokens, u.messageTokens);
			const convoInMessages = Math.max(0, u.messageTokens - sysInMessages);
			const bar =
				renderUsageBar(
					this.theme,
					{
						system: sysInMessages,
						tools: u.toolsTokens,
						convo: convoInMessages,
						remaining: u.remainingTokens,
					},
					u.contextWindow,
					barWidth,
				) +
				" " +
				dim("sys") +
				this.theme.fg("accent", "█") +
				" " +
				dim("tools") +
				this.theme.fg("warning", "█") +
				" " +
				dim("convo") +
				this.theme.fg("success", "█") +
				" " +
				dim("free") +
				this.theme.fg("dim", "█");
			lines.push(bar);
		}

		lines.push("");

		// System prompt + tools totals (approx)
		if (this.data.usage) {
			const u = this.data.usage;
			lines.push(
				muted("System: ") +
					text(`~${u.systemPromptTokens.toLocaleString()} tok`) +
					muted(` (AGENTS ~${u.agentTokens.toLocaleString()})`),
			);
			lines.push(
				muted("Tools: ") +
					text(`~${u.toolsTokens.toLocaleString()} tok`) +
					muted(` (${u.activeTools} active)`),
			);
		}

		lines.push(muted(`AGENTS (${this.data.agentFiles.length}): `) + text(this.data.agentFiles.length ? joinComma(this.data.agentFiles) : "(none)"));
		lines.push("");
		lines.push(muted(`Extensions (${this.data.extensions.length}): `) + text(this.data.extensions.length ? joinComma(this.data.extensions) : "(none)"));

		const loaded = new Set(this.data.loadedSkills);
		const skillsRendered = this.data.skills.length
			? joinCommaStyled(
					this.data.skills,
					(name) => (loaded.has(name) ? this.theme.fg("success", name) : this.theme.fg("muted", name)),
					this.theme.fg("muted", ", "),
				)
			: "(none)";
		lines.push(muted(`Skills (${this.data.skills.length}): `) + skillsRendered);
		lines.push("");
		lines.push(
			muted("Session: ") +
				text(`${this.data.session.totalTokens.toLocaleString()} tokens`) +
				muted(" · ") +
				text(formatUsd(this.data.session.totalCost)),
		);

		this.body.setText(lines.join("\n"));
		this.cachedWidth = width;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			data.toLowerCase() === "q" ||
			data === "\r"
		) {
			this.onDone();
			return;
		}
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth !== width) this.rebuild(width);
		return this.container.render(width);
	}
}

export default function contextExtension(pi: ExtensionAPI) {
	// Track which skills were actually pulled in via read tool calls.
	let lastSessionId: string | null = null;
	let cachedLoadedSkills = new Set<string>();
	let cachedSkillIndex: SkillIndexEntry[] = [];

	const ensureCaches = (ctx: ExtensionContext) => {
		const sid = ctx.sessionManager.getSessionId();
		if (sid !== lastSessionId) {
			lastSessionId = sid;
			cachedLoadedSkills = getLoadedSkillsFromSession(ctx);
			cachedSkillIndex = buildSkillIndex(pi, ctx.cwd);
		}
		if (cachedSkillIndex.length === 0) {
			cachedSkillIndex = buildSkillIndex(pi, ctx.cwd);
		}
	};

	const matchSkillForPath = (absPath: string): string | null => {
		let best: SkillIndexEntry | null = null;
		for (const s of cachedSkillIndex) {
			if (!s.skillDir) continue;
			if (absPath === s.skillFilePath || absPath.startsWith(s.skillDir + path.sep)) {
				if (!best || s.skillDir.length > best.skillDir.length) best = s;
			}
		}
		return best?.name ?? null;
	};

	pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
		// Only count successful reads.
		if ((event as any).toolName !== "read") return;
		if ((event as any).isError) return;

		const input = (event as any).input as { path?: unknown } | undefined;
		const p = typeof input?.path === "string" ? input.path : "";
		if (!p) return;

		ensureCaches(ctx);
		const abs = normalizeReadPath(p, ctx.cwd);
		const skillName = matchSkillForPath(abs);
		if (!skillName) return;

		if (!cachedLoadedSkills.has(skillName)) {
			cachedLoadedSkills.add(skillName);
			pi.appendEntry<SkillLoadedEntryData>(SKILL_LOADED_ENTRY, { name: skillName, path: abs });
		}
	});

	pi.registerCommand("context", {
		description: "Show loaded context overview",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const commands = pi.getCommands();
			const extensionCmds = commands.filter((c) => c.source === "extension");
			const skillCmds = commands.filter((c) => c.source === "skill");

			const extensionsByPath = new Map<string, string[]>();
			for (const c of extensionCmds) {
				const p = c.path ?? "<unknown>";
				const arr = extensionsByPath.get(p) ?? [];
				arr.push(c.name);
				extensionsByPath.set(p, arr);
			}
			const extensionFiles = [...extensionsByPath.keys()]
				.map((p) => (p === "<unknown>" ? p : path.basename(p)))
				.sort((a, b) => a.localeCompare(b));

			const skills = skillCmds
				.map((c) => normalizeSkillName(c.name))
				.sort((a, b) => a.localeCompare(b));

			const agentFiles = await loadProjectContextFiles(ctx.cwd);
			const agentFilePaths = agentFiles.map((f) => shortenPath(f.path, ctx.cwd));
			const agentTokens = agentFiles.reduce((a, f) => a + f.tokens, 0);

			const systemPrompt = ctx.getSystemPrompt();
			const systemPromptTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;

			const usage = ctx.getContextUsage();
			const messageTokens = usage?.tokens ?? 0;
			const ctxWindow = usage?.contextWindow ?? 0;

			// Tool definitions are not part of ctx.getContextUsage() (it estimates message tokens).
			// We approximate their token impact from tool name + description, and apply a fudge
			// factor to account for parameters/schema/formatting.
			const TOOL_FUDGE = 1.5;
			const activeToolNames = pi.getActiveTools();
			const toolInfoByName = new Map(pi.getAllTools().map((t) => [t.name, t] as const));
			let toolsTokens = 0;
			for (const name of activeToolNames) {
				const info = toolInfoByName.get(name);
				const blob = `${name}\n${info?.description ?? ""}`;
				toolsTokens += estimateTokens(blob);
			}
			toolsTokens = Math.round(toolsTokens * TOOL_FUDGE);

			const effectiveTokens = messageTokens + toolsTokens;
			const percent = ctxWindow > 0 ? (effectiveTokens / ctxWindow) * 100 : 0;
			const remainingTokens = ctxWindow > 0 ? Math.max(0, ctxWindow - effectiveTokens) : 0;

			const sessionUsage = sumSessionUsage(ctx);

			const makePlainText = () => {
				const lines: string[] = [];
				lines.push("Context");
				if (usage) {
					lines.push(
						`Window: ~${effectiveTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} (${percent.toFixed(1)}% used, ~${remainingTokens.toLocaleString()} left)`,
					);
				} else {
					lines.push("Window: (unknown)");
				}
				lines.push(`System: ~${systemPromptTokens.toLocaleString()} tok (AGENTS ~${agentTokens.toLocaleString()})`);
				lines.push(`Tools: ~${toolsTokens.toLocaleString()} tok (${activeToolNames.length} active)`);
				lines.push(`AGENTS: ${agentFilePaths.length ? joinComma(agentFilePaths) : "(none)"}`);
				lines.push(`Extensions (${extensionFiles.length}): ${extensionFiles.length ? joinComma(extensionFiles) : "(none)"}`);
				lines.push(`Skills (${skills.length}): ${skills.length ? joinComma(skills) : "(none)"}`);
				lines.push(`Session: ${sessionUsage.totalTokens.toLocaleString()} tokens · ${formatUsd(sessionUsage.totalCost)}`);
				return lines.join("\n");
			};

			if (!ctx.hasUI) {
				pi.sendMessage({ customType: "context", content: makePlainText(), display: true }, { triggerTurn: false });
				return;
			}

			const loadedSkills = Array.from(getLoadedSkillsFromSession(ctx)).sort((a, b) => a.localeCompare(b));

			const viewData: ContextViewData = {
				usage: usage
					? {
						messageTokens,
						contextWindow: ctxWindow,
						effectiveTokens,
						percent,
						remainingTokens,
						systemPromptTokens,
						agentTokens,
						toolsTokens,
						activeTools: activeToolNames.length,
					}
					: null,
				agentFiles: agentFilePaths,
				extensions: extensionFiles,
				skills,
				loadedSkills,
				session: { totalTokens: sessionUsage.totalTokens, totalCost: sessionUsage.totalCost },
			};

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return new ContextView(tui, theme, viewData, done);
			});
		},
	});
}
