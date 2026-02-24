#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, realpathSync } from "fs";
import { spawnSync, execSync } from "child_process";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

function parseArgs(argv) {
	const out = {
		provider: undefined,
		model: undefined,
		purpose: "general research support",
		timeoutMs: 120000,
		json: false,
		help: false,
		query: "",
	};

	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = true;
			continue;
		}
		if (arg === "--json") {
			out.json = true;
			continue;
		}
		if (arg === "--provider") {
			out.provider = argv[++i];
			continue;
		}
		if (arg.startsWith("--provider=")) {
			out.provider = arg.slice("--provider=".length);
			continue;
		}
		if (arg === "--model") {
			out.model = argv[++i];
			continue;
		}
		if (arg.startsWith("--model=")) {
			out.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--purpose") {
			out.purpose = argv[++i] || out.purpose;
			continue;
		}
		if (arg.startsWith("--purpose=")) {
			out.purpose = arg.slice("--purpose=".length) || out.purpose;
			continue;
		}
		if (arg === "--timeout") {
			out.timeoutMs = Math.max(1000, Number(argv[++i] || out.timeoutMs));
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			out.timeoutMs = Math.max(1000, Number(arg.slice("--timeout=".length) || out.timeoutMs));
			continue;
		}
		positional.push(arg);
	}

	out.query = positional.join(" ").trim();
	return out;
}

function usage() {
	return `Usage:
  node search.mjs "<query>" [--purpose "<why>"] [--provider openai-codex|anthropic] [--model <id>] [--json]

Examples:
  node search.mjs "latest python release" --purpose "update dependency notes"
  node search.mjs "HTTP/3 browser support 2026" --provider openai-codex
  node search.mjs "vite 7 breaking changes" --json`;
}

