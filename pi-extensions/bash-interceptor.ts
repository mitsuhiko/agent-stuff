/**
 * Bash Interceptor Extension
 *
 * Intercepts bash tool execution to prepend interceptor directories to PATH.
 * Supports both project-level (.pi/interceptors) and global (~/.pi/interceptors).
 * Project-level interceptors take priority over global ones.
 *
 * This enables command interception for tools like python (redirecting to uv run python)
 * and pip (failing with a helpful "use uv" message).
 *
 * Usage:
 *   1. Place wrapper scripts in .pi/interceptors/ (project) or ~/.pi/interceptors/ (global)
 *   2. Load this extension with: pi -e ./bash-interceptor.ts
 *
 * Example interceptor scripts:
 *   .pi/interceptors/python    -> #!/bin/bash\nexec uv run python "$@"
 *   ~/.pi/interceptors/pip     -> #!/bin/bash\necho "Error: Use 'uv pip' instead of pip" >&2; exit 1
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
} from "@mariozechner/pi-coding-agent";

const GLOBAL_INTERCEPTORS_DIR = path.join(os.homedir(), ".pi", "interceptors");

function getProjectInterceptorsDir(cwd: string): string {
	return path.join(cwd, ".pi", "interceptors");
}

function ensureInterceptorsDirs(cwd: string): void {
	const projectDir = getProjectInterceptorsDir(cwd);
	if (!fs.existsSync(projectDir)) {
		fs.mkdirSync(projectDir, { recursive: true });
	}
	if (!fs.existsSync(GLOBAL_INTERCEPTORS_DIR)) {
		fs.mkdirSync(GLOBAL_INTERCEPTORS_DIR, { recursive: true });
	}
}

function getModifiedPath(cwd: string): string {
	const currentPath = process.env.PATH || "";
	const projectDir = getProjectInterceptorsDir(cwd);
	// Project-level takes priority over global
	return `${projectDir}:${GLOBAL_INTERCEPTORS_DIR}:${currentPath}`;
}

function getInterceptorFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir).filter((f) => {
		const filePath = path.join(dir, f);
		try {
			const stat = fs.statSync(filePath);
			return stat.isFile();
		} catch {
			return false;
		}
	});
}

function getAllInterceptorFiles(cwd: string): { project: string[]; global: string[] } {
	return {
		project: getInterceptorFiles(getProjectInterceptorsDir(cwd)),
		global: getInterceptorFiles(GLOBAL_INTERCEPTORS_DIR),
	};
}

function createInterceptedBashOps(localCwd: string): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const modifiedEnv = {
					...process.env,
					PATH: getModifiedPath(localCwd),
				};

				const child = spawn("bash", ["-c", command], {
					cwd,
					env: modifiedEnv,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;

				child.stdout.on("data", onData);
				child.stderr.on("data", onData);

				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});

				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

export default function bashInterceptor(pi: ExtensionAPI) {
	const localCwd = process.cwd();

	// Ensure interceptors directories exist
	ensureInterceptorsDirs(localCwd);

	// Create the intercepted bash tool
	const interceptedBashTool = createBashTool(localCwd, {
		operations: createInterceptedBashOps(localCwd),
	});

	// Register the tool (this overrides the default bash tool)
	pi.registerTool(interceptedBashTool);

	// Handle user !/!! commands with intercepted PATH
	pi.on("user_bash", (_event) => {
		return { operations: createInterceptedBashOps(localCwd) };
	});

	// Show status on session start
	pi.on("session_start", async (_event, ctx) => {
		const { project, global } = getAllInterceptorFiles(localCwd);
		const allFiles = [...new Set([...project, ...global])];

		if (allFiles.length > 0) {
			ctx.ui.setStatus(
				"interceptor",
				ctx.ui.theme.fg("accent", `PATH interceptors: ${allFiles.join(", ")}`)
			);
		}

		const projectDir = getProjectInterceptorsDir(localCwd);
		ctx.ui.notify(
			`Bash interceptor active. Dirs: ${projectDir}, ${GLOBAL_INTERCEPTORS_DIR}`,
			"info"
		);
	});

	// Modify system prompt to inform the agent about intercepted commands
	pi.on("before_agent_start", async (event) => {
		const { project, global } = getAllInterceptorFiles(localCwd);
		const allFiles = [...new Set([...project, ...global])];

		if (allFiles.length === 0) {
			return;
		}

		const interceptorInfo = `\n\nNote: The following commands are intercepted via PATH override: ${allFiles.join(", ")}. These may behave differently than their standard counterparts.`;

		return {
			systemPrompt: event.systemPrompt + interceptorInfo,
		};
	});
}
