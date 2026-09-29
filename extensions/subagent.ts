import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ATTACH_FLAG = "attach-subagent";
const CHILD_ENV = "PI_TMUX_SUBAGENT_CHILD";
const RESULT_ENV = "PI_TMUX_SUBAGENT_RESULT";
const RUNS_DIR = "tmux-subagents";
const POLL_INTERVAL_MS = 500;
const PANE_PREVIEW_LINES = 18;
const IDLE_TIMEOUT_ENV = "PI_TMUX_SUBAGENT_IDLE_TIMEOUT_MS";
const MAX_RUNTIME_ENV = "PI_TMUX_SUBAGENT_MAX_RUNTIME_MS";
/** Default inactivity budget: no agent events (child watchdog) with no result kills the subagent. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
/** How often the child watchdog re-checks activity. */
const CHILD_WATCHDOG_INTERVAL_MS = 10_000;
/**
 * Extra time the parent gives a child after the idle timeout before killing it.
 * The child should report its own idle timeout via result.json; this backstop
 * covers cases where the child reporter is itself stuck (no result file will
 * ever appear and the pane stays alive).
 */
const PARENT_IDLE_GRACE_MS = 5 * 60_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EXTENSION_PATH = fileURLToPath(import.meta.url);

type RunStatus = "queued" | "running" | "completed" | "failed";

interface ChildResult {
	version: 1;
	status: "completed" | "failed";
	output: string;
	error?: string;
	stopReason?: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	finishedAt: number;
}

interface RunDetails {
	status: RunStatus;
	task: string;
	cwd: string;
	tmuxSession: string;
	attachCommand: string;
	captureCommand: string;
	killCommand: string;
	provider: string;
	model: string;
	thinking: string;
	pane?: string;
	output?: string;
	sessionFile?: string;
	startedAt?: number;
	finishedAt?: number;
}

