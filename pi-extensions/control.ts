/**
 * Session Control Extension
 *
 * Enables inter-session communication via Unix domain sockets.  When enabled with
 * the `--session-control` flag, each pi session creates a control socket at
 * `~/.pi/session-control/<session-id>.sock` that accepts JSON-RPC commands.
 *
 * Features:
 * - Send messages to other running pi sessions (steer or follow-up mode)
 * - Retrieve the last assistant message from a session
 * - Get AI-generated summaries of session activity
 * - Clear/rewind sessions to their initial state
 * - Subscribe to turn_end events for async coordination
 *
 * Once loaded the extension registers a `send_to_session` tool that allows the AI to
 * communicate with other pi sessions programmatically.
 *
 * Usage:
 *   pi --session-control
 *
 * Environment:
 *   Sets PI_SESSION_ID when enabled, allowing child processes to discover
 *   the current session.
 *
 * RPC Protocol:
 *   Commands are newline-delimited JSON objects with a `type` field:
 *   - { type: "send", message: "...", mode?: "steer"|"follow_up" }
 *   - { type: "get_message" }
 *   - { type: "get_summary" }
 *   - { type: "clear", summarize?: boolean }
 *   - { type: "abort" }
 *   - { type: "subscribe", event: "turn_end" }
 *
 *   Responses are JSON objects with { type: "response", command, success, data?, error? }
 *   Events are JSON objects with { type: "event", event, data?, subscriptionId? }
 */

import type { ExtensionAPI, ExtensionContext, TurnEndEvent, MessageRenderer } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { complete, type Model, type Api, type UserMessage, type TextContent } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const CONTROL_FLAG = "session-control";
const CONTROL_DIR = path.join(os.homedir(), ".pi", "session-control");
const SOCKET_SUFFIX = ".sock";
const SESSION_MESSAGE_TYPE = "session-message";
const SENDER_INFO_PATTERN = /<sender_info>[\s\S]*?<\/sender_info>/g;

// ============================================================================
// RPC Types
// ============================================================================

interface RpcResponse {
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
	id?: string;
}

interface RpcEvent {
	type: "event";
	event: string;
	data?: unknown;
	subscriptionId?: string;
}

// Unified command structure
interface RpcSendCommand {
	type: "send";
	message: string;
	mode?: "steer" | "follow_up";
	id?: string;
}

interface RpcGetMessageCommand {
	type: "get_message";
	id?: string;
}

interface RpcGetSummaryCommand {
	type: "get_summary";
	id?: string;
}

interface RpcClearCommand {
	type: "clear";
	summarize?: boolean;
	id?: string;
}

interface RpcAbortCommand {
	type: "abort";
	id?: string;
}

interface RpcSubscribeCommand {
	type: "subscribe";
	event: "turn_end";
	id?: string;
}

type RpcCommand =
	| RpcSendCommand
	| RpcGetMessageCommand
	| RpcGetSummaryCommand
	| RpcClearCommand
	| RpcAbortCommand
	| RpcSubscribeCommand;

// ============================================================================
// Subscription Management
// ============================================================================

interface TurnEndSubscription {
	socket: net.Socket;
	subscriptionId: string;
}

interface SocketState {
	server: net.Server | null;
	socketPath: string | null;
	context: ExtensionContext | null;
	alias: string | null;
	aliasTimer: ReturnType<typeof setInterval> | null;
	turnEndSubscriptions: TurnEndSubscription[];
}

// ============================================================================
// Summarization
// ============================================================================

const CODEX_MODEL_ID = "gpt-5.1-codex-mini";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summarizer. Create concise, accurate summaries that preserve key information, decisions, and outcomes.`;

const TURN_SUMMARY_PROMPT = `Summarize what happened in this conversation since the last user prompt. Focus on:
- What was accomplished
- Any decisions made
- Files that were read, modified, or created
- Any errors or issues encountered
- Current state/next steps

