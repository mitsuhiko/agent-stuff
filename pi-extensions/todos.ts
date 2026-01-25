import { DynamicBorder, getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import crypto from "node:crypto";
import {
	Container,
	type Focusable,
	Input,
	Markdown,
	Spacer,
	Text,
	TUI,
	fuzzyMatch,
	getEditorKeybindings,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";

const TODO_DIR_NAME = ".pi/todos";
const LOCK_TTL_MS = 30 * 60 * 1000;

interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
}

interface TodoRecord extends TodoFrontMatter {
	body: string;
}

interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "get", "create", "update", "append"] as const),
	id: Type.Optional(Type.String({ description: "Todo id (filename)" })),
	title: Type.Optional(Type.String({ description: "Todo title" })),
	status: Type.Optional(Type.String({ description: "Todo status" })),
	tags: Type.Optional(Type.Array(Type.String({ description: "Todo tag" }))),
	body: Type.Optional(Type.String({ description: "Todo body or append text" })),
});

type TodoAction = "list" | "get" | "create" | "update" | "append";

type TodoOverlayAction = "refine" | "close" | "reopen" | "work" | "cancel";

function isTodoClosed(status: string): boolean {
	return ["closed", "done"].includes(status.toLowerCase());
}

function sortTodos(todos: TodoFrontMatter[]): TodoFrontMatter[] {
	return [...todos].sort((a, b) => {
		const aClosed = isTodoClosed(a.status);
		const bClosed = isTodoClosed(b.status);
		if (aClosed !== bClosed) return aClosed ? 1 : -1;
		return (a.created_at || "").localeCompare(b.created_at || "");
	});
}

function buildTodoSearchText(todo: TodoFrontMatter): string {
	const tags = todo.tags.join(" ");
	return `${todo.id} ${todo.title} ${tags} ${todo.status}`.trim();
}

function filterTodos(todos: TodoFrontMatter[], query: string): TodoFrontMatter[] {
	const trimmed = query.trim();
	if (!trimmed) return todos;

	const tokens = trimmed
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);

	if (tokens.length === 0) return todos;

	const matches: Array<{ todo: TodoFrontMatter; score: number }> = [];
	for (const todo of todos) {
		const text = buildTodoSearchText(todo);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) {
				matched = false;
				break;
			}
			totalScore += result.score;
		}
		if (matched) {
			matches.push({ todo, score: totalScore });
		}
	}

	return matches
		.sort((a, b) => {
			const aClosed = isTodoClosed(a.todo.status);
			const bClosed = isTodoClosed(b.todo.status);
			if (aClosed !== bClosed) return aClosed ? 1 : -1;
			return a.score - b.score;
		})
		.map((match) => match.todo);
}

class TodoSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private allTodos: TodoFrontMatter[];
	private filteredTodos: TodoFrontMatter[];
	private selectedIndex = 0;
	private onSelectCallback: (todo: TodoFrontMatter) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private theme: Theme;
	private headerText: Text;
	private hintText: Text;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		todos: TodoFrontMatter[],
		onSelect: (todo: TodoFrontMatter) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.allTodos = todos;
		this.filteredTodos = todos;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateHeader();
		this.updateHints();
		this.applyFilter(this.searchInput.getValue());
	}

	setTodos(todos: TodoFrontMatter[]): void {
		this.allTodos = todos;
		this.updateHeader();
		this.applyFilter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	getSearchValue(): string {
		return this.searchInput.getValue();
	}

	private updateHeader(): void {
		const openCount = this.allTodos.filter((todo) => !isTodoClosed(todo.status)).length;
		const closedCount = this.allTodos.length - openCount;
		const title = `Todos (${openCount} open, ${closedCount} closed)`;
		this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
	}

	private updateHints(): void {
		this.hintText.setText(
			this.theme.fg("dim", "Type to search • ↑↓ select • Enter view • Esc close"),
		);
	}

	private applyFilter(query: string): void {
		this.filteredTodos = filterTodos(this.allTodos, query);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTodos.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredTodos.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching todos"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredTodos.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredTodos.length);

		for (let i = startIndex; i < endIndex; i += 1) {
			const todo = this.filteredTodos[i];
			if (!todo) continue;
			const isSelected = i === this.selectedIndex;
			const closed = isTodoClosed(todo.status);
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const titleColor = isSelected ? "accent" : closed ? "dim" : "text";
			const statusColor = closed ? "dim" : "success";
			const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
			const line =
				prefix +
				this.theme.fg("accent", `#${todo.id}`) +
				" " +
				this.theme.fg(titleColor, todo.title || "(untitled)") +
				this.theme.fg("muted", tagText) +
				" " +
				this.theme.fg(statusColor, `(${todo.status || "open"})`);
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredTodos.length) {
			const scrollInfo = this.theme.fg(
				"dim",
				`  (${this.selectedIndex + 1}/${this.filteredTodos.length})`,
			);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectUp")) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredTodos.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "selectDown")) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredTodos.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "selectConfirm")) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
			return;
		}

		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateHints();
		this.updateList();
	}
}