interface RunSpec {
	task: string;
	cwd: string;
	attachmentId: string;
	tmuxSession: string;
	tmuxTarget: string;
	attachCommand: string;
	captureCommand: string;
	killCommand: string;
	provider: string;
	model: string;
	thinking: string;
	trusted: boolean;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function tmuxSocketPath(): string {
	return path.join(getAgentDir(), "tmux-subagents.sock");
}

function tmuxSessionName(sessionId: string): string {
	return `pi-agent-${sessionId}`;
}

function currentTmuxSocket(): string | undefined {
	const socket = process.env.TMUX?.split(",", 1)[0]?.trim();
	return socket || undefined;
}

function attachFlagValue(argv: string[]): string | undefined {
	const flag = `--${ATTACH_FLAG}`;
	for (let index = 2; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--") break;
		if (argument === flag) {
			const value = argv[index + 1];
			return !value || value.startsWith("--") ? "" : value;
		}
		if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
	}
	return undefined;
}

function tmuxCommandPrefix(): string {
	return `tmux -S ${shellQuote(tmuxSocketPath())}`;
}

function tmuxArgs(...args: string[]): string[] {
	return ["-S", tmuxSocketPath(), ...args];
}

function updateTmuxCommands(spec: RunSpec): void {
	const tmux = tmuxCommandPrefix();
	spec.attachCommand = `pi --${ATTACH_FLAG} ${shellQuote(spec.attachmentId)}`;
	spec.captureCommand = `${tmux} capture-pane -p -J -t ${shellQuote(spec.tmuxTarget)}`;
	spec.killCommand = `${tmux} kill-session -t ${shellQuote(spec.tmuxSession)}`;
}

function attachToSubagentAndExit(rawTarget: string): never {
	const target = rawTarget.trim();
	if (!target) {
		console.error(`Error: --${ATTACH_FLAG} requires the session id printed by the subagent tool.`);
		process.exit(2);
	}

	let socket = tmuxSocketPath();
	let session: string;
	if (target.startsWith("v1.")) {
		// Keep attachment working for sessions started before session-id targets.
		try {
			const legacy = JSON.parse(Buffer.from(target.slice(3), "base64url").toString("utf8")) as {
				s?: unknown;
				p?: unknown;
			};
			if (typeof legacy.s !== "string" || !legacy.s || typeof legacy.p !== "string" || !legacy.p) {
				throw new Error("missing tmux session or socket");
			}
			session = legacy.s;
			socket = legacy.p;
		} catch (error) {
			console.error(`Error: invalid legacy subagent target: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(2);
		}
	} else {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) {
			console.error(`Error: invalid subagent session id: ${target}`);
			process.exit(2);
		}
		session = tmuxSessionName(target);
	}

	const sameServer = currentTmuxSocket() === socket;
	const args = ["-S", socket, sameServer ? "switch-client" : "attach-session", "-t", session];
	const env = { ...process.env };
	if (!sameServer) {
		delete env.TMUX;
		delete env.TMUX_PANE;
	}
	const result = spawnSync("tmux", args, { stdio: "inherit", env });
	if (result.error) console.error(`Failed to run tmux: ${result.error.message}`);
	process.exit(result.status ?? 1);
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return [process.execPath];
	}

	return ["pi"];
}

function textFromAssistant(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
		})
		.map((part) => part.text)
		.join("\n");
}

function findLastAssistant(ctx: ExtensionContext): Record<string, unknown> | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, filePath);
}

function registerChildReporter(pi: ExtensionAPI, resultPath: string): void {
	let reported = false;
	let latestCtx: ExtensionContext | undefined;
	let lastActivityAt = Date.now();
	let toolExecutingSince: number | undefined;
	const startedAt = Date.now();
	const idleTimeoutMs = parseTimeoutEnv(process.env[IDLE_TIMEOUT_ENV]);
	const maxRuntimeMs = parseTimeoutEnv(process.env[MAX_RUNTIME_ENV]);
	let watchdog: ReturnType<typeof setInterval> | undefined;

	const report = async (ctx: ExtensionContext | undefined, fallbackError?: string): Promise<void> => {
		if (reported) return;
		reported = true;
		if (watchdog) clearInterval(watchdog);

		const assistant = ctx ? findLastAssistant(ctx) : undefined;
		const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
		const assistantError = typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined;
		const failed = !assistant || stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
		const output = assistant ? textFromAssistant(assistant) : "";
		const result: ChildResult = {
			version: 1,
			status: failed ? "failed" : "completed",
			output,
			error: fallbackError ?? assistantError ?? (!assistant ? "Subagent exited without an assistant response." : undefined),
			stopReason,
			sessionFile: ctx?.sessionManager.getSessionFile(),
			provider: typeof assistant?.provider === "string" ? assistant.provider : ctx?.model?.provider,
			model: typeof assistant?.model === "string" ? assistant.model : ctx?.model?.id,
			thinking: pi.getThinkingLevel(),
			finishedAt: Date.now(),
		};

		try {
			await writeJsonAtomic(resultPath, result);
		} catch (error) {
			console.error(`[tmux-subagent] Failed to write result: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	if (idleTimeoutMs > 0 || maxRuntimeMs > 0) {
		// Track agent activity. Any of these events means the child is making
		// progress: a stalled LLM request (no deltas), a hung tool execution, a
		// compaction hang, or an interactive wait (auth/trust prompt) produce no
		// events at all, so the watchdog below can detect and terminate them.
		const activityEvents = [
			"agent_start",
			"turn_start",
			"turn_end",
			"message_start",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		] as const;
		for (const event of activityEvents) {
			(
				pi.on as unknown as (
					event: string,
					handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
				) => void
			)(event, (_event, ctx) => {
				latestCtx = ctx;
				lastActivityAt = Date.now();
				if (event === "tool_execution_start") toolExecutingSince = Date.now();
				else if (event === "tool_execution_end") toolExecutingSince = undefined;
			});
		}

		watchdog = setInterval(async () => {
			if (reported) return;
			const now = Date.now();
			let reason: string | undefined;
			if (idleTimeoutMs > 0) {
				// While a tool is running, count inactivity from the tool's start
				// so silent-but-long commands get the same budget as everything else.
				const reference =
					toolExecutingSince !== undefined && toolExecutingSince < lastActivityAt
						? toolExecutingSince
						: lastActivityAt;
				if (now - reference > idleTimeoutMs) {
					reason = `Subagent was idle for ${formatDurationMs(now - reference)} with no agent activity (idle timeout ${formatDurationMs(idleTimeoutMs)}). This usually means an LLM request, a tool call, or an interactive prompt in the child stalled without erroring or exiting.`;
				}
			}
			if (!reason && maxRuntimeMs > 0 && now - startedAt > maxRuntimeMs) {
				reason = `Subagent exceeded the ${formatDurationMs(maxRuntimeMs)} wall-clock limit.`;
			}
			if (!reason) return;
			await report(latestCtx, reason);
			// Force-exit so the pane dies too; result.json (written above) is what
			// the parent actually consumes.
			process.exit(1);
		}, CHILD_WATCHDOG_INTERVAL_MS);
	}

	// agent_settled was added after older peer type declarations but is present
	// in the Pi runtime this extension targets.
	(
		pi.on as unknown as (
			event: "agent_settled",
			handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
		) => void
	)("agent_settled", async (_event, ctx) => {
		await report(ctx);
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!reported) await report(ctx, "Subagent session shut down before the task settled.");
	});
}

function trimPane(output: string): string {
	const lines = output.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
	return lines.slice(-PANE_PREVIEW_LINES).join("\n");
}

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function formatDurationMs(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

/** Parse a non-negative millisecond value from env; 0/NaN/undefined/negative become 0 (disabled). */
function parseTimeoutEnv(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Validate a user-supplied timeout parameter. Returns 0 when the timeout is disabled. */
function resolveTimeoutParam(value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error("timeoutMs and idleTimeoutMs must be non-negative numbers of milliseconds (0 disables).");
	}
	return value;
}

function detailsFor(spec: RunSpec, status: RunStatus, extra: Partial<RunDetails> = {}): RunDetails {
	return {
		status,
		task: spec.task,
		cwd: spec.cwd,
		tmuxSession: spec.tmuxSession,
		attachCommand: spec.attachCommand,
		captureCommand: spec.captureCommand,
		killCommand: spec.killCommand,
		provider: spec.provider,
		model: spec.model,
		thinking: spec.thinking,
		...extra,
	};
}

function partialText(details: RunDetails): string {
	const lines = [
		`Subagent ${details.status} in tmux session ${details.tmuxSession}.`,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
	];
	if (details.pane) lines.push("", details.pane);
	return lines.join("\n");
}

function truncateToolText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Output truncated. Full output is available in the child session file.]`;
}

function resultText(details: RunDetails): string {
	const duration = formatDuration(details.startedAt, details.finishedAt);
	const lines = [
		`Subagent ${details.status}${duration ? ` after ${duration}` : ""}.`,
		`Model: ${details.provider}/${details.model} (${details.thinking})`,
		`tmux: ${details.tmuxSession}`,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
		`Clean up: ${details.killCommand}`,
	];
	if (details.sessionFile) lines.push(`Child session: ${details.sessionFile}`);
	if (details.output) lines.push("", details.output);
	return truncateToolText(lines.join("\n"));
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Subagent aborted.");
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new Error("Subagent aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function validateCwd(cwd: string): Promise<void> {
	let info;
	try {
		info = await stat(cwd);
	} catch {
		throw new Error(`Subagent working directory does not exist: ${cwd}`);
	}
	if (!info.isDirectory()) throw new Error(`Subagent working directory is not a directory: ${cwd}`);
}

function isSameOrDescendant(base: string, candidate: string): boolean {
	const relative = path.relative(base, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveModel(
	ctx: ExtensionContext,
	providerOverride: string | undefined,
	modelOverride: string | undefined,
): { provider: string; model: string } {
	const explicitProvider = providerOverride?.trim();
	const explicitModel = modelOverride?.trim();
	let provider = explicitProvider || ctx.model?.provider || "";
	let model = explicitModel || ctx.model?.id || "";

	// A slash in an inherited id can be part of the id itself (for example,
	// OpenRouter's openai/gpt-* models). Only interpret an explicit model as
	// provider/model when no separate provider was supplied. If both are given
	// and the prefixes agree, accept the redundant canonical provider/model form.
	const slashIndex = explicitModel?.indexOf("/") ?? -1;
	if (explicitModel && slashIndex > 0) {
		const modelProvider = explicitModel.slice(0, slashIndex);
		if (!explicitProvider) {
			provider = modelProvider;
			model = explicitModel.slice(slashIndex + 1);
		} else if (explicitProvider === modelProvider) {
			model = explicitModel.slice(slashIndex + 1);
		}
	}

	if (!provider || !model) {
		throw new Error("No model is active. Pass both provider and model to the subagent tool.");
	}
	return { provider, model };
}

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerFlag(ATTACH_FLAG, {
		description: "Attach using the child session id printed by the subagent tool",
		type: "string",
	});
	const attachTarget = attachFlagValue(process.argv);
	if (attachTarget !== undefined) attachToSubagentAndExit(attachTarget);

	if (process.env[CHILD_ENV] === "1") {
		const resultPath = process.env[RESULT_ENV];
		if (!resultPath) {
			console.error(`[tmux-subagent] ${RESULT_ENV} is required in child mode.`);
			return;
		}
		registerChildReporter(pi, resultPath);
		return;
	}

	let queueTail: Promise<void> = Promise.resolve();
	let queueDepth = 0;
	let activeSession: string | undefined;

	const withSerialExecution = async <T>(
		signal: AbortSignal | undefined,
		onQueued: () => void,
		fn: () => Promise<T>,
	): Promise<T> => {
		const queued = queueDepth > 0;
		queueDepth++;
		const previous = queueTail;
		let release!: () => void;
		queueTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		if (queued) onQueued();

		try {
			await previous;
			if (signal?.aborted) throw new Error("Subagent aborted while waiting in the serial queue.");
			return await fn();
		} finally {
			queueDepth--;
			release();
		}
	};

	pi.on("session_shutdown", async () => {
		if (!activeSession) return;
		await pi.exec("tmux", tmuxArgs("kill-session", "-t", activeSession));
		activeSession = undefined;
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run one delegated task in a separate interactive Pi process inside tmux. Calls are serialized: only one child works at a time, even if several calls are requested together. The child inherits the current provider, model, and thinking level unless overridden. Live pane output and a copy/paste pi --attach-subagent command are shown while it runs. Output is capped at 50KB or 2000 lines; the complete child session is preserved on disk. Stalled subagents (failed LLM calls that neither error nor exit, hung tool executions, interactive waits) are killed after idleTimeoutMs (default 600000 ms = 10 min) of inactivity with no result, or after timeoutMs wall-clock time (default disabled). Pass 0 to disable a timeout.",
		promptSnippet: "Run one delegated task in an observable, tmux-backed Pi session",
		promptGuidelines: [
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete task for the child Pi process" }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
			provider: Type.Optional(Type.String({ description: "Provider override. Defaults to the current provider." })),
			model: Type.Optional(
				Type.String({ description: "Model id or provider/model override. Defaults to the current model." }),
			),
			thinking: Type.Optional(
				StringEnum(THINKING_LEVELS, {
					description: "Thinking level override. Defaults to the current thinking level.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description:
						"Hard wall-clock limit in milliseconds for the whole subagent run. 0 disables (default). The child is force-killed when exceeded.",
				}),
			),
			idleTimeoutMs: Type.Optional(
				Type.Number({
					description:
						"Inactivity limit in milliseconds: the subagent is killed when no agent activity or output is seen for this long. Defaults to 600000 (10 min). Pass 0 to disable.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Subagent task must not be empty.");
			const maxRuntimeMs = resolveTimeoutParam(params.timeoutMs);
			// Explicit 0 disables the idle watchdog; omitting the parameter uses the default.
			const idleTimeoutMs = params.idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : resolveTimeoutParam(params.idleTimeoutMs);
			const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			const selectedModel = resolveModel(ctx, params.provider, params.model);
			const thinking = params.thinking ?? pi.getThinkingLevel();
			const childSessionId = randomUUID();
			const runDir = path.join(getAgentDir(), RUNS_DIR, ctx.sessionManager.getSessionId(), childSessionId);
			const resultPath = path.join(runDir, "result.json");
			const tmuxSession = tmuxSessionName(childSessionId);
			const tmuxTarget = `${tmuxSession}:0.0`;
			const spec: RunSpec = {
				task: params.task,
				cwd,
				attachmentId: childSessionId,
				tmuxSession,
				tmuxTarget,
				attachCommand: "",
				captureCommand: "",
				killCommand: "",
				provider: selectedModel.provider,
				model: selectedModel.model,
				thinking,
				trusted: isSameOrDescendant(path.resolve(ctx.cwd), cwd) && ctx.isProjectTrusted(),
			};
			updateTmuxCommands(spec);

			return withSerialExecution(
				signal,
				() => {
					const details = detailsFor(spec, "queued");
					onUpdate?.({ content: [{ type: "text", text: "Waiting for the active subagent to finish..." }], details });
				},
				async () => {
					await validateCwd(cwd);
					await mkdir(runDir, { recursive: true, mode: 0o700 });
					const promptPath = path.join(runDir, "task.md");
					const sessionDir = path.join(runDir, "session");
					await mkdir(sessionDir, { recursive: true, mode: 0o700 });
					await writeFile(promptPath, `# Delegated task\n\n${params.task}\n`, {
						encoding: "utf8",
						mode: 0o600,
					});