Be concise but comprehensive. Preserve exact file paths, function names, and error messages.`;

async function selectSummarizationModel(
	currentModel: Model<Api> | undefined,
	modelRegistry: {
		find: (provider: string, modelId: string) => Model<Api> | undefined;
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	},
): Promise<Model<Api> | undefined> {
	const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
	if (codexModel) {
		const apiKey = await modelRegistry.getApiKey(codexModel);
		if (apiKey) return codexModel;
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (haikuModel) {
		const apiKey = await modelRegistry.getApiKey(haikuModel);
		if (apiKey) return haikuModel;
	}

	return currentModel;
}

// ============================================================================
// Utilities
// ============================================================================

const STATUS_KEY = "session-control";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

function getSocketPath(sessionId: string): string {
	return path.join(CONTROL_DIR, `${sessionId}${SOCKET_SUFFIX}`);
}

function isSafeSessionId(sessionId: string): boolean {
	return !sessionId.includes("/") && !sessionId.includes("\\") && !sessionId.includes("..") && sessionId.length > 0;
}

function isSafeAlias(alias: string): boolean {
	return !alias.includes("/") && !alias.includes("\\") && !alias.includes("..") && alias.length > 0;
}

function getAliasPath(alias: string): string {
	return path.join(CONTROL_DIR, `${alias}.alias`);
}

function getSessionAlias(ctx: ExtensionContext): string | null {
	const sessionName = ctx.sessionManager.getSessionName();
	const alias = sessionName ? sessionName.trim() : "";
	if (!alias || !isSafeAlias(alias)) return null;
	return alias;
}

async function ensureControlDir(): Promise<void> {
	await fs.mkdir(CONTROL_DIR, { recursive: true });
}

async function removeSocket(socketPath: string | null): Promise<void> {
	if (!socketPath) return;
	try {
		await fs.unlink(socketPath);
	} catch (error) {
		if (isErrnoException(error) && error.code !== "ENOENT") {
			throw error;
		}
	}
}

// TODO: add GC for stale sockets/aliases older than 7 days.
async function removeAliasesForSocket(socketPath: string | null): Promise<void> {
	if (!socketPath) return;
	try {
		const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isSymbolicLink()) continue;
			const aliasPath = path.join(CONTROL_DIR, entry.name);
			let target: string;
			try {
				target = await fs.readlink(aliasPath);
			} catch {
				continue;
			}
			const resolvedTarget = path.resolve(CONTROL_DIR, target);
			if (resolvedTarget === socketPath) {
				await fs.unlink(aliasPath);
			}
		}
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return;
		throw error;
	}
}

async function createAliasSymlink(sessionId: string, alias: string): Promise<void> {
	if (!alias || !isSafeAlias(alias)) return;
	const aliasPath = getAliasPath(alias);
	const target = `${sessionId}${SOCKET_SUFFIX}`;
	try {
		await fs.unlink(aliasPath);
	} catch (error) {
		if (isErrnoException(error) && error.code !== "ENOENT") {
			throw error;
		}
	}
	try {
		await fs.symlink(target, aliasPath);
	} catch (error) {
		if (isErrnoException(error) && error.code !== "EEXIST") {
			throw error;
		}
	}
}

async function resolveSessionIdFromAlias(alias: string): Promise<string | null> {
	if (!alias || !isSafeAlias(alias)) return null;
	const aliasPath = getAliasPath(alias);
	try {
		const target = await fs.readlink(aliasPath);
		const resolvedTarget = path.resolve(CONTROL_DIR, target);
		const base = path.basename(resolvedTarget);
		if (!base.endsWith(SOCKET_SUFFIX)) return null;
		const sessionId = base.slice(0, -SOCKET_SUFFIX.length);
		return isSafeSessionId(sessionId) ? sessionId : null;
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return null;
		return null;
	}
}

async function getAliasMap(): Promise<Map<string, string[]>> {
	const aliasMap = new Map<string, string[]>();
	const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isSymbolicLink()) continue;
		if (!entry.name.endsWith(".alias")) continue;
		const aliasPath = path.join(CONTROL_DIR, entry.name);
		let target: string;
		try {
			target = await fs.readlink(aliasPath);
		} catch {
			continue;
		}
		const resolvedTarget = path.resolve(CONTROL_DIR, target);
		const aliases = aliasMap.get(resolvedTarget);
		const aliasName = entry.name.slice(0, -".alias".length);
		if (aliases) {
			aliases.push(aliasName);
		} else {
			aliasMap.set(resolvedTarget, [aliasName]);
		}
	}
	return aliasMap;
}

async function isSocketAlive(socketPath: string): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = net.createConnection(socketPath);
		const timeout = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 300);

		const cleanup = (alive: boolean) => {
			clearTimeout(timeout);
			socket.removeAllListeners();
			resolve(alive);
		};

		socket.once("connect", () => {
			socket.end();
			cleanup(true);
		});
		socket.once("error", () => {
			cleanup(false);
		});
	});
}

type LiveSessionInfo = {
	sessionId: string;
	name?: string;
	aliases: string[];
	socketPath: string;
};

async function getLiveSessions(): Promise<LiveSessionInfo[]> {
	await ensureControlDir();
	const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
	const aliasMap = await getAliasMap();
	const sessions: LiveSessionInfo[] = [];

	for (const entry of entries) {
		if (!entry.name.endsWith(SOCKET_SUFFIX)) continue;
		const socketPath = path.join(CONTROL_DIR, entry.name);
		const alive = await isSocketAlive(socketPath);
		if (!alive) continue;
		const sessionId = entry.name.slice(0, -SOCKET_SUFFIX.length);
		if (!isSafeSessionId(sessionId)) continue;
		const aliases = aliasMap.get(socketPath) ?? [];
		const name = aliases[0];
		sessions.push({ sessionId, name, aliases, socketPath });
	}

	sessions.sort((a, b) => (a.name ?? a.sessionId).localeCompare(b.name ?? b.sessionId));
	return sessions;
}

async function syncAlias(state: SocketState, ctx: ExtensionContext): Promise<void> {
	if (!state.server || !state.socketPath) return;
	const alias = getSessionAlias(ctx);
	if (alias && alias !== state.alias) {
		await removeAliasesForSocket(state.socketPath);
		await createAliasSymlink(ctx.sessionManager.getSessionId(), alias);
		state.alias = alias;
		return;
	}
	if (!alias && state.alias) {
		await removeAliasesForSocket(state.socketPath);
		state.alias = null;
	}
}

function writeResponse(socket: net.Socket, response: RpcResponse): void {
	try {
		socket.write(`${JSON.stringify(response)}\n`);
	} catch {
		// Socket may be closed
	}
}

function writeEvent(socket: net.Socket, event: RpcEvent): void {
	try {
		socket.write(`${JSON.stringify(event)}\n`);
	} catch {
		// Socket may be closed
	}
}

function parseCommand(line: string): { command?: RpcCommand; error?: string } {
	try {
		const parsed = JSON.parse(line) as RpcCommand;
		if (!parsed || typeof parsed !== "object") {
			return { error: "Invalid command" };
		}
		if (typeof parsed.type !== "string") {
			return { error: "Missing command type" };
		}
		return { command: parsed };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Failed to parse command" };
	}
}

// ============================================================================
// Message Extraction
// ============================================================================

interface ExtractedMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

function getLastAssistantMessage(ctx: ExtensionContext): ExtractedMessage | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if ("role" in msg && msg.role === "assistant") {
				const textParts = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text);
				if (textParts.length > 0) {
					return {
						role: "assistant",
						content: textParts.join("\n"),
						timestamp: msg.timestamp,
					};
				}
			}
		}
	}
	return undefined;
}

function getMessagesSinceLastPrompt(ctx: ExtensionContext): ExtractedMessage[] {
	const branch = ctx.sessionManager.getBranch();
	const messages: ExtractedMessage[] = [];

	let lastUserIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && "role" in entry.message && entry.message.role === "user") {
			lastUserIndex = i;
			break;
		}
	}

	if (lastUserIndex === -1) return [];

	for (let i = lastUserIndex; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if ("role" in msg && (msg.role === "user" || msg.role === "assistant")) {
				const textParts = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text);
				if (textParts.length > 0) {
					messages.push({
						role: msg.role,
						content: textParts.join("\n"),
						timestamp: msg.timestamp,
					});
				}
			}
		}
	}

	return messages;
}

function getFirstEntryId(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	if (entries.length === 0) return undefined;
	const root = entries.find((e) => e.parentId === null);
	return root?.id ?? entries[0]?.id;
}

function extractTextContent(content: string | Array<TextContent | { type: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function stripSenderInfo(text: string): string {
	return text.replace(SENDER_INFO_PATTERN, "").trim();
}

interface SenderInfo {
	sessionId?: string;
	sessionName?: string;
}

function parseSenderInfo(text: string): SenderInfo | null {
	const match = text.match(/<sender_info>([\s\S]*?)<\/sender_info>/);
	if (!match) return null;
	const raw = match[1].trim();
	if (!raw) return null;

	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw) as { sessionId?: unknown; sessionName?: unknown };
			const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
			const sessionName = typeof parsed.sessionName === "string" ? parsed.sessionName.trim() : "";
			if (sessionId || sessionName) {
				return {
					sessionId: sessionId || undefined,
					sessionName: sessionName || undefined,
				};
			}
		} catch {
			// Ignore JSON parse errors, fall back to legacy parsing.
		}
	}

	const legacyIdMatch = raw.match(/session\s+([a-f0-9-]{6,})/i);
	if (legacyIdMatch) {
		return { sessionId: legacyIdMatch[1] };
	}

	return null;
}

function formatSenderInfo(info: SenderInfo | null): string | null {
	if (!info) return null;
	const { sessionName, sessionId } = info;
	if (sessionName && sessionId) return `${sessionName} (${sessionId})`;
	if (sessionName) return sessionName;
	if (sessionId) return sessionId;
	return null;
}

const renderSessionMessage: MessageRenderer = (message, { expanded }, theme) => {
	const rawContent = extractTextContent(message.content);
	const senderInfo = parseSenderInfo(rawContent);
	let text = stripSenderInfo(rawContent);
	if (!text) text = "(no content)";

	if (!expanded) {
		const lines = text.split("\n");
		if (lines.length > 5) {
			text = `${lines.slice(0, 5).join("\n")}\n...`;
		}
	}

	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	const labelBase = theme.fg("customMessageLabel", `\x1b[1m[${message.customType}]\x1b[22m`);
	const senderText = formatSenderInfo(senderInfo);
	const label = senderText ? `${labelBase} ${theme.fg("dim", `from ${senderText}`)}` : labelBase;
	box.addChild(new Text(label, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(
		new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);
	return box;
};

// ============================================================================
// Command Handlers
// ============================================================================

async function handleCommand(
	pi: ExtensionAPI,
	state: SocketState,
	command: RpcCommand,
	socket: net.Socket,
): Promise<void> {
	const id = "id" in command && typeof command.id === "string" ? command.id : undefined;
	const respond = (success: boolean, commandName: string, data?: unknown, error?: string) => {
		if (state.context) {
			void syncAlias(state, state.context);
		}
		writeResponse(socket, { type: "response", command: commandName, success, data, error, id });
	};

	const ctx = state.context;
	if (!ctx) {
		respond(false, command.type, undefined, "Session not ready");
		return;
	}

	void syncAlias(state, ctx);

	// Abort
	if (command.type === "abort") {
		ctx.abort();
		respond(true, "abort");
		return;
	}

	// Subscribe to turn_end
	if (command.type === "subscribe") {
		if (command.event === "turn_end") {
			const subscriptionId = id ?? `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			state.turnEndSubscriptions.push({ socket, subscriptionId });

			const cleanup = () => {
				const idx = state.turnEndSubscriptions.findIndex((s) => s.subscriptionId === subscriptionId);
				if (idx !== -1) state.turnEndSubscriptions.splice(idx, 1);
			};
			socket.once("close", cleanup);
			socket.once("error", cleanup);

			respond(true, "subscribe", { subscriptionId, event: "turn_end" });
			return;
		}
		respond(false, "subscribe", undefined, `Unknown event type: ${command.event}`);
		return;
	}

	// Get last message
	if (command.type === "get_message") {
		const message = getLastAssistantMessage(ctx);
		if (!message) {
			respond(true, "get_message", { message: null });
			return;
		}
		respond(true, "get_message", { message });
		return;
	}

	// Get summary
	if (command.type === "get_summary") {
		const messages = getMessagesSinceLastPrompt(ctx);
		if (messages.length === 0) {
			respond(false, "get_summary", undefined, "No messages to summarize");
			return;
		}

		const model = await selectSummarizationModel(ctx.model, ctx.modelRegistry);
		if (!model) {
			respond(false, "get_summary", undefined, "No model available for summarization");
			return;
		}

		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) {
			respond(false, "get_summary", undefined, "No API key available for summarization model");
			return;
		}

		try {
			const conversationText = messages
				.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
				.join("\n\n");

			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_SUMMARY_PROMPT}` }],
				timestamp: Date.now(),
			};

			const response = await complete(
				model,
				{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey },
			);

			if (response.stopReason === "aborted" || response.stopReason === "error") {
				respond(false, "get_summary", undefined, "Summarization failed");
				return;
			}

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			respond(true, "get_summary", { summary, model: model.id });
		} catch (error) {
			respond(false, "get_summary", undefined, error instanceof Error ? error.message : "Summarization failed");
		}
		return;
	}

	// Clear session
	if (command.type === "clear") {
		if (!ctx.isIdle()) {
			respond(false, "clear", undefined, "Session is busy - wait for turn to complete");
			return;
		}

		const firstEntryId = getFirstEntryId(ctx);
		if (!firstEntryId) {
			respond(false, "clear", undefined, "No entries in session");
			return;
		}

		const currentLeafId = ctx.sessionManager.getLeafId();
		if (currentLeafId === firstEntryId) {
			respond(true, "clear", { cleared: true, alreadyAtRoot: true });
			return;
		}

		if (command.summarize) {
			// Summarization requires navigateTree which we don't have direct access to
			// Return an error for now - the caller should clear without summarize
			// or use a different approach
			respond(false, "clear", undefined, "Clear with summarization not supported via RPC - use summarize=false");
			return;
		}

		// Access internal session manager to rewind (type assertion to access non-readonly methods)
		try {
			const sessionManager = ctx.sessionManager as unknown as { rewindTo(id: string): void };
			sessionManager.rewindTo(firstEntryId);
			respond(true, "clear", { cleared: true, targetId: firstEntryId });
		} catch (error) {
			respond(false, "clear", undefined, error instanceof Error ? error.message : "Clear failed");
		}
		return;
	}

	// Send message
	if (command.type === "send") {
		const message = command.message;
		if (typeof message !== "string" || message.trim().length === 0) {
			respond(false, "send", undefined, "Missing message");
			return;
		}

		const mode = command.mode ?? "steer";
		const isIdle = ctx.isIdle();
		const customMessage = {
			customType: SESSION_MESSAGE_TYPE,
			content: message,
			display: true,
		};

		if (isIdle) {
			pi.sendMessage(customMessage, { triggerTurn: true });
		} else {
			pi.sendMessage(customMessage, {
				triggerTurn: true,
				deliverAs: mode === "follow_up" ? "followUp" : "steer",
			});
		}

		respond(true, "send", { delivered: true, mode: isIdle ? "direct" : mode });
		return;
	}

	respond(false, command.type, undefined, `Unsupported command: ${command.type}`);
}

// ============================================================================
// Server Management
// ============================================================================

async function createServer(pi: ExtensionAPI, state: SocketState, socketPath: string): Promise<net.Server> {
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;

				const parsed = parseCommand(line);
				if (parsed.error) {
					if (state.context) {
						void syncAlias(state, state.context);
					}
					writeResponse(socket, {
						type: "response",
						command: "parse",
						success: false,
						error: `Failed to parse command: ${parsed.error}`,
					});
					continue;
				}

				handleCommand(pi, state, parsed.command!, socket);
			}
		});
	});

	// Wait for server to start listening, with error handling
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	return server;
}

interface RpcClientOptions {
	timeout?: number;
	waitForEvent?: "turn_end";
}

async function sendRpcCommand(
	socketPath: string,
	command: RpcCommand,
	options: RpcClientOptions = {},
): Promise<{ response: RpcResponse; event?: { message?: ExtractedMessage; turnIndex?: number } }> {
	const { timeout = 5000, waitForEvent } = options;

	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");

		const timeoutHandle = setTimeout(() => {
			socket.destroy(new Error("timeout"));
		}, timeout);

		let buffer = "";
		let response: RpcResponse | null = null;

		const cleanup = () => {
			clearTimeout(timeoutHandle);
			socket.removeAllListeners();
		};

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(command)}\n`);

			// If waiting for turn_end, also subscribe
			if (waitForEvent === "turn_end") {
				const subscribeCmd: RpcSubscribeCommand = { type: "subscribe", event: "turn_end" };
				socket.write(`${JSON.stringify(subscribeCmd)}\n`);
			}
		});

		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;

				try {
					const msg = JSON.parse(line);

					// Handle response
					if (msg.type === "response") {
						if (msg.command === command.type) {
							response = msg;
							// If not waiting for event, we're done
							if (!waitForEvent) {
								cleanup();
								socket.end();
								resolve({ response });
								return;
							}
						}
						// Ignore subscribe response
						continue;
					}

					// Handle turn_end event
					if (msg.type === "event" && msg.event === "turn_end" && waitForEvent === "turn_end") {
						cleanup();
						socket.end();
						if (!response) {
							reject(new Error("Received event before response"));
							return;
						}
						resolve({ response, event: msg.data || {} });
						return;
					}
				} catch {
					// Ignore parse errors, keep waiting
				}
			}
		});

		socket.on("error", (error) => {
			cleanup();
			reject(error);
		});
	});
}

