/**
 * Multi-Edit Extension — replaces the built-in `edit` tool.
 *
 * Supports all original parameters (path, oldText, newText) plus:
 * - `multi`: array of {path, oldText, newText} edits applied in sequence
 * - `patch`: Codex-style apply_patch payload
 *
 * When both top-level params and `multi` are provided, the top-level edit
 * is treated as an implicit first item prepended to the multi list.
 *
 * A preflight pass is performed before mutating files:
 * - multi/top-level mode: preflight via virtualized built-in edit tool
 * - patch mode: preflight by applying patch operations on a virtual filesystem
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, unlink as fsUnlink, writeFile as fsWriteFile } from "fs/promises";
import { isAbsolute, resolve as resolvePath } from "path";

const editItemSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute). Inherits from top-level path if omitted." })),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

const multiEditSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute)" })),
	oldText: Type.Optional(Type.String({ description: "Exact text to find and replace (must match exactly)" })),
	newText: Type.Optional(Type.String({ description: "New text to replace the old text with" })),
	multi: Type.Optional(
		Type.Array(editItemSchema, {
			description: "Multiple edits to apply in sequence. Each item has path, oldText, and newText.",
		}),
	),
	patch: Type.Optional(
		Type.String({
			description:
				"Codex-style apply_patch payload (*** Begin Patch ... *** End Patch). Mutually exclusive with path/oldText/newText/multi.",
		}),
	),
});

interface EditItem {
	path: string;
	oldText: string;
	newText: string;
}

interface EditResult {
	path: string;
	success: boolean;
	message: string;
	diff?: string;
	firstChangedLine?: number;
}

interface UpdateChunk {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

type PatchOperation =
	| { kind: "add"; path: string; contents: string }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; chunks: UpdateChunk[] };

interface PatchOpResult {
	path: string;
	message: string;
	diff?: string;
	firstChangedLine?: number;
}

function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				// Determine how many lines to show at the start and end of this
				// unchanged block.  When the block sits between two changes we
				// show context on both sides but collapse the middle.
				const showAtStart = lastWasChange ? contextLines : 0;
				const showAtEnd = nextPartIsChange ? contextLines : 0;

				if (raw.length <= showAtStart + showAtEnd) {
					// Block is small enough — show it entirely.
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					// Show head context.
					for (let j = 0; j < showAtStart; j++) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${raw[j]}`);
						oldLineNum++;
						newLineNum++;
					}

					// Collapse the middle.
					const skipped = raw.length - showAtStart - showAtEnd;
					if (skipped > 0) {
						output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
						oldLineNum += skipped;
						newLineNum += skipped;
					}

					// Show tail context.
					for (let j = raw.length - showAtEnd; j < raw.length; j++) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${raw[j]}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

interface Workspace {
	readText: (absolutePath: string) => Promise<string>;
	writeText: (absolutePath: string, content: string) => Promise<void>;
	deleteFile: (absolutePath: string) => Promise<void>;
	exists: (absolutePath: string) => Promise<boolean>;
	/** Check that the file is writable. Rejects if not. No-op on virtual workspaces. */
	checkWriteAccess: (absolutePath: string) => Promise<void>;
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function resolvePatchPath(cwd: string, filePath: string): string {
	const trimmed = filePath.trim();
	if (!trimmed) {
		throw new Error("Patch path cannot be empty");
	}
	return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(cwd, trimmed);
}

function ensureTrailingNewline(content: string): string {
	return content.endsWith("\n") ? content : `${content}\n`;
}

function normaliseLineForFuzzyMatch(s: string): string {
	return s
		.trim()
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const searchEnd = lines.length - pattern.length;

	const exactEqual = (a: string, b: string) => a === b;
	const rstripEqual = (a: string, b: string) => a.trimEnd() === b.trimEnd();
	const trimEqual = (a: string, b: string) => a.trim() === b.trim();
	const fuzzyEqual = (a: string, b: string) => normaliseLineForFuzzyMatch(a) === normaliseLineForFuzzyMatch(b);

	const passes = [exactEqual, rstripEqual, trimEqual, fuzzyEqual];

	for (const eq of passes) {
		for (let i = searchStart; i <= searchEnd; i++) {
			let ok = true;
			for (let p = 0; p < pattern.length; p++) {
				if (!eq(lines[i + p], pattern[p])) {
					ok = false;
					break;
				}
			}
			if (ok) return i;
		}
	}

	return undefined;
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
	const next = [...lines];

	for (const [start, oldLen, newSegment] of [...replacements].sort((a, b) => b[0] - a[0])) {
		next.splice(start, oldLen, ...newSegment);
	}

	return next;
}

