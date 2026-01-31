/**
 * Files Extension
 *
 * /files command lists files in the current git tree (plus session-referenced files)
 * and offers quick actions like reveal, open, edit, or diff.
 * /diff is kept as an alias to the same picker.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getEditorKeybindings,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";

type ContentBlock = {
	type?: string;
	text?: string;
	arguments?: Record<string, unknown>;
};

type FileReference = {
	path: string;
	display: string;
	exists: boolean;
	isDirectory: boolean;
};

type FileEntry = {
	canonicalPath: string;
	resolvedPath: string;
	displayPath: string;
	exists: boolean;
	isDirectory: boolean;
	status?: string;
	inRepo: boolean;
	isTracked: boolean;
	isReferenced: boolean;
	hasSessionChange: boolean;
	lastTimestamp: number;
};

type GitStatusEntry = {
	status: string;
	exists: boolean;
	isDirectory: boolean;
};

type FileToolName = "write" | "edit";

type SessionFileChange = {
	operations: Set<FileToolName>;
	lastTimestamp: number;
};

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

const MAX_EDIT_BYTES = 40 * 1024 * 1024;

const extractFileReferencesFromText = (text: string): string[] => {
	const refs: string[] = [];

	for (const match of text.matchAll(FILE_TAG_REGEX)) {
		refs.push(match[1]);
	}

	for (const match of text.matchAll(FILE_URL_REGEX)) {
		refs.push(match[0]);
	}

	for (const match of text.matchAll(PATH_REGEX)) {
		refs.push(match[1]);
	}

	return refs;
};

const extractPathsFromToolArgs = (args: unknown): string[] => {
	if (!args || typeof args !== "object") {
		return [];
	}

	const refs: string[] = [];
	const record = args as Record<string, unknown>;
	const directKeys = ["path", "file", "filePath", "filepath", "fileName", "filename"] as const;
	const listKeys = ["paths", "files", "filePaths"] as const;

	for (const key of directKeys) {
		const value = record[key];
		if (typeof value === "string") {
			refs.push(value);
		}
	}

	for (const key of listKeys) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") {
					refs.push(item);
				}
			}
		}
	}

	return refs;
};

const extractFileReferencesFromContent = (content: unknown): string[] => {
	if (typeof content === "string") {
		return extractFileReferencesFromText(content);
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const refs: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;

		if (block.type === "text" && typeof block.text === "string") {
			refs.push(...extractFileReferencesFromText(block.text));
		}

		if (block.type === "toolCall") {
			refs.push(...extractPathsFromToolArgs(block.arguments));
		}
	}

	return refs;
};

const extractFileReferencesFromEntry = (entry: SessionEntry): string[] => {
	if (entry.type === "message") {
		return extractFileReferencesFromContent(entry.message.content);
	}

	if (entry.type === "custom_message") {
		return extractFileReferencesFromContent(entry.content);
	}

	return [];
};

const sanitizeReference = (raw: string): string => {
	let value = raw.trim();
	value = value.replace(/^["'`(<\[]+/, "");
	value = value.replace(/[>"'`,;).\]]+$/, "");
	value = value.replace(/[.,;:]+$/, "");
	return value;
};

const isCommentLikeReference = (value: string): boolean => value.startsWith("//");

const stripLineSuffix = (value: string): string => {
	let result = value.replace(/#L\d+(C\d+)?$/i, "");
	const lastSeparator = Math.max(result.lastIndexOf("/"), result.lastIndexOf("\\"));
	const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
	const segment = result.slice(segmentStart);
	const colonIndex = segment.indexOf(":");
	if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
		result = result.slice(0, segmentStart + colonIndex);
		return result;
	}

	const lastColon = result.lastIndexOf(":");
	if (lastColon > lastSeparator) {
		const suffix = result.slice(lastColon + 1);
		if (/^\d+(?::\d+)?$/.test(suffix)) {
			result = result.slice(0, lastColon);
		}
	}
	return result;
};

const normalizeReferencePath = (raw: string, cwd: string): string | null => {
	let candidate = sanitizeReference(raw);
	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return null;
		}
	}

	candidate = stripLineSuffix(candidate);
	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("~")) {
		candidate = path.join(os.homedir(), candidate.slice(1));
	}

	if (!path.isAbsolute(candidate)) {
		candidate = path.resolve(cwd, candidate);
	}

	candidate = path.normalize(candidate);
	const root = path.parse(candidate).root;
	if (candidate.length > root.length) {
		candidate = candidate.replace(/[\\/]+$/, "");
	}

	return candidate;
};

const formatDisplayPath = (absolutePath: string, cwd: string): string => {
	const normalizedCwd = path.resolve(cwd);
	if (absolutePath.startsWith(normalizedCwd + path.sep)) {
		return path.relative(normalizedCwd, absolutePath);
	}

	return absolutePath;
};

const collectRecentFileReferences = (entries: SessionEntry[], cwd: string, limit: number): FileReference[] => {
	const results: FileReference[] = [];
	const seen = new Set<string>();

	for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
		const refs = extractFileReferencesFromEntry(entries[i]);
		for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
			const normalized = normalizeReferencePath(refs[j], cwd);
			if (!normalized || seen.has(normalized)) {
				continue;
			}

			seen.add(normalized);

			let exists = false;
			let isDirectory = false;
			if (existsSync(normalized)) {
				exists = true;
				const stats = statSync(normalized);
				isDirectory = stats.isDirectory();
			}

			results.push({
				path: normalized,
				display: formatDisplayPath(normalized, cwd),
				exists,
				isDirectory,
			});
		}
	}

	return results;
};

const findLatestFileReference = (entries: SessionEntry[], cwd: string): FileReference | null => {
	const refs = collectRecentFileReferences(entries, cwd, 100);
	return refs.find((ref) => ref.exists) ?? null;
};

const toCanonicalPath = (inputPath: string): { canonicalPath: string; isDirectory: boolean } | null => {
	if (!existsSync(inputPath)) {
		return null;
	}

	try {
		const canonicalPath = realpathSync(inputPath);
		const stats = statSync(canonicalPath);
		return { canonicalPath, isDirectory: stats.isDirectory() };
	} catch {
		return null;
	}
};

const toCanonicalPathMaybeMissing = (
	inputPath: string,
): { canonicalPath: string; isDirectory: boolean; exists: boolean } | null => {
	const resolvedPath = path.resolve(inputPath);
	if (!existsSync(resolvedPath)) {
		return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: false };
	}

	try {
		const canonicalPath = realpathSync(resolvedPath);
		const stats = statSync(canonicalPath);
		return { canonicalPath, isDirectory: stats.isDirectory(), exists: true };
	} catch {
		return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: true };
	}
};

const collectSessionFileChanges = (entries: SessionEntry[], cwd: string): Map<string, SessionFileChange> => {
	const toolCalls = new Map<string, { path: string; name: FileToolName }>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const name = block.name as FileToolName;
					if (name === "write" || name === "edit") {
						const filePath = block.arguments?.path;
						if (filePath && typeof filePath === "string") {
							toolCalls.set(block.id, { path: filePath, name });
						}
					}
				}
			}
		}
	}

	const fileMap = new Map<string, SessionFileChange>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "toolResult") {
			const toolCall = toolCalls.get(msg.toolCallId);
			if (!toolCall) continue;

			const resolvedPath = path.isAbsolute(toolCall.path)
				? toolCall.path
				: path.resolve(cwd, toolCall.path);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) {
				continue;
			}

			const existing = fileMap.get(canonical.canonicalPath);
			if (existing) {
				existing.operations.add(toolCall.name);
				if (msg.timestamp > existing.lastTimestamp) {
					existing.lastTimestamp = msg.timestamp;
				}
			} else {
				fileMap.set(canonical.canonicalPath, {
					operations: new Set([toolCall.name]),
					lastTimestamp: msg.timestamp,
				});
			}
		}
	}

	return fileMap;
};

const splitNullSeparated = (value: string): string[] => value.split("\0").filter(Boolean);

const getGitRoot = async (pi: ExtensionAPI, cwd: string): Promise<string | null> => {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) {
		return null;
	}

	const root = result.stdout.trim();
	return root ? root : null;
};

const getGitStatusMap = async (pi: ExtensionAPI, cwd: string): Promise<Map<string, GitStatusEntry>> => {
	const statusMap = new Map<string, GitStatusEntry>();
	const statusResult = await pi.exec("git", ["status", "--porcelain=1", "-z"], { cwd });
	if (statusResult.code !== 0 || !statusResult.stdout) {
		return statusMap;
	}

	const entries = splitNullSeparated(statusResult.stdout);
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry || entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const statusLabel = status.replace(/\s/g, "") || status.trim();
		let filePath = entry.slice(3);
		if ((status.startsWith("R") || status.startsWith("C")) && entries[i + 1]) {
			filePath = entries[i + 1];
			i += 1;
		}
		if (!filePath) continue;

		const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
		const canonical = toCanonicalPathMaybeMissing(resolved);
		if (!canonical) continue;
		statusMap.set(canonical.canonicalPath, {
			status: statusLabel,
			exists: canonical.exists,
			isDirectory: canonical.isDirectory,
		});
	}

	return statusMap;
};

const getGitFiles = async (
	pi: ExtensionAPI,
	gitRoot: string,
): Promise<{ tracked: Set<string>; files: Array<{ canonicalPath: string; isDirectory: boolean }> }> => {
	const tracked = new Set<string>();
	const files: Array<{ canonicalPath: string; isDirectory: boolean }> = [];

	const trackedResult = await pi.exec("git", ["ls-files", "-z"], { cwd: gitRoot });
	if (trackedResult.code === 0 && trackedResult.stdout) {
		for (const relativePath of splitNullSeparated(trackedResult.stdout)) {
			const resolvedPath = path.resolve(gitRoot, relativePath);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) continue;
			tracked.add(canonical.canonicalPath);
			files.push(canonical);
		}
	}

	const untrackedResult = await pi.exec("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: gitRoot });
	if (untrackedResult.code === 0 && untrackedResult.stdout) {
		for (const relativePath of splitNullSeparated(untrackedResult.stdout)) {
			const resolvedPath = path.resolve(gitRoot, relativePath);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) continue;
			files.push(canonical);
		}
	}

	return { tracked, files };
};

const buildFileEntries = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<{ files: FileEntry[]; gitRoot: string | null }> => {
	const entries = ctx.sessionManager.getBranch();
	const sessionChanges = collectSessionFileChanges(entries, ctx.cwd);
	const gitRoot = await getGitRoot(pi, ctx.cwd);
	const statusMap = gitRoot ? await getGitStatusMap(pi, gitRoot) : new Map<string, GitStatusEntry>();

	let trackedSet = new Set<string>();
	let gitFiles: Array<{ canonicalPath: string; isDirectory: boolean }> = [];
	if (gitRoot) {
		const gitListing = await getGitFiles(pi, gitRoot);
		trackedSet = gitListing.tracked;
		gitFiles = gitListing.files;
	}

	const fileMap = new Map<string, FileEntry>();

	const upsertFile = (data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean }) => {
		const existing = fileMap.get(data.canonicalPath);
		const displayPath = data.displayPath ?? formatDisplayPath(data.canonicalPath, ctx.cwd);

		if (existing) {
			fileMap.set(data.canonicalPath, {
				...existing,
				...data,
				displayPath,
				exists: data.exists ?? existing.exists,
				isDirectory: data.isDirectory ?? existing.isDirectory,
				isReferenced: existing.isReferenced || data.isReferenced === true,
				inRepo: existing.inRepo || data.inRepo === true,
				isTracked: existing.isTracked || data.isTracked === true,
				hasSessionChange: existing.hasSessionChange || data.hasSessionChange === true,
				lastTimestamp: Math.max(existing.lastTimestamp, data.lastTimestamp ?? 0),
			});
			return;
		}

		fileMap.set(data.canonicalPath, {
			canonicalPath: data.canonicalPath,
			resolvedPath: data.resolvedPath ?? data.canonicalPath,
			displayPath,
			exists: data.exists ?? true,
			isDirectory: data.isDirectory,
			status: data.status,
			inRepo: data.inRepo ?? false,
			isTracked: data.isTracked ?? false,
			isReferenced: data.isReferenced ?? false,
			hasSessionChange: data.hasSessionChange ?? false,
			lastTimestamp: data.lastTimestamp ?? 0,
		});
	};

	for (const file of gitFiles) {
		upsertFile({
			canonicalPath: file.canonicalPath,
			resolvedPath: file.canonicalPath,
			isDirectory: file.isDirectory,
			exists: true,
			status: statusMap.get(file.canonicalPath)?.status,
			inRepo: true,
			isTracked: trackedSet.has(file.canonicalPath),
		});
	}

	for (const [canonicalPath, statusEntry] of statusMap.entries()) {
		if (fileMap.has(canonicalPath)) {
			continue;
		}

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonicalPath));

		upsertFile({
			canonicalPath,
			resolvedPath: canonicalPath,
			isDirectory: statusEntry.isDirectory,
			exists: statusEntry.exists,
			status: statusEntry.status,
			inRepo,
			isTracked: trackedSet.has(canonicalPath) || statusEntry.status !== "??",
		});
	}

	const references = collectRecentFileReferences(entries, ctx.cwd, 200).filter((ref) => ref.exists);
	for (const ref of references) {
		const canonical = toCanonicalPath(ref.path);
		if (!canonical) continue;

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonical.canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));

		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			status: statusMap.get(canonical.canonicalPath)?.status,
			inRepo,
			isTracked: trackedSet.has(canonical.canonicalPath),
			isReferenced: true,
		});
	}

	for (const [canonicalPath, change] of sessionChanges.entries()) {
		const canonical = toCanonicalPath(canonicalPath);
		if (!canonical) continue;

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonical.canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));

		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			status: statusMap.get(canonical.canonicalPath)?.status,
			inRepo,
			isTracked: trackedSet.has(canonical.canonicalPath),
			hasSessionChange: true,
			lastTimestamp: change.lastTimestamp,
		});
	}

	const files = Array.from(fileMap.values()).sort((a, b) => {
		const aDirty = Boolean(a.status);
		const bDirty = Boolean(b.status);
		if (aDirty !== bDirty) {
			return aDirty ? -1 : 1;
		}
		if (a.inRepo !== b.inRepo) {
			return a.inRepo ? -1 : 1;
		}
		if (a.hasSessionChange !== b.hasSessionChange) {
			return a.hasSessionChange ? -1 : 1;
		}
		if (a.lastTimestamp !== b.lastTimestamp) {
			return b.lastTimestamp - a.lastTimestamp;
		}
		if (a.isReferenced !== b.isReferenced) {
			return a.isReferenced ? -1 : 1;
		}
		return a.displayPath.localeCompare(b.displayPath);
	});

	return { files, gitRoot };
};

type EditCheckResult = {
	allowed: boolean;
	reason?: string;
	content?: string;
};

const getEditableContent = (target: FileEntry): EditCheckResult => {
	if (!existsSync(target.resolvedPath)) {
		return { allowed: false, reason: "File not found" };
	}

	const stats = statSync(target.resolvedPath);
	if (stats.isDirectory()) {
		return { allowed: false, reason: "Directories cannot be edited" };
	}

	if (stats.size >= MAX_EDIT_BYTES) {
		return { allowed: false, reason: "File is too large" };
	}

	const buffer = readFileSync(target.resolvedPath);
	if (buffer.includes(0)) {
		return { allowed: false, reason: "File contains null bytes" };
	}

	return { allowed: true, content: buffer.toString("utf8") };
};

const showActionSelector = async (
	ctx: ExtensionContext,
	options: { canQuickLook: boolean; canEdit: boolean; canDiff: boolean },
): Promise<"reveal" | "quicklook" | "open" | "edit" | "addToPrompt" | "diff" | null> => {
	const actions: SelectItem[] = [
		...(options.canDiff ? [{ value: "diff", label: "Diff in VS Code" }] : []),
		{ value: "reveal", label: "Reveal in Finder" },
		{ value: "open", label: "Open" },
		{ value: "addToPrompt", label: "Add to prompt" },
		...(options.canQuickLook ? [{ value: "quicklook", label: "Open in Quick Look" }] : []),
		...(options.canEdit ? [{ value: "edit", label: "Edit" }] : []),
	];

	return ctx.ui.custom<"reveal" | "quicklook" | "open" | "edit" | "addToPrompt" | "diff" | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Choose action"))));

		const selectList = new SelectList(actions, actions.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(item.value as "reveal" | "quicklook" | "open" | "edit" | "addToPrompt" | "diff");
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

const openPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const command = process.platform === "darwin" ? "open" : "xdg-open";
	const result = await pi.exec(command, [target.resolvedPath]);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to open ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const openExternalEditor = (tui: TUI, editorCmd: string, content: string): string | null => {
	const tmpFile = path.join(os.tmpdir(), `pi-files-edit-${Date.now()}.txt`);

	try {
		writeFileSync(tmpFile, content, "utf8");
		tui.stop();

		const [editor, ...editorArgs] = editorCmd.split(" ");
		const result = spawnSync(editor, [...editorArgs, tmpFile], { stdio: "inherit" });

		if (result.status === 0) {
			return readFileSync(tmpFile, "utf8").replace(/\n$/, "");
		}

		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
		}
		tui.start();
		tui.requestRender(true);
	}
};

const editPath = async (ctx: ExtensionContext, target: FileEntry, content: string): Promise<void> => {
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd) {
		ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
		return;
	}

	const updated = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const status = new Text(theme.fg("dim", `Opening ${editorCmd}...`));

		queueMicrotask(() => {
			const result = openExternalEditor(tui, editorCmd, content);
			done(result);
		});

		return status;
	});

	if (updated === null) {
		ctx.ui.notify("Edit cancelled", "info");
		return;
	}

	try {
		writeFileSync(target.resolvedPath, updated, "utf8");
	} catch {
		ctx.ui.notify(`Failed to save ${target.displayPath}`, "error");
	}
};

const revealPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.resolvedPath).isDirectory();
	let command = "open";
	let args: string[] = [];

	if (process.platform === "darwin") {
		args = isDirectory ? [target.resolvedPath] : ["-R", target.resolvedPath];
	} else {
		command = "xdg-open";
		args = [isDirectory ? target.resolvedPath : path.dirname(target.resolvedPath)];
	}

	const result = await pi.exec(command, args);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to reveal ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const quickLookPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry): Promise<void> => {
	if (process.platform !== "darwin") {
		ctx.ui.notify("Quick Look is only available on macOS", "warning");
		return;
	}

	if (!existsSync(target.resolvedPath)) {
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.resolvedPath).isDirectory();
	if (isDirectory) {
		ctx.ui.notify("Quick Look only works on files", "warning");
		return;
	}

	const result = await pi.exec("qlmanage", ["-p", target.resolvedPath]);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to Quick Look ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const openDiff = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry, gitRoot: string | null): Promise<void> => {
	if (!gitRoot) {
		ctx.ui.notify("Git repository not found", "warning");
		return;
	}

	const relativePath = path.relative(gitRoot, target.resolvedPath).split(path.sep).join("/");
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-files-"));
	const tmpFile = path.join(tmpDir, path.basename(target.displayPath));

	const existsInHead = await pi.exec("git", ["cat-file", "-e", `HEAD:${relativePath}`], { cwd: gitRoot });
	if (existsInHead.code === 0) {
		const result = await pi.exec("git", ["show", `HEAD:${relativePath}`], { cwd: gitRoot });
		if (result.code !== 0) {
			const errorMessage = result.stderr?.trim() || `Failed to diff ${target.displayPath}`;
			ctx.ui.notify(errorMessage, "error");
			return;
		}
		writeFileSync(tmpFile, result.stdout ?? "", "utf8");
	} else {
		writeFileSync(tmpFile, "", "utf8");
	}

	let workingPath = target.resolvedPath;
	if (!existsSync(target.resolvedPath)) {
		workingPath = path.join(tmpDir, `pi-files-working-${path.basename(target.displayPath)}`);
		writeFileSync(workingPath, "", "utf8");
	}

	const openResult = await pi.exec("code", ["--diff", tmpFile, workingPath], { cwd: gitRoot });
	if (openResult.code !== 0) {
		const errorMessage = openResult.stderr?.trim() || `Failed to open diff for ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const addFileToPrompt = (ctx: ExtensionContext, target: FileEntry): void => {
	const mentionTarget = target.displayPath || target.resolvedPath;
	const mention = `@${mentionTarget}`;
	const current = ctx.ui.getEditorText();
	const separator = current && !current.endsWith(" ") ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}${mention}`);
	ctx.ui.notify(`Added ${mention} to prompt`, "info");
};

const showFileSelector = async (
	ctx: ExtensionContext,
	files: FileEntry[],
	selectedPath?: string | null,
	gitRoot?: string | null,
): Promise<{ selected: FileEntry | null; quickAction: "diff" | null }> => {
	const items: SelectItem[] = files.map((file) => {
		const directoryLabel = file.isDirectory ? " [directory]" : "";
		return {
			value: file.canonicalPath,
			label: `${file.displayPath}${directoryLabel}`,
			description: file.status ? `[${file.status}]` : undefined,
		};
	});

	let quickAction: "diff" | null = null;
	const selection = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(" Select file")), 0, 0));

		const searchInput = new Input();
		container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(
			new Text(theme.fg("dim", "Type to filter • enter to select • ctrl+shift+d diff • esc to cancel"), 0, 0),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		let filteredItems = items;
		let selectList: SelectList | null = null;

		const updateList = () => {
			listContainer.clear();
			if (filteredItems.length === 0) {
				listContainer.addChild(new Text(theme.fg("warning", "  No matching files"), 0, 0));
				selectList = null;
				return;
			}

			selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			if (selectedPath) {
				const index = filteredItems.findIndex((item) => item.value === selectedPath);
				if (index >= 0) {
					selectList.setSelectedIndex(index);
				}
			}

			selectList.onSelect = (item) => done(item.value as string);
			selectList.onCancel = () => done(null);

			listContainer.addChild(selectList);
		};

		const applyFilter = () => {
			const query = searchInput.getValue();
			filteredItems = query
				? fuzzyFilter(items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`)
				: items;
			updateList();
		};

		applyFilter();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "ctrl+shift+d")) {
					const selected = selectList?.getSelectedItem();
					if (selected) {
						const file = files.find((entry) => entry.canonicalPath === selected.value);
						const canDiff = file?.isTracked && !file.isDirectory && Boolean(gitRoot);
						if (!canDiff) {
							ctx.ui.notify("Diff is only available for tracked files", "warning");
							return;
						}
						quickAction = "diff";
						done(selected.value as string);
						return;
					}
				}

				const kb = getEditorKeybindings();
				if (
					kb.matches(data, "selectUp") ||
					kb.matches(data, "selectDown") ||
					kb.matches(data, "selectConfirm") ||
					kb.matches(data, "selectCancel")
				) {
					if (selectList) {
						selectList.handleInput(data);
					} else if (kb.matches(data, "selectCancel")) {
						done(null);
					}
					tui.requestRender();
					return;
				}

				searchInput.handleInput(data);
				applyFilter();
				tui.requestRender();
			},
		};
	});

	const selected = selection ? files.find((file) => file.canonicalPath === selection) ?? null : null;
	return { selected, quickAction };
};

const runFileBrowser = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (!ctx.hasUI) {
		ctx.ui.notify("Files requires interactive mode", "error");
		return;
	}

	const { files, gitRoot } = await buildFileEntries(pi, ctx);
	if (files.length === 0) {
		ctx.ui.notify("No files found", "info");
		return;
	}

	let lastSelectedPath: string | null = null;
	while (true) {
		const { selected, quickAction } = await showFileSelector(ctx, files, lastSelectedPath, gitRoot);
		if (!selected) {
			ctx.ui.notify("Files cancelled", "info");
			return;
		}

		lastSelectedPath = selected.canonicalPath;

		const canQuickLook = process.platform === "darwin" && !selected.isDirectory;
		const editCheck = getEditableContent(selected);
		const canDiff = selected.isTracked && !selected.isDirectory && Boolean(gitRoot);

		if (quickAction === "diff") {
			await openDiff(pi, ctx, selected, gitRoot);
			continue;
		}

		const action = await showActionSelector(ctx, {
			canQuickLook,
			canEdit: editCheck.allowed,
			canDiff,
		});
		if (!action) {
			continue;
		}

		switch (action) {
			case "quicklook":
				await quickLookPath(pi, ctx, selected);
				break;
			case "open":
				await openPath(pi, ctx, selected);
				break;
			case "edit":
				if (!editCheck.allowed || editCheck.content === undefined) {
					ctx.ui.notify(editCheck.reason ?? "File cannot be edited", "warning");
					break;
				}
				await editPath(ctx, selected, editCheck.content);
				break;
			case "addToPrompt":
				addFileToPrompt(ctx, selected);
				break;
			case "diff":
				await openDiff(pi, ctx, selected, gitRoot);
				break;
			default:
				await revealPath(pi, ctx, selected);
				break;
		}
	}
};

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("files", {
		description: "Browse files with git status and session references",
		handler: async (_args, ctx) => {
			await runFileBrowser(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Browse files mentioned in the session",
		handler: async (ctx) => {
			await runFileBrowser(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+f", {
		description: "Reveal the latest file reference in Finder",
		handler: async (ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				ctx.ui.notify("No file reference found in the session", "warning");
				return;
			}

			const canonical = toCanonicalPath(latest.path);
			if (!canonical) {
				ctx.ui.notify(`File not found: ${latest.display}`, "error");
				return;
			}

			await revealPath(pi, ctx, {
				canonicalPath: canonical.canonicalPath,
				resolvedPath: canonical.canonicalPath,
				displayPath: latest.display,
				exists: true,
				isDirectory: canonical.isDirectory,
				status: undefined,
				inRepo: false,
				isTracked: false,
				isReferenced: true,
				hasSessionChange: false,
				lastTimestamp: 0,
			});
		},
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Quick Look the latest file reference",
		handler: async (ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				ctx.ui.notify("No file reference found in the session", "warning");
				return;
			}

			const canonical = toCanonicalPath(latest.path);
			if (!canonical) {
				ctx.ui.notify(`File not found: ${latest.display}`, "error");
				return;
			}

			await quickLookPath(pi, ctx, {
				canonicalPath: canonical.canonicalPath,
				resolvedPath: canonical.canonicalPath,
				displayPath: latest.display,
				exists: true,
				isDirectory: canonical.isDirectory,
				status: undefined,
				inRepo: false,
				isTracked: false,
				isReferenced: true,
				hasSessionChange: false,
				lastTimestamp: 0,
			});
		},
	});
}
