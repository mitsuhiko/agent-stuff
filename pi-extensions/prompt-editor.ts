import type { ExtensionAPI, ExtensionContext, ModelSelectEvent, ThinkingLevel } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";

// =============================================================================
// Modes
// =============================================================================

type ModeName = string;

type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	/**
	 * Optional theme color token to use for the editor border.
	 * If unset, the border color is derived from the (current) thinking level.
	 */
	color?: string;
};

type ModesFile = {
	version: 1;
	currentMode: ModeName;
	modes: Record<ModeName, ModeSpec>;
};

const DEFAULT_MODE_ORDER = ["default", "fast", "precise"] as const;
const CUSTOM_MODE_NAME = "custom" as const;

function expandUserPath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function getGlobalAgentDir(): string {
	// Mirror pi-coding-agent's getAgentDir() behavior (best-effort).
	// For the canonical implementation see pi-mono/packages/coding-agent/src/config.ts
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return expandUserPath(env);
	return path.join(os.homedir(), ".pi", "agent");
}

function getGlobalModesPath(): string {
	return path.join(getGlobalAgentDir(), "modes.json");
}

function getProjectModesPath(cwd: string): string {
	return path.join(cwd, ".pi", "modes.json");
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function ensureDirForFile(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	if (typeof level !== "string") return undefined;
	const v = level as ThinkingLevel;
	// Keep the list local to avoid importing internal enums.
	const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
	return allowed.includes(v) ? v : undefined;
}

function sanitizeModeSpec(spec: unknown): ModeSpec {
	const obj = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
	return {
		provider: typeof obj.provider === "string" ? obj.provider : undefined,
		modelId: typeof obj.modelId === "string" ? obj.modelId : undefined,
		thinkingLevel: normalizeThinkingLevel(obj.thinkingLevel),
		color: typeof obj.color === "string" ? obj.color : undefined,
	};
}

function createDefaultModes(ctx: ExtensionContext, pi: ExtensionAPI): ModesFile {
	const currentModel = ctx.model;
	const currentThinking = pi.getThinkingLevel();

	const base: ModeSpec = {
		provider: currentModel?.provider,
		modelId: currentModel?.id,
		thinkingLevel: currentThinking,
	};

	return {
		version: 1,
		currentMode: "default",
		modes: {
			default: { ...base },
			fast: { ...base, thinkingLevel: "off" },
			precise: { ...base, thinkingLevel: "high" },
		},
	};
}

function ensureDefaultModeEntries(file: ModesFile, ctx: ExtensionContext, pi: ExtensionAPI): void {
	for (const name of DEFAULT_MODE_ORDER) {
		if (!file.modes[name]) {
			const defaults = createDefaultModes(ctx, pi);
			file.modes[name] = defaults.modes[name];
		}
	}

	// "custom" is an overlay mode; never treat it as a valid persisted current mode.
	if (file.currentMode === CUSTOM_MODE_NAME) {
		file.currentMode = "" as any;
	}

	if (!file.currentMode || !(file.currentMode in file.modes) || file.currentMode === CUSTOM_MODE_NAME) {
		const first = Object.keys(file.modes).find((k) => k !== CUSTOM_MODE_NAME);
		file.currentMode = file.modes.default ? "default" : first || "default";
	}
}

async function loadModesFile(filePath: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<ModesFile> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const currentMode = typeof parsed.currentMode === "string" ? parsed.currentMode : "default";
		const modesRaw = parsed.modes && typeof parsed.modes === "object" ? (parsed.modes as Record<string, unknown>) : {};
		const modes: Record<string, ModeSpec> = {};
		for (const [k, v] of Object.entries(modesRaw)) {
			modes[k] = sanitizeModeSpec(v);
		}
		const file: ModesFile = {
			version: 1,
			currentMode,
			modes,
		};
		ensureDefaultModeEntries(file, ctx, pi);
		return file;
	} catch {
		return createDefaultModes(ctx, pi);
	}
}

