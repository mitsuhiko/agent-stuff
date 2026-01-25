import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";

const ISSUE_DIR_NAME = ".pi/issues";
const LOCK_TTL_MS = 30 * 60 * 1000;

interface IssueFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
}

interface IssueRecord extends IssueFrontMatter {
	body: string;
}

interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

const IssueParams = Type.Object({
	action: StringEnum(["list", "get", "create", "update", "append"] as const),
	id: Type.Optional(Type.String({ description: "Issue id (filename)" })),
	title: Type.Optional(Type.String({ description: "Issue title" })),
	status: Type.Optional(Type.String({ description: "Issue status" })),
	tags: Type.Optional(Type.Array(Type.String({ description: "Issue tag" }))),
	body: Type.Optional(Type.String({ description: "Issue body or append text" })),
});

type IssueAction = "list" | "get" | "create" | "update" | "append";

function getIssuesDir(cwd: string): string {
	return path.resolve(cwd, ISSUE_DIR_NAME);
}

function getIssuePath(issuesDir: string, id: string): string {
	return path.join(issuesDir, `${id}.md`);
}

function getLockPath(issuesDir: string, id: string): string {
	return path.join(issuesDir, `${id}.lock`);
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseTagsInline(value: string): string[] {
	const inner = value.trim().slice(1, -1);
	if (!inner.trim()) return [];
	return inner
		.split(",")
		.map((item) => stripQuotes(item))
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseFrontMatter(text: string, idFallback: string): IssueFrontMatter {
	const data: IssueFrontMatter = {
		id: idFallback,
		title: "",
		tags: [],
		status: "open",
		created_at: "",
	};

	let currentKey: string | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		const listMatch = currentKey === "tags" ? line.match(/^-\s*(.+)$/) : null;
		if (listMatch) {
			data.tags.push(stripQuotes(listMatch[1]));
			continue;
		}

		const match = line.match(/^(?<key>[a-zA-Z0-9_]+):\s*(?<value>.*)$/);
		if (!match?.groups) continue;

		const key = match.groups.key;
		const value = match.groups.value ?? "";
		currentKey = null;

		if (key === "tags") {
			if (!value) {
				currentKey = "tags";
				continue;
			}
			if (value.startsWith("[") && value.endsWith("]")) {
				data.tags = parseTagsInline(value);
				continue;
			}
			data.tags = [stripQuotes(value)].filter(Boolean);
			continue;
		}

		switch (key) {
			case "id":
				data.id = stripQuotes(value) || data.id;
				break;
			case "title":
				data.title = stripQuotes(value);
				break;
			case "status":
				data.status = stripQuotes(value) || data.status;
				break;
			case "created_at":
				data.created_at = stripQuotes(value);
				break;
			default:
				break;
		}
	}

	return data;
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) {
		return { frontMatter: "", body: content };
	}
	const frontMatter = match[1] ?? "";
	const body = content.slice(match[0].length);
	return { frontMatter, body };
}

function parseIssueContent(content: string, idFallback: string): IssueRecord {
	const { frontMatter, body } = splitFrontMatter(content);
	const parsed = parseFrontMatter(frontMatter, idFallback);
	return {
		id: idFallback,
		title: parsed.title,
		tags: parsed.tags ?? [],
		status: parsed.status,
		created_at: parsed.created_at,
		body: body ?? "",
	};
}

function escapeYaml(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function serializeIssue(issue: IssueRecord): string {
	const tags = issue.tags ?? [];
	const lines = [
		"---",
		`id: \"${escapeYaml(issue.id)}\"`,
		`title: \"${escapeYaml(issue.title)}\"`,
		"tags:",
		...tags.map((tag) => `  - \"${escapeYaml(tag)}\"`),
		`status: \"${escapeYaml(issue.status)}\"`,
		`created_at: \"${escapeYaml(issue.created_at)}\"`,
		"---",
		"",
	];

	const body = issue.body ?? "";
	const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
	return `${lines.join("\n")}${trimmedBody ? `${trimmedBody}\n` : ""}`;
}

async function ensureIssuesDir(issuesDir: string) {
	await fs.mkdir(issuesDir, { recursive: true });
}

async function readIssueFile(filePath: string, idFallback: string): Promise<IssueRecord> {
	const content = await fs.readFile(filePath, "utf8");
	return parseIssueContent(content, idFallback);
}

async function writeIssueFile(filePath: string, issue: IssueRecord) {
	await fs.writeFile(filePath, serializeIssue(issue), "utf8");
}

async function generateIssueId(issuesDir: string): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = crypto.randomBytes(4).toString("hex");
		const issuePath = getIssuePath(issuesDir, id);
		if (!existsSync(issuePath)) return id;
	}
	throw new Error("Failed to generate unique issue id");
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

