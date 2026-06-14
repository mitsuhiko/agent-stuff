import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function getDraftDir(): string {
	return path.join(os.tmpdir(), "pi-split-editor");
}

async function openSplitEditor(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	if (process.platform !== "darwin") {
		ctx.ui.notify("/split-editor currently requires macOS + Ghostty AppleScript.", "warning");
		return;
	}

	const nvimCheck = await pi.exec("sh", ["-lc", "command -v nvim"], { timeout: 5_000 });
	if (nvimCheck.code !== 0) {
		ctx.ui.notify("nvim was not found on PATH.", "error");
		return;
	}

	const draftDir = getDraftDir();
	await fs.mkdir(draftDir, { recursive: true });

	const id = randomUUID();
	const draftPath = path.join(draftDir, `${id}.md`);
	const donePath = path.join(draftDir, `${id}.done`);

	const editorText = ctx.ui.getEditorText?.() ?? "";
	const initialText = args.trim().length > 0 ? args.trim() + "\n" : editorText;
	await fs.writeFile(draftPath, initialText, "utf8");

	const startupInput = [
		`nvim ${shellQuote(draftPath)}`,
		`printf done > ${shellQuote(donePath)}`,
		`exit`,
	].join("; ") + "\n";

	const result = await pi.exec("osascript", ["-e", GHOSTTY_SPLIT_SCRIPT, "--", ctx.cwd, startupInput]);
	if (result.code !== 0) {
		const reason = result.stderr?.trim() || result.stdout?.trim() || "unknown osascript error";
		ctx.ui.notify(`Failed to launch Ghostty split: ${reason}`, "error");
		ctx.ui.notify(`Draft file: ${draftPath}`, "info");
		return;
	}

	ctx.ui.notify("Opened nvim in a right-hand Ghostty split. Save and quit (:wq) to load the draft into pi.", "info");

	// Wait for the split shell to mark completion after nvim exits.
	while (!(await exists(donePath))) {
		await sleep(500);
	}

	const finalText = await fs.readFile(draftPath, "utf8");
	ctx.ui.setEditorText(finalText.replace(/\s+$/, ""));
	ctx.ui.notify("Loaded split-editor draft into pi prompt. Press Enter to send, or edit more first.", "info");
}

export default function splitEditorExtension(pi: ExtensionAPI): void {
	pi.registerCommand("split-editor", {
		description: "Open a right-hand Ghostty split running nvim for drafting a prompt, then load it back into pi after :wq.",
		handler: async (args, ctx) => {
			await openSplitEditor(pi, args, ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+g", {
		description: "Open nvim prompt draft in a right-hand Ghostty split",
		handler: async (ctx) => {
			await openSplitEditor(pi, "", ctx);
		},
	});
}