async function startControlServer(pi: ExtensionAPI, state: SocketState, ctx: ExtensionContext): Promise<void> {
	await ensureControlDir();
	const sessionId = ctx.sessionManager.getSessionId();
	const socketPath = getSocketPath(sessionId);

	if (state.socketPath === socketPath && state.server) {
		state.context = ctx;
		await syncAlias(state, ctx);
		return;
	}

	await stopControlServer(state);
	await removeSocket(socketPath);

	state.context = ctx;
	state.socketPath = socketPath;
	state.server = await createServer(pi, state, socketPath);
	state.alias = null;
	await syncAlias(state, ctx);
}

async function stopControlServer(state: SocketState): Promise<void> {
	if (!state.server) {
		await removeAliasesForSocket(state.socketPath);
		await removeSocket(state.socketPath);
		state.socketPath = null;
		state.alias = null;
		return;
	}

	const socketPath = state.socketPath;
	state.socketPath = null;
	state.turnEndSubscriptions = [];
	await new Promise<void>((resolve) => state.server?.close(() => resolve()));
	state.server = null;
	await removeAliasesForSocket(socketPath);
	await removeSocket(socketPath);
	state.alias = null;
}

function updateStatus(ctx: ExtensionContext | null, enabled: boolean): void {
	if (!ctx?.hasUI) return;
	if (!enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `session ${sessionId}`));
}