async function acquireLock(
	issuesDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<(() => Promise<void>) | { error: string }> {
	const lockPath = getLockPath(issuesDir, id);
	const now = Date.now();
	const session = ctx.sessionManager.getSessionFile();

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(lockPath, "wx");
			const info: LockInfo = {
				id,
				pid: process.pid,
				session,
				created_at: new Date(now).toISOString(),
			};
			await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
			await handle.close();
			return async () => {
				try {
					await fs.unlink(lockPath);
				} catch {
					// ignore
				}
			};
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				return { error: `Failed to acquire lock: ${error?.message ?? "unknown error"}` };
			}
			const stats = await fs.stat(lockPath).catch(() => null);
			const lockAge = stats ? now - stats.mtimeMs : LOCK_TTL_MS + 1;
			if (lockAge <= LOCK_TTL_MS) {
				const info = await readLockInfo(lockPath);
				const owner = info?.session ? ` (session ${info.session})` : "";
				return { error: `Issue ${id} is locked${owner}. Try again later.` };
			}
			if (!ctx.hasUI) {
				return { error: `Issue ${id} lock is stale; rerun in interactive mode to steal it.` };
			}
			const ok = await ctx.ui.confirm("Issue locked", `Issue ${id} appears locked. Steal the lock?`);
			if (!ok) {
				return { error: `Issue ${id} remains locked.` };
			}
			await fs.unlink(lockPath).catch(() => undefined);
		}
	}

	return { error: `Failed to acquire lock for issue ${id}.` };
}

async function withIssueLock<T>(
	issuesDir: string,
	id: string,
	ctx: ExtensionContext,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	const lock = await acquireLock(issuesDir, id, ctx);
	if (typeof lock === "object" && "error" in lock) return lock;
	try {
		return await fn();
	} finally {
		await lock();
	}
}

async function listIssues(issuesDir: string): Promise<IssueFrontMatter[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(issuesDir);
	} catch {
		return [];
	}

	const issues: IssueFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(issuesDir, entry);
		try {
			const content = await fs.readFile(filePath, "utf8");
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			issues.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
			});
		} catch {
			// ignore unreadable issue
		}
	}

	issues.sort((a, b) => a.created_at.localeCompare(b.created_at));
	return issues;
}

function formatIssueList(issues: IssueFrontMatter[]): string {
	if (!issues.length) return "No issues.";
	return issues
		.map((issue) => {
			const tagText = issue.tags.length ? ` [${issue.tags.join(", ")}]` : "";
			return `#${issue.id} (${issue.status}) ${issue.title}${tagText}`;
		})
		.join("\n");
}

async function ensureIssueExists(filePath: string, id: string): Promise<IssueRecord | null> {
	if (!existsSync(filePath)) return null;
	return readIssueFile(filePath, id);
}

async function appendIssueBody(filePath: string, issue: IssueRecord, text: string): Promise<IssueRecord> {
	const spacer = issue.body.trim().length ? "\n\n" : "";
	issue.body = `${issue.body.replace(/\s+$/, "")}${spacer}${text.trim()}\n`;
	await writeIssueFile(filePath, issue);
	return issue;
}

