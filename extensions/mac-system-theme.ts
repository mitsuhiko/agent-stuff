/**
 * Syncs pi theme with macOS system appearance (dark/light mode).
 *
 * This extension is self-contained: it polls macOS directly and calls
 * ctx.ui.setTheme() when the system appearance changes. It does not depend on
 * Hammerspoon or an external signal file.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const POLL_MS = 2000;
const DARK_THEME = "nightowl";
const LIGHT_THEME = "modern-light";
const BUILTIN_DARK_THEME = "dark";
const BUILTIN_LIGHT_THEME = "light";

type Appearance = "dark" | "light";

async function getMacAppearance(): Promise<Appearance> {
	try {
		const { stdout } = await execFileAsync("osascript", [
			"-e",
			'tell application "System Events" to tell appearance preferences to return dark mode',
		]);
		return stdout.trim() === "true" ? "dark" : "light";
	} catch {
		return "light";
	}
}

function preferredThemeForAppearance(appearance: Appearance): string {
	return appearance === "dark" ? DARK_THEME : LIGHT_THEME;
}

function fallbackThemeForAppearance(appearance: Appearance): string {
	return appearance === "dark" ? BUILTIN_DARK_THEME : BUILTIN_LIGHT_THEME;
}

function availableThemeNames(ctx: ExtensionContext): Set<string> {
	return new Set(ctx.ui.getAllThemes().map((theme) => theme.name));
}

function applyTheme(ctx: ExtensionContext, themeName: string): boolean {
	const result = ctx.ui.setTheme(themeName);
	if (!result.success) {
		ctx.ui.notify(`Failed to switch Pi theme to ${themeName}: ${result.error}`, "error");
		return false;
	}
	return true;
}

async function syncTheme(ctx: ExtensionContext, currentTheme: string | undefined): Promise<string | undefined> {
	const appearance = await getMacAppearance();
	const preferredTheme = preferredThemeForAppearance(appearance);
	const fallbackTheme = fallbackThemeForAppearance(appearance);
	const themes = availableThemeNames(ctx);
	const targetTheme = themes.has(preferredTheme) ? preferredTheme : fallbackTheme;

	if (targetTheme === currentTheme) return currentTheme;

	if (applyTheme(ctx, targetTheme)) return targetTheme;

	if (targetTheme !== fallbackTheme && applyTheme(ctx, fallbackTheme)) return fallbackTheme;

	return currentTheme;
}

export default function (pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | undefined;
	let currentTheme: string | undefined;
	let syncInFlight = false;

	async function sync(ctx: ExtensionContext) {
		if (syncInFlight) return;
		syncInFlight = true;
		try {
			currentTheme = await syncTheme(ctx, currentTheme);
		} finally {
			syncInFlight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await sync(ctx);

		intervalId = setInterval(() => {
			void sync(ctx);
		}, POLL_MS);
		intervalId.unref?.();
	});

	pi.on("session_shutdown", () => {
		if (intervalId) clearInterval(intervalId);
		intervalId = undefined;
	});

	pi.registerCommand("theme-sync-status", {
		description: "Show macOS appearance and Pi theme-sync state",
		handler: async (_args, ctx) => {
			const appearance = await getMacAppearance();
			const preferredTheme = preferredThemeForAppearance(appearance);
			const fallbackTheme = fallbackThemeForAppearance(appearance);
			const themes = [...availableThemeNames(ctx)].sort();
			const targetTheme = themes.includes(preferredTheme) ? preferredTheme : fallbackTheme;

			ctx.ui.notify(
				[
					`macOS appearance: ${appearance}`,
					`preferred Pi theme: ${preferredTheme}`,
					`fallback Pi theme: ${fallbackTheme}`,
					`active sync target: ${targetTheme}`,
					`last applied by extension: ${currentTheme ?? "unknown"}`,
					`available themes: ${themes.join(", ")}`,
				].join("\n"),
				"info",
			);
		},
	});
}
