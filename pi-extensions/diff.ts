/**
 * Changes Extension
 *
 * /diff command lists all files with git status changes or written/edited in the active session branch,
 * coalesced by path and sorted newest first. Selecting a file opens actions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
} from "@mariozechner/pi-tui";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface FileEntryBase {
	canonicalPath: string;
	operations: Set<"write" | "edit">;
	lastTimestamp: number;
	status?: string;
}

interface FileEntry extends FileEntryBase {
	displayPath: string;
	resolvedPath: string;
	hasSessionChange: boolean;
}

type FileToolName = "write" | "edit";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description: "Show changed files and actions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("No UI available", "error");
				return;
			}

			// Get the current branch (path from leaf to root)
			const branch = ctx.sessionManager.getBranch();
			const cwdReal = realpathSync(ctx.cwd);

			const toCanonicalPath = (inputPath: string): string | null => {
				const resolvedPath = path.isAbsolute(inputPath) ? inputPath : path.join(ctx.cwd, inputPath);
				if (!existsSync(resolvedPath)) {
					return null;
				}

				try {
					return realpathSync(resolvedPath);
				} catch {
					return null;
				}
			};

			// First pass: collect tool calls (id -> {path, name}) from assistant messages
			const toolCalls = new Map<string, { path: string; name: FileToolName; timestamp: number }>();

			for (const entry of branch) {
				if (entry.type !== "message") continue;
				const msg = entry.message;

				if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "toolCall") {
							const name = block.name;
							if (name === "write" || name === "edit") {
								const path = block.arguments?.path;
								if (path && typeof path === "string") {
									toolCalls.set(block.id, { path, name, timestamp: msg.timestamp });
								}
							}
						}
					}
				}
			}

			// Second pass: match tool results to get the actual execution timestamp
			const fileMap = new Map<string, FileEntryBase>();

			for (const entry of branch) {
				if (entry.type !== "message") continue;
				const msg = entry.message;

				if (msg.role === "toolResult") {
					const toolCall = toolCalls.get(msg.toolCallId);
					if (!toolCall) continue;

					const { path, name } = toolCall;
					const timestamp = msg.timestamp;
					const canonicalPath = toCanonicalPath(path);
					if (!canonicalPath) {
						continue;
					}

					const existing = fileMap.get(canonicalPath);
					if (existing) {
						existing.operations.add(name);
						if (timestamp > existing.lastTimestamp) {
							existing.lastTimestamp = timestamp;
						}
					} else {
						fileMap.set(canonicalPath, {
							canonicalPath,
							operations: new Set([name]),
							lastTimestamp: timestamp,
						});
					}
				}
			}

			const statusMap = new Map<string, string>();
			const statusResult = await pi.exec("git", ["status", "--porcelain=1", "-z"], { cwd: ctx.cwd });
			if (statusResult.code === 0 && statusResult.stdout) {
				const entries = statusResult.stdout.split("\0").filter(Boolean);
				for (let i = 0; i < entries.length; i++) {
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
					const canonicalPath = toCanonicalPath(filePath);
					if (!canonicalPath) continue;
					statusMap.set(canonicalPath, statusLabel);
					if (!fileMap.has(canonicalPath)) {
						fileMap.set(canonicalPath, {
							canonicalPath,
							operations: new Set(),
							lastTimestamp: 0,
						});
					}
				}
			}

			// Resolve paths and sort with session-modified files first
			const files = Array.from(fileMap.values())
				.map((file) => {
					const relativePath = path.relative(cwdReal, file.canonicalPath);
					const isWithinCwd = relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
					const displayPath = isWithinCwd
						? relativePath || path.basename(file.canonicalPath)
						: file.canonicalPath;
					return {
						...file,
						status: file.status ?? statusMap.get(file.canonicalPath),
						hasSessionChange: file.operations.size > 0,
						resolvedPath: file.canonicalPath,
						displayPath,
					};
				})
				.sort((a, b) => {
					if (a.hasSessionChange !== b.hasSessionChange) {
						return a.hasSessionChange ? -1 : 1;
					}
					if (a.lastTimestamp !== b.lastTimestamp) {
						return b.lastTimestamp - a.lastTimestamp;
					}
					return a.displayPath.localeCompare(b.displayPath);
				});

			if (files.length === 0) {
				ctx.ui.notify("No changed files found", "info");
				return;
			}

			const revealPath = async (file: FileEntry): Promise<void> => {
				let command = "open";
				let args: string[] = [];

				if (process.platform === "darwin") {
					args = ["-R", file.resolvedPath];
				} else {
					command = "xdg-open";
					args = [path.dirname(file.resolvedPath)];
				}

				const result = await pi.exec(command, args);
				if (result.code !== 0) {
					const errorMessage = result.stderr?.trim() || `Failed to reveal ${file.displayPath}`;
					ctx.ui.notify(errorMessage, "error");
				}
			};

			const openPath = async (file: FileEntry): Promise<void> => {
				const command = process.platform === "darwin" ? "open" : "xdg-open";
				const result = await pi.exec(command, [file.resolvedPath]);
				if (result.code !== 0) {
					const errorMessage = result.stderr?.trim() || `Failed to open ${file.displayPath}`;
					ctx.ui.notify(errorMessage, "error");
				}
			};

			const quickLookPath = async (file: FileEntry): Promise<void> => {
				if (process.platform !== "darwin") {
					ctx.ui.notify("Quick Look is only available on macOS", "warning");
					return;
				}

				const result = await pi.exec("qlmanage", ["-p", file.resolvedPath]);
				if (result.code !== 0) {
					const errorMessage = result.stderr?.trim() || `Failed to Quick Look ${file.displayPath}`;
					ctx.ui.notify(errorMessage, "error");
				}
			};

			const openDiff = async (file: FileEntry): Promise<void> => {
				const relativePath = path.relative(ctx.cwd, file.resolvedPath).split(path.sep).join("/");
				const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-changes-"));
				const tmpFile = path.join(tmpDir, path.basename(file.displayPath));

				const existsInHead = await pi.exec("git", ["cat-file", "-e", `HEAD:${relativePath}`], { cwd: ctx.cwd });
				if (existsInHead.code === 0) {
					const result = await pi.exec("git", ["show", `HEAD:${relativePath}`], { cwd: ctx.cwd });
					if (result.code !== 0) {
						const errorMessage = result.stderr?.trim() || `Failed to diff ${file.displayPath}`;
						ctx.ui.notify(errorMessage, "error");
						return;
					}
					writeFileSync(tmpFile, result.stdout ?? "", "utf8");
				} else {
					writeFileSync(tmpFile, "", "utf8");
				}

				const openResult = await pi.exec("code", ["--diff", tmpFile, file.resolvedPath], { cwd: ctx.cwd });
				if (openResult.code !== 0) {
					const errorMessage = openResult.stderr?.trim() || `Failed to open diff for ${file.displayPath}`;
					ctx.ui.notify(errorMessage, "error");
				}
			};

			const showActionSelector = async (
				file: FileEntry,
				options: { canQuickLook: boolean },
			): Promise<"reveal" | "open" | "diff" | "quicklook" | null> => {
				const actions: SelectItem[] = [
					{ value: "diff", label: "Diff in VS Code" },
					{ value: "open", label: "Open" },
					{ value: "reveal", label: "Reveal in Finder" },
					...(options.canQuickLook ? [{ value: "quicklook", label: "Open in Quick Look" }] : []),
				];

				return ctx.ui.custom<"reveal" | "open" | "diff" | "quicklook" | null>((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
					container.addChild(new Text(theme.fg("accent", theme.bold(`Choose action for ${file.displayPath}`))));

					const selectList = new SelectList(actions, actions.length, {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});

					selectList.onSelect = (item) =>
						done(item.value as "reveal" | "open" | "diff" | "quicklook");
					selectList.onCancel = () => done(null);

					container.addChild(selectList);
					container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
					container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

					return {
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				});
			};

			const fileByPath = new Map(files.map((file) => [file.canonicalPath, file]));

			// Show file picker with SelectList
			while (true) {
				let quickAction: "diff" | null = null;
				const selection = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Text(theme.fg("accent", theme.bold(" Select file")), 0, 0));

					const searchInput = new Input();
					container.addChild(searchInput);
					container.addChild(new Spacer(1));

					const listContainer = new Container();
					container.addChild(listContainer);
					container.addChild(
						new Text(theme.fg("dim", "Type to filter • enter to select • ctrl+shift+d diff • esc to cancel"), 0, 0),
					);
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					const items: SelectItem[] = files.map((f) => ({
						value: f.canonicalPath,
						label: f.displayPath,
						description: f.status ? `[${f.status}]` : undefined,
					}));

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
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						});

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
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							if (matchesKey(data, "ctrl+shift+d")) {
								const selected = selectList?.getSelectedItem();
								if (selected) {
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

				if (!selection) {
					return;
				}

				const selectedFile = fileByPath.get(selection);
				if (!selectedFile) {
					ctx.ui.notify(`File not found: ${selection}`, "error");
					return;
				}

				if (quickAction === "diff") {
					await openDiff(selectedFile);
					continue;
				}

				const canQuickLook = process.platform === "darwin";
				const action = await showActionSelector(selectedFile, { canQuickLook });
				if (!action) {
					continue;
				}

				switch (action) {
					case "reveal":
						await revealPath(selectedFile);
						break;
					case "open":
						await openPath(selectedFile);
						break;
					case "diff":
						await openDiff(selectedFile);
						break;
					case "quicklook":
						await quickLookPath(selectedFile);
						break;
				}
			}
		},
	});
}