function deriveUpdatedContent(filePath: string, currentContent: string, chunks: UpdateChunk[]): string {
	const originalLines = currentContent.split("\n");
	if (originalLines[originalLines.length - 1] === "") {
		originalLines.pop();
	}

	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const ctxIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (ctxIndex === undefined) {
				throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
			}
			lineIndex = ctxIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			replacements.push([originalLines.length, 0, [...chunk.newLines]]);
			continue;
		}

		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;

		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (found === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice[newSlice.length - 1] === "") {
				newSlice = newSlice.slice(0, -1);
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (found === undefined) {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		}

		replacements.push([found, pattern.length, [...newSlice]]);
		lineIndex = found + pattern.length;
	}

	const newLines = applyReplacements(originalLines, replacements);
	if (newLines[newLines.length - 1] !== "") {
		newLines.push("");
	}
	return newLines.join("\n");
}

function parseUpdateChunk(
	lines: string[],
	startIndex: number,
	lastContentLine: number,
	allowMissingContext: boolean,
): { chunk: UpdateChunk; nextIndex: number } {
	let i = startIndex;
	let changeContext: string | undefined;
	const first = lines[i].trimEnd();

	if (first === "@@") {
		i++;
	} else if (first.startsWith("@@ ")) {
		changeContext = first.slice(3);
		i++;
	} else if (!allowMissingContext) {
		throw new Error(`Expected update hunk to start with @@ context marker, got: '${lines[i]}'`);
	}

	const oldLines: string[] = [];
	const newLines: string[] = [];
	let parsed = 0;
	let isEndOfFile = false;

	while (i <= lastContentLine) {
		const raw = lines[i];
		const trimmed = raw.trimEnd();

		if (trimmed === "*** End of File") {
			if (parsed === 0) {
				throw new Error("Update hunk does not contain any lines");
			}
			isEndOfFile = true;
			i++;
			break;
		}

		if (parsed > 0 && (trimmed.startsWith("@@") || trimmed.startsWith("*** "))) {
			break;
		}

		if (raw.length === 0) {
			oldLines.push("");
			newLines.push("");
			parsed++;
			i++;
			continue;
		}

		const marker = raw[0];
		const body = raw.slice(1);
		if (marker === " ") {
			oldLines.push(body);
			newLines.push(body);
		} else if (marker === "-") {
			oldLines.push(body);
		} else if (marker === "+") {
			newLines.push(body);
		} else if (parsed === 0) {
			throw new Error(
				`Unexpected line found in update hunk: '${raw}'. Every line should start with ' ', '+', or '-'.`,
			);
		} else {
			break;
		}

		parsed++;
		i++;
	}

	if (parsed === 0) {
		throw new Error("Update hunk does not contain any lines");
	}

	return {
		chunk: { changeContext, oldLines, newLines, isEndOfFile },
		nextIndex: i,
	};
}

function parsePatch(patchText: string): PatchOperation[] {
	const lines = normalizeToLF(patchText).trim().split("\n");
	if (lines.length < 2) {
		throw new Error("Patch is empty or invalid");
	}
	if (lines[0].trim() !== "*** Begin Patch") {
		throw new Error("The first line of the patch must be '*** Begin Patch'");
	}
	if (lines[lines.length - 1].trim() !== "*** End Patch") {
		throw new Error("The last line of the patch must be '*** End Patch'");
	}

	const operations: PatchOperation[] = [];
	let i = 1;
	const lastContentLine = lines.length - 2;

	while (i <= lastContentLine) {
		if (lines[i].trim() === "") {
			i++;
			continue;
		}

		const line = lines[i].trim();
		if (line.startsWith("*** Add File: ")) {
			const path = line.slice("*** Add File: ".length);
			i++;
			const contentLines: string[] = [];
			while (i <= lastContentLine) {
				const next = lines[i];
				if (next.trim().startsWith("*** ")) break;
				if (!next.startsWith("+")) {
					throw new Error(`Invalid add-file line '${next}'. Add file lines must start with '+'`);
				}
				contentLines.push(next.slice(1));
				i++;
			}
			operations.push({ kind: "add", path, contents: contentLines.length > 0 ? `${contentLines.join("\n")}\n` : "" });
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			const path = line.slice("*** Delete File: ".length);
			operations.push({ kind: "delete", path });
			i++;
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const path = line.slice("*** Update File: ".length);
			i++;

			if (i <= lastContentLine && lines[i].trim().startsWith("*** Move to: ")) {
				throw new Error("Patch move operations (*** Move to:) are not supported.");
			}

			const chunks: UpdateChunk[] = [];
			while (i <= lastContentLine) {
				if (lines[i].trim() === "") {
					i++;
					continue;
				}
				if (lines[i].trim().startsWith("*** ")) {
					break;
				}

				const parsed = parseUpdateChunk(lines, i, lastContentLine, chunks.length === 0);
				chunks.push(parsed.chunk);
				i = parsed.nextIndex;
			}

			if (chunks.length === 0) {
				throw new Error(`Update file hunk for path '${path}' is empty`);
			}

			operations.push({ kind: "update", path, chunks });
			continue;
		}

		throw new Error(
			`'${line}' is not a valid hunk header. Valid headers: '*** Add File:', '*** Delete File:', '*** Update File:'`,
		);
	}

	return operations;
}