function updateSessionEnv(ctx: ExtensionContext | null, enabled: boolean): void {
	if (!enabled) {
		delete process.env.PI_SESSION_ID;
		return;
	}
	if (!ctx) return;
	process.env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
}

// ============================================================================
// Extension Export
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerFlag(CONTROL_FLAG, {
		description: "Enable per-session control socket under ~/.pi/session-control",
		type: "boolean",
	});

	const state: SocketState = {
		server: null,
		socketPath: null,
		context: null,
		alias: null,
		aliasTimer: null,
		turnEndSubscriptions: [],
	};

	pi.registerMessageRenderer(SESSION_MESSAGE_TYPE, renderSessionMessage);

	registerSessionTool(pi, state);
	registerListSessionsTool(pi);
	registerControlSessionsCommand(pi);

	const refreshServer = async (ctx: ExtensionContext) => {
		const enabled = pi.getFlag(CONTROL_FLAG) === true;
		if (!enabled) {
			if (state.aliasTimer) {
				clearInterval(state.aliasTimer);
				state.aliasTimer = null;
			}
			await stopControlServer(state);
			updateStatus(ctx, false);
			updateSessionEnv(ctx, false);
			return;
		}
		await startControlServer(pi, state, ctx);
		if (!state.aliasTimer) {
			state.aliasTimer = setInterval(() => {
				if (!state.context) return;
				void syncAlias(state, state.context);
			}, 1000);
		}
		updateStatus(ctx, true);
		updateSessionEnv(ctx, true);
	};

	pi.on("session_start", async (_event, ctx) => {
		await refreshServer(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await refreshServer(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (state.aliasTimer) {
			clearInterval(state.aliasTimer);
			state.aliasTimer = null;
		}
		updateStatus(state.context, false);
		updateSessionEnv(state.context, false);
		await stopControlServer(state);
	});

	// Fire turn_end events to subscribers
	pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
		if (state.turnEndSubscriptions.length === 0) return;

		void syncAlias(state, ctx);
		const lastMessage = getLastAssistantMessage(ctx);
		const eventData = { message: lastMessage, turnIndex: event.turnIndex };

		// Fire to all subscribers (one-shot)
		const subscriptions = [...state.turnEndSubscriptions];
		state.turnEndSubscriptions = [];

		for (const sub of subscriptions) {
			writeEvent(sub.socket, {
				type: "event",
				event: "turn_end",
				data: eventData,
				subscriptionId: sub.subscriptionId,
			});
		}
	});
}

