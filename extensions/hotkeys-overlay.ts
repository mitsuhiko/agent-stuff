/**
 * Lightweight shortcut-help overlay for pi.
 *
 * Default shortcut: alt+h (macOS Option-H).
 * Configure globally at ~/.pi/agent/hotkeys-overlay.json or per project at .pi/hotkeys-overlay.json:
 *   { "shortcut": "alt+h" }
 *   { "shortcuts": ["alt+h", "f1"] }
 * Environment override: PI_HOTKEYS_OVERLAY_SHORTCUT=alt+h
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface HotkeysOverlayConfig {
  /** Single pi key id, e.g. "alt+h" for macOS Option-H. */
  shortcut?: string;
  /** Multiple pi key ids. Takes precedence over shortcut when present. */
  shortcuts?: string[];
}

const DEFAULT_SHORTCUTS = ["alt+h"];
const CONFIG_BASENAME = "hotkeys-overlay.json";

function parseConfigFile(filePath: string): HotkeysOverlayConfig | undefined {
  if (!existsSync(filePath)) return undefined;

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as HotkeysOverlayConfig;
  } catch (error) {
    console.warn(`Failed to load ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function normalizeShortcutList(value: unknown): string[] {
  if (typeof value === "string") {
    const shortcut = value.trim();
    return shortcut ? [shortcut] : [];
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function loadConfiguredShortcuts(cwd: string): string[] {
  // Later sources override earlier ones. Project config overrides global config.
  const configs = [
    parseConfigFile(join(getAgentDir(), CONFIG_BASENAME)),
    parseConfigFile(join(cwd, ".pi", CONFIG_BASENAME)),
  ].filter((config): config is HotkeysOverlayConfig => config !== undefined);

  let shortcuts = DEFAULT_SHORTCUTS;
  for (const config of configs) {
    const fromList = normalizeShortcutList(config.shortcuts);
    const fromSingle = normalizeShortcutList(config.shortcut);
    const next = fromList.length > 0 ? fromList : fromSingle;
    if (next.length > 0) shortcuts = next;
  }

  const fromEnv = normalizeShortcutList(process.env.PI_HOTKEYS_OVERLAY_SHORTCUT);
  if (fromEnv.length > 0) shortcuts = fromEnv;

  return [...new Set(shortcuts.map((shortcut) => shortcut.toLowerCase()))];
}

function formatKey(key: string): string {
  return key
    .split("/")
    .map((variant) =>
      variant
        .split("+")
        .map((part) => {
          const lower = part.toLowerCase();
          if (process.platform === "darwin" && lower === "alt") return "Option";
          if (lower === "ctrl") return "Ctrl";
          if (lower === "shift") return "Shift";
          if (lower === "escape" || lower === "esc") return "Esc";
          if (lower === "enter" || lower === "return") return "Enter";
          if (lower === "pageup") return "PageUp";
          if (lower === "pagedown") return "PageDown";
          return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join("+"),
    )
    .join("/");
}

function compactKey(key: string): string {
  return key
    .replace(/PageUp/g, "Pg<UP>")
    .replace(/PageDown/g, "Pg<DOWN>")
    .replace(/Option\+/g, "Opt+")
    .replace(/Shift\+/g, "⇧+")
    .replace(/Backspace/g, "Bksp")
    .replace(/Delete/g, "Del")
    .replace(/Left/g, "←")
    .replace(/Right/g, "→")
    .replace(/Up/g, "↑")
    .replace(/Down/g, "↓")
    .replace(/Pg<UP>/g, "PgUp")
    .replace(/Pg<DOWN>/g, "PgDn");
}

function keyText(keybindings: any, action: string, fallback = ""): string {
  const keys = keybindings?.getKeys?.(action) ?? [];
  // Keep the overlay dense: show the primary binding. The full list remains available in /hotkeys.
  return keys.length > 0 ? compactKey(formatKey(keys[0])) : compactKey(fallback);
}

function showHotkeysOverlay(ctx: ExtensionContext, shortcutLabels: string[]): Promise<void> {
  const custom = (ctx.ui as any).custom;
  if (!ctx.hasUI || typeof custom !== "function") {
    ctx.ui.notify("Shortcut overlay requires TUI mode", "warning");
    return Promise.resolve();
  }

  return custom(
    (_tui: any, theme: Theme, keybindings: any, done: () => void) =>
      new HotkeysOverlay(_tui, theme, keybindings, shortcutLabels, () => done()),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        minWidth: 54,
        maxHeight: "80%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

class HotkeysOverlay {
  private readonly tui: any;
  private readonly theme: Theme;
  private readonly keybindings: any;
  private readonly shortcutLabels: string[];
  private readonly close: () => void;
  private scrollOffset = 0;

  constructor(tui: any, theme: Theme, keybindings: any, shortcutLabels: string[], close: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.shortcutLabels = shortcutLabels;
    this.close = close;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.close();
      return;
    }

    const page = Math.max(3, Math.floor(this.maxRows() * 0.7));
    if (matchesKey(data, "up") || data === "k") this.scrollBy(-1);
    else if (matchesKey(data, "down") || data === "j") this.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.scrollBy(-page);
    else if (matchesKey(data, "pageDown")) this.scrollBy(page);
    else if (matchesKey(data, "home")) this.setScroll(0);
    else if (matchesKey(data, "end")) this.setScroll(Number.MAX_SAFE_INTEGER);
  }

  private maxRows(): number {
    const rows = this.tui?.terminal?.rows;
    return Math.max(8, Math.floor((typeof rows === "number" ? rows : 40) * 0.8));
  }

  private scrollBy(delta: number): void {
    this.setScroll(this.scrollOffset + delta);
  }

  private setScroll(offset: number): void {
    this.scrollOffset = Math.max(0, offset);
    this.tui?.requestRender?.();
  }

  render(width: number): string[] {
    const w = Math.max(30, width);
    const inner = Math.max(1, w - 2);
    const th = this.theme;
    const body: string[] = [];

    const pad = (text: string, targetWidth: number) => {
      const clipped = truncateToWidth(text, targetWidth, "…");
      return clipped + " ".repeat(Math.max(0, targetWidth - visibleWidth(clipped)));
    };

    const fill = (content = "") => th.bg("customMessageBg", pad(content, inner));
    const row = (content = "") => th.fg("borderMuted", "│") + fill(content) + th.fg("borderMuted", "│");
    const blank = () => row("");
    const kb = (action: string, fallback = "") => keyText(this.keybindings, action, fallback);

    const combo = (...actions: string[]) => {
      const keys = actions.map((action) => kb(action)).filter(Boolean);
      if (keys.length !== 2) return keys.join("/");

      const [left, right] = keys;
      const leftParts = left.split("+");
      const rightParts = right.split("+");
      if (leftParts.length === rightParts.length && leftParts.length > 1) {
        const leftPrefix = leftParts.slice(0, -1).join("+");
        const rightPrefix = rightParts.slice(0, -1).join("+");
        if (leftPrefix === rightPrefix) return `${leftPrefix}+${leftParts.at(-1)}/${rightParts.at(-1)}`;
      }

      return keys.join("/");
    };
    const item = (keys: string, action: string) => ({ keys, action });
    const bound = (action: string, label: string) => {
      const keys = kb(action);
      return keys ? item(keys, label) : undefined;
    };
    const section = (title: string) => {
      const label = ` ${th.fg("accent", th.bold(title))} `;
      const rule = th.fg("dim", "─".repeat(Math.max(0, inner - visibleWidth(label) - 1)));
      body.push(row(label + rule));
    };
    const cell = (entry: { keys: string; action: string } | undefined, cellWidth: number) => {
      if (!entry) return " ".repeat(cellWidth);
      const keyWidth = Math.min(20, Math.max(18, Math.floor(cellWidth * 0.47)));
      const actionWidth = Math.max(1, cellWidth - keyWidth - 1);
      const key = th.fg("accent", pad(entry.keys, keyWidth));
      const action = th.fg("text", pad(entry.action, actionWidth));
      return pad(`${key} ${action}`, cellWidth);
    };
    const entries = (...values: Array<{ keys: string; action: string } | undefined>) =>
      values.filter((entry): entry is { keys: string; action: string } => entry !== undefined && entry.keys.length > 0);
    const itemRows = (values: Array<{ keys: string; action: string } | undefined>) => {
      const visible = entries(...values);
      const columns = inner >= 105 ? 3 : inner >= 74 ? 2 : 1;
      const separator = th.fg("dim", " │ ");
      const gap = columns > 1 ? 3 * (columns - 1) : 0;
      const cellWidth = Math.floor((inner - 2 - gap) / columns);
      for (let i = 0; i < visible.length; i += columns) {
        const rowCells = visible.slice(i, i + columns).map((entry) => cell(entry, cellWidth));
        body.push(row(` ${rowCells.join(separator)}`));
      }
    };

    body.push(blank());

    section("Core");
    itemRows([
      bound("app.suspend", "Suspend"),
      item(kb("app.editor.external"), "External editor"),
    ]);
    body.push(blank());

    section("Models, display, queue");
    itemRows([
      item(kb("app.model.select"), "Model selector"),
      item(kb("app.thinking.toggle"), "Toggle thinking"),
      item(kb("app.tools.expand"), "Toggle tools"),
      item(kb("app.message.followUp"), "Queue follow-up"),
      item(kb("app.message.dequeue"), "Restore queue"),
    ]);
    body.push(blank());

    section("Editor");
    itemRows([
      item(kb("tui.input.newLine"), "Newline"),
      item(kb("tui.input.tab"), "Autocomplete"),
      item(combo("tui.editor.cursorUp", "tui.editor.cursorDown"), "Up/down"),
      item(combo("tui.editor.cursorLeft", "tui.editor.cursorRight"), "Left/right"),
      item(combo("tui.editor.cursorWordLeft", "tui.editor.cursorWordRight"), "Word left/right"),
      item(combo("tui.editor.cursorLineStart", "tui.editor.cursorLineEnd"), "Line start/end"),
      item(combo("tui.editor.pageUp", "tui.editor.pageDown"), "Page up/down"),
      item(combo("tui.editor.jumpForward", "tui.editor.jumpBackward"), "Jump char"),
      item(kb("tui.editor.deleteCharBackward"), "Backspace"),
      item(kb("tui.editor.deleteCharForward"), "Delete forward"),
      item(kb("tui.editor.deleteWordBackward"), "Delete word back"),
      item(kb("tui.editor.deleteWordForward"), "Delete word fwd"),
      item(kb("tui.editor.deleteToLineStart"), "Delete to start"),
      item(kb("tui.editor.deleteToLineEnd"), "Delete to end"),
      item(kb("tui.editor.yank"), "Yank"),
      item(kb("tui.editor.yankPop"), "Yank-pop"),
      item(kb("tui.editor.undo"), "Undo"),
    ]);
    body.push(blank());

    section("Pickers, sessions, tree");
    itemRows([
      item(combo("tui.select.up", "tui.select.down"), "Select up/down"),
      item(combo("tui.select.pageUp", "tui.select.pageDown"), "Select page"),
      bound("app.session.new", "New session"),
      bound("app.session.tree", "Session tree"),
      bound("app.session.fork", "Fork session"),
      bound("app.session.resume", "Resume session"),
      item(combo("app.tree.foldOrUp", "app.tree.unfoldOrDown"), "Tree fold/unfold"),
      item(combo("app.tree.editLabel", "app.tree.toggleLabelTimestamp"), "Tree labels"),
      item(combo("app.tree.filter.cycleForward", "app.tree.filter.cycleBackward"), "Tree filters"),
      item(combo("app.session.toggleSort", "app.session.toggleNamedFilter"), "Session list opts"),
      item(combo("app.session.rename", "app.session.delete"), "Rename/delete"),
      item(combo("app.models.save", "app.models.enableAll"), "Scoped models"),
      item(combo("app.models.clearAll", "app.models.toggleProvider"), "Scoped toggles"),
      item(combo("app.models.reorderUp", "app.models.reorderDown"), "Scoped reorder"),
    ]);

    const maxRows = this.maxRows();
    const fixedRows = 3; // top border, title, bottom border
    const visibleBodyRows = Math.max(1, maxRows - fixedRows);
    const maxScroll = Math.max(0, body.length - visibleBodyRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const clippedBody = body.slice(this.scrollOffset, this.scrollOffset + visibleBodyRows);
    const scrollHint = maxScroll > 0
      ? ` • ↑↓/PgUp/PgDn scroll ${this.scrollOffset + 1}-${Math.min(body.length, this.scrollOffset + visibleBodyRows)}/${body.length}`
      : "";

    const lines: string[] = [];
    lines.push(th.fg("borderMuted", `╭${"─".repeat(inner)}╮`));
    lines.push(
      row(
        ` ${th.fg("accent", th.bold("Pi shortcuts"))} ${th.fg("dim", `${this.shortcutLabels.join("/")} opens • q closes${scrollHint}`)}`,
      ),
    );
    lines.push(...clippedBody);
    lines.push(th.fg("borderMuted", `╰${"─".repeat(inner)}╯`));

    return lines;
  }

  invalidate(): void {}
}

export default function hotkeysOverlayExtension(pi: ExtensionAPI): void {
  let shortcutLabels = DEFAULT_SHORTCUTS.map(formatKey);
  let shortcutsRegistered = false;

  pi.on("session_start", async (_event, ctx) => {
    if (shortcutsRegistered) return;

    const shortcuts = loadConfiguredShortcuts(ctx.cwd);
    shortcutLabels = shortcuts.map(formatKey);
    for (const shortcut of shortcuts) {
      pi.registerShortcut(shortcut as any, {
        description: "Show shortcut help overlay",
        handler: async (ctx) => {
          await showHotkeysOverlay(ctx, shortcutLabels);
        },
      });
    }
    shortcutsRegistered = true;
  });
}