function readJson(path, fallback = {}) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveConfigValue(config) {
	if (typeof config !== "string" || !config) return undefined;
	if (config.startsWith("!")) {
		try {
			const out = execSync(config.slice(1), {
				encoding: "utf8",
				timeout: 10000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return out || undefined;
		} catch {
			return undefined;
		}
	}
	return process.env[config] || config;
}

function getAgentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

function normalizeProvider(provider) {
	if (!provider) return undefined;
	const p = String(provider).toLowerCase().trim();
	if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
	if (p.includes("codex") || p === "openai" || p.startsWith("openai")) return "openai-codex";
	return undefined;
}

function pickProvider(argProvider, settings, auth) {
	const forced = normalizeProvider(argProvider);
	if (forced) return forced;

	const fromSettings = normalizeProvider(settings?.defaultProvider);
	if (fromSettings) return fromSettings;

	if (auth?.["openai-codex"]) return "openai-codex";
	if (auth?.anthropic) return "anthropic";

	throw new Error("Could not determine provider. Pass --provider openai-codex|anthropic");
}

function decodeJwtAccountId(jwt) {
	if (!jwt || typeof jwt !== "string") return undefined;
	try {
		const parts = jwt.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function findPiExecutable() {
	const cmd = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(cmd, ["pi"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const first = result.stdout
		.split(/\r?\n/)
		.map((x) => x.trim())
		.find(Boolean);
	return first || undefined;
}

function collectModuleCandidates() {
	const candidates = new Set();

	const add = (p) => {
		if (!p) return;
		const abs = isAbsolute(p) ? p : resolve(p);
		candidates.add(abs);
	};

	if (process.env.PI_AI_MODULE_PATH) add(process.env.PI_AI_MODULE_PATH);

	const cwd = process.cwd();
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	for (const start of [cwd, scriptDir]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			add(join(dir, "node_modules", "@mariozechner", "pi-ai", "dist", "index.js"));
			add(join(dir, "packages", "ai", "dist", "index.js"));
			add(join(dir, "ai", "dist", "index.js"));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	const piExec = findPiExecutable();
	if (piExec) {
		try {
			const piReal = realpathSync(piExec);
			const piDir = dirname(piReal);
			add(join(piDir, "..", "..", "ai", "dist", "index.js"));
			add(join(piDir, "..", "..", "pi-ai", "dist", "index.js"));
			add(join(piDir, "..", "node_modules", "@mariozechner", "pi-ai", "dist", "index.js"));
			add(join(piDir, "..", "..", "node_modules", "@mariozechner", "pi-ai", "dist", "index.js"));
		} catch {
			// ignore
		}
	}

	add(join(homedir(), "Development", "pi-mono", "packages", "ai", "dist", "index.js"));

	return Array.from(candidates);
}

async function loadPiAi() {
	const tried = [];

	try {
		return await import("@mariozechner/pi-ai");
	} catch (err) {
		tried.push(`@mariozechner/pi-ai (${err?.code || err?.message || "not found"})`);
	}

	for (const candidate of collectModuleCandidates()) {
		if (!existsSync(candidate)) continue;
		try {
			return await import(pathToFileURL(candidate).href);
		} catch (err) {
			tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
		}
	}

	throw new Error(
		`Could not load @mariozechner/pi-ai. Set PI_AI_MODULE_PATH to its dist/index.js.\nTried:\n- ${tried.join("\n- ")}`,
	);
}

function pickFastModel(provider, requestedModel, piAi) {
	const models = typeof piAi.getModels === "function" ? piAi.getModels(provider) : [];
	if (!Array.isArray(models) || models.length === 0) {
		if (requestedModel) return { id: requestedModel, baseUrl: undefined };
		if (provider === "openai-codex") return { id: "gpt-5.1-codex-mini", baseUrl: "https://chatgpt.com/backend-api" };
		return { id: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com" };
	}

	if (requestedModel) {
		const exact = models.find((m) => m.id === requestedModel);
		if (exact) return exact;
		return { ...models[0], id: requestedModel };
	}

	const preferredIds =
		provider === "openai-codex"
			? ["gpt-5.1-codex-mini", "gpt-5.3-codex-spark", "gpt-5.1"]
			: ["claude-haiku-4-5", "claude-3-5-haiku-latest", "claude-3-5-haiku-20241022"];

	for (const id of preferredIds) {
		const found = models.find((m) => m.id === id);
		if (found) return found;
	}

	const heuristic = models.find((m) => /mini|haiku|spark|flash|fast/i.test(m.id));
	return heuristic || models[0];
}

async function resolveApiKey(provider, auth, authPath, piAi) {
	const entry = auth?.[provider];
	if (!entry) {
		throw new Error(`No credentials for provider '${provider}' in ${authPath}`);
	}

	const inferredType = entry.type || (entry.access && entry.refresh ? "oauth" : entry.key ? "api_key" : undefined);

	if (inferredType === "api_key") {
		const key = resolveConfigValue(entry.key);
		if (!key) throw new Error(`API key for ${provider} is empty or unresolved.`);
		return { apiKey: key, accountId: entry.accountId };
	}

	if (inferredType !== "oauth") {
		throw new Error(`Unsupported credential type for ${provider}: ${String(entry.type || "unknown")}`);
	}

	if (typeof piAi.getOAuthApiKey !== "function") {
		throw new Error("Loaded pi-ai module does not export getOAuthApiKey");
	}

	const oauthCreds = {};
	for (const [k, v] of Object.entries(auth || {})) {
		if (v && (v.type === "oauth" || (v.access && v.refresh && v.expires))) {
			oauthCreds[k] = v;
		}
	}

	const refreshed = await piAi.getOAuthApiKey(provider, oauthCreds);
	if (!refreshed) {
		throw new Error(`No OAuth credentials available for provider '${provider}'`);
	}

	const mergedCred = { type: "oauth", ...(entry || {}), ...(refreshed.newCredentials || {}) };
	auth[provider] = mergedCred;
	writeJson(authPath, auth);

	return {
		apiKey: refreshed.apiKey,
		accountId: mergedCred.accountId,
	};
}

function buildUserPrompt(query, purpose) {
	return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function buildSystemPrompt() {
	return "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).";
}

function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api") {
	const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function extractEventData(chunk) {
	const payload = chunk
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	if (!payload || payload === "[DONE]") return null;
	return payload;
}

async function runCodexSearch({ model, apiKey, accountId, query, purpose, timeoutMs, baseUrl }) {
	const tokenAccountId = accountId || decodeJwtAccountId(apiKey);
	if (!tokenAccountId) {
		throw new Error("Could not determine ChatGPT account ID for openai-codex token.");
	}

	const body = {
		model,
		store: false,
		stream: true,
		instructions: buildSystemPrompt(),
		input: [{ role: "user", content: buildUserPrompt(query, purpose) }],
		tools: [{ type: "web_search" }],
		tool_choice: "auto",
	};

	const endpoint = resolveCodexUrl(baseUrl);
	const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"chatgpt-account-id": tokenAccountId,
			"content-type": "application/json",
			accept: "text/event-stream",
			"OpenAI-Beta": "responses=experimental",
			originator: "pi-native-web-search-skill",
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const detail = await res.text();
		throw new Error(`Codex request failed (${res.status}): ${detail}`);
	}
	if (!res.body) {
		throw new Error("Codex response had no body");
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let fallbackText = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const chunk = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			idx = buffer.indexOf("\n\n");

			const data = extractEventData(chunk);
			if (!data) continue;

			let event;
			try {
				event = JSON.parse(data);
			} catch {
				continue;
			}

			if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
				text += event.delta;
			}

			if (event.type === "response.output_item.done" && event.item?.type === "message") {
				const parts = Array.isArray(event.item?.content) ? event.item.content : [];
				const full = parts
					.filter((p) => p.type === "output_text" && typeof p.text === "string")
					.map((p) => p.text)
					.join("\n");
				if (full) fallbackText = full;
			}

			if (event.type === "error") {
				throw new Error(event.message || "Codex stream failed");
			}

			if (event.type === "response.failed") {
				throw new Error(event.response?.error?.message || "Codex response failed");
			}
		}
	}

	const finalText = (text || fallbackText || "").trim();
	if (!finalText) {
		throw new Error("Codex returned an empty response");
	}
	return finalText;
}

function buildAnthropicHeaders(apiKey) {
	const oauthToken = typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
	if (oauthToken) {
		return {
			authorization: `Bearer ${apiKey}`,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20,web-search-2025-03-05",
			"content-type": "application/json",
			accept: "application/json",
			"x-app": "cli",
			"user-agent": "claude-cli/1.0.72 (external, cli)",
		};
	}
	return {
		"x-api-key": apiKey,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "web-search-2025-03-05",
		"content-type": "application/json",
		accept: "application/json",
	};
}

async function runAnthropicSearch({ model, apiKey, query, purpose, timeoutMs }) {
	const body = {
		model,
		max_tokens: 1800,
		temperature: 0,
		system: buildSystemPrompt(),
		tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
		messages: [{ role: "user", content: buildUserPrompt(query, purpose) }],
	};

	const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: buildAnthropicHeaders(apiKey),
		body: JSON.stringify(body),
		signal,
	});

	const payload = await res.text();
	if (!res.ok) {
		throw new Error(`Anthropic request failed (${res.status}): ${payload}`);
	}

	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new Error("Anthropic returned non-JSON response");
	}

	const text = (parsed.content || [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n\n")
		.trim();

	if (!text) {
		throw new Error("Anthropic returned no text content");
	}

	return text;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.query) {
		console.error(usage());
		process.exit(args.help ? 0 : 1);
	}

	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const settingsPath = join(agentDir, "settings.json");
	const auth = readJson(authPath, {});
	const settings = readJson(settingsPath, {});

	const provider = pickProvider(args.provider, settings, auth);
	const piAi = await loadPiAi();
	const model = pickFastModel(provider, args.model, piAi);
	const { apiKey, accountId } = await resolveApiKey(provider, auth, authPath, piAi);

	const text =
		provider === "openai-codex"
			? await runCodexSearch({
					model: model.id,
					apiKey,
					accountId,
					query: args.query,
					purpose: args.purpose,
					timeoutMs: args.timeoutMs,
					baseUrl: model.baseUrl,
			  })
			: await runAnthropicSearch({
					model: model.id,
					apiKey,
					query: args.query,
					purpose: args.purpose,
					timeoutMs: args.timeoutMs,
			  });

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					provider,
					model: model.id,
					query: args.query,
					purpose: args.purpose,
					result: text,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Provider: ${provider}`);
	console.log(`Model: ${model.id}`);
	console.log("");
	console.log(text);
}

main().catch((err) => {
	console.error(`Error: ${err?.message || err}`);
	process.exit(1);
});