async function saveModesFile(filePath: string, data: ModesFile): Promise<void> {
	await ensureDirForFile(filePath);
	await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function orderedModeNames(modes: Record<string, ModeSpec>): string[] {
	// Preserve insertion order from the JSON file.
	// Object key iteration order is stable in modern JS runtimes.
	// NOTE: "custom" is an overlay mode and must not be selectable/persisted.
	return Object.keys(modes).filter((name) => name !== CUSTOM_MODE_NAME);
}

function getModeBorderColor(ctx: ExtensionContext, pi: ExtensionAPI, mode: string): (text: string) => string {
	const theme = ctx.ui.theme;
	const spec = runtime.data.modes[mode];

	// Explicit color override in JSON.
	if (spec?.color) {
		try {
			// Validate early so we don't crash during render.
			theme.getFgAnsi(spec.color as any);
			return (text: string) => theme.fg(spec.color as any, text);
		} catch {
			// fall through to thinking-based colors
		}
	}

	// Default: derive from the current thinking level.
	return theme.getThinkingBorderColor(pi.getThinkingLevel());
}

function formatModeLabel(mode: string): string {
	return mode;
}

async function resolveModesPath(cwd: string): Promise<string> {
	const projectPath = getProjectModesPath(cwd);
	if (await fileExists(projectPath)) return projectPath;
	return getGlobalModesPath();
}

type ModeRuntime = {
	filePath: string;
	data: ModesFile;
	/**
	 * The effective current mode. Can temporarily be "custom" (overlay),
	 * which is *not* persisted and not selectable via /mode.
	 */
	currentMode: string;
	// guard against feedback loops when we switch model ourselves
	applying: boolean;
};

const runtime: ModeRuntime = {
	filePath: "",
	data: { version: 1, currentMode: "default", modes: {} },
	currentMode: "default",
	applying: false,
};

// Updated by setEditor() when the custom editor is instantiated.
let requestEditorRender: (() => void) | undefined;

async function ensureRuntime(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const filePath = await resolveModesPath(ctx.cwd);
	if (runtime.filePath !== filePath) {
		runtime.filePath = filePath;
		runtime.data = await loadModesFile(filePath, ctx, pi);
		// Reset overlay when switching projects.
		runtime.currentMode = runtime.data.currentMode;
	}
	ensureDefaultModeEntries(runtime.data, ctx, pi);
	// If we're not in the overlay "custom" mode, ensure currentMode is valid.
	if (runtime.currentMode !== CUSTOM_MODE_NAME) {
		if (!runtime.currentMode || !(runtime.currentMode in runtime.data.modes)) {
			runtime.currentMode = runtime.data.currentMode;
		}
	}
}

async function persistRuntime(): Promise<void> {
	if (!runtime.filePath) return;
	// Keep file in sync, but never persist the overlay mode.
	if (runtime.currentMode !== CUSTOM_MODE_NAME) {
		runtime.data.currentMode = runtime.currentMode;
	}
	await saveModesFile(runtime.filePath, runtime.data);
}

async function rememberSelectionForMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	// "custom" is an overlay; do not persist it.
	if (mode === CUSTOM_MODE_NAME) return;

	await ensureRuntime(pi, ctx);
	const spec = runtime.data.modes[mode] ?? (runtime.data.modes[mode] = {});
	if (ctx.model) {
		spec.provider = ctx.model.provider;
		spec.modelId = ctx.model.id;
	}
	spec.thinkingLevel = pi.getThinkingLevel();
	await persistRuntime();
}

async function rememberCurrentSelection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (runtime.currentMode === CUSTOM_MODE_NAME) return;
	await rememberSelectionForMode(pi, ctx, runtime.currentMode);
}