class TodoDetailOverlayComponent {
	private todo: TodoRecord;
	private theme: Theme;
	private tui: TUI;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private onAction: (action: TodoOverlayAction) => void;

	constructor(tui: TUI, theme: Theme, todo: TodoRecord, onAction: (action: TodoOverlayAction) => void) {
		this.tui = tui;
		this.theme = theme;
		this.todo = todo;
		this.onAction = onAction;
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private getMarkdownText(): string {
		const body = this.todo.body?.trim();
		return body ? body : "_No details yet._";
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectCancel")) {
			this.onAction("cancel");
			return;
		}
		if (kb.matches(keyData, "selectUp")) {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(keyData, "selectDown")) {
			this.scrollBy(1);
			return;
		}
		if (kb.matches(keyData, "selectPageUp")) {
			this.scrollBy(-this.viewHeight || -1);
			return;
		}
		if (kb.matches(keyData, "selectPageDown")) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
		if (keyData === "r" || keyData === "R") {
			this.onAction("refine");
			return;
		}
		if (keyData === "c" || keyData === "C") {
			this.onAction("close");
			return;
		}
		if (keyData === "o" || keyData === "O") {
			this.onAction("reopen");
			return;
		}
		if (keyData === "w" || keyData === "W") {
			this.onAction("work");
			return;
		}
	}

	render(width: number): string[] {
		const maxHeight = this.getMaxHeight();
		const headerLines = 3;
		const footerLines = 3;
		const borderLines = 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - borderLines);

		const markdownLines = this.markdown.render(innerWidth);
		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const lines: string[] = [];

		lines.push(this.buildTitleLine(innerWidth));
		lines.push(this.buildMetaLine(innerWidth));
		lines.push("");

		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, innerWidth));
		}
		while (lines.length < headerLines + contentHeight) {
			lines.push("");
		}

		lines.push("");
		lines.push(this.buildActionLine(innerWidth));

		const borderColor = (text: string) => this.theme.fg("borderMuted", text);
		const top = borderColor(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = borderColor(`└${"─".repeat(innerWidth)}┘`);
		const framedLines = lines.map((line) => {
			const truncated = truncateToWidth(line, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
		});

		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private getMaxHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(10, Math.floor(rows * 0.8));
	}

	private buildTitleLine(width: number): string {
		const titleText = this.todo.title ? ` ${this.todo.title} ` : ` Todo #${this.todo.id} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= width) {
			return truncateToWidth(this.theme.fg("accent", titleText.trim()), width);
		}
		const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
		const rightWidth = Math.max(0, width - titleWidth - leftWidth);
		return (
			this.theme.fg("borderMuted", "─".repeat(leftWidth)) +
			this.theme.fg("accent", titleText) +
			this.theme.fg("borderMuted", "─".repeat(rightWidth))
		);
	}

	private buildMetaLine(width: number): string {
		const status = this.todo.status || "open";
		const statusColor = isTodoClosed(status) ? "dim" : "success";
		const tagText = this.todo.tags.length ? this.todo.tags.join(", ") : "no tags";
		const line =
			this.theme.fg("accent", `#${this.todo.id}`) +
			this.theme.fg("muted", " • ") +
			this.theme.fg(statusColor, status) +
			this.theme.fg("muted", " • ") +
			this.theme.fg("muted", tagText);
		return truncateToWidth(line, width);
	}

	private buildActionLine(width: number): string {
		const closed = isTodoClosed(this.todo.status);
		const refine = this.theme.fg("accent", "r") + this.theme.fg("muted", " refine task");
		const work = this.theme.fg("accent", "w") + this.theme.fg("muted", " work on todo");
		const close = this.theme.fg(closed ? "dim" : "accent", "c") +
			this.theme.fg(closed ? "dim" : "muted", " close task");
		const reopen = this.theme.fg(closed ? "accent" : "dim", "o") +
			this.theme.fg(closed ? "muted" : "dim", " reopen task");
		const back = this.theme.fg("dim", "esc back");
		const pieces = [refine, work, close, reopen, back];

		let line = pieces.join(this.theme.fg("muted", " • "));
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			const scrollInfo = this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
			line += scrollInfo;
		}

		return truncateToWidth(line, width);
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
	}
}