					const piArgs = [
						...getPiInvocationParts(),
						"--provider",
						selectedModel.provider,
						"--model",
						selectedModel.model,
						"--thinking",
						thinking,
						"--session-dir",
						sessionDir,
						"--session-id",
						childSessionId,
						"--name",
						tmuxSession,
						spec.trusted ? "--approve" : "--no-approve",
						"--extension",
						EXTENSION_PATH,
						`@${promptPath}`,
					];
					const childCommand = [
						"exec env",
						`${CHILD_ENV}=1`,
						`${RESULT_ENV}=${shellQuote(resultPath)}`,
						`${IDLE_TIMEOUT_ENV}=${idleTimeoutMs}`,
						`${MAX_RUNTIME_ENV}=${maxRuntimeMs}`,
						piArgs.map(shellQuote).join(" "),
					].join(" ");

					const tmuxVersion = await pi.exec("tmux", ["-V"], { timeout: 5_000 });
					if (tmuxVersion.code !== 0) {
						throw new Error(`tmux is required for subagents: ${tmuxVersion.stderr.trim() || "tmux not found"}`);
					}

					const startedAt = Date.now();
					const created = await pi.exec(
						"tmux",
						tmuxArgs("new-session", "-d", "-s", tmuxSession, "-n", "pi", "-c", cwd),
					);
					if (created.code !== 0) {
						throw new Error(`Failed to create tmux session: ${created.stderr.trim() || created.stdout.trim()}`);
					}
					activeSession = tmuxSession;

