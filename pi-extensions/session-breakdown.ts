/**
 * /session-breakdown
 *
 * Interactive TUI that analyzes ~/.pi/agent/sessions (recursively, *.jsonl) and shows
 * last 7/30/90 days of:
 * - sessions/day
 * - messages/day
 * - tokens/day (if available)
 * - cost/day (if available)
 * - model breakdown (sessions/messages/tokens + cost)
 *
 * Graph:
 * - GitHub-contributions-style calendar (weeks x weekdays)
 * - Hue: weighted mix of popular model colors (weighted by the selected metric)
 * - Brightness: selected metric per day (log-scaled)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	sliceByColumn,
	type Component,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import readline from "node:readline";

type ModelKey = string; // `${provider}/${model}`

interface ParsedSession {
	filePath: string;
	startedAt: Date;
	dayKeyLocal: string; // YYYY-MM-DD (local)
	modelsUsed: Set<ModelKey>;
	messages: number;
	tokens: number;
	totalCost: number;
	costByModel: Map<ModelKey, number>;
	messagesByModel: Map<ModelKey, number>;
	tokensByModel: Map<ModelKey, number>;
}

interface DayAgg {
	date: Date; // local midnight
	dayKeyLocal: string;
	sessions: number;
	messages: number;
	tokens: number;
	totalCost: number;
	costByModel: Map<ModelKey, number>;
	sessionsByModel: Map<ModelKey, number>;
	messagesByModel: Map<ModelKey, number>;
	tokensByModel: Map<ModelKey, number>;
}

interface RangeAgg {
	days: DayAgg[];
	dayByKey: Map<string, DayAgg>;
	sessions: number;
	totalMessages: number;
	totalTokens: number;
	totalCost: number;
	modelCost: Map<ModelKey, number>;
	modelSessions: Map<ModelKey, number>; // number of sessions where model was used
	modelMessages: Map<ModelKey, number>;
	modelTokens: Map<ModelKey, number>;
}

interface RGB {
	r: number;
	g: number;
	b: number;
}

interface BreakdownData {
	generatedAt: Date;
	ranges: Map<number, RangeAgg>;
	palette: {
		modelColors: Map<ModelKey, RGB>;
		otherColor: RGB;
		orderedModels: ModelKey[];
	};
}

const SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
const RANGE_DAYS = [7, 30, 90] as const;

type MeasurementMode = "sessions" | "messages" | "tokens";

type BreakdownProgressPhase = "scan" | "parse" | "finalize";

interface BreakdownProgressState {
	phase: BreakdownProgressPhase;
	foundFiles: number;
	parsedFiles: number;
	totalFiles: number;
	currentFile?: string;
}

function setBorderedLoaderMessage(loader: BorderedLoader, message: string) {
	// BorderedLoader wraps a (Cancellable)Loader which supports setMessage(),
	// but it doesn't expose it publicly. Access the inner loader for progress updates.
	const inner = (loader as any)["loader"]; // eslint-disable-line @typescript-eslint/no-explicit-any
	if (inner && typeof inner.setMessage === "function") {
		inner.setMessage(message);
	}
}

// Dark-ish background and empty cell color (close to GitHub dark)
const DEFAULT_BG: RGB = { r: 13, g: 17, b: 23 };
const EMPTY_CELL_BG: RGB = { r: 22, g: 27, b: 34 };

// Default palette (assigned to top models)
const PALETTE: RGB[] = [
	{ r: 64, g: 196, b: 99 }, // green
	{ r: 47, g: 129, b: 247 }, // blue
	{ r: 163, g: 113, b: 247 }, // purple
	{ r: 255, g: 159, b: 10 }, // orange
	{ r: 244, g: 67, b: 54 }, // red
];

function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
	return {
		r: Math.round(lerp(a.r, b.r, t)),
		g: Math.round(lerp(a.g, b.g, t)),
		b: Math.round(lerp(a.b, b.b, t)),
	};
}

function weightedMix(colors: Array<{ color: RGB; weight: number }>): RGB {
	let total = 0;
	let r = 0;
	let g = 0;
	let b = 0;
	for (const c of colors) {
		if (!Number.isFinite(c.weight) || c.weight <= 0) continue;
		total += c.weight;
		r += c.color.r * c.weight;
		g += c.color.g * c.weight;
		b += c.color.b * c.weight;
	}
	if (total <= 0) return EMPTY_CELL_BG;
	return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) };
}

function ansiBg(rgb: RGB, text: string): string {
	return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

function ansiFg(rgb: RGB, text: string): string {
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

function dim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[0m`;
}

function formatCount(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "0";
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toLocaleString("en-US");
}

function formatUsd(cost: number): string {
	if (!Number.isFinite(cost)) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

function padRight(s: string, n: number): string {
	const delta = n - s.length;
	return delta > 0 ? s + " ".repeat(delta) : s;
}

function padLeft(s: string, n: number): string {
	const delta = n - s.length;
	return delta > 0 ? " ".repeat(delta) + s : s;
}

function toLocalDayKey(d: Date): string {
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function localMidnight(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addDaysLocal(d: Date, days: number): Date {
	const x = new Date(d);
	x.setDate(x.getDate() + days);
	return x;
}

function countDaysInclusiveLocal(start: Date, end: Date): number {
	// Avoid ms-based day math because DST transitions can make a “day” 23/25h in local time.
	let n = 0;
	for (let d = new Date(start); d <= end; d = addDaysLocal(d, 1)) n++;
	return n;
}

function mondayIndex(date: Date): number {
	// Mon=0 .. Sun=6
	return (date.getDay() + 6) % 7;
}

function modelKeyFromParts(provider?: unknown, model?: unknown): ModelKey | null {
	const p = typeof provider === "string" ? provider.trim() : "";
	const m = typeof model === "string" ? model.trim() : "";
	if (!p && !m) return null;
	if (!p) return m;
	if (!m) return p;
	return `${p}/${m}`;
}

function parseSessionStartFromFilename(name: string): Date | null {
	// Example: 2026-02-02T21-52-28-774Z_<uuid>.jsonl
	const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
	if (!m) return null;
	const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d : null;
}

function extractProviderModelAndUsage(obj: any): { provider?: any; model?: any; modelId?: any; usage?: any } {
	// Session format varies across versions.
	// - Newer: { provider, model, usage } on the message wrapper
	// - Older: { message: { provider, model, usage } }
	const msg = obj?.message;
	return {
		provider: obj?.provider ?? msg?.provider,
		model: obj?.model ?? msg?.model,
		modelId: obj?.modelId ?? msg?.modelId,
		usage: obj?.usage ?? msg?.usage,
	};
}

function extractCostTotal(usage: any): number {
	if (!usage) return 0;
	const c = usage?.cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	if (typeof c === "string") {
		const n = Number(c);
		return Number.isFinite(n) ? n : 0;
	}
	const t = c?.total;
	if (typeof t === "number") return Number.isFinite(t) ? t : 0;
	if (typeof t === "string") {
		const n = Number(t);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

function extractTokensTotal(usage: any): number {
	// Usage format varies across providers and pi versions.
	// We try a few common shapes:
	// - { totalTokens }
	// - { total_tokens }
	// - { promptTokens, completionTokens }
	// - { prompt_tokens, completion_tokens }
	// - { input_tokens, output_tokens }
	// - { inputTokens, outputTokens }
	// - { tokens: number | { total } }
	if (!usage) return 0;

	const readNum = (v: any): number => {
		if (typeof v === "number") return Number.isFinite(v) ? v : 0;
		if (typeof v === "string") {
			const n = Number(v);
			return Number.isFinite(n) ? n : 0;
		}
		return 0;
	};

	let total = 0;
	// direct totals
	total =
		readNum(usage?.totalTokens) ||
		readNum(usage?.total_tokens) ||
		readNum(usage?.tokens) ||
		readNum(usage?.tokenCount) ||
		readNum(usage?.token_count);
	if (total > 0) return total;

	// nested tokens object
	total = readNum(usage?.tokens?.total) || readNum(usage?.tokens?.totalTokens) || readNum(usage?.tokens?.total_tokens);
	if (total > 0) return total;

	// sum of parts
	const a =
		readNum(usage?.promptTokens) ||
		readNum(usage?.prompt_tokens) ||
		readNum(usage?.inputTokens) ||
		readNum(usage?.input_tokens);
	const b =
		readNum(usage?.completionTokens) ||
		readNum(usage?.completion_tokens) ||
		readNum(usage?.outputTokens) ||
		readNum(usage?.output_tokens);
	const sum = a + b;
	return sum > 0 ? sum : 0;
}

async function walkSessionFiles(
	root: string,
	startCutoffLocal: Date,
	signal?: AbortSignal,
	onFound?: (found: number) => void,
): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length) {
		if (signal?.aborted) break;
		const dir = stack.pop()!;
		let entries: Dirent[] = [];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const ent of entries) {
			if (signal?.aborted) break;
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				stack.push(p);
				continue;
			}
			if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;

			// Prefer filename timestamp, else fall back to mtime.
			const startedAt = parseSessionStartFromFilename(ent.name);
			if (startedAt) {
				if (localMidnight(startedAt) >= startCutoffLocal) {
					out.push(p);
					if (onFound && out.length % 10 === 0) onFound(out.length);
				}
				continue;
			}

			try {
				const st = await fs.stat(p);
				const approx = new Date(st.mtimeMs);
				if (localMidnight(approx) >= startCutoffLocal) {
					out.push(p);
					if (onFound && out.length % 10 === 0) onFound(out.length);
				}
			} catch {
				// ignore
			}
		}
	}
	onFound?.(out.length);
	return out;
}

async function parseSessionFile(filePath: string, signal?: AbortSignal): Promise<ParsedSession | null> {
	const fileName = path.basename(filePath);
	let startedAt = parseSessionStartFromFilename(fileName);
	let currentModel: ModelKey | null = null;

	const modelsUsed = new Set<ModelKey>();
	let messages = 0;
	let tokens = 0;
	let totalCost = 0;
	const costByModel = new Map<ModelKey, number>();
	const messagesByModel = new Map<ModelKey, number>();
	const tokensByModel = new Map<ModelKey, number>();

	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of rl) {
			if (signal?.aborted) {
				rl.close();
				stream.destroy();
				return null;
			}
			if (!line) continue;
			let obj: any;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}

			if (!startedAt && obj?.type === "session" && typeof obj?.timestamp === "string") {
				const d = new Date(obj.timestamp);
				if (Number.isFinite(d.getTime())) startedAt = d;
				continue;
			}

			if (obj?.type === "model_change") {
				const mk = modelKeyFromParts(obj.provider, obj.modelId);
				if (mk) {
					currentModel = mk;
					modelsUsed.add(mk);
				}
				continue;
			}

			if (obj?.type !== "message") continue;

			const { provider, model, modelId, usage } = extractProviderModelAndUsage(obj);
			const mk =
				modelKeyFromParts(provider, model) ??
				modelKeyFromParts(provider, modelId) ??
				currentModel ??
				"unknown";
			modelsUsed.add(mk);

			messages += 1;
			messagesByModel.set(mk, (messagesByModel.get(mk) ?? 0) + 1);

			const tok = extractTokensTotal(usage);
			if (tok > 0) {
				tokens += tok;
				tokensByModel.set(mk, (tokensByModel.get(mk) ?? 0) + tok);
			}

			const cost = extractCostTotal(usage);
			if (cost > 0) {
				totalCost += cost;
				costByModel.set(mk, (costByModel.get(mk) ?? 0) + cost);
			}
		}
	} finally {
		rl.close();
		stream.destroy();
	}

	if (!startedAt) return null;
	const dayKeyLocal = toLocalDayKey(startedAt);
	return {
		filePath,
		startedAt,
		dayKeyLocal,
		modelsUsed,
		messages,
		tokens,
		totalCost,
		costByModel,
		messagesByModel,
		tokensByModel,
	};
}

function buildRangeAgg(days: number, now: Date): RangeAgg {
	const end = localMidnight(now);
	const start = addDaysLocal(end, -(days - 1));
	const outDays: DayAgg[] = [];
	const dayByKey = new Map<string, DayAgg>();

	for (let i = 0; i < days; i++) {
		const d = addDaysLocal(start, i);
		const dayKeyLocal = toLocalDayKey(d);
		const day: DayAgg = {
			date: d,
			dayKeyLocal,
			sessions: 0,
			messages: 0,
			tokens: 0,
			totalCost: 0,
			costByModel: new Map(),
			sessionsByModel: new Map(),
			messagesByModel: new Map(),
			tokensByModel: new Map(),
		};
		outDays.push(day);
		dayByKey.set(dayKeyLocal, day);
	}

	return {
		days: outDays,
		dayByKey,
		sessions: 0,
		totalMessages: 0,
		totalTokens: 0,
		totalCost: 0,
		modelCost: new Map(),
		modelSessions: new Map(),
		modelMessages: new Map(),
		modelTokens: new Map(),
	};
}

function addSessionToRange(range: RangeAgg, session: ParsedSession): void {
	const day = range.dayByKey.get(session.dayKeyLocal);
	if (!day) return;

	range.sessions += 1;
	range.totalMessages += session.messages;
	range.totalTokens += session.tokens;
	range.totalCost += session.totalCost;
	day.sessions += 1;
	day.messages += session.messages;
	day.tokens += session.tokens;
	day.totalCost += session.totalCost;

	// Sessions-per-model (presence)
	for (const mk of session.modelsUsed) {
		day.sessionsByModel.set(mk, (day.sessionsByModel.get(mk) ?? 0) + 1);
		range.modelSessions.set(mk, (range.modelSessions.get(mk) ?? 0) + 1);
	}

	// Messages-per-model
	for (const [mk, n] of session.messagesByModel.entries()) {
		day.messagesByModel.set(mk, (day.messagesByModel.get(mk) ?? 0) + n);
		range.modelMessages.set(mk, (range.modelMessages.get(mk) ?? 0) + n);
	}

	// Tokens-per-model
	for (const [mk, n] of session.tokensByModel.entries()) {
		day.tokensByModel.set(mk, (day.tokensByModel.get(mk) ?? 0) + n);
		range.modelTokens.set(mk, (range.modelTokens.get(mk) ?? 0) + n);
	}

	// Cost-per-model
	for (const [mk, cost] of session.costByModel.entries()) {
		day.costByModel.set(mk, (day.costByModel.get(mk) ?? 0) + cost);
		range.modelCost.set(mk, (range.modelCost.get(mk) ?? 0) + cost);
	}
}

function sortMapByValueDesc<K extends string>(m: Map<K, number>): Array<{ key: K; value: number }> {
	return [...m.entries()]
		.map(([key, value]) => ({ key, value }))
		.sort((a, b) => b.value - a.value);
}

function choosePaletteFromLast30Days(range30: RangeAgg, topN = 4): {
	modelColors: Map<ModelKey, RGB>;
	otherColor: RGB;
	orderedModels: ModelKey[];
} {
	// Prefer cost if any cost exists, else tokens, else messages, else sessions.
	const costSum = [...range30.modelCost.values()].reduce((a, b) => a + b, 0);
	const popularity =
		costSum > 0
			? range30.modelCost
			: range30.totalTokens > 0
				? range30.modelTokens
				: range30.totalMessages > 0
					? range30.modelMessages
					: range30.modelSessions;

	const sorted = sortMapByValueDesc(popularity);
	const orderedModels = sorted.slice(0, topN).map((x) => x.key);
	const modelColors = new Map<ModelKey, RGB>();
	for (let i = 0; i < orderedModels.length; i++) {
		modelColors.set(orderedModels[i], PALETTE[i % PALETTE.length]);
	}
	return {
		modelColors,
		otherColor: { r: 160, g: 160, b: 160 },
		orderedModels,
	};
}

function dayMixedColor(
	day: DayAgg,
	modelColors: Map<ModelKey, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
): RGB {
	const parts: Array<{ color: RGB; weight: number }> = [];
	let otherWeight = 0;

	let map: Map<ModelKey, number>;
	if (mode === "tokens") {
		map = day.tokens > 0 ? day.tokensByModel : day.messages > 0 ? day.messagesByModel : day.sessionsByModel;
	} else if (mode === "messages") {
		map = day.messages > 0 ? day.messagesByModel : day.sessionsByModel;
	} else {
		map = day.sessionsByModel;
	}

	for (const [mk, w] of map.entries()) {
		const c = modelColors.get(mk);
		if (c) parts.push({ color: c, weight: w });
		else otherWeight += w;
	}
	if (otherWeight > 0) parts.push({ color: otherColor, weight: otherWeight });
	return weightedMix(parts);
}

function graphMetricForRange(
	range: RangeAgg,
	mode: MeasurementMode,
): { kind: "sessions" | "messages" | "tokens"; max: number; denom: number } {
	if (mode === "tokens") {
		const maxTokens = Math.max(0, ...range.days.map((d) => d.tokens));
		if (maxTokens > 0) return { kind: "tokens", max: maxTokens, denom: Math.log1p(maxTokens) };
		// fall back if tokens aren't available
		mode = "messages";
	}

	if (mode === "messages") {
		const maxMessages = Math.max(0, ...range.days.map((d) => d.messages));
		if (maxMessages > 0) return { kind: "messages", max: maxMessages, denom: Math.log1p(maxMessages) };
		// fall back if messages aren't available
		mode = "sessions";
	}

	const maxSessions = Math.max(0, ...range.days.map((d) => d.sessions));
	return { kind: "sessions", max: maxSessions, denom: Math.log1p(maxSessions) };
}

function weeksForRange(range: RangeAgg): number {
	const days = range.days;
	const start = days[0].date;
	const end = days[days.length - 1].date;
	const gridStart = addDaysLocal(start, -mondayIndex(start));
	const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
	const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
	return Math.ceil(totalGridDays / 7);
}

function renderGraphLines(
	range: RangeAgg,
	modelColors: Map<ModelKey, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
	options?: { cellWidth?: number; gap?: number },
): string[] {
	const days = range.days;
	const start = days[0].date;
	const end = days[days.length - 1].date;

	const gridStart = addDaysLocal(start, -mondayIndex(start));
	const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
	const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
	const weeks = Math.ceil(totalGridDays / 7);

	const cellWidth = Math.max(1, Math.floor(options?.cellWidth ?? 1));
	const gap = Math.max(0, Math.floor(options?.gap ?? 1));
	const block = "█".repeat(cellWidth);
	const gapStr = " ".repeat(gap);

	const metric = graphMetricForRange(range, mode);
	const denom = metric.denom;

	// Label only Mon/Wed/Fri like GitHub (saves space)
	const labelByRow = new Map<number, string>([
		[0, "Mon"],
		[2, "Wed"],
		[4, "Fri"],
	]);

	const lines: string[] = [];
	for (let row = 0; row < 7; row++) {
		const label = labelByRow.get(row);
		let line = label ? padRight(label, 3) + " " : "    ";

		for (let w = 0; w < weeks; w++) {
			const cellDate = addDaysLocal(gridStart, w * 7 + row);
			const inRange = cellDate >= start && cellDate <= end;
			const colGap = w < weeks - 1 ? gapStr : "";
			if (!inRange) {
				line += " ".repeat(cellWidth) + colGap;
				continue;
			}

			const key = toLocalDayKey(cellDate);
			const day = range.dayByKey.get(key);
			const value =
				metric.kind === "tokens"
					? (day?.tokens ?? 0)
					: metric.kind === "messages"
						? (day?.messages ?? 0)
						: (day?.sessions ?? 0);

			if (!day || value <= 0) {
				line += ansiFg(EMPTY_CELL_BG, block) + colGap;
				continue;
			}

			const hue = dayMixedColor(day, modelColors, otherColor, mode);
			let t = denom > 0 ? Math.log1p(value) / denom : 0;
			t = clamp01(t);
			const minVisible = 0.2;
			const intensity = minVisible + (1 - minVisible) * t;
			const rgb = mixRgb(DEFAULT_BG, hue, intensity);
			line += ansiFg(rgb, block) + colGap;
		}

		lines.push(line);
	}

	return lines;
}

function displayModelName(modelKey: string): string {
	const idx = modelKey.indexOf("/");
	return idx === -1 ? modelKey : modelKey.slice(idx + 1);
}

function renderLegendItems(modelColors: Map<ModelKey, RGB>, orderedModels: ModelKey[], otherColor: RGB): string[] {
	const items: string[] = [];
	for (const mk of orderedModels) {
		const c = modelColors.get(mk);
		if (!c) continue;
		items.push(`${ansiFg(c, "█")} ${displayModelName(mk)}`);
	}
	items.push(`${ansiFg(otherColor, "█")} other`);
	return items;
}

function fitRight(text: string, width: number): string {
	if (width <= 0) return "";
	let w = visibleWidth(text);
	let t = text;
	if (w > width) {
		t = sliceByColumn(t, w - width, width, true);
		w = visibleWidth(t);
	}
	return " ".repeat(Math.max(0, width - w)) + t;
}

function renderLegendBlock(leftLabel: string, items: string[], width: number): string[] {
	if (width <= 0) return [];
	if (items.length === 0) return [truncateToWidth(leftLabel, width)];

	const lines: string[] = [];
	// First line: label on left, first item right-aligned into remaining space.
	const leftW = visibleWidth(leftLabel);
	if (leftW >= width) {
		lines.push(truncateToWidth(leftLabel, width));
		// Put all items on their own lines right-aligned.
		for (const it of items) lines.push(fitRight(it, width));
		return lines;
	}

	const remaining = Math.max(0, width - leftW);
	lines.push(leftLabel + fitRight(items[0], remaining));

	for (let i = 1; i < items.length; i++) {
		lines.push(fitRight(items[i], width));
	}
	return lines;
}

function renderModelTable(range: RangeAgg, mode: MeasurementMode, maxRows = 8): string[] {
	// Keep this relatively narrow: model + selected metric + cost + share.
	const metric = graphMetricForRange(range, mode);
	const kind = metric.kind;

	let perModel: Map<ModelKey, number>;
	let total = 0;
	let label = kind;

	if (kind === "tokens") {
		perModel = range.modelTokens;
		total = range.totalTokens;
	} else if (kind === "messages") {
		perModel = range.modelMessages;
		total = range.totalMessages;
	} else {
		perModel = range.modelSessions;
		total = range.sessions;
	}

	const sorted = sortMapByValueDesc(perModel);
	const rows = sorted.slice(0, maxRows);

	const valueWidth = kind === "tokens" ? 10 : 8;
	const modelWidth = Math.min(52, Math.max("model".length, ...rows.map((r) => r.key.length)));

	const lines: string[] = [];
	lines.push(`${padRight("model", modelWidth)}  ${padLeft(label, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`);
	lines.push(`${"-".repeat(modelWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`);

	for (const r of rows) {
		const value = perModel.get(r.key) ?? 0;
		const cost = range.modelCost.get(r.key) ?? 0;
		const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
		lines.push(
			`${padRight(r.key.slice(0, modelWidth), modelWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
		);
	}

	if (sorted.length === 0) {
		lines.push(dim("(no model data found)"));
	}

	return lines;
}

function renderLeftRight(left: string, right: string, width: number): string {
	const leftW = visibleWidth(left);
	if (width <= 0) return "";
	if (leftW >= width) return truncateToWidth(left, width);

	const remaining = width - leftW;
	let rightText = right;
	const rightW = visibleWidth(rightText);
	if (rightW > remaining) {
		// Keep the *rightmost* part visible.
		rightText = sliceByColumn(rightText, rightW - remaining, remaining, true);
	}
	const pad = Math.max(0, remaining - visibleWidth(rightText));
	return left + " ".repeat(pad) + rightText;
}

function rangeSummary(range: RangeAgg, days: number, mode: MeasurementMode): string {
	const avg = range.sessions > 0 ? range.totalCost / range.sessions : 0;
	const costPart = range.totalCost > 0 ? `${formatUsd(range.totalCost)} · avg ${formatUsd(avg)}/session` : `$0.0000`;

	if (mode === "tokens") {
		return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalTokens)} tokens · ${costPart}`;
	}
	if (mode === "messages") {
		return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalMessages)} messages · ${costPart}`;
	}
	return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${costPart}`;
}

async function computeBreakdown(
	signal?: AbortSignal,
	onProgress?: (update: Partial<BreakdownProgressState>) => void,
): Promise<BreakdownData> {
	const now = new Date();
	const ranges = new Map<number, RangeAgg>();
	for (const d of RANGE_DAYS) ranges.set(d, buildRangeAgg(d, now));
	const range90 = ranges.get(90)!;
	const start90 = range90.days[0].date;

	onProgress?.({ phase: "scan", foundFiles: 0, parsedFiles: 0, totalFiles: 0, currentFile: undefined });

	const candidates = await walkSessionFiles(SESSION_ROOT, start90, signal, (found) => {
		onProgress?.({ phase: "scan", foundFiles: found });
	});

	const totalFiles = candidates.length;
	onProgress?.({
		phase: "parse",
		foundFiles: totalFiles,
		totalFiles,
		parsedFiles: 0,
		currentFile: totalFiles > 0 ? path.basename(candidates[0]!) : undefined,
	});

	let parsedFiles = 0;
	for (const filePath of candidates) {
		if (signal?.aborted) break;
		parsedFiles += 1;
		onProgress?.({ phase: "parse", parsedFiles, totalFiles, currentFile: path.basename(filePath) });

		const session = await parseSessionFile(filePath, signal);
		if (!session) continue;

		const sessionDay = localMidnight(session.startedAt);
		for (const d of RANGE_DAYS) {
			const range = ranges.get(d)!;
			const start = range.days[0].date;
			const end = range.days[range.days.length - 1].date;
			if (sessionDay < start || sessionDay > end) continue;
			addSessionToRange(range, session);
		}
	}

	onProgress?.({ phase: "finalize", currentFile: undefined });

	const palette = choosePaletteFromLast30Days(ranges.get(30)!, 4);
	return { generatedAt: now, ranges, palette };
}

class BreakdownComponent implements Component {
	private data: BreakdownData;
	private tui: TUI;
	private onDone: () => void;
	private rangeIndex = 1; // default 30d
	private measurement: MeasurementMode = "sessions";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(data: BreakdownData, tui: TUI, onDone: () => void) {
		this.data = data;
		this.tui = tui;
		this.onDone = onDone;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") {
			this.onDone();
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || data.toLowerCase() === "t") {
			const order: MeasurementMode[] = ["sessions", "messages", "tokens"];
			const idx = Math.max(0, order.indexOf(this.measurement));
			const dir = matchesKey(data, Key.shift("tab")) ? -1 : 1;
			this.measurement = order[(idx + order.length + dir) % order.length] ?? "sessions";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const prev = () => {
			this.rangeIndex = (this.rangeIndex + RANGE_DAYS.length - 1) % RANGE_DAYS.length;
			this.invalidate();
			this.tui.requestRender();
		};
		const next = () => {
			this.rangeIndex = (this.rangeIndex + 1) % RANGE_DAYS.length;
			this.invalidate();
			this.tui.requestRender();
		};

		if (matchesKey(data, Key.left) || data.toLowerCase() === "h") prev();
		if (matchesKey(data, Key.right) || data.toLowerCase() === "l") next();

		if (data === "1") {
			this.rangeIndex = 0;
			this.invalidate();
			this.tui.requestRender();
		}
		if (data === "2") {
			this.rangeIndex = 1;
			this.invalidate();
			this.tui.requestRender();
		}
		if (data === "3") {
			this.rangeIndex = 2;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const selectedDays = RANGE_DAYS[this.rangeIndex];
		const range = this.data.ranges.get(selectedDays)!;
		const metric = graphMetricForRange(range, this.measurement);

		const tab = (days: number, idx: number): string => {
			const selected = idx === this.rangeIndex;
			const label = `${days}d`;
			return selected ? bold(`[${label}]`) : dim(` ${label} `);
		};

		const metricTab = (mode: MeasurementMode, label: string): string => {
			const selected = mode === this.measurement;
			return selected ? bold(`[${label}]`) : dim(` ${label} `);
		};

		const header =
			`${bold("Session breakdown")}  ${tab(7, 0)} ${tab(30, 1)} ${tab(90, 2)}  ` +
			`${metricTab("sessions", "sess")} ${metricTab("messages", "msg")} ${metricTab("tokens", "tok")}`;

		const legendItems = renderLegendItems(
			this.data.palette.modelColors,
			this.data.palette.orderedModels,
			this.data.palette.otherColor,
		);

		const summary = rangeSummary(range, selectedDays, metric.kind) + dim(`   (graph: ${metric.kind}/day)`);

		const maxScale = selectedDays === 7 ? 4 : selectedDays === 30 ? 3 : 2;
		const weeks = weeksForRange(range);
		const leftMargin = 4; // "Mon " (or 4 spaces)
		const gap = 1;
		const graphArea = Math.max(1, width - leftMargin);
		// Each week column uses: cellWidth + gap. Last column also gets gap (fine; we truncate anyway).
		const idealCellWidth = Math.floor((graphArea + gap) / Math.max(1, weeks)) - gap;
		const cellWidth = Math.min(maxScale, Math.max(1, idealCellWidth));

		const graphLines = renderGraphLines(
			range,
			this.data.palette.modelColors,
			this.data.palette.otherColor,
			this.measurement,
			{ cellWidth, gap },
		);
		const tableLines = renderModelTable(range, metric.kind, 8);

		const lines: string[] = [];
		lines.push(truncateToWidth(header, width));
		lines.push(truncateToWidth(dim("←/→ range · tab metric · q to close"), width));
		lines.push("");
		lines.push(truncateToWidth(summary, width));
		lines.push("");

		// Render legend on the RIGHT of the graph if there is space.
		const graphWidth = Math.max(0, ...graphLines.map((l) => visibleWidth(l)));
		const sep = 2;
		const legendWidth = width - graphWidth - sep;
		const showSideLegend = legendWidth >= 22;

		if (showSideLegend) {
			const legendBlock: string[] = [];
			legendBlock.push(dim("Top models (30d palette):"));
			legendBlock.push(...legendItems);
			// Fit into 7 rows (same as graph). If too many, show a final "+N more" line.
			const maxLegendRows = graphLines.length;
			let legendLines = legendBlock.slice(0, maxLegendRows);
			if (legendBlock.length > maxLegendRows) {
				const remaining = legendBlock.length - (maxLegendRows - 1);
				legendLines = [...legendBlock.slice(0, maxLegendRows - 1), dim(`+${remaining} more`)];
			}
			while (legendLines.length < graphLines.length) legendLines.push("");

			const padRightAnsi = (s: string, target: number): string => {
				const w = visibleWidth(s);
				return w >= target ? s : s + " ".repeat(target - w);
			};

			for (let i = 0; i < graphLines.length; i++) {
				const left = padRightAnsi(graphLines[i] ?? "", graphWidth);
				const right = truncateToWidth(legendLines[i] ?? "", Math.max(0, legendWidth));
				lines.push(truncateToWidth(left + " ".repeat(sep) + right, width));
			}
		} else {
			// Fallback: graph only (legend will be shown below).
			for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
			lines.push("");
			// Compact legend below, left-aligned.
			lines.push(truncateToWidth(dim("Top models (30d palette):"), width));
			for (const it of legendItems) lines.push(truncateToWidth(it, width));
		}

		lines.push("");
		for (const tl of tableLines) lines.push(truncateToWidth(tl, width));

		// Ensure no overly long lines (truncateToWidth already), but keep at least 1 line.
		this.cachedWidth = width;
		this.cachedLines = lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
		return this.cachedLines;
	}
}

export default function sessionBreakdownExtension(pi: ExtensionAPI) {
	pi.registerCommand("session-breakdown", {
		description: "Interactive breakdown of last 7/30/90 days of ~/.pi session usage (sessions/messages/tokens + cost by model)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				// Non-interactive fallback: just notify.
				const data = await computeBreakdown(undefined);
				const range = data.ranges.get(30)!;
				pi.sendMessage(
					{
						customType: "session-breakdown",
						content: `Session breakdown (non-interactive)\n${rangeSummary(range, 30, "sessions")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			let aborted = false;
			const data = await ctx.ui.custom<BreakdownData | null>((tui, theme, _kb, done) => {
				const baseMessage = "Analyzing sessions (last 90 days)…";
				const loader = new BorderedLoader(tui, theme, baseMessage);

				const startedAt = Date.now();
				const progress: BreakdownProgressState = {
					phase: "scan",
					foundFiles: 0,
					parsedFiles: 0,
					totalFiles: 0,
					currentFile: undefined,
				};

				const renderMessage = (): string => {
					const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
					if (progress.phase === "scan") {
						return `${baseMessage}  scanning (${formatCount(progress.foundFiles)} files) · ${elapsed}s`;
					}
					if (progress.phase === "parse") {
						return `${baseMessage}  parsing (${formatCount(progress.parsedFiles)}/${formatCount(progress.totalFiles)}) · ${elapsed}s`;
					}
					return `${baseMessage}  finalizing · ${elapsed}s`;
				};

				let intervalId: NodeJS.Timeout | null = null;
				const stopTicker = () => {
					if (intervalId) {
						clearInterval(intervalId);
						intervalId = null;
					}
				};

				// Update every 0.5s so long-running scans show some visible progress.
				setBorderedLoaderMessage(loader, renderMessage());
				intervalId = setInterval(() => {
					setBorderedLoaderMessage(loader, renderMessage());
				}, 500);

				loader.onAbort = () => {
					aborted = true;
					stopTicker();
					done(null);
				};

				computeBreakdown(loader.signal, (update) => Object.assign(progress, update))
					.then((d) => {
						stopTicker();
						if (!aborted) done(d);
					})
					.catch((err) => {
						stopTicker();
						console.error("session-breakdown: failed to analyze sessions", err);
						if (!aborted) done(null);
					});

				return loader;
			});

			if (!data) {
				ctx.ui.notify(aborted ? "Cancelled" : "Failed to analyze sessions", aborted ? "info" : "error");
				return;
			}

			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				return new BreakdownComponent(data, tui, done);
			});
		},
	});
}