async function applyMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	await ensureRuntime(pi, ctx);

	const previousMode = runtime.currentMode;

	// Save previous mode's selection before switching away.
	// Never persist the overlay "custom" mode.
	if (previousMode !== mode && previousMode !== CUSTOM_MODE_NAME) {
		await rememberSelectionForMode(pi, ctx, previousMode);
	}

	if (!(mode in runtime.data.modes)) {
		runtime.data.modes[mode] = {
			provider: ctx.model?.provider,
			modelId: ctx.model?.id,
			thinkingLevel: pi.getThinkingLevel(),
		};
	}

	runtime.currentMode = mode;
	runtime.data.currentMode = mode;

	const spec = runtime.data.modes[mode] ?? {};

	runtime.applying = true;
	try {
		// Apply model
		if (spec.provider && spec.modelId) {
			const m = ctx.modelRegistry.find(spec.provider, spec.modelId);
			if (m) {
				const ok = await pi.setModel(m);
				if (!ok && ctx.hasUI) {
					ctx.ui.notify(`No API key available for ${spec.provider}/${spec.modelId}`, "warning");
				}
			} else if (ctx.hasUI) {
				ctx.ui.notify(`Mode "${mode}" references unknown model ${spec.provider}/${spec.modelId}`, "warning");
			}
		}

		// Apply thinking level
		if (spec.thinkingLevel) {
			pi.setThinkingLevel(spec.thinkingLevel);
		}
	} finally {
		runtime.applying = false;
	}

	// Persist again to capture any clamping (thinking) or effective model.
	await rememberSelectionForMode(pi, ctx, mode);

	if (ctx.hasUI) {
		requestEditorRender?.();
	}
}

async function selectModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	await ensureRuntime(pi, ctx);

	const names = orderedModeNames(runtime.data.modes);
	const choice = await ctx.ui.select(`Select mode (current: ${runtime.currentMode})`, names);
	if (!choice) return;

	// Special behavior: when we're in "custom" and select another mode,
	// offer to either *use* it (switch) or *store* the current custom selection into it.
	if (runtime.currentMode === CUSTOM_MODE_NAME && choice !== CUSTOM_MODE_NAME) {
		const action = await ctx.ui.select(`Mode "${choice}"`, ["use", "store"]);
		if (!action) return;

		if (action === "use") {
			await applyMode(pi, ctx, choice);
			return;
		}

		// "store": overwrite target mode with the current overlay selection (keep target color if set)
		await ensureRuntime(pi, ctx);

		const overlay: ModeSpec =
			customOverlay ??
			({
				provider: ctx.model?.provider,
				modelId: ctx.model?.id,
				thinkingLevel: pi.getThinkingLevel(),
			} as ModeSpec);

		const existingTarget = runtime.data.modes[choice] ?? {};
		runtime.data.modes[choice] = {
			...existingTarget,
			provider: overlay.provider,
			modelId: overlay.modelId,
			thinkingLevel: overlay.thinkingLevel,
			// preserve existingTarget.color
		};
		await persistRuntime();
		await applyMode(pi, ctx, choice);
		if (ctx.hasUI) {
			ctx.ui.notify(`Stored ${CUSTOM_MODE_NAME} into "${choice}"`, "info");
		}
		return;
	}

	await applyMode(pi, ctx, choice);
}

async function cycleMode(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
	if (!ctx.hasUI) return;
	await ensureRuntime(pi, ctx);
	const names = orderedModeNames(runtime.data.modes);
	if (names.length === 0) return;

	// If we're currently in the overlay mode, cycle relative to the last real mode.
	const baseMode = runtime.currentMode === CUSTOM_MODE_NAME ? runtime.data.currentMode : runtime.currentMode;
	const idx = Math.max(0, names.indexOf(baseMode));
	const next = names[(idx + direction + names.length) % names.length] ?? names[0]!;
	await applyMode(pi, ctx, next);
}

// =============================================================================
// Prompt history
// =============================================================================

const MAX_HISTORY_ENTRIES = 100;
const MAX_RECENT_PROMPTS = 30;

interface PromptEntry {
	text: string;
	timestamp: number;
}