					try {
						const remain = await pi.exec(
							"tmux",
							tmuxArgs("set-window-option", "-t", `${tmuxSession}:0`, "remain-on-exit", "on"),
						);
						if (remain.code !== 0) throw new Error(remain.stderr.trim() || "Failed to set remain-on-exit.");

						const initialDetails = detailsFor(spec, "running", { startedAt });
						onUpdate?.({ content: [{ type: "text", text: partialText(initialDetails) }], details: initialDetails });

						const sent = await pi.exec("tmux", tmuxArgs("send-keys", "-t", tmuxTarget, "-l", "--", childCommand));
						if (sent.code !== 0) throw new Error(sent.stderr.trim() || "Failed to start child Pi.");
						const entered = await pi.exec("tmux", tmuxArgs("send-keys", "-t", tmuxTarget, "Enter"));
						if (entered.code !== 0) throw new Error(entered.stderr.trim() || "Failed to submit child command.");

						let lastPane = "";
						let lastPaneChangedAt = Date.now();
						let childResult: ChildResult | undefined;

						const failAndCleanup = async (reason: string): Promise<never> => {
							try {
								await pi.exec("tmux", tmuxArgs("kill-session", "-t", tmuxSession));
							} catch {
								// Best-effort cleanup; the diagnostic below matters more.
							}
							if (activeSession === tmuxSession) activeSession = undefined;
							throw new Error(
								`Subagent ${reason}\n\n${lastPane || "No pane output."}\n\nAttach: ${spec.attachCommand}\nCapture: ${spec.captureCommand}`,
							);
						};

						while (!childResult) {
							if (signal?.aborted) throw new Error("Subagent aborted.");
							// Watchdog: without this, a child that stays alive without
							// ever writing result.json (stalled LLM request, hung tool,
							// interactive wait) would make the parent poll forever.
							const now = Date.now();
							if (maxRuntimeMs > 0 && now - startedAt > maxRuntimeMs) {
								await failAndCleanup(
									`exceeded the ${formatDurationMs(maxRuntimeMs)} wall-clock limit without producing a result.`,
								);
							}
							if (idleTimeoutMs > 0 && now - lastPaneChangedAt > idleTimeoutMs + PARENT_IDLE_GRACE_MS) {
								await failAndCleanup(
									`was idle (no output for ${formatDurationMs(now - lastPaneChangedAt)}) without producing a result. The LLM call or a tool inside the child likely stalled.`,
								);
							}
							try {
								childResult = JSON.parse(await readFile(resultPath, "utf8")) as ChildResult;
								break;
							} catch {
								// The result file is created atomically when the child settles.
							}

							const paneResult = await pi.exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", tmuxTarget), {
								timeout: 5_000,
							});
							if (paneResult.code === 0) {
								const pane = trimPane(paneResult.stdout);
								if (pane && pane !== lastPane) {
									lastPane = pane;
									lastPaneChangedAt = Date.now();
									const details = detailsFor(spec, "running", { pane, startedAt });
									onUpdate?.({ content: [{ type: "text", text: partialText(details) }], details });
								}
							}