// ============================================================================
// Tool: send_to_session
// ============================================================================

function registerSessionTool(pi: ExtensionAPI, state: SocketState): void {
	pi.registerTool({
		name: "send_to_session",
		label: "Send To Session",
		description: `Interact with another running pi session via its control socket.

Actions:
- send: Send a message (default). Requires 'message' parameter.
- get_message: Get the most recent assistant message.
- get_summary: Get a summary of activity since the last user prompt.
- clear: Rewind session to initial state.

Target selection:
- sessionId: UUID of the session.
- sessionName: session name (alias from /name).

Wait behavior (only for action=send):
- wait_until=turn_end: Wait for the turn to complete, returns last assistant message.
- wait_until=message_processed: Returns immediately after message is queued.

Note: If you ask the target session to reply back via sender_info, do not use wait_until; waiting is redundant and can duplicate responses.

Messages automatically include sender session info for replies. When you want a response, instruct the target session to reply directly to the sender by calling send_to_session with the sender_info reference (do not poll get_message).`,
		parameters: Type.Object({
			sessionId: Type.Optional(Type.String({ description: "Target session id (UUID)" })),
			sessionName: Type.Optional(Type.String({ description: "Target session name (alias)" })),
			action: Type.Optional(
				StringEnum(["send", "get_message", "get_summary", "clear"] as const, {
					description: "Action to perform (default: send)",
					default: "send",
				}),
			),
			message: Type.Optional(Type.String({ description: "Message to send (required for action=send)" })),
			mode: Type.Optional(
				StringEnum(["steer", "follow_up"] as const, {
					description: "Delivery mode for send: steer (immediate) or follow_up (after task)",
					default: "steer",
				}),
			),
			wait_until: Type.Optional(
				StringEnum(["turn_end", "message_processed"] as const, {
					description: "Wait behavior for send action",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const action = params.action ?? "send";
			const sessionName = params.sessionName?.trim();
			const sessionId = params.sessionId?.trim();
			let targetSessionId: string | null = null;
			const displayTarget = sessionName || sessionId || "";

			if (sessionName) {
				targetSessionId = await resolveSessionIdFromAlias(sessionName);
				if (!targetSessionId) {
					return {
						content: [{ type: "text", text: "Unknown session name" }],
						isError: true,
						details: { error: "Unknown session name" },
					};
				}
			}

			if (sessionId) {
				if (!isSafeSessionId(sessionId)) {
					return {
						content: [{ type: "text", text: "Invalid session id" }],
						isError: true,
						details: { error: "Invalid session id" },
					};
				}
				if (targetSessionId && targetSessionId !== sessionId) {
					return {
						content: [{ type: "text", text: "Session name does not match session id" }],
						isError: true,
						details: { error: "Session name does not match session id" },
					};
				}
				targetSessionId = sessionId;
			}

			if (!targetSessionId) {
				return {
					content: [{ type: "text", text: "Missing session id or session name" }],
					isError: true,
					details: { error: "Missing session id or session name" },
				};
			}

			const socketPath = getSocketPath(targetSessionId);
			const senderSessionId = state.context?.sessionManager.getSessionId();

			try {
				// Handle each action
				if (action === "get_message") {
					const result = await sendRpcCommand(socketPath, { type: "get_message" });
					if (!result.response.success) {
						return {
							content: [{ type: "text", text: `Failed: ${result.response.error ?? "unknown error"}` }],
							isError: true,
							details: result,
						};
					}
					const data = result.response.data as { message?: ExtractedMessage };
					if (!data?.message) {
						return {
							content: [{ type: "text", text: "No assistant message found in session" }],
							details: result,
						};
					}
					return {
						content: [{ type: "text", text: data.message.content }],
						details: { message: data.message },
					};
				}

				if (action === "get_summary") {
					const result = await sendRpcCommand(socketPath, { type: "get_summary" }, { timeout: 60000 });
					if (!result.response.success) {
						return {
							content: [{ type: "text", text: `Failed: ${result.response.error ?? "unknown error"}` }],
							isError: true,
							details: result,
						};
					}
					const data = result.response.data as { summary?: string; model?: string };
					if (!data?.summary) {
						return {
							content: [{ type: "text", text: "No summary generated" }],
							details: result,
						};
					}
					return {
						content: [{ type: "text", text: `Summary (via ${data.model}):\n\n${data.summary}` }],
						details: { summary: data.summary, model: data.model },
					};
				}

				if (action === "clear") {
					const result = await sendRpcCommand(socketPath, { type: "clear", summarize: false }, { timeout: 10000 });
					if (!result.response.success) {
						return {
							content: [{ type: "text", text: `Failed to clear: ${result.response.error ?? "unknown error"}` }],
							isError: true,
							details: result,
						};
					}
					const data = result.response.data as { cleared?: boolean; alreadyAtRoot?: boolean };
					const msg = data?.alreadyAtRoot ? "Session already at root" : "Session cleared";
					return {
						content: [{ type: "text", text: msg }],
						details: data,
					};
				}

				// action === "send"
				if (!params.message || params.message.trim().length === 0) {
					return {
						content: [{ type: "text", text: "Missing message for send action" }],
						isError: true,
						details: { error: "Missing message" },
					};
				}

				const senderSessionName = state.context?.sessionManager.getSessionName()?.trim();
				const senderInfo = senderSessionId
					? `\n\n<sender_info>${JSON.stringify({
						sessionId: senderSessionId,
						sessionName: senderSessionName || undefined,
					})}</sender_info>`
					: "";

				const sendCommand: RpcSendCommand = {
					type: "send",
					message: params.message + senderInfo,
					mode: params.mode ?? "steer",
				};

				// Determine wait behavior
				if (params.wait_until === "message_processed") {
					// Just send and confirm delivery
					const result = await sendRpcCommand(socketPath, sendCommand);
					if (!result.response.success) {
						return {
							content: [{ type: "text", text: `Failed: ${result.response.error ?? "unknown error"}` }],
							isError: true,
							details: result,
						};
					}
					return {
						content: [{ type: "text", text: "Message delivered to session" }],
						details: result.response.data,
					};
				}

				if (params.wait_until === "turn_end") {
					// Send and wait for turn to complete
					const result = await sendRpcCommand(socketPath, sendCommand, {
						timeout: 300000, // 5 minutes
						waitForEvent: "turn_end",
					});

					if (!result.response.success) {
						return {
							content: [{ type: "text", text: `Failed: ${result.response.error ?? "unknown error"}` }],
							isError: true,
							details: result,
						};
					}

					const lastMessage = result.event?.message;
					if (!lastMessage) {
						return {
							content: [{ type: "text", text: "Turn completed but no assistant message found" }],
							details: { turnIndex: result.event?.turnIndex },
						};
					}

					return {
						content: [{ type: "text", text: lastMessage.content }],
						details: { message: lastMessage, turnIndex: result.event?.turnIndex },
					};
				}

				// No wait - just send
				const result = await sendRpcCommand(socketPath, sendCommand);
				if (!result.response.success) {
					return {
						content: [{ type: "text", text: `Failed: ${result.response.error ?? "unknown error"}` }],
						isError: true,
						details: result,
					};
				}

				return {
					content: [{ type: "text", text: `Message sent to session ${displayTarget || targetSessionId}` }],
					details: result.response.data,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Failed: ${message}` }],
					isError: true,
					details: { error: message },
				};
			}
		},

		renderCall(args, theme) {
			const action = args.action ?? "send";
			const sessionRef = args.sessionName ?? args.sessionId ?? "...";
			const shortSessionRef = sessionRef.length > 12 ? sessionRef.slice(0, 8) + "..." : sessionRef;

			// Build the header line
			let header = theme.fg("toolTitle", theme.bold("→ session "));
			header += theme.fg("accent", shortSessionRef);

			// Add action-specific info
			if (action === "send") {
				const mode = args.mode ?? "steer";
				const wait = args.wait_until;
				let info = theme.fg("muted", ` (${mode}`);
				if (wait) info += theme.fg("dim", `, wait: ${wait}`);
				info += theme.fg("muted", ")");
				header += info;
			} else {
				header += theme.fg("muted", ` (${action})`);
			}

			// For send action, show the message
			if (action === "send" && args.message) {
				const msg = args.message;
				const preview = msg.length > 80 ? msg.slice(0, 80) + "..." : msg;
				// Handle multi-line messages
				const firstLine = preview.split("\n")[0];
				const hasMore = preview.includes("\n") || msg.length > 80;
				return new Text(
					header + "\n  " + theme.fg("dim", `"${firstLine}${hasMore ? "..." : ""}"`),
					0,
					0,
				);
			}

			return new Text(header, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as Record<string, unknown> | undefined;
			const isError = result.isError === true;

			// Error case
			if (isError || details?.error) {
				const errorMsg = (details?.error as string) || result.content[0]?.type === "text" ? (result.content[0] as { type: "text"; text: string }).text : "Unknown error";
				return new Text(theme.fg("error", "✗ ") + theme.fg("error", errorMsg), 0, 0);
			}

			// Detect action from details structure
			const hasMessage = details && "message" in details && details.message;
			const hasSummary = details && "summary" in details;
			const hasCleared = details && "cleared" in details;
			const hasTurnIndex = details && "turnIndex" in details;

			// get_message or turn_end result with message
			if (hasMessage) {
				const message = details.message as ExtractedMessage;
				const icon = theme.fg("success", "✓");

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(icon + theme.fg("muted", " Message received"), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(message.content, 0, 0, getMarkdownTheme()));
					if (hasTurnIndex) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Turn #${details.turnIndex}`), 0, 0));
					}
					return container;
				}

				// Collapsed view - show preview
				const preview = message.content.length > 200
					? message.content.slice(0, 200) + "..."
					: message.content;
				const lines = preview.split("\n").slice(0, 5);
				let text = icon + theme.fg("muted", " Message received");
				if (hasTurnIndex) text += theme.fg("dim", ` (turn #${details.turnIndex})`);
				text += "\n" + theme.fg("toolOutput", lines.join("\n"));
				if (message.content.split("\n").length > 5 || message.content.length > 200) {
					text += "\n" + theme.fg("dim", "(Ctrl+O to expand)");
				}
				return new Text(text, 0, 0);
			}

			// get_summary result
			if (hasSummary) {
				const summary = details.summary as string;
				const model = details.model as string | undefined;
				const icon = theme.fg("success", "✓");

				if (expanded) {
					const container = new Container();
					let header = icon + theme.fg("muted", " Summary");
					if (model) header += theme.fg("dim", ` via ${model}`);
					container.addChild(new Text(header, 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(summary, 0, 0, getMarkdownTheme()));
					return container;
				}

				const preview = summary.length > 200 ? summary.slice(0, 200) + "..." : summary;
				const lines = preview.split("\n").slice(0, 5);
				let text = icon + theme.fg("muted", " Summary");
				if (model) text += theme.fg("dim", ` via ${model}`);
				text += "\n" + theme.fg("toolOutput", lines.join("\n"));
				if (summary.split("\n").length > 5 || summary.length > 200) {
					text += "\n" + theme.fg("dim", "(Ctrl+O to expand)");
				}
				return new Text(text, 0, 0);
			}

			// clear result
			if (hasCleared) {
				const alreadyAtRoot = details.alreadyAtRoot as boolean | undefined;
				const icon = theme.fg("success", "✓");
				const msg = alreadyAtRoot ? "Session already at root" : "Session cleared";
				return new Text(icon + " " + theme.fg("muted", msg), 0, 0);
			}

			// send result (no wait or message_processed)
			if (details && "delivered" in details) {
				const mode = details.mode as string | undefined;
				const icon = theme.fg("success", "✓");
				let text = icon + theme.fg("muted", " Message delivered");
				if (mode) text += theme.fg("dim", ` (${mode})`);
				return new Text(text, 0, 0);
			}

			// Fallback - just show the text content
			const text = result.content[0];
			const content = text?.type === "text" ? text.text : "(no output)";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", content), 0, 0);
		},
	});
}

// ============================================================================
// Tool: list_sessions
// ============================================================================

function registerListSessionsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "list_sessions",
		label: "List Sessions",
		description: "List live sessions that expose a control socket (optionally with session names).",
		parameters: Type.Object({}),
		async execute() {
			const sessions = await getLiveSessions();

			if (sessions.length === 0) {
				return {
					content: [{ type: "text", text: "No live sessions found." }],
					details: { sessions: [] },
				};
			}

			const lines = sessions.map((session) => {
				const name = session.name ? ` (${session.name})` : "";
				return `- ${session.sessionId}${name}`;
			});

			return {
				content: [{ type: "text", text: `Live sessions:\n${lines.join("\n")}` }],
				details: { sessions },
			};
		},
	});
}

function registerControlSessionsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("control-sessions", {
		description: "List controllable sessions (from session-control sockets)",
		handler: async (_args, ctx) => {
			if (pi.getFlag(CONTROL_FLAG) !== true) {
				if (ctx.hasUI) {
					ctx.ui.notify("Session control not enabled (use --session-control)", "warning");
				}
				return;
			}

			const sessions = await getLiveSessions();
			const currentSessionId = ctx.sessionManager.getSessionId();
			const lines = sessions.map((session) => {
				const name = session.name ? ` (${session.name})` : "";
				const current = session.sessionId === currentSessionId ? " (current)" : "";
				return `- ${session.sessionId}${name}${current}`;
			});
			const content = sessions.length === 0
				? "No live sessions found."
				: `Controllable sessions:\n${lines.join("\n")}`;

			pi.sendMessage(
				{
					customType: "control-sessions",
					content,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});
}