class PromptEditor extends CustomEditor {
	public modeLabelProvider?: () => string;
	/**
	 * Color function for the mode label. If unset, the label inherits the border color.
	 * We use this to keep the label consistent (e.g. same as the footer/status bar).
	 */
	public modeLabelColor?: (text: string) => string;
	private lockedBorder = false;
	private _borderColor?: (text: string) => string;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
	) {
		super(tui, theme, keybindings);
		delete (this as { borderColor?: (text: string) => string }).borderColor;
		Object.defineProperty(this, "borderColor", {
			get: () => this._borderColor ?? ((text: string) => text),
			set: (value: (text: string) => string) => {
				if (this.lockedBorder) return;
				this._borderColor = value;
			},
			configurable: true,
			enumerable: true,
		});
	}

	lockBorderColor() {
		this.lockedBorder = true;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const mode = this.modeLabelProvider?.();
		if (!mode) return lines;

		const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		const topPlain = stripAnsi(lines[0] ?? "");

		// If the editor is scrolled, the built-in editor renders a scroll indicator on the top border.
		// Preserve it, but still show the mode label.
		const scrollPrefixMatch = topPlain.match(/^(─── ↑ \d+ more )/);
		const prefix = scrollPrefixMatch?.[1] ?? "──";

		let label = formatModeLabel(mode);

		// Compute how much room we have for the label core (without truncating the prefix).
		const labelLeftSpace = prefix.endsWith(" ") ? "" : " ";
		const labelRightSpace = " ";
		const minRightBorder = 1; // keep at least one border cell on the right
		const maxLabelLen = Math.max(0, width - prefix.length - labelLeftSpace.length - labelRightSpace.length - minRightBorder);
		if (maxLabelLen <= 0) return lines;
		if (label.length > maxLabelLen) label = label.slice(0, maxLabelLen);

		const labelChunk = `${labelLeftSpace}${label}${labelRightSpace}`;

		const remaining = width - prefix.length - labelChunk.length;
		if (remaining < 0) return lines;

		const right = "─".repeat(Math.max(0, remaining));

		const labelColor = this.modeLabelColor ?? ((text: string) => this.borderColor(text));
		lines[0] = this.borderColor(prefix) + labelColor(labelChunk) + this.borderColor(right);
		return lines;
	}

	public requestRenderNow(): void {
		this.tui.requestRender();
	}
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("")
		.trim();
}

function collectUserPromptsFromEntries(entries: Array<any>): PromptEntry[] {
	const prompts: PromptEntry[] = [];

	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry?.message;
		if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = extractText(message.content);
		if (!text) continue;
		const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
		prompts.push({ text, timestamp });
	}

	return prompts;
}

function getSessionDirForCwd(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getGlobalAgentDir(), "sessions", safePath);
}

async function readTail(filePath: string, maxBytes = 256 * 1024): Promise<string> {
	let fileHandle: fs.FileHandle | undefined;
	try {
		const stats = await fs.stat(filePath);
		const size = stats.size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return "";

		const buffer = Buffer.alloc(length);
		fileHandle = await fs.open(filePath, "r");
		const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
		if (bytesRead === 0) return "";
		let chunk = buffer.subarray(0, bytesRead).toString("utf8");
		if (start > 0) {
			const firstNewline = chunk.indexOf("\n");
			if (firstNewline !== -1) {
				chunk = chunk.slice(firstNewline + 1);
			}
		}
		return chunk;
	} catch {
		return "";
	} finally {
		await fileHandle?.close();
	}
}

async function loadPromptHistoryForCwd(cwd: string, excludeSessionFile?: string): Promise<PromptEntry[]> {
	const sessionDir = getSessionDirForCwd(path.resolve(cwd));
	const resolvedExclude = excludeSessionFile ? path.resolve(excludeSessionFile) : undefined;
	const prompts: PromptEntry[] = [];

	let entries: Dirent[] = [];
	try {
		entries = await fs.readdir(sessionDir, { withFileTypes: true });
	} catch {
		return prompts;
	}

	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry) => {
				const filePath = path.join(sessionDir, entry.name);
				try {
					const stats = await fs.stat(filePath);
					return { filePath, mtimeMs: stats.mtimeMs };
				} catch {
					return undefined;
				}
			}),
	);

	const sortedFiles = files
		.filter((file): file is { filePath: string; mtimeMs: number } => Boolean(file))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	for (const file of sortedFiles) {
		if (resolvedExclude && path.resolve(file.filePath) === resolvedExclude) continue;

		const tail = await readTail(file.filePath);
		if (!tail) continue;
		const lines = tail.split("\n").filter(Boolean);
		for (const line of lines) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry?.message;
			if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
			const text = extractText(message.content);
			if (!text) continue;
			const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
			prompts.push({ text, timestamp });
			if (prompts.length >= MAX_RECENT_PROMPTS) break;
		}
		if (prompts.length >= MAX_RECENT_PROMPTS) break;
	}

	return prompts;
}