function createRealWorkspace(): Workspace {
	return {
		readText: (absolutePath: string) => fsReadFile(absolutePath, "utf-8"),
		writeText: (absolutePath: string, content: string) => fsWriteFile(absolutePath, content, "utf-8"),
		deleteFile: (absolutePath: string) => fsUnlink(absolutePath),
		exists: async (absolutePath: string) => {
			try {
				await fsAccess(absolutePath, constants.F_OK);
				return true;
			} catch {
				return false;
			}
		},
		checkWriteAccess: (absolutePath: string) => fsAccess(absolutePath, constants.R_OK | constants.W_OK),
	};
}

function createVirtualWorkspace(cwd: string): Workspace {
	const state = new Map<string, string | null>();

	async function ensureLoaded(absolutePath: string): Promise<void> {
		if (state.has(absolutePath)) return;
		try {
			const content = await fsReadFile(absolutePath, "utf-8");
			state.set(absolutePath, content);
		} catch {
			state.set(absolutePath, null);
		}
	}

	return {
		readText: async (absolutePath) => {
			await ensureLoaded(absolutePath);
			const content = state.get(absolutePath);
			if (content === null || content === undefined) {
				throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, "")}`);
			}
			return content;
		},
		writeText: async (absolutePath, content) => {
			state.set(absolutePath, content);
		},
		deleteFile: async (absolutePath) => {
			await ensureLoaded(absolutePath);
			if (state.get(absolutePath) === null) {
				throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, "")}`);
			}
			state.set(absolutePath, null);
		},
		exists: async (absolutePath) => {
			await ensureLoaded(absolutePath);
			return state.get(absolutePath) !== null;
		},
		checkWriteAccess: async () => {
			// No-op for virtual workspace — permission checks happen on the real pass.
		},
	};
}

async function applyPatchOperations(
	ops: PatchOperation[],
	workspace: Workspace,
	cwd: string,
	signal?: AbortSignal,
	options?: { collectDiff?: boolean },
): Promise<PatchOpResult[]> {
	const results: PatchOpResult[] = [];
	const collectDiff = options?.collectDiff ?? false;

	for (const op of ops) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		if (op.kind === "add") {
			const abs = resolvePatchPath(cwd, op.path);
			let oldText = "";
			if (collectDiff && (await workspace.exists(abs))) {
				oldText = await workspace.readText(abs);
			}
			const newText = ensureTrailingNewline(op.contents);
			await workspace.writeText(abs, newText);
			const result: PatchOpResult = { path: op.path, message: `Added file ${op.path}.` };
			if (collectDiff) {
				const diffResult = generateDiffString(oldText, newText);
				result.diff = diffResult.diff;
				result.firstChangedLine = diffResult.firstChangedLine;
			}
			results.push(result);
			continue;
		}

		if (op.kind === "delete") {
			const abs = resolvePatchPath(cwd, op.path);
			const exists = await workspace.exists(abs);
			if (!exists) {
				throw new Error(`Failed to delete ${op.path}: file does not exist`);
			}
			let oldText = "";
			if (collectDiff) {
				oldText = await workspace.readText(abs);
			}
			await workspace.deleteFile(abs);
			const result: PatchOpResult = { path: op.path, message: `Deleted file ${op.path}.` };
			if (collectDiff) {
				const diffResult = generateDiffString(oldText, "");
				result.diff = diffResult.diff;
				result.firstChangedLine = diffResult.firstChangedLine;
			}
			results.push(result);
			continue;
		}

		const sourceAbs = resolvePatchPath(cwd, op.path);
		const sourceText = await workspace.readText(sourceAbs);
		const updated = deriveUpdatedContent(op.path, sourceText, op.chunks);

		await workspace.writeText(sourceAbs, updated);
		const result: PatchOpResult = { path: op.path, message: `Updated ${op.path}.` };
		if (collectDiff) {
			const diffResult = generateDiffString(sourceText, updated);
			result.diff = diffResult.diff;
			result.firstChangedLine = diffResult.firstChangedLine;
		}
		results.push(result);
	}

	return results;
}

