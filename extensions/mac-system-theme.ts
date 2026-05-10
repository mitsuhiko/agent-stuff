/**
 * Syncs pi theme with macOS system appearance (dark/light mode).
 *
 * Watches ~/.pi/agent/theme-signal for changes. Hammerspoon writes
 * "dark" or "light" to this file when toggling system appearance,
 * and all pi sessions pick it up instantly via fs.watch().
 *
 * Also sets the correct theme on session start based on current system appearance.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, watchFile, unwatchFile, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execAsync = promisify(exec);
const SIGNAL_FILE = join(homedir(), ".pi", "agent", "theme-signal");

async function isDarkMode(): Promise<boolean> {
	try {
		const { stdout } = await execAsync(
			"osascript -e 'tell application \"System Events\" to tell appearance preferences to return dark mode'",
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

function readSignalFile(): string | null {
	try {
		return readFileSync(SIGNAL_FILE, "utf-8").trim();
	} catch {
		return null;
	}
}

function ensureSignalFile(theme: string): void {
	const dir = join(homedir(), ".pi", "agent");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(SIGNAL_FILE, theme);
}

export default function (pi: ExtensionAPI) {
	let currentTheme: string;

	pi.on("session_start", async (_event, ctx) => {
		// Determine initial theme from signal file or system appearance
		const signaled = readSignalFile();
		if (signaled === "dark" || signaled === "light") {
			currentTheme = signaled;
		} else {
			currentTheme = (await isDarkMode()) ? "dark" : "light";
			ensureSignalFile(currentTheme);
		}
		ctx.ui.setTheme(currentTheme);

		// Watch the signal file for changes from Hammerspoon
		watchFile(SIGNAL_FILE, { interval: 500 }, () => {
			const newTheme = readSignalFile();
			if (newTheme && newTheme !== currentTheme && (newTheme === "dark" || newTheme === "light")) {
				currentTheme = newTheme;
				ctx.ui.setTheme(currentTheme);
			}
		});
	});

	pi.on("session_shutdown", () => {
		unwatchFile(SIGNAL_FILE);
	});
}