function buildHistoryList(currentSession: PromptEntry[], previousSessions: PromptEntry[]): PromptEntry[] {
	const all = [...currentSession, ...previousSessions];
	all.sort((a, b) => a.timestamp - b.timestamp);

	const seen = new Set<string>();
	const deduped: PromptEntry[] = [];
	for (const prompt of all) {
		const key = `${prompt.timestamp}:${prompt.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(prompt);
	}

	return deduped.slice(-MAX_HISTORY_ENTRIES);
}

// Overlay mode state ("custom"). Not selectable, not cycled into.
let customOverlay: ModeSpec | null = null;

let loadCounter = 0;

function historiesMatch(a: PromptEntry[], b: PromptEntry[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i]?.text !== b[i]?.text || a[i]?.timestamp !== b[i]?.timestamp) return false;
	}
	return true;
}

function setEditor(pi: ExtensionAPI, ctx: ExtensionContext, history: PromptEntry[]) {
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = new PromptEditor(tui, theme, keybindings);
		requestEditorRender = () => editor.requestRenderNow();
		editor.modeLabelProvider = () => runtime.currentMode;
		// Keep the mode label color stable (match footer/status bar).
		editor.modeLabelColor = (text: string) => ctx.ui.theme.fg("dim", text);
		const borderColor = (text: string) => {
			const isBashMode = editor.getText().trimStart().startsWith("!");
			if (isBashMode) {
				return ctx.ui.theme.getBashModeBorderColor()(text);
			}
			return getModeBorderColor(ctx, pi, runtime.currentMode)(text);
		};

		editor.borderColor = borderColor;
		editor.lockBorderColor();
		for (const prompt of history) {
			editor.addToHistory?.(prompt.text);
		}
		return editor;
	});
}

function applyEditor(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	const sessionFile = ctx.sessionManager.getSessionFile();
	const currentEntries = ctx.sessionManager.getBranch();
	const currentPrompts = collectUserPromptsFromEntries(currentEntries);
	const immediateHistory = buildHistoryList(currentPrompts, []);

	const currentLoad = ++loadCounter;
	const initialText = ctx.ui.getEditorText();
	setEditor(pi, ctx, immediateHistory);

	void (async () => {
		const previousPrompts = await loadPromptHistoryForCwd(ctx.cwd, sessionFile ?? undefined);
		if (currentLoad !== loadCounter) return;
		if (ctx.ui.getEditorText() !== initialText) return;
		const history = buildHistoryList(currentPrompts, previousPrompts);
		if (historiesMatch(history, immediateHistory)) return;
		setEditor(pi, ctx, history);
	})();
}

// =============================================================================
// Extension Export
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerCommand("mode", {
		description: "Select prompt mode",
		handler: async (_args, ctx) => {
			await selectModeUI(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Select prompt mode",
		handler: async (ctx) => {
			await selectModeUI(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+space", {
		description: "Cycle prompt mode",
		handler: async (ctx) => {
			await cycleMode(pi, ctx, 1);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await ensureRuntime(pi, ctx);
		customOverlay = null;
		applyEditor(pi, ctx);
		// Apply the persisted mode on startup (best-effort).
		await applyMode(pi, ctx, runtime.currentMode);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await ensureRuntime(pi, ctx);
		customOverlay = null;
		applyEditor(pi, ctx);
		await applyMode(pi, ctx, runtime.currentMode);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// Capture current thinking/model so each mode remembers its last selection.
		await rememberCurrentSelection(pi, ctx);
	});

	pi.on("model_select", async (event: ModelSelectEvent, ctx) => {
		// Skip updates triggered by applyMode() itself – the thinking level hasn't
		// been applied yet so pi.getThinkingLevel() still returns the *previous*
		// mode's value, which would overwrite the target mode's stored level.
		if (runtime.applying) return;

		// Manual model changes always go into the overlay "custom" mode.
		await ensureRuntime(pi, ctx);
		runtime.currentMode = CUSTOM_MODE_NAME;

		customOverlay = {
			provider: event.model.provider,
			modelId: event.model.id,
			thinkingLevel: pi.getThinkingLevel(),
		};

		// Do not persist/select custom.
		if (ctx.hasUI) {
			requestEditorRender?.();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await rememberCurrentSelection(pi, ctx);
	});
}
