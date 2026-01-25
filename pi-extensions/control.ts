import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const CONTROL_FLAG = "session-control";
const CONTROL_DIR = path.join(os.homedir(), ".pi", "session-control");
const SOCKET_SUFFIX = ".sock";

interface RpcResponse {
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
	id?: string;
}

interface RpcPromptCommand {
	type: "prompt";
	message: string;
	streamingBehavior?: "steer" | "followUp" | "follow_up";
	id?: string;
}

interface RpcSteerCommand {
	type: "steer";
	message: string;
	id?: string;
}

interface RpcFollowUpCommand {
	type: "follow_up" | "followUp";
	message: string;
	id?: string;
}

interface RpcAbortCommand {
	type: "abort";
	id?: string;
}

type RpcCommand = RpcPromptCommand | RpcSteerCommand | RpcFollowUpCommand | RpcAbortCommand;

type SendMode = "steer" | "follow_up";

interface SocketState {
	server: net.Server | null;
	socketPath: string | null;
	context: ExtensionContext | null;
}

const STATUS_KEY = "session-control";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

function normalizeStreamingBehavior(value: unknown): "steer" | "followUp" | null {
	if (value === "steer") return "steer";
	if (value === "followUp" || value === "follow_up") return "followUp";
	return null;
}

function getSocketPath(sessionId: string): string {
	return path.join(CONTROL_DIR, `${sessionId}${SOCKET_SUFFIX}`);
}

function isSafeSessionId(sessionId: string): boolean {
	return !sessionId.includes("/") && !sessionId.includes("\\") && !sessionId.includes("..") && sessionId.length > 0;
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

function writeResponse(socket: net.Socket, response: RpcResponse): void {
	socket.write(`${JSON.stringify(response)}\n`);
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

function handleCommand(pi: ExtensionAPI, state: SocketState, command: RpcCommand, socket: net.Socket): void {
	const id = "id" in command && typeof command.id === "string" ? command.id : undefined;
	const respond = (success: boolean, commandName: string, data?: unknown, error?: string) => {
		writeResponse(socket, {
			type: "response",
			command: commandName,
			success,
			data,
			error,
			id,
		});
	};

	const ctx = state.context;
	if (!ctx) {
		respond(false, command.type, undefined, "Session not ready");
		return;
	}

	const isIdle = ctx.isIdle();

	if (command.type === "abort") {
		ctx.abort();
		respond(true, "abort");
		return;
	}

	const message = "message" in command ? command.message : undefined;
	if (typeof message !== "string" || message.trim().length === 0) {
		respond(false, command.type, undefined, "Missing message");
		return;
	}

	const send = (deliverAs?: "steer" | "followUp") => {
		if (deliverAs) {
			pi.sendUserMessage(message, { deliverAs });
		} else {
			pi.sendUserMessage(message);
		}
	};

	if (command.type === "prompt") {
		if (!isIdle) {
			const behavior = normalizeStreamingBehavior(command.streamingBehavior);
			if (!behavior) {
				respond(false, "prompt", undefined, "streamingBehavior required while streaming");
				return;
			}
			send(behavior === "followUp" ? "followUp" : "steer");
			respond(true, "prompt");
			return;
		}

		send();
		respond(true, "prompt");
		return;
	}

	if (command.type === "steer") {
		if (isIdle) {
			send();
		} else {
			send("steer");
		}
		respond(true, "steer");
		return;
	}

	if (command.type === "follow_up" || command.type === "followUp") {
		if (isIdle) {
			send();
		} else {
			send("followUp");
		}
		respond(true, "follow_up");
		return;
	}

	respond(false, command.type, undefined, `Unsupported command: ${command.type}`);
}

function createServer(pi: ExtensionAPI, state: SocketState, socketPath: string): net.Server {
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

	server.listen(socketPath);
	return server;
}

async function sendRpcCommand(socketPath: string, command: RpcCommand): Promise<RpcResponse> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");

		const timeout = setTimeout(() => {
			socket.destroy(new Error("timeout"));
		}, 5000);

		let buffer = "";

		const cleanup = () => {
			clearTimeout(timeout);
			socket.removeAllListeners();
		};

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(command)}\n`);
		});

		socket.on("data", (chunk) => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = buffer.slice(0, newlineIndex).trim();
			if (!line) return;
			try {
				const response = JSON.parse(line) as RpcResponse;
				cleanup();
				socket.end();
				resolve(response);
			} catch (error) {
				cleanup();
				socket.destroy();
				reject(error instanceof Error ? error : new Error("Failed to parse response"));
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
		return;
	}

	await stopControlServer(state);
	await removeSocket(socketPath);

	state.context = ctx;
	state.socketPath = socketPath;
	state.server = createServer(pi, state, socketPath);
}

async function stopControlServer(state: SocketState): Promise<void> {
	if (!state.server) {
		await removeSocket(state.socketPath);
		state.socketPath = null;
		return;
	}

	const socketPath = state.socketPath;
	state.socketPath = null;
	await new Promise<void>((resolve) => state.server?.close(() => resolve()));
	state.server = null;
	await removeSocket(socketPath);
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

export default function (pi: ExtensionAPI) {
	pi.registerFlag(CONTROL_FLAG, {
		description: "Enable per-session control socket under ~/.pi/session-control",
		type: "boolean",
	});

	const state: SocketState = { server: null, socketPath: null, context: null };

	const refreshServer = async (ctx: ExtensionContext) => {
		const enabled = pi.getFlag(CONTROL_FLAG) === true;
		if (!enabled) {
			await stopControlServer(state);
			updateStatus(ctx, false);
			updateSessionEnv(ctx, false);
			return;
		}
		await startControlServer(pi, state, ctx);
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
		updateStatus(state.context, false);
		updateSessionEnv(state.context, false);
		await stopControlServer(state);
	});

	pi.registerTool({
		name: "send_to_session",
		label: "Send To Session",
		description: `Send a prompt to another running pi session via its control socket.
steer sends into the current task if running (acts like a normal prompt when idle). follow_up delivers only after the current task finishes.
Messages automatically include a <sender_info> block with the sender's session id. To reply, use that session id as the target.`,
		parameters: Type.Object({
			sessionId: Type.String({ description: "Target session id (UUID)" }),
			message: Type.String({ description: "Message to send" }),
			mode: Type.Optional(
				StringEnum(["steer", "follow_up"] as const, {
					description: "Delivery mode: steer (immediate) or follow_up (after task)",
					default: "steer",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const mode = (params.mode ?? "steer") as SendMode;
			if (!isSafeSessionId(params.sessionId)) {
				return {
					content: [{ type: "text", text: "Invalid session id" }],
					isError: true,
					details: { error: "Invalid session id" },
				};
			}

			const senderSessionId = state.context?.sessionManager.getSessionId();
			const senderInfo = senderSessionId
				? `\n\n<sender_info>This message was sent by session ${senderSessionId}</sender_info>`
				: "";

			const socketPath = getSocketPath(params.sessionId);
			const command: RpcCommand = {
				type: mode === "follow_up" ? "follow_up" : "steer",
				message: params.message + senderInfo,
			};

			try {
				const response = await sendRpcCommand(socketPath, command);
				if (!response.success) {
					return {
						content: [
							{
								type: "text",
								text: `Failed to send message: ${response.error ?? "unknown error"}`,
							},
						],
						isError: true,
						details: { response },
					};
				}

				return {
					content: [{ type: "text", text: `Message sent to session ${params.sessionId}` }],
					details: { response },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Failed to send message: ${message}` }],
					isError: true,
					details: { error: message },
				};
			}
		},
	});
}