function getTodosDir(cwd: string): string {
	return path.resolve(cwd, TODO_DIR_NAME);
}

function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

function getLockPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.lock`);
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

function parseFrontMatter(text: string, idFallback: string): TodoFrontMatter {
	const data: TodoFrontMatter = {
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

function parseTodoContent(content: string, idFallback: string): TodoRecord {
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

function serializeTodo(todo: TodoRecord): string {
	const tags = todo.tags ?? [];
	const lines = [
		"---",
		`id: \"${escapeYaml(todo.id)}\"`,
		`title: \"${escapeYaml(todo.title)}\"`,
		"tags:",
		...tags.map((tag) => `  - \"${escapeYaml(tag)}\"`),
		`status: \"${escapeYaml(todo.status)}\"`,
		`created_at: \"${escapeYaml(todo.created_at)}\"`,
		"---",
		"",
	];

	const body = todo.body ?? "";
	const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
	return `${lines.join("\n")}${trimmedBody ? `${trimmedBody}\n` : ""}`;
}

async function ensureTodosDir(todosDir: string) {
	await fs.mkdir(todosDir, { recursive: true });
}

async function readTodoFile(filePath: string, idFallback: string): Promise<TodoRecord> {
	const content = await fs.readFile(filePath, "utf8");
	return parseTodoContent(content, idFallback);
}

async function writeTodoFile(filePath: string, todo: TodoRecord) {
	await fs.writeFile(filePath, serializeTodo(todo), "utf8");
}

async function generateTodoId(todosDir: string): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = crypto.randomBytes(4).toString("hex");
		const todoPath = getTodoPath(todosDir, id);
		if (!existsSync(todoPath)) return id;
	}
	throw new Error("Failed to generate unique todo id");
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
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<(() => Promise<void>) | { error: string }> {
	const lockPath = getLockPath(todosDir, id);
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
				return { error: `Todo ${id} is locked${owner}. Try again later.` };
			}
			if (!ctx.hasUI) {
				return { error: `Todo ${id} lock is stale; rerun in interactive mode to steal it.` };
			}
			const ok = await ctx.ui.confirm("Todo locked", `Todo ${id} appears locked. Steal the lock?`);
			if (!ok) {
				return { error: `Todo ${id} remains locked.` };
			}
			await fs.unlink(lockPath).catch(() => undefined);
		}
	}

	return { error: `Failed to acquire lock for todo ${id}.` };
}

async function withTodoLock<T>(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	const lock = await acquireLock(todosDir, id, ctx);
	if (typeof lock === "object" && "error" in lock) return lock;
	try {
		return await fn();
	} finally {
		await lock();
	}
}

async function listTodos(todosDir: string): Promise<TodoFrontMatter[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return [];
	}

	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const content = await fs.readFile(filePath, "utf8");
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			todos.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
			});
		} catch {
			// ignore unreadable todo
		}
	}

	return sortTodos(todos);
}

function listTodosSync(todosDir: string): TodoFrontMatter[] {
	let entries: string[] = [];
	try {
		entries = readdirSync(todosDir);
	} catch {
		return [];
	}

	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const content = readFileSync(filePath, "utf8");
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			todos.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
			});
		} catch {
			// ignore
		}
	}

	return sortTodos(todos);
}

function formatTodoList(todos: TodoFrontMatter[]): string {
	if (!todos.length) return "No todos.";
	return todos
		.map((todo) => {
			const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
			return `#${todo.id} (${todo.status}) ${todo.title}${tagText}`;
		})
		.join("\n");
}