export default function issuesExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "issue",
		label: "Issue",
		description: "Manage file-based issues in .pi/issues (list, get, create, update, append)",
		parameters: IssueParams,

		async execute(_toolCallId, params, _onUpdate, ctx) {
			const issuesDir = getIssuesDir(ctx.cwd);
			const action: IssueAction = params.action;

			switch (action) {
				case "list": {
					const issues = await listIssues(issuesDir);
					return {
						content: [{ type: "text", text: formatIssueList(issues) }],
						details: { issues },
					};
				}

				case "get": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { error: "id required" },
						};
					}
					const filePath = getIssuePath(issuesDir, params.id);
					const issue = await ensureIssueExists(filePath, params.id);
					if (!issue) {
						return {
							content: [{ type: "text", text: `Issue ${params.id} not found` }],
							details: { error: "not found" },
						};
					}
					return {
						content: [{ type: "text", text: serializeIssue(issue) }],
						details: { issue },
					};
				}

				case "create": {
					if (!params.title) {
						return {
							content: [{ type: "text", text: "Error: title required" }],
							details: { error: "title required" },
						};
					}
					await ensureIssuesDir(issuesDir);
					const id = await generateIssueId(issuesDir);
					const filePath = getIssuePath(issuesDir, id);
					const issue: IssueRecord = {
						id,
						title: params.title,
						tags: params.tags ?? [],
						status: params.status ?? "open",
						created_at: new Date().toISOString(),
						body: params.body ?? "",
					};

					const result = await withIssueLock(issuesDir, id, ctx, async () => {
						await writeIssueFile(filePath, issue);
						return issue;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: `Created issue ${id}` }],
						details: { issue },
					};
				}

				case "update": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { error: "id required" },
						};
					}
					const filePath = getIssuePath(issuesDir, params.id);
					if (!existsSync(filePath)) {
						return {
							content: [{ type: "text", text: `Issue ${params.id} not found` }],
							details: { error: "not found" },
						};
					}
					const result = await withIssueLock(issuesDir, params.id, ctx, async () => {
						const existing = await ensureIssueExists(filePath, params.id);
						if (!existing) return { error: `Issue ${params.id} not found` } as const;

						existing.id = params.id;
						if (params.title !== undefined) existing.title = params.title;
						if (params.status !== undefined) existing.status = params.status;
						if (params.tags !== undefined) existing.tags = params.tags;
						if (!existing.created_at) existing.created_at = new Date().toISOString();

						await writeIssueFile(filePath, existing);
						return existing;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: `Updated issue ${params.id}` }],
						details: { issue: result },
					};
				}

				case "append": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { error: "id required" },
						};
					}
					if (!params.body) {
						return {
							content: [{ type: "text", text: "Error: body required" }],
							details: { error: "body required" },
						};
					}
					const filePath = getIssuePath(issuesDir, params.id);
					if (!existsSync(filePath)) {
						return {
							content: [{ type: "text", text: `Issue ${params.id} not found` }],
							details: { error: "not found" },
						};
					}
					const result = await withIssueLock(issuesDir, params.id, ctx, async () => {
						const existing = await ensureIssueExists(filePath, params.id);
						if (!existing) return { error: `Issue ${params.id} not found` } as const;
						const updated = await appendIssueBody(filePath, existing, params.body!);
						return updated;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: `Appended to issue ${params.id}` }],
						details: { issue: result },
					};
				}
			}
		},
	});

	pi.registerCommand("issues", {
		description: "List issues from .pi/issues",
		handler: async (_args, ctx) => {
			const issuesDir = getIssuesDir(ctx.cwd);
			const issues = await listIssues(issuesDir);
			const text = formatIssueList(issues);
			if (ctx.hasUI) {
				ctx.ui.notify(text, "info");
			} else {
				console.log(text);
			}
		},
	});

	pi.registerCommand("issue-log", {
		description: "Append text to an issue body",
		handler: async (args, ctx) => {
			const id = (args ?? "").trim();
			if (!id) {
				ctx.ui.notify("Usage: /issue-log <id>", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/issue-log requires interactive mode", "error");
				return;
			}

			const issuesDir = getIssuesDir(ctx.cwd);
			const filePath = getIssuePath(issuesDir, id);
			if (!existsSync(filePath)) {
				ctx.ui.notify(`Issue ${id} not found`, "error");
				return;
			}

			const text = await ctx.ui.editor(`Append to issue ${id}:`, "");
			if (!text?.trim()) {
				ctx.ui.notify("No text provided", "warning");
				return;
			}

			const result = await withIssueLock(issuesDir, id, ctx, async () => {
				const existing = await ensureIssueExists(filePath, id);
				if (!existing) return { error: `Issue ${id} not found` } as const;
				return appendIssueBody(filePath, existing, text);
			});

			if (typeof result === "object" && "error" in result) {
				ctx.ui.notify(result.error, "error");
				return;
			}

			ctx.ui.notify(`Appended to issue ${id}`, "info");
		},
	});
}
