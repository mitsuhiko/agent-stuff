/**
 * Assisted Review Extension
 *
 * Provides a `/assisted-review` command for a collaborative human + AI review flow.
 * The AI skims the diff and then guides the human through a structured review,
 * collecting comment candidates along the way.
 *
 * Supports targets:
 * - uncommitted changes
 * - base branch diff
 * - specific commit
 * - GitHub PR (URL or number)
 * - custom instructions
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, BorderedLoader, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, Markdown, matchesKey, Key } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";

let reviewOriginId: string | undefined;
let reviewActive = false;
let previousActiveTools: string[] | null = null;
let activePrRef: string | null = null;

// State persisted to session for reload survival
interface ReviewModeState {
	active: boolean;
	originId?: string;
	previousTools?: string[];
	prRef?: string;
}

interface AssistedReviewComment {
	id: number;
	title: string;
	body: string;
	priority: "P0" | "P1" | "P2" | "P3";
	path?: string;
	line?: number;
	side?: "RIGHT" | "LEFT";
}

interface AssistedReviewDetails {
	action: "list" | "add" | "clear" | "update" | "delete";
	comments: AssistedReviewComment[];
	nextId: number;
	error?: string;
}

interface CommentsState {
	comments: AssistedReviewComment[];
	nextId: number;
}

let comments: AssistedReviewComment[] = [];
let nextCommentId = 1;

type AssistedReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string }
	| { type: "pr"; ref: string }
	| { type: "custom"; instructions: string };

const ASSISTED_REVIEW_PROMPT = `You are the AI partner in an assisted code review. This is a collaborative review between a human and the AI.

Process:
1. Skim the diff to understand the change at a high level (do NOT perform a full review yet).
2. Summarize the intent and major areas touched in 3-5 bullets.
3. Propose a short review plan (3-6 focus areas) and ask the human which to focus on first.
4. Drive a back-and-forth review: ask clarifying questions, wait for the human's answers, and only then drill down.
5. When the human agrees that a finding should be recorded, add it via the assisted_review_comment tool.

Guidelines:
- Start from architecture and system-level concerns, then move to the most important sections.
- Be explicit about what you need the human to clarify.
- Do not attempt to review every line; prioritize impact.
- Comments should be clear and actionable.
- You MUST use the assisted_review_comment tool to record any review comments the human agrees to capture. Do not store comments elsewhere.
- If a potential comment is identified, explicitly ask the human whether to record it, then use assisted_review_comment if they agree.
- Use assisted_review_diff to render unified diffs (with GitHub links) when the human asks to inspect changes. Prefer paths, grep, grepContext, and lineRange to keep output small.
- After calling assisted_review_diff, do NOT reprint the diff in your own message. Only refer to the tool output and ask follow-up questions.
`;

const UNCOMMITTED_INSTRUCTIONS =
	"Skim the current working tree changes (staged, unstaged, and untracked). Use git status and git diff to understand what changed.";

const BASE_BRANCH_INSTRUCTIONS_WITH_MERGE_BASE =
	"Skim the changes against base branch '{baseBranch}'. The merge base is {mergeBaseSha}. Use `git diff {mergeBaseSha}` to inspect changes.";

const BASE_BRANCH_INSTRUCTIONS_FALLBACK =
	"Skim the changes against base branch '{branch}'. Find the merge base between HEAD and {branch} (or its upstream), then run `git diff` against that SHA.";

const COMMIT_INSTRUCTIONS_WITH_TITLE =
	"Skim the changes introduced by commit {sha} (\"{title}\"). Use `git show {sha}` to view the diff.";

const COMMIT_INSTRUCTIONS = "Skim the changes introduced by commit {sha}. Use `git show {sha}` to view the diff.";

const PR_INSTRUCTIONS =
	"Skim the GitHub pull request {ref}. Use `gh pr view {ref}` to see context, then `gh pr diff {ref}` to inspect the diff.";

const REVIEW_PRESETS = [
	{ value: "baseBranch", label: "Review against a base branch", description: "(PR style)" },
	{ value: "uncommitted", label: "Review uncommitted changes", description: "" },
	{ value: "commit", label: "Review a commit", description: "" },
	{ value: "pr", label: "Review a GitHub PR", description: "" },
	{ value: "custom", label: "Custom review instructions", description: "" },
] as const;

const COMMENT_PARAMS = Type.Object({
	action: StringEnum(["list", "add", "clear", "update", "delete"] as const),
	id: Type.Optional(Type.Number({ description: "Comment id for update/delete" })),
	title: Type.Optional(Type.String({ description: "Short summary for the comment" })),
	body: Type.Optional(Type.String({ description: "Detailed comment body" })),
	priority: Type.Optional(StringEnum(["P0", "P1", "P2", "P3"] as const)),
	path: Type.Optional(Type.String({ description: "File path for inline comment" })),
	line: Type.Optional(Type.Number({ description: "Line number for inline comment" })),
	side: Type.Optional(StringEnum(["RIGHT", "LEFT"] as const)),
});

const DIFF_PARAMS = Type.Object({
	source: StringEnum(["git", "pr", "diff"] as const),
	diff: Type.Optional(Type.String({ description: "Unified diff input when source=diff" })),
	base: Type.Optional(Type.String({ description: "Base ref for git diff" })),
	head: Type.Optional(Type.String({ description: "Head ref for git diff" })),
	pr: Type.Optional(Type.String({ description: "PR number or URL when source=pr" })),
	paths: Type.Optional(Type.Array(Type.String(), { description: "Optional file filters" })),
	grep: Type.Optional(Type.String({ description: "Regex to filter hunks" })),
	grepContext: Type.Optional(Type.Number({ description: "Lines of context around grep matches" })),
	lineRange: Type.Optional(Type.String({ description: "Line range for new file content, e.g. '120-200'" })),
	context: Type.Optional(Type.Number({ description: "Context lines for git diff" })),
});

interface DiffHunk {
	header: string;
	lines: string[];
	oldStart: number;
	newStart: number;
}

interface DiffFile {
	path: string;
	headerLines: string[];
	hunks: DiffHunk[];
}

interface PrInfo {
	owner: string;
	repo: string;
	number: number;
	headSha: string;
	url: string;
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "github.com") return null;
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length < 4) return null;
		if (parts[2] !== "pull") return null;
		const number = Number(parts[3]);
		if (!Number.isFinite(number)) return null;
		return { owner: parts[0], repo: parts[1], number };
	} catch {
		return null;
	}
}

async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	try {
		const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
			"rev-parse",
			"--abbrev-ref",
			`${branch}@{upstream}`,
		]);

		if (upstreamCode === 0 && upstream.trim()) {
			const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", upstream.trim()]);
			if (code === 0 && mergeBase.trim()) {
				return mergeBase.trim();
			}
		}

		const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", branch]);
		if (code === 0 && mergeBase.trim()) {
			return mergeBase.trim();
		}

		return null;
	} catch {
		return null;
	}
}

async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.filter((b) => b.trim());
}

async function getRecentCommits(pi: ExtensionAPI, limit: number = 10): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("git", ["log", "--oneline", "-n", `${limit}`]);
	if (code !== 0) return [];

	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [sha, ...rest] = line.trim().split(" ");
			return { sha, title: rest.join(" ") };
		});
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	return code === 0 && stdout.trim().length > 0;
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim();
	}
	return null;
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	const { stdout, code } = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim().replace("origin/", "");
	}

	const branches = await getLocalBranches(pi);
	if (branches.includes("main")) return "main";
	if (branches.includes("master")) return "master";

	return "main";
}

async function buildAssistedPrompt(pi: ExtensionAPI, target: AssistedReviewTarget): Promise<string> {
	switch (target.type) {
		case "uncommitted":
			return `${ASSISTED_REVIEW_PROMPT}\n\n${UNCOMMITTED_INSTRUCTIONS}`;
		case "baseBranch": {
			const mergeBase = await getMergeBase(pi, target.branch);
			if (mergeBase) {
				return `${ASSISTED_REVIEW_PROMPT}\n\n${BASE_BRANCH_INSTRUCTIONS_WITH_MERGE_BASE.replace(
					/{baseBranch}/g,
					target.branch,
				).replace(/{mergeBaseSha}/g, mergeBase)}`;
			}
			return `${ASSISTED_REVIEW_PROMPT}\n\n${BASE_BRANCH_INSTRUCTIONS_FALLBACK.replace(/{branch}/g, target.branch)}`;
		}
		case "commit": {
			const base = target.title ? COMMIT_INSTRUCTIONS_WITH_TITLE : COMMIT_INSTRUCTIONS;
			return `${ASSISTED_REVIEW_PROMPT}\n\n${base}`
				.replace(/{sha}/g, target.sha)
				.replace(/{title}/g, target.title ?? "");
		}
		case "pr":
			return `${ASSISTED_REVIEW_PROMPT}\n\n${PR_INSTRUCTIONS.replace(/{ref}/g, target.ref)}`;
		case "custom":
			return `${ASSISTED_REVIEW_PROMPT}\n\n${target.instructions}`;
	}
}

function getUserFacingHint(target: AssistedReviewTarget): string {
	switch (target.type) {
		case "uncommitted":
			return "current changes";
		case "baseBranch":
			return `changes against '${target.branch}'`;
		case "commit": {
			const shortSha = target.sha.slice(0, 7);
			return target.title ? `commit ${shortSha}: ${target.title}` : `commit ${shortSha}`;
		}
		case "pr":
			return `PR ${target.ref}`;
		case "custom":
			return target.instructions.length > 40 ? target.instructions.slice(0, 37) + "..." : target.instructions;
	}
}

function formatMarkdown(commentsToFormat: AssistedReviewComment[]): string {
	if (commentsToFormat.length === 0) {
		return "# Assisted Review\n\nNo comments captured.";
	}

	const summary = commentsToFormat.filter((c) => !c.path || c.line === undefined);
	const inline = commentsToFormat.filter((c) => c.path && c.line !== undefined);

	let output = "# Assisted Review\n\n";

	if (summary.length > 0) {
		output += "## Summary Comments\n\n";
		for (const comment of summary) {
			output += `- **[${comment.priority}] ${comment.title}**\n\n  ${comment.body.replace(/\n/g, "\n  ")}\n\n`;
		}
	}

	if (inline.length > 0) {
		output += "## Inline Comments\n\n";
		for (const comment of inline) {
			output += `- **[${comment.priority}] ${comment.title}** (${comment.path}:${comment.line})\n\n  ${comment.body.replace(/\n/g, "\n  ")}\n\n`;
		}
	}

	return output.trimEnd();
}

async function ensureGhAvailable(pi: ExtensionAPI): Promise<boolean> {
	const { code } = await pi.exec("gh", ["--version"]);
	return code === 0;
}

async function getRepoFromGh(pi: ExtensionAPI): Promise<{ owner: string; repo: string } | null> {
	const { stdout, code } = await pi.exec("gh", ["repo", "view", "--json", "owner,name"]);
	if (code !== 0 || !stdout.trim()) return null;
	try {
		const data = JSON.parse(stdout);
		if (!data?.owner?.login || !data?.name) return null;
		return { owner: data.owner.login, repo: data.name };
	} catch {
		return null;
	}
}

async function resolvePrInfo(pi: ExtensionAPI, prRef: string): Promise<PrInfo | null> {
	let owner: string | null = null;
	let repo: string | null = null;
	let number: number | null = null;

	const parsed = parsePrUrl(prRef);
	if (parsed) {
		owner = parsed.owner;
		repo = parsed.repo;
		number = parsed.number;
	} else if (/^\d+$/.test(prRef)) {
		const repoInfo = await getRepoFromGh(pi);
		if (!repoInfo) return null;
		owner = repoInfo.owner;
		repo = repoInfo.repo;
		number = Number(prRef);
	}

	if (!owner || !repo || !number) return null;

	const { stdout, code } = await pi.exec("gh", [
		"pr",
		"view",
		String(number),
		"--repo",
		`${owner}/${repo}`,
		"--json",
		"number,headRefOid,url",
	]);

	if (code !== 0 || !stdout.trim()) return null;
	try {
		const data = JSON.parse(stdout);
		if (!data?.headRefOid || !data?.number || !data?.url) return null;
		return {
			owner,
			repo,
			number: Number(data.number),
			headSha: data.headRefOid,
			url: data.url,
		};
	} catch {
		return null;
	}
}

function compileGrep(pattern?: string): RegExp | null {
	if (!pattern) return null;
	try {
		return new RegExp(pattern);
	} catch {
		const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(escaped);
	}
}

function parseUnifiedDiff(diff: string): DiffFile[] {
	const lines = diff.split("\n");
	const files: DiffFile[] = [];
	let currentFile: DiffFile | null = null;
	let currentHunk: DiffHunk | null = null;

	const pushCurrent = () => {
		if (currentFile) files.push(currentFile);
		currentFile = null;
		currentHunk = null;
	};

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			pushCurrent();
			const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
			const path = match ? match[2] : line.replace("diff --git ", "");
			currentFile = { path, headerLines: [line], hunks: [] };
			continue;
		}

		if (!currentFile) continue;

		if (line.startsWith("@@ ")) {
			const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			const oldStart = match ? Number(match[1]) : 0;
			const newStart = match ? Number(match[2]) : 0;
			currentHunk = { header: line, lines: [line], oldStart, newStart };
			currentFile.hunks.push(currentHunk);
			continue;
		}

		if (currentHunk) {
			currentHunk.lines.push(line);
		} else {
			currentFile.headerLines.push(line);
		}
	}

	pushCurrent();
	return files;
}

function filterDiffFiles(
	files: DiffFile[],
	options: { paths?: string[]; grep?: string; grepContext?: number; lineRange?: { start: number; end: number } },
): DiffFile[] {
	let filtered = files;
	if (options.paths?.length) {
		filtered = filtered.filter((file) =>
			options.paths?.some((path) => file.path === path || file.path.startsWith(`${path}/`)),
		);
	}

	const grep = compileGrep(options.grep);
	const grepContext = options.grepContext ?? 0;
	const lineRange = options.lineRange;

	const sliceByRange = (hunk: DiffHunk) => {
		if (!lineRange) return hunk;
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		const collected: string[] = [];
		let hasAny = false;

		for (const line of hunk.lines) {
			if (line.startsWith("@@")) {
				collected.push(line);
				continue;
			}

			const isAdded = line.startsWith("+") && !line.startsWith("+++");
			const isRemoved = line.startsWith("-") && !line.startsWith("---");
			const isContext = line.startsWith(" ");

			if (isAdded) {
				if (newLine >= lineRange.start && newLine <= lineRange.end) {
					collected.push(line);
					hasAny = true;
				}
				newLine += 1;
				continue;
			}

			if (isRemoved) {
				oldLine += 1;
				continue;
			}

			if (isContext) {
				if (newLine >= lineRange.start && newLine <= lineRange.end) {
					collected.push(line);
					hasAny = true;
				}
				oldLine += 1;
				newLine += 1;
			}
		}

		if (!hasAny) return null;
		return { ...hunk, lines: collected };
	};

	const applyGrep = (hunk: DiffHunk) => {
		if (!grep) return hunk;
		const matchLines = hunk.lines.map((line, index) => (grep.test(line) ? index : -1)).filter((i) => i >= 0);
		if (matchLines.length === 0) return null;
		if (grepContext <= 0) return hunk;

		const keep = new Set<number>();
		for (const idx of matchLines) {
			for (let i = Math.max(0, idx - grepContext); i <= Math.min(hunk.lines.length - 1, idx + grepContext); i++) {
				keep.add(i);
			}
		}

		const lines = hunk.lines.filter((_line, index) => keep.has(index) || index === 0);
		return { ...hunk, lines };
	};

	const filteredFiles = filtered
		.map((file) => {
			const hunks = file.hunks
				.map((hunk) => {
					const ranged = sliceByRange(hunk);
					if (!ranged) return null;
					return applyGrep(ranged);
				})
				.filter((hunk): hunk is DiffHunk => Boolean(hunk));
			return { ...file, hunks };
		})
		.filter((file) => file.hunks.length > 0 || file.headerLines.length > 0);

	if (!grep) return filteredFiles;
	return filteredFiles.filter((file) => file.hunks.length > 0);
}

function diffAnchor(path: string): string {
	return createHash("sha256").update(path).digest("hex");
}

function hunkLinkTarget(hunk: DiffHunk): { line: number; side: "R" | "L" } {
	let oldLine = hunk.oldStart;
	let newLine = hunk.newStart;
	let firstAdded: number | null = null;
	let firstRemoved: number | null = null;

	for (const line of hunk.lines) {
		if (line.startsWith("@@")) {
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			if (firstAdded === null) firstAdded = newLine;
			newLine += 1;
			continue;
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			if (firstRemoved === null) firstRemoved = oldLine;
			oldLine += 1;
			continue;
		}
		if (line.startsWith(" ")) {
			oldLine += 1;
			newLine += 1;
			continue;
		}
	}

	if (firstAdded !== null) return { line: firstAdded, side: "R" };
	if (firstRemoved !== null) return { line: firstRemoved, side: "L" };
	return { line: hunk.newStart, side: "R" };
}

function buildGithubLink(prUrl: string, path: string, line?: number, side: "R" | "L" = "R"): string {
	const base = prUrl.replace(/\/$/, "");
	const anchor = `diff-${diffAnchor(path)}`;
	if (line && line > 0) {
		return `${base}/changes#${anchor}${side}${line}`;
	}
	return `${base}/changes#${anchor}`;
}

function isNewFileDiff(file: DiffFile): boolean {
	return file.headerLines.some((line) => line.startsWith("--- /dev/null") || line.startsWith("new file mode"));
}

function computeFileLineRanges(file: DiffFile, chunkSize: number): string[] {
	let minLine: number | null = null;
	let maxLine: number | null = null;

	for (const hunk of file.hunks) {
		let newLine = hunk.newStart;
		for (const line of hunk.lines) {
			if (line.startsWith("@@")) continue;
			if (line.startsWith("+") && !line.startsWith("+++")) {
				if (minLine === null) minLine = newLine;
				maxLine = newLine;
				newLine += 1;
				continue;
			}
			if (line.startsWith(" ")) {
				if (minLine === null) minLine = newLine;
				maxLine = newLine;
				newLine += 1;
			}
		}
	}

	if (minLine === null || maxLine === null) return [];
	const ranges: string[] = [];
	for (let start = minLine; start <= maxLine; start += chunkSize) {
		const end = Math.min(maxLine, start + chunkSize - 1);
		ranges.push(`${start}-${end}`);
	}
	return ranges;
}

function parsePrettyDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

function renderPrettyDiff(text: string, theme: { fg: (c: string, s: string) => string }): string {
	const lines = text.split("\n");
	return lines
		.map((line) => {
			const parsed = parsePrettyDiffLine(line);
			if (!parsed) {
				return theme.fg("toolDiffContext", line);
			}

			switch (parsed.prefix) {
				case "+":
					return theme.fg("toolDiffAdded", `+${parsed.lineNum} ${parsed.content}`);
				case "-":
					return theme.fg("toolDiffRemoved", `-${parsed.lineNum} ${parsed.content}`);
				default:
					return theme.fg("toolDiffContext", ` ${parsed.lineNum} ${parsed.content}`);
			}
		})
		.join("\n");
}

function formatDiffOutput(
	files: DiffFile[],
	options: { prUrl?: string; maxLines: number; maxHunks: number },
): {
	text: string;
	diffText: string;
	info: {
		shownFiles: number;
		shownHunks: number;
		shownLines: number;
		truncated: boolean;
		suggestedRanges: Record<string, string[]>;
	};
} {
	if (files.length === 0) {
		return {
			text: "No diff output (filters removed all hunks).",
			diffText: "",
			info: { shownFiles: 0, shownHunks: 0, shownLines: 0, truncated: false, suggestedRanges: {} },
		};
	}

	const blocks: string[] = [];
	const diffBlocks: string[] = [];
	let shownHunks = 0;
	let shownFiles = 0;
	let shownLines = 0;
	let truncated = false;
	const suggestedRanges: Record<string, string[]> = {};

	const addBlock = (text: string) => {
		const lines = text.split("\n").length;
		shownLines += lines;
		blocks.push(text);
	};

	const addDiffBlock = (text: string) => {
		if (text.trim().length === 0) return;
		diffBlocks.push(text);
	};

	for (const file of files) {
		if (shownHunks >= options.maxHunks || shownLines >= options.maxLines) {
			truncated = true;
			break;
		}

		let fileShown = false;
		let diffStarted = false;
		let prettyHeaderAdded = false;

		if (file.hunks.length === 0) {
			const diffText = [...file.headerLines].join("\n");
			const block = `== ${file.path}\n${diffText}`;
			addBlock(block);
			addDiffBlock(`  ${file.path}`);
			fileShown = true;
			if (options.prUrl) {
				addBlock(`GitHub: ${buildGithubLink(options.prUrl, file.path)}`);
			}
			shownFiles += 1;
			continue;
		}

		for (const hunk of file.hunks) {
			if (shownHunks >= options.maxHunks || shownLines >= options.maxLines) {
				truncated = true;
				break;
			}

			const remainingLines = options.maxLines - shownLines;
			const fullLines = [...file.headerLines, ...hunk.lines];
			let linesToRender = fullLines;
			let hunkTruncated = false;

			if (fullLines.length > remainingLines) {
				linesToRender = fullLines.slice(0, Math.max(0, remainingLines - 1));
				hunkTruncated = true;
				truncated = true;
			}

			const diffText = linesToRender.join("\n");
			let block = `== ${file.path} (hunk +${hunk.newStart})\n${diffText}`;
			if (hunkTruncated) {
				block += "\n... (truncated)";
			}
			addBlock(block);
			fileShown = true;
			shownHunks += 1;

			if (!prettyHeaderAdded) {
				addDiffBlock(`  ${file.path}`);
				prettyHeaderAdded = true;
			}

			const prettyLines: string[] = [];
			let oldLine = hunk.oldStart;
			let newLine = hunk.newStart;
			for (const line of hunk.lines) {
				if (line.startsWith("@@")) continue;
				if (line.startsWith("+") && !line.startsWith("+++")) {
					prettyLines.push(`+${newLine} ${line.slice(1)}`);
					newLine += 1;
					continue;
				}
				if (line.startsWith("-") && !line.startsWith("---")) {
					prettyLines.push(`-${oldLine} ${line.slice(1)}`);
					oldLine += 1;
					continue;
				}
				if (line.startsWith(" ")) {
					prettyLines.push(` ${newLine} ${line.slice(1)}`);
					oldLine += 1;
					newLine += 1;
					continue;
				}
				prettyLines.push(` ${newLine} ${line}`);
			}

			addDiffBlock(prettyLines.join("\n"));
			if (!diffStarted) {
				diffStarted = true;
			} else {
				addDiffBlock("");
			}

			if (options.prUrl) {
				const target = hunkLinkTarget(hunk);
				addBlock(`GitHub: ${buildGithubLink(options.prUrl, file.path, target.line, target.side)}`);
			}
		}

		if (truncated && isNewFileDiff(file)) {
			suggestedRanges[file.path] = computeFileLineRanges(file, options.maxLines);
		}

		if (fileShown) {
			shownFiles += 1;
		}
	}

	if (truncated) {
		let note = "---\nDiff output truncated. The diff has already been shown to the user; do NOT show another diff unless the user explicitly asks.";
		const rangeHints = Object.entries(suggestedRanges)
			.filter(([, ranges]) => ranges.length > 0)
			.map(([path, ranges]) => `${path}: ${ranges.join(", ")}`)
			.join("\n");
		if (rangeHints) {
			note += `\nSuggested lineRange values:\n${rangeHints}`;
		}
		blocks.push(note);
	}

	return {
		text: blocks.join("\n\n"),
		diffText: diffBlocks.join("\n"),
		info: { shownFiles, shownHunks, shownLines, truncated, suggestedRanges },
	};
}

async function postGithubComments(
	pi: ExtensionAPI,
	prInfo: PrInfo,
	commentsToPost: AssistedReviewComment[],
): Promise<{ posted: number; failed: AssistedReviewComment[] }> {
	let posted = 0;
	const failed: AssistedReviewComment[] = [];

	for (const comment of commentsToPost) {
		if (!comment.path || comment.line === undefined) {
			failed.push(comment);
			continue;
		}

		const body = `**[${comment.priority}] ${comment.title}**\n\n${comment.body}`;
		const side = comment.side ?? "RIGHT";

		const { code } = await pi.exec("gh", [
			"api",
			"-X",
			"POST",
			`repos/${prInfo.owner}/${prInfo.repo}/pulls/${prInfo.number}/comments`,
			"-f",
			`body=${body}`,
			"-f",
			`commit_id=${prInfo.headSha}`,
			"-f",
			`path=${comment.path}`,
			"-f",
			`line=${comment.line}`,
			"-f",
			`side=${side}`,
		]);

		if (code === 0) {
			posted += 1;
		} else {
			failed.push(comment);
		}
	}

	return { posted, failed };
}

async function postGithubSummary(
	pi: ExtensionAPI,
	prInfo: PrInfo,
	body: string,
): Promise<boolean> {
	const { code } = await pi.exec("gh", [
		"pr",
		"review",
		String(prInfo.number),
		"--repo",
		`${prInfo.owner}/${prInfo.repo}`,
		"--comment",
		"-b",
		body,
	]);

	return code === 0;
}

export default function assistedReviewExtension(pi: ExtensionAPI) {
	// Persist review mode state
	const persistReviewMode = () => {
		pi.appendEntry<ReviewModeState>("assisted-review-mode", {
			active: reviewActive,
			originId: reviewOriginId,
			previousTools: previousActiveTools ?? undefined,
			prRef: activePrRef ?? undefined,
		});
	};

	const persistCommentsState = () => {
		pi.appendEntry<CommentsState>("assisted-review-comments", {
			comments: [...comments],
			nextId: nextCommentId,
		});
	};

	const reconstructState = (ctx: ExtensionContext, restoreUI = true) => {
		comments = [];
		nextCommentId = 1;
		reviewActive = false;
		reviewOriginId = undefined;
		previousActiveTools = null;
		activePrRef = null;

		for (const entry of ctx.sessionManager.getBranch()) {
			// Restore comment state from tool results
			if (entry.type === "message") {
				const msg = entry.message;
				if (msg.role === "toolResult" && msg.toolName === "assisted_review_comment") {
					const details = msg.details as AssistedReviewDetails | undefined;
					if (details) {
						comments = details.comments;
						nextCommentId = details.nextId;
					}
				}
			}

			// Restore review mode state from custom entries
			if (entry.type === "custom" && entry.customType === "assisted-review-mode") {
				const data = entry.data as ReviewModeState | undefined;
				if (data) {
					reviewActive = data.active;
					reviewOriginId = data.originId;
					previousActiveTools = data.previousTools ?? null;
					activePrRef = data.prRef ?? null;
				}
			}

			if (entry.type === "custom" && entry.customType === "assisted-review-comments") {
				const data = entry.data as CommentsState | undefined;
				if (data) {
					comments = data.comments;
					nextCommentId = data.nextId;
				}
			}
		}

		// Re-activate UI if review mode is active
		if (restoreUI && reviewActive && ctx.hasUI) {
			// Re-enable tools
			if (previousActiveTools) {
				const toolNames = new Set(previousActiveTools);
				toolNames.add("assisted_review_comment");
				toolNames.add("assisted_review_diff");
				pi.setActiveTools([...toolNames]);
			}

			// Re-show widget
			ctx.ui.setWidget("assisted-review", (_tui, theme) => {
				const text = new Text(theme.fg("warning", "Assisted review active • /end-assisted-review to finish"), 0, 0);
				return {
					render(width: number) {
						return text.render(width);
					},
					invalidate() {
						text.invalidate();
					},
				};
			});
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx, false));
	pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.registerTool({
		name: "assisted_review_comment",
		label: "Assisted Review Comment",
		description: "Capture review comments during assisted review. Actions: list, add, update, delete, clear.",
		parameters: COMMENT_PARAMS,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: comments.length
									? comments
											.map((comment) =>
													`[${comment.priority}] #${comment.id} ${comment.title}` +
													(comment.path && comment.line !== undefined
														? ` (${comment.path}:${comment.line})`
														: ""),
											)
											.join("\n")
									: "No comments captured",
							},
						],
						details: { action: "list", comments: [...comments], nextId: nextCommentId } as AssistedReviewDetails,
					};

				case "add": {
					if (!params.title || !params.body || !params.priority) {
						return {
							content: [{ type: "text", text: "Error: title, body, and priority are required" }],
							details: {
								action: "add",
								comments: [...comments],
								nextId: nextCommentId,
								error: "missing required fields",
							} as AssistedReviewDetails,
						};
					}

					if (params.line !== undefined && !params.path) {
						return {
							content: [{ type: "text", text: "Error: path is required when line is provided" }],
							details: {
								action: "add",
								comments: [...comments],
								nextId: nextCommentId,
								error: "path required for line",
							} as AssistedReviewDetails,
						};
					}

					const newComment: AssistedReviewComment = {
						id: nextCommentId++,
						title: params.title,
						body: params.body,
						priority: params.priority,
						path: params.path,
						line: params.line,
						side: params.side,
					};
					comments.push(newComment);
					persistCommentsState();
					return {
						content: [
							{
								type: "text",
								text: `Added comment #${newComment.id}: ${newComment.title}`,
							},
						],
						details: { action: "add", comments: [...comments], nextId: nextCommentId } as AssistedReviewDetails,
					};
				}

				case "update": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id is required for update" }],
							details: {
								action: "update",
								comments: [...comments],
								nextId: nextCommentId,
								error: "id required",
							} as AssistedReviewDetails,
						};
					}

					const index = comments.findIndex((comment) => comment.id === params.id);
					if (index === -1) {
						return {
							content: [{ type: "text", text: `Error: comment #${params.id} not found` }],
							details: {
								action: "update",
								comments: [...comments],
								nextId: nextCommentId,
								error: "comment not found",
							} as AssistedReviewDetails,
						};
					}

					const current = comments[index];
					const next: AssistedReviewComment = { ...current };
					let changed = false;

					if (params.title !== undefined) {
						next.title = params.title;
						changed = true;
					}
					if (params.body !== undefined) {
						next.body = params.body;
						changed = true;
					}
					if (params.priority !== undefined) {
						next.priority = params.priority;
						changed = true;
					}
					if (params.path !== undefined) {
						if (params.path.trim() === "") {
							next.path = undefined;
							next.line = undefined;
							next.side = undefined;
						} else {
							next.path = params.path;
						}
						changed = true;
					}
					if (params.line !== undefined) {
						if (params.line <= 0) {
							next.line = undefined;
							if (!next.path) next.side = undefined;
						} else {
							next.line = params.line;
						}
						changed = true;
					}
					if (params.side !== undefined) {
						next.side = params.side;
						changed = true;
					}

					if (!changed) {
						return {
							content: [{ type: "text", text: "Error: no fields provided to update" }],
							details: {
								action: "update",
								comments: [...comments],
								nextId: nextCommentId,
								error: "no changes",
							} as AssistedReviewDetails,
						};
					}

					if (next.line !== undefined && !next.path) {
						return {
							content: [{ type: "text", text: "Error: path is required when line is provided" }],
							details: {
								action: "update",
								comments: [...comments],
								nextId: nextCommentId,
								error: "path required for line",
							} as AssistedReviewDetails,
						};
					}

					comments[index] = next;
					persistCommentsState();
					return {
						content: [{ type: "text", text: `Updated comment #${next.id}` }],
						details: { action: "update", comments: [...comments], nextId: nextCommentId } as AssistedReviewDetails,
					};
				}

				case "delete": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id is required for delete" }],
							details: {
								action: "delete",
								comments: [...comments],
								nextId: nextCommentId,
								error: "id required",
							} as AssistedReviewDetails,
						};
					}

					const index = comments.findIndex((comment) => comment.id === params.id);
					if (index === -1) {
						return {
							content: [{ type: "text", text: `Error: comment #${params.id} not found` }],
							details: {
								action: "delete",
								comments: [...comments],
								nextId: nextCommentId,
								error: "comment not found",
							} as AssistedReviewDetails,
						};
					}

					const removed = comments.splice(index, 1)[0];
					persistCommentsState();
					return {
						content: [{ type: "text", text: `Deleted comment #${removed.id}` }],
						details: { action: "delete", comments: [...comments], nextId: nextCommentId } as AssistedReviewDetails,
					};
				}

				case "clear": {
					const count = comments.length;
					comments = [];
					nextCommentId = 1;
					persistCommentsState();
					return {
						content: [{ type: "text", text: `Cleared ${count} comments` }],
						details: { action: "clear", comments: [], nextId: 1 } as AssistedReviewDetails,
					};
				}
			}
		},
	});

	pi.registerTool({
		name: "assisted_review_diff",
		label: "Assisted Review Diff",
		description: "Render a unified diff for assisted review (git, GitHub PR, or provided diff). The diff is fully rendered in the tool output; do not reprint it.",
		parameters: DIFF_PARAMS,
		async execute(_toolCallId, params) {
			let diffText = "";
			let prUrl: string | undefined;

			switch (params.source) {
				case "diff": {
					if (!params.diff) {
						return {
							content: [{ type: "text", text: "Error: diff is required when source=diff" }],
						};
					}
					diffText = params.diff;
					break;
				}
				case "git": {
					const args = ["diff", `--unified=${params.context ?? 3}`];
					if (params.base && params.head) {
						args.push(params.base, params.head);
					} else if (params.base) {
						args.push(params.base);
					} else if (params.head) {
						args.push(params.head);
					}

					if (params.paths?.length) {
						args.push("--", ...params.paths);
					}

					const { stdout, stderr, code } = await pi.exec("git", args);
					if (code !== 0) {
						return {
							content: [{ type: "text", text: `Error: git diff failed\n${stderr || stdout}` }],
						};
					}
					diffText = stdout;
					break;
				}
				case "pr": {
					if (!params.pr) {
						return {
							content: [{ type: "text", text: "Error: pr is required when source=pr" }],
						};
					}
					if (!(await ensureGhAvailable(pi))) {
						return { content: [{ type: "text", text: "Error: gh CLI not available" }] };
					}
					const prInfo = await resolvePrInfo(pi, params.pr);
					if (!prInfo) {
						return { content: [{ type: "text", text: "Error: failed to resolve PR info" }] };
					}
					prUrl = prInfo.url;
					const { stdout, stderr, code } = await pi.exec("gh", [
						"pr",
						"diff",
						params.pr,
						"--patch",
						"--color=never",
					]);
					if (code !== 0) {
						return {
							content: [{ type: "text", text: `Error: gh pr diff failed\n${stderr || stdout}` }],
						};
					}
					diffText = stdout;
					break;
				}
			}

			if (!diffText.trim()) {
				return { content: [{ type: "text", text: "No diff output" }] };
			}

			const files = parseUnifiedDiff(diffText);
			const rangeMatch = params.lineRange?.match(/^(\d+)\s*-\s*(\d+)$/);
			const lineRange = rangeMatch
				? { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) }
				: undefined;
			const filtered = filterDiffFiles(files, {
				paths: params.paths,
				grep: params.grep,
				grepContext: params.grep ? params.grepContext ?? 3 : params.grepContext,
				lineRange,
			});
			const maxLines = params.context && params.context > 0 ? Math.max(50, params.context * 20) : 150;
			const maxHunks = 8;
			const rendered = formatDiffOutput(filtered, { prUrl, maxLines, maxHunks });

			return {
				content: [{ type: "text", text: rendered.text }],
				details: {
					files: filtered.length,
					hunks: filtered.reduce((acc, file) => acc + file.hunks.length, 0),
					shownFiles: rendered.info.shownFiles,
					shownHunks: rendered.info.shownHunks,
					shownLines: rendered.info.shownLines,
					truncated: rendered.info.truncated,
					suggestedRanges: rendered.info.suggestedRanges,
					maxLines,
					maxHunks,
					diffText: rendered.diffText,
					request: params,
				},
			};
		},
		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Rendering diff..."), 0, 0);
			}

			const details = result.details as
				| { shownFiles?: number; shownHunks?: number; shownLines?: number; truncated?: boolean; diffText?: string }
				| undefined;

			if (!expanded) {
				const stats = [
					`files ${details?.shownFiles ?? 0}`,
					`hunks ${details?.shownHunks ?? 0}`,
					`lines ${details?.shownLines ?? 0}`,
				];
				const suffix = details?.truncated ? " (truncated)" : "";
				return new Text(theme.fg("muted", `Diff stats: ${stats.join(" • ")}${suffix}`), 0, 0);
			}

			const diffText =
				details?.diffText ??
				result.content
					?.filter((item): item is { type: "text"; text: string } => item.type === "text")
					.map((item) => item.text)
					.join("\n") ??
				"";

			if (!diffText) {
				return new Text("", 0, 0);
			}

			const renderedDiff = renderPrettyDiff(diffText, theme);
			return new Text(renderedDiff, 0, 0);
		},
	});

	async function getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit"> {
		if (await hasUncommittedChanges(pi)) {
			return "uncommitted";
		}

		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);
		if (currentBranch && currentBranch !== defaultBranch) {
			return "baseBranch";
		}

		return "commit";
	}

	async function showReviewSelector(ctx: ExtensionContext): Promise<AssistedReviewTarget | null> {
		const smartDefault = await getSmartDefault();
		const items: SelectItem[] = REVIEW_PRESETS
			.slice()
			.sort((a, b) => {
				if (a.value === smartDefault) return -1;
				if (b.value === smartDefault) return 1;
				return 0;
			})
			.map((preset) => ({
				value: preset.value,
				label: preset.label,
				description: preset.description,
			}));

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select assisted review preset"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to go back")));
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

		if (!result) return null;

		switch (result) {
			case "uncommitted":
				return { type: "uncommitted" };
			case "baseBranch":
				return await showBranchSelector(ctx);
			case "commit":
				return await showCommitSelector(ctx);
			case "pr":
				return await showPrInput(ctx);
			case "custom":
				return await showCustomInput(ctx);
			default:
				return null;
		}
	}

	async function showBranchSelector(ctx: ExtensionContext): Promise<AssistedReviewTarget | null> {
		const branches = await getLocalBranches(pi);
		const defaultBranch = await getDefaultBranch(pi);

		if (branches.length === 0) {
			ctx.ui.notify("No branches found", "error");
			return null;
		}

		const sortedBranches = branches.sort((a, b) => {
			if (a === defaultBranch) return -1;
			if (b === defaultBranch) return 1;
			return a.localeCompare(b);
		});

		const items: SelectItem[] = sortedBranches.map((branch) => ({
			value: branch,
			label: branch,
			description: branch === defaultBranch ? "(default)" : "",
		}));

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select base branch"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.searchable = true;
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")));
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

		if (!result) return null;
		return { type: "baseBranch", branch: result };
	}

	async function showCommitSelector(ctx: ExtensionContext): Promise<AssistedReviewTarget | null> {
		const commits = await getRecentCommits(pi, 20);

		if (commits.length === 0) {
			ctx.ui.notify("No commits found", "error");
			return null;
		}

		const items: SelectItem[] = commits.map((commit) => ({
			value: commit.sha,
			label: `${commit.sha.slice(0, 7)} ${commit.title}`,
			description: "",
		}));

		const result = await ctx.ui.custom<{ sha: string; title: string } | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select commit to review"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.searchable = true;
			selectList.onSelect = (item) => {
				const commit = commits.find((c) => c.sha === item.value);
				if (commit) {
					done(commit);
				} else {
					done(null);
				}
			};
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")));
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

		if (!result) return null;
		return { type: "commit", sha: result.sha, title: result.title };
	}

	async function showPrInput(ctx: ExtensionContext): Promise<AssistedReviewTarget | null> {
		const result = await ctx.ui.input("Enter PR number or GitHub URL:", "123 or https://github.com/org/repo/pull/123");
		if (!result?.trim()) return null;
		return { type: "pr", ref: result.trim() };
	}

	async function showCustomInput(ctx: ExtensionContext): Promise<AssistedReviewTarget | null> {
		const result = await ctx.ui.editor(
			"Enter assisted review instructions:",
			"Skim the changes and guide a human review focusing on architecture and risks...",
		);
		if (!result?.trim()) return null;
		return { type: "custom", instructions: result.trim() };
	}

	function parseArgs(args: string | undefined): AssistedReviewTarget | null {
		if (!args?.trim()) return null;

		const parts = args.trim().split(/\s+/);
		const subcommand = parts[0]?.toLowerCase();

		switch (subcommand) {
			case "uncommitted":
				return { type: "uncommitted" };
			case "branch": {
				const branch = parts[1];
				if (!branch) return null;
				return { type: "baseBranch", branch };
			}
			case "commit": {
				const sha = parts[1];
				if (!sha) return null;
				const title = parts.slice(2).join(" ") || undefined;
				return { type: "commit", sha, title };
			}
			case "pr": {
				const ref = parts[1];
				if (!ref) return null;
				return { type: "pr", ref };
			}
			case "custom": {
				const instructions = parts.slice(1).join(" ");
				if (!instructions) return null;
				return { type: "custom", instructions };
			}
			default: {
				if (/^\d+$/.test(subcommand) || subcommand.startsWith("http")) {
					return { type: "pr", ref: args.trim() };
				}
				return null;
			}
		}
	}

	async function activateCommentTool(ctx: ExtensionContext): Promise<void> {
		if (previousActiveTools) return;
		previousActiveTools = pi.getActiveTools();
		const toolNames = new Set(previousActiveTools);
		toolNames.add("assisted_review_comment");
		toolNames.add("assisted_review_diff");
		pi.setActiveTools([...toolNames]);
		ctx.ui.setWidget("assisted-review", (_tui, theme) => {
			const text = new Text(theme.fg("warning", "Assisted review active • /end-assisted-review to finish"), 0, 0);
			return {
				render(width: number) {
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	function deactivateCommentTool(ctx: ExtensionContext): void {
		if (!previousActiveTools) return;
		pi.setActiveTools(previousActiveTools);
		previousActiveTools = null;
		ctx.ui.setWidget("assisted-review", undefined);
	}

	async function executeReview(ctx: ExtensionCommandContext, target: AssistedReviewTarget, useFreshSession: boolean) {
		if (reviewActive) {
			ctx.ui.notify("Already in an assisted review. Use /end-assisted-review to finish first.", "warning");
			return;
		}

		reviewActive = true;
		activePrRef = target.type === "pr" ? target.ref : null;

		if (useFreshSession) {
			reviewOriginId = ctx.sessionManager.getLeafId() ?? undefined;
			const entries = ctx.sessionManager.getEntries();
			const firstUserMessage = entries.find((e) => e.type === "message" && e.message.role === "user");
			if (!firstUserMessage) {
				ctx.ui.notify("No user message found in session", "error");
				reviewActive = false;
				reviewOriginId = undefined;
				activePrRef = null;
				return;
			}

			try {
				const result = await ctx.navigateTree(firstUserMessage.id, { summarize: false, label: "assisted-review" });
				if (result.cancelled) {
					reviewActive = false;
					reviewOriginId = undefined;
					activePrRef = null;
					return;
				}
			} catch (error) {
				reviewActive = false;
				reviewOriginId = undefined;
				activePrRef = null;
				ctx.ui.notify(`Failed to start assisted review: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			ctx.ui.setEditorText("");
		}

		await activateCommentTool(ctx);
		persistReviewMode();

		const prompt = await buildAssistedPrompt(pi, target);
		const hint = getUserFacingHint(target);

		ctx.ui.notify(`Starting assisted review: ${hint}${useFreshSession ? " (fresh session)" : ""}`, "info");
		pi.sendUserMessage(prompt);
	}

	async function shareComments(ctx: ExtensionCommandContext): Promise<void> {
		if (comments.length === 0) {
			ctx.ui.notify("No comments to share", "info");
			return;
		}

		const shareChoice = await ctx.ui.select("Share comments?", ["Yes", "No"]);
		if (shareChoice !== "Yes") {
			ctx.ui.notify("Comments not shared", "info");
			return;
		}

		const canShareToPr = activePrRef !== null;
		const options = canShareToPr ? ["Markdown", "GitHub PR"] : ["Markdown"];
		const target = await ctx.ui.select("Share comments as:", options);
		if (!target) {
			ctx.ui.notify("Share cancelled", "info");
			return;
		}

		if (target === "Markdown") {
			ctx.ui.setEditorText(formatMarkdown(comments));
			ctx.ui.notify("Comments loaded into editor", "info");
			return;
		}

		if (!activePrRef) {
			ctx.ui.notify("No PR target available", "error");
			return;
		}

		if (!(await ensureGhAvailable(pi))) {
			ctx.ui.notify("gh CLI not available", "error");
			return;
		}

		const result = await ctx.ui.custom<{ ok: boolean; error?: string } | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, "Posting review comments to GitHub...");
			loader.onAbort = () => done(null);

			const doPost = async () => {
				const prInfo = await resolvePrInfo(pi, activePrRef);
				if (!prInfo) {
					return { ok: false, error: "Failed to resolve PR info" };
				}

				const inlineComments = comments.filter((comment) => comment.path && comment.line !== undefined);
				const summaryComments = comments.filter((comment) => !comment.path || comment.line === undefined);

				const { posted, failed } = await postGithubComments(pi, prInfo, inlineComments);

				const summaryBodyParts: string[] = ["## Assisted Review Summary", ""];
				for (const comment of summaryComments) {
					summaryBodyParts.push(`- **[${comment.priority}] ${comment.title}**`, "");
					summaryBodyParts.push(comment.body, "");
				}

				if (failed.length > 0) {
					summaryBodyParts.push("## Inline Comments (fallback)", "");
					for (const comment of failed) {
						summaryBodyParts.push(
							`- **[${comment.priority}] ${comment.title}** (${comment.path}:${comment.line})`,
							"",
							comment.body,
							"",
						);
					}
				}

				const summaryBody = summaryBodyParts.join("\n").trim();
				const summaryOk = await postGithubSummary(pi, prInfo, summaryBody);
				if (!summaryOk) {
					return { ok: false, error: "Failed to post PR summary" };
				}

				return { ok: true, error: posted ? undefined : "No inline comments posted" };
			};

			doPost()
				.then(done)
				.catch((err) => done({ ok: false, error: err instanceof Error ? err.message : String(err) }));

			return loader;
		});

		if (result === null) {
			ctx.ui.notify("Share cancelled", "info");
			return;
		}

		if (!result.ok) {
			ctx.ui.notify(result.error ?? "Failed to post comments", "error");
			return;
		}

		ctx.ui.notify("Comments posted to GitHub", "info");
	}

	pi.registerCommand("assisted-review", {
		description: "Start an assisted code review with comment capture",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Assisted review requires interactive mode", "error");
				return;
			}

			if (reviewActive) {
				ctx.ui.notify("Already in an assisted review. Use /end-assisted-review to finish first.", "warning");
				return;
			}

			const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			const inRepo = code === 0;

			let target = parseArgs(args);
			if (!target) {
				if (!inRepo) {
					ctx.ui.notify("Not a git repository (use /assisted-review pr <url|number> if needed)", "error");
					return;
				}
				target = await showReviewSelector(ctx);
			}

			if (!inRepo && target.type !== "pr") {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			if (!target) {
				ctx.ui.notify("Assisted review cancelled", "info");
				return;
			}

			const entries = ctx.sessionManager.getEntries();
			const messageCount = entries.filter((e) => e.type === "message").length;
			let useFreshSession = false;

			if (messageCount > 0) {
				const choice = await ctx.ui.select("Start assisted review in:", ["Empty branch", "Current session"]);
				if (choice === undefined) {
					ctx.ui.notify("Assisted review cancelled", "info");
					return;
				}
				useFreshSession = choice === "Empty branch";
			}

			await executeReview(ctx, target, useFreshSession);
		},
	});

	pi.registerCommand("assisted-review-comments", {
		description: "Review, copy, or insert assisted review comments",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("assisted-review-comments requires interactive mode", "error");
				return;
			}

			if (comments.length === 0) {
				ctx.ui.notify("No assisted review comments captured", "info");
				return;
			}

			const showCommentDetail = async (comment: AssistedReviewComment) => {
				const location = comment.path
					? `${comment.path}${comment.line !== undefined ? `:${comment.line}` : ""}`
					: "Summary";
				const detailMarkdown = `# [${comment.priority}] ${comment.title}\n\n**Location:** ${location}\n\n${comment.body}`;

				await ctx.ui.custom<void>((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
					container.addChild(new Markdown(detailMarkdown, 1, 0, getMarkdownTheme()));
					container.addChild(new Text(theme.fg("dim", "Press esc to go back"), 1, 0));
					container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

					return {
						render(width: number) {
							return container.render(width);
						},
						invalidate() {
							container.invalidate();
						},
						handleInput(data: string) {
							if (matchesKey(data, Key.escape)) {
								done();
								return;
							}
						},
					};
				});
			};

			const editComment = async (comment: AssistedReviewComment): Promise<boolean> => {
				const newTitle = await ctx.ui.input("Title (blank keeps current)", comment.title);
				if (newTitle === undefined) return false;
				const title = newTitle.trim() ? newTitle.trim() : comment.title;

				const priorityChoice = await ctx.ui.select("Priority", [
					`Keep (${comment.priority})`,
					"P0",
					"P1",
					"P2",
					"P3",
				]);
				if (priorityChoice === undefined) return false;
				const priority = priorityChoice.startsWith("Keep") ? comment.priority : (priorityChoice as AssistedReviewComment["priority"]);

				const pathInput = await ctx.ui.input(
					"Path (blank keeps, '-' clears)",
					comment.path ?? "",
				);
				if (pathInput === undefined) return false;

				let path: string | undefined = comment.path;
				let line: number | undefined = comment.line;
				let side: AssistedReviewComment["side"] | undefined = comment.side;

				const pathTrimmed = pathInput.trim();
				if (pathTrimmed) {
					if (pathTrimmed === "-") {
						path = undefined;
						line = undefined;
						side = undefined;
					} else {
						path = pathTrimmed;
					}
				}

				if (path) {
					const lineInput = await ctx.ui.input(
						"Line (blank keeps, '-' clears)",
						line !== undefined ? String(line) : "",
					);
					if (lineInput === undefined) return false;
					const lineTrimmed = lineInput.trim();
					if (lineTrimmed) {
						if (lineTrimmed === "-") {
							line = undefined;
							side = undefined;
						} else {
							const parsed = Number(lineTrimmed);
							if (!Number.isFinite(parsed) || parsed <= 0) {
								ctx.ui.notify("Invalid line number", "error");
								return false;
							}
							line = parsed;
						}
					}

					if (line !== undefined) {
						const sideChoice = await ctx.ui.select("Side", [
							`Keep (${side ?? "RIGHT"})`,
							"RIGHT",
							"LEFT",
						]);
						if (sideChoice === undefined) return false;
						if (!sideChoice.startsWith("Keep")) {
							side = sideChoice as AssistedReviewComment["side"];
						}
					}
				}

				const bodyInput = await ctx.ui.editor("Comment body", comment.body);
				if (bodyInput === undefined) return false;
				const body = bodyInput.trim() ? bodyInput : comment.body;

				const index = comments.findIndex((c) => c.id === comment.id);
				if (index === -1) {
					ctx.ui.notify("Comment not found", "error");
					return false;
				}

				comments[index] = {
					...comment,
					title,
					priority,
					body,
					path,
					line,
					side,
				};
				persistCommentsState();
				ctx.ui.notify(`Updated comment #${comment.id}`, "info");
				return true;
			};

			const reviewComments = async () => {
				while (true) {
					const items: SelectItem[] = comments.map((comment) => {
						const location = comment.path
							? `${comment.path}:${comment.line ?? "?"}`
							: "Summary";
						return {
							value: String(comment.id),
							label: `${location}`,
							description: `[${comment.priority}] ${comment.title}`,
						};
					});

					const selectedId = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
						const container = new Container();
						container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
						container.addChild(new Text(theme.fg("accent", theme.bold("Assisted review comments"))));

						const selectList = new SelectList(items, Math.min(items.length, 12), {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: (text) => theme.fg("warning", text),
						});

						selectList.searchable = true;
						selectList.onSelect = (item) => done(item.value);
						selectList.onCancel = () => done(null);

						container.addChild(selectList);
						container.addChild(new Text(theme.fg("dim", "Enter to view • esc to menu")));
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

					if (!selectedId) {
						return;
					}

					let selectedComment = comments.find((comment) => String(comment.id) === selectedId);
					if (!selectedComment) {
						ctx.ui.notify("Comment not found", "error");
						return;
					}

					while (true) {
						const action = await ctx.ui.select(`Comment #${selectedComment.id}`, ["View", "Edit", "Delete", "Back"]);
						if (action === undefined || action === "Back") {
							break;
						}

						if (action === "View") {
							await showCommentDetail(selectedComment);
							continue;
						}

						if (action === "Edit") {
							const updated = await editComment(selectedComment);
							if (updated) {
								const refreshed = comments.find((comment) => comment.id === selectedComment.id);
								if (!refreshed) {
									break;
								}
								selectedComment = refreshed;
							}
							continue;
						}

						if (action === "Delete") {
							const confirm = await ctx.ui.confirm(
								"Delete comment",
								`Delete comment #${selectedComment.id}?`,
							);
							if (!confirm) {
								continue;
							}
							const index = comments.findIndex((comment) => comment.id === selectedComment.id);
							if (index === -1) {
								ctx.ui.notify("Comment not found", "error");
								break;
							}
							comments.splice(index, 1);
							persistCommentsState();
							ctx.ui.notify(`Deleted comment #${selectedComment.id}`, "info");
							break;
						}
					}
				}
			};

			while (true) {
				const choice = await ctx.ui.select("Assisted review comments", [
					"Review comments",
					"Copy markdown to clipboard",
					"Insert markdown into editor",
				]);

				if (choice === undefined) {
					return;
				}

				if (choice === "Review comments") {
					await reviewComments();
					continue;
				}

				if (choice === "Copy markdown to clipboard") {
					const markdown = formatMarkdown(comments);
					const { code, stderr } = await pi.exec("bash", [
						"-lc",
						`cat <<'EOF' | pbcopy\n${markdown}\nEOF`,
						]);
					if (code !== 0) {
						ctx.ui.notify(`Failed to copy to clipboard${stderr ? `: ${stderr.trim()}` : ""}`, "error");
						return;
					}
					ctx.ui.notify("Comments copied to clipboard", "info");
					return;
				}

				if (choice === "Insert markdown into editor") {
					ctx.ui.setEditorText(formatMarkdown(comments));
					ctx.ui.notify("Comments inserted into editor", "info");
					return;
				}
			}
		},
	});

	pi.registerCommand("end-assisted-review", {
		description: "End assisted review, share comments, and return",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("End-assisted-review requires interactive mode", "error");
				return;
			}

			if (!reviewActive) {
				ctx.ui.notify("Not in an assisted review", "info");
				return;
			}

			await shareComments(ctx);

			if (reviewOriginId) {
				try {
					const result = await ctx.navigateTree(reviewOriginId, { summarize: false });
					if (result.cancelled) {
						ctx.ui.notify("Navigation cancelled", "info");
						return;
					}
				} catch (error) {
					ctx.ui.notify(`Failed to return: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
			}

			reviewActive = false;
			reviewOriginId = undefined;
			activePrRef = null;
			deactivateCommentTool(ctx);
			persistReviewMode();
			ctx.ui.notify("Assisted review complete", "info");
		},
	});
}