async function ensureTodoExists(filePath: string, id: string): Promise<TodoRecord | null> {
	if (!existsSync(filePath)) return null;
	return readTodoFile(filePath, id);
}

async function appendTodoBody(filePath: string, todo: TodoRecord, text: string): Promise<TodoRecord> {
	const spacer = todo.body.trim().length ? "\n\n" : "";
	todo.body = `${todo.body.replace(/\s+$/, "")}${spacer}${text.trim()}\n`;
	await writeTodoFile(filePath, todo);
	return todo;
}

async function updateTodoStatus(
	todosDir: string,
	id: string,
	status: string,
	ctx: ExtensionContext,
): Promise<TodoRecord | { error: string }> {
	const filePath = getTodoPath(todosDir, id);
	if (!existsSync(filePath)) {
		return { error: `Todo ${id} not found` };
	}

	const result = await withTodoLock(todosDir, id, ctx, async () => {
		const existing = await ensureTodoExists(filePath, id);
		if (!existing) return { error: `Todo ${id} not found` } as const;
		existing.status = status;
		await writeTodoFile(filePath, existing);
		return existing;
	});

	if (typeof result === "object" && "error" in result) {
		return { error: result.error };
	}

	return result;
}

export default function todosExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage file-based todos in .pi/todos (list, get, create, update, append)",
		parameters: TodoParams,

		async execute(_toolCallId, params, _onUpdate, ctx) {
			const todosDir = getTodosDir(ctx.cwd);
			const action: TodoAction = params.action;

			switch (action) {
				case "list": {
					const todos = await listTodos(todosDir);
					return {
						content: [{ type: "text", text: formatTodoList(todos) }],
						details: { todos },
					};
				}

				case "get": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { error: "id required" },
						};
					}
					const filePath = getTodoPath(todosDir, params.id);
					const todo = await ensureTodoExists(filePath, params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo ${params.id} not found` }],
							details: { error: "not found" },
						};
					}
					return {
						content: [{ type: "text", text: serializeTodo(todo) }],
						details: { todo },
					};
				}

				case "create": {
					if (!params.title) {
						return {
							content: [{ type: "text", text: "Error: title required" }],
							details: { error: "title required" },
						};
					}
					await ensureTodosDir(todosDir);
					const id = await generateTodoId(todosDir);
					const filePath = getTodoPath(todosDir, id);
					const todo: TodoRecord = {
						id,
						title: params.title,
						tags: params.tags ?? [],
						status: params.status ?? "open",
						created_at: new Date().toISOString(),
						body: params.body ?? "",
					};

					const result = await withTodoLock(todosDir, id, ctx, async () => {
						await writeTodoFile(filePath, todo);
						return todo;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: `Created todo ${id}` }],
						details: { todo },
					};
				}

				case "update": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required" }],
							details: { error: "id required" },
						};
					}
					const filePath = getTodoPath(todosDir, params.id);
					if (!existsSync(filePath)) {
						return {
							content: [{ type: "text", text: `Todo ${params.id} not found` }],
							details: { error: "not found" },
						};
					}
					const result = await withTodoLock(todosDir, params.id, ctx, async () => {
						const existing = await ensureTodoExists(filePath, params.id);
						if (!existing) return { error: `Todo ${params.id} not found` } as const;

						existing.id = params.id;
						if (params.title !== undefined) existing.title = params.title;
						if (params.status !== undefined) existing.status = params.status;
						if (params.tags !== undefined) existing.tags = params.tags;
					if (params.body !== undefined) existing.body = params.body;
						if (!existing.created_at) existing.created_at = new Date().toISOString();

						await writeTodoFile(filePath, existing);
						return existing;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: `Updated todo ${params.id}` }],
						details: { todo: result },
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
					const filePath = getTodoPath(todosDir, params.id);
					if (!existsSync(filePath)) {
						return {
							content: [{ type: "text", text: `Todo ${params.id} not found` }],
							details: { error: "not found" },
						};
					}
					const result = await withTodoLock(todosDir, params.id, ctx, async () => {
						const existing = await ensureTodoExists(filePath, params.id);
						if (!existing) return { error: `Todo ${params.id} not found` } as const;
						const updated = await appendTodoBody(filePath, existing, params.body!);
						return updated;
					});

					if (typeof result === "object" && "error" in result) {
						return {
							content: [{ type: "text", text: result.error }],
							details: { error: result.error },
						};
					}

					return {
						content: [{ type: "text", text: `Appended to todo ${params.id}` }],
						details: { todo: result },
					};
				}
			}
		},
	});

	pi.registerCommand("todos", {
		description: "List todos from .pi/todos",
		getArgumentCompletions: (argumentPrefix: string) => {
			const todos = listTodosSync(getTodosDir(process.cwd()));
			if (!todos.length) return null;
			const matches = filterTodos(todos, argumentPrefix);
			if (!matches.length) return null;
			return matches.map((todo) => {
				const title = todo.title || "(untitled)";
				const tags = todo.tags.length ? ` • ${todo.tags.join(", ")}` : "";
				return {
					value: title,
					label: `#${todo.id} ${title}`,
					description: `${todo.status || "open"}${tags}`,
				};
			});
		},
		handler: async (args, ctx) => {
			const todosDir = getTodosDir(ctx.cwd);
			const todos = await listTodos(todosDir);
			const searchTerm = (args ?? "").trim();

			if (!ctx.hasUI) {
				const text = formatTodoList(todos);
				console.log(text);
				return;
			}

			let nextPrompt: string | null = null;
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let selector: TodoSelectorComponent;

				const handleSelect = async (todo: TodoFrontMatter) => {
					const filePath = getTodoPath(todosDir, todo.id);
					const record = await ensureTodoExists(filePath, todo.id);
					if (!record) {
						ctx.ui.notify(`Todo ${todo.id} not found`, "error");
						return;
					}

					const action = await ctx.ui.custom<TodoOverlayAction>(
						(overlayTui, overlayTheme, _overlayKb, overlayDone) =>
							new TodoDetailOverlayComponent(overlayTui, overlayTheme, record, overlayDone),
						{
							overlay: true,
							overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
						},
					);

					if (!action || action === "cancel") return;
					if (action === "refine") {
						const title = record.title || "(untitled)";
						nextPrompt = `let's refine task #${record.id} "${title}": `;
						done();
						return;
					}
					if (action === "work") {
						const title = record.title || "(untitled)";
						nextPrompt = `work on todo #${record.id} "${title}"`;
						done();
						return;
					}

					const nextStatus = action === "close" ? "closed" : "open";
					const result = await updateTodoStatus(todosDir, record.id, nextStatus, ctx);
					if ("error" in result) {
						ctx.ui.notify(result.error, "error");
						return;
					}

					const updatedTodos = await listTodos(todosDir);
					selector.setTodos(updatedTodos);
					ctx.ui.notify(
						`${action === "close" ? "Closed" : "Reopened"} todo ${record.id}`,
						"info",
					);
				};

				selector = new TodoSelectorComponent(
					tui,
					theme,
					todos,
					(todo) => {
						void handleSelect(todo);
					},
					() => done(),
					searchTerm || undefined,
				);

				return selector;
			});

			if (nextPrompt) {
				ctx.ui.setEditorText(nextPrompt);
			}
		},
	});

	pi.registerCommand("todo-log", {
		description: "Append text to a todo body",
		handler: async (args, ctx) => {
			const id = (args ?? "").trim();
			if (!id) {
				ctx.ui.notify("Usage: /todo-log <id>", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/todo-log requires interactive mode", "error");
				return;
			}

			const todosDir = getTodosDir(ctx.cwd);
			const filePath = getTodoPath(todosDir, id);
			if (!existsSync(filePath)) {
				ctx.ui.notify(`Todo ${id} not found`, "error");
				return;
			}

			const text = await ctx.ui.editor(`Append to todo ${id}:`, "");
			if (!text?.trim()) {
				ctx.ui.notify("No text provided", "warning");
				return;
			}

			const result = await withTodoLock(todosDir, id, ctx, async () => {
				const existing = await ensureTodoExists(filePath, id);
				if (!existing) return { error: `Todo ${id} not found` } as const;
				return appendTodoBody(filePath, existing, text);
			});

			if (typeof result === "object" && "error" in result) {
				ctx.ui.notify(result.error, "error");
				return;
			}

			ctx.ui.notify(`Appended to todo ${id}`, "info");
		},
	});
}