							const dead = await pi.exec(
								"tmux",
								tmuxArgs("display-message", "-p", "-t", tmuxTarget, "#{pane_dead}"),
							);
							if (dead.code === 0 && dead.stdout.trim() === "1") {
								await abortableDelay(100, signal);
								try {
									childResult = JSON.parse(await readFile(resultPath, "utf8")) as ChildResult;
									break;
								} catch {
									throw new Error(
										`Child Pi exited before reporting a result.\n\n${lastPane || "No pane output."}\n\nInspect: ${spec.captureCommand}`,
									);
								}
							}

							await abortableDelay(POLL_INTERVAL_MS, signal);
						}

						const finalPaneResult = await pi.exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", tmuxTarget), {
							timeout: 5_000,
						});
						const finalPane = finalPaneResult.code === 0 ? trimPane(finalPaneResult.stdout) : lastPane;
						const status: RunStatus = childResult.status === "completed" ? "completed" : "failed";
						let rawOutput = childResult.output.trim();
						if (childResult.status === "failed" && childResult.error?.trim()) {
							rawOutput += `${rawOutput ? "\n\n" : ""}Error: ${childResult.error.trim()}`;
						}
						const output = truncateToolText(rawOutput || "(no text output)");
						const details = detailsFor(spec, status, {
							pane: finalPane,
							output,
							sessionFile: childResult.sessionFile,
							provider: childResult.provider ?? spec.provider,
							model: childResult.model ?? spec.model,
							thinking: childResult.thinking ?? spec.thinking,
							startedAt,
							finishedAt: childResult.finishedAt,
						});

						if (childResult.status === "failed") {
							throw new Error(resultText(details));
						}
						return {
							content: [{ type: "text", text: resultText(details) }],
							details,
						};
					} catch (error) {
						if (signal?.aborted) {
							await pi.exec("tmux", tmuxArgs("kill-session", "-t", tmuxSession));
							activeSession = undefined;
						}
						throw error;
					} finally {
						if (activeSession === tmuxSession) activeSession = undefined;
					}
				},
			);
		},

		renderCall(args, theme) {
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("dim", preview);
			const overrides = [args.provider, args.model, args.thinking].filter(Boolean);
			if (overrides.length > 0) text += `\n  ${theme.fg("muted", overrides.join(" · "))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as RunDetails | undefined;
			if (!details) {
				const content = result.content.find((part) => part.type === "text");
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}

			const running = isPartial || details.status === "queued" || details.status === "running";
			const icon = running
				? theme.fg("warning", details.status === "queued" ? "◦" : "●")
				: details.status === "completed"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
			const duration = formatDuration(details.startedAt, details.finishedAt);
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.tmuxSession))}`;
			text += theme.fg("muted", ` · ${details.status}${duration ? ` · ${duration}` : ""}`);
			text += `\n  ${theme.fg("accent", details.attachCommand)}`;
			text += `\n  ${theme.fg("dim", `${details.provider}/${details.model} (${details.thinking})`)}`;

			if (running && details.pane) {
				const paneLines = details.pane.split("\n");
				const visible = expanded ? paneLines : paneLines.slice(-8);
				text += `\n\n${visible.map((line) => theme.fg("dim", line)).join("\n")}`;
			} else if (!running && details.output) {
				const outputLines = details.output.split("\n");
				const visible = expanded ? outputLines : outputLines.slice(0, 8);
				text += `\n\n${visible.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
				if (!expanded && outputLines.length > visible.length) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				text += `\n\n  ${theme.fg("dim", `capture: ${details.captureCommand}`)}`;
				text += `\n  ${theme.fg("dim", `cleanup: ${details.killCommand}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