/**
 * Apply a list of classic edits (path/oldText/newText) sequentially via a Workspace.
 *
 * When multiple edits target the same file, occurrences are matched in file order
 * (advancing a cursor after each match) so that the model can rely on positional
 * ordering instead of needing globally-unique oldText snippets.
 */
async function applyClassicEdits(
	edits: EditItem[],
	workspace: Workspace,
	cwd: string,
	signal?: AbortSignal,
	options?: { collectDiff?: boolean },
): Promise<EditResult[]> {
	const collectDiff = options?.collectDiff ?? false;

	// Group edits by resolved absolute path, preserving order.
	const fileGroups = new Map<string, { index: number; edit: EditItem }[]>();
	const editOrder: string[] = []; // track insertion order of keys

	for (let i = 0; i < edits.length; i++) {
		const abs = isAbsolute(edits[i].path) ? resolvePath(edits[i].path) : resolvePath(cwd, edits[i].path);
		if (!fileGroups.has(abs)) {
			fileGroups.set(abs, []);
			editOrder.push(abs);
		}
		fileGroups.get(abs)!.push({ index: i, edit: edits[i] });
	}

	const results: EditResult[] = new Array(edits.length);

	// Verify write access to all target files before mutating anything.
	for (const absPath of editOrder) {
		await workspace.checkWriteAccess(absPath);
	}

	for (const absPath of editOrder) {
		const group = fileGroups.get(absPath)!;

		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const originalContent = await workspace.readText(absPath);
		let content = originalContent;
		let searchOffset = 0;

		for (const { index, edit } of group) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Find oldText starting from the cursor position (positional ordering).
			const pos = content.indexOf(edit.oldText, searchOffset);

			if (pos === -1) {
				results[index] = {
					path: edit.path,
					success: false,
					message: `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
				};
				// Fill remaining edits in this group as skipped.
				const filled = Array.from({ length: edits.length }, (_, i) => results[i]).filter(Boolean);
				throw new Error(formatResults(filled, edits.length));
			}

			content = content.slice(0, pos) + edit.newText + content.slice(pos + edit.oldText.length);
			searchOffset = pos + edit.newText.length;

			results[index] = {
				path: edit.path,
				success: true,
				message: `Edited ${edit.path}.`,
			};
		}

		// Write back the fully-edited file.
		await workspace.writeText(absPath, content);

		// Generate a single diff for all edits to this file; attach to first edit.
		if (collectDiff) {
			const diffResult = generateDiffString(originalContent, content);
			const firstIdx = group[0].index;
			results[firstIdx].diff = diffResult.diff;
			results[firstIdx].firstChangedLine = diffResult.firstChangedLine;
		}
	}

	return results;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits. Supports a `multi` parameter for batch edits across one or more files, and a `patch` parameter for Codex-style patches.",
		promptSnippet:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		promptGuidelines: [
			"Use edit for precise changes (old text must match exactly)",
			"Use the `multi` parameter to apply multiple edits in a single tool call",
			"Use the `patch` parameter for Codex-style multi-file / hunk-based edits",
		],
		parameters: multiEditSchema,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path, oldText, newText, multi, patch } = params;

			const hasAnyClassicParam = path !== undefined || oldText !== undefined || newText !== undefined || multi !== undefined;
			if (patch !== undefined && hasAnyClassicParam) {
				throw new Error("The `patch` parameter is mutually exclusive with path/oldText/newText/multi.");
			}

			if (patch !== undefined) {
				const ops = parsePatch(patch);

				// Preflight on virtual filesystem before mutating real files.
				await applyPatchOperations(ops, createVirtualWorkspace(ctx.cwd), ctx.cwd, signal, { collectDiff: false });

				// Apply for real.
				const applied = await applyPatchOperations(ops, createRealWorkspace(), ctx.cwd, signal, { collectDiff: true });
				const summary = applied.map((r, i) => `${i + 1}. ${r.message}`).join("\n");
				const combinedDiff = applied
					.filter((r) => r.diff)
					.map((r) => `File: ${r.path}\n${r.diff}`)
					.join("\n\n");
				const firstChangedLine = applied.find((r) => r.firstChangedLine !== undefined)?.firstChangedLine;
				return {
					content: [{ type: "text" as const, text: `Applied patch with ${applied.length} operation(s).\n${summary}` }],
					details: {
						diff: combinedDiff,
						firstChangedLine,
					},
				};
			}

			// Build classic edit list.
			const edits: EditItem[] = [];
			const hasTopLevel = path !== undefined && oldText !== undefined && newText !== undefined;

			if (hasTopLevel) {
				edits.push({ path: path!, oldText: oldText!, newText: newText! });
			} else if (path !== undefined || oldText !== undefined || newText !== undefined) {
				// When multi is present, only a bare top-level `path` (for inheritance) is allowed.
				// Any other partial combination (e.g. path+oldText, oldText+newText) is an error.
				const hasOnlyPath = path !== undefined && oldText === undefined && newText === undefined;
				if (!hasOnlyPath || multi === undefined) {
					const missing: string[] = [];
					if (path === undefined) missing.push("path");
					if (oldText === undefined) missing.push("oldText");
					if (newText === undefined) missing.push("newText");
					throw new Error(
						`Incomplete top-level edit: missing ${missing.join(", ")}. Provide all three (path, oldText, newText) or use only the multi parameter.`,
					);
				}
				// path-only top-level with multi is fine — path is inherited below.
			}

			if (multi) {
				for (const item of multi) {
					edits.push({
						path: item.path ?? path ?? "",
						oldText: item.oldText,
						newText: item.newText,
					});
				}
			}

			if (edits.length === 0) {
				throw new Error("No edits provided. Supply path/oldText/newText, a multi array, or a patch.");
			}

			// Validate that every edit has a path.
			for (let i = 0; i < edits.length; i++) {
				if (!edits[i].path) {
					throw new Error(
						`Edit ${i + 1} is missing a path. Provide a path on each multi item or set a top-level path to inherit.`,
					);
				}
			}

			// Preflight pass on virtual workspace before mutating real files.
			// Uses sequential occurrence matching so same-file edits are resolved
			// in file order (positional ordering).
			try {
				await applyClassicEdits(edits, createVirtualWorkspace(ctx.cwd), ctx.cwd, signal, { collectDiff: false });
			} catch (err: any) {
				throw new Error(`Preflight failed before mutating files.\n${err.message ?? String(err)}`);
			}

			// Apply for real.
			const results = await applyClassicEdits(edits, createRealWorkspace(), ctx.cwd, signal, { collectDiff: true });

			if (results.length === 1) {
				const r = results[0];
				return {
					content: [{ type: "text" as const, text: r.message }],
					details: {
						diff: r.diff ?? "",
						firstChangedLine: r.firstChangedLine,
					},
				};
			}

			const combinedDiff = results
				.filter((r) => r.diff)
				.map((r) => r.diff)
				.join("\n");

			const firstChanged = results.find((r) => r.firstChangedLine !== undefined)?.firstChangedLine;
			const summary = results.map((r, i) => `${i + 1}. ${r.message}`).join("\n");

			return {
				content: [{ type: "text" as const, text: `Applied ${results.length} edit(s) successfully.\n${summary}` }],
				details: {
					diff: combinedDiff,
					firstChangedLine: firstChanged,
				},
			};
		},
	});
}

function formatResults(results: EditResult[], totalEdits: number): string {
	const lines: string[] = [];

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const status = r.success ? "✓" : "✗";
		lines.push(`${status} Edit ${i + 1}/${totalEdits} (${r.path}): ${r.message}`);
	}

	const remaining = totalEdits - results.length;
	if (remaining > 0) {
		lines.push(`⊘ ${remaining} remaining edit(s) skipped due to error.`);
	}

	return lines.join("\n");
}
