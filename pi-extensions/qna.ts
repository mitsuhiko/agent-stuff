/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Demonstrates the "prompt generator" pattern:
 * 1. /qna command gets the last assistant message
 * 2. Shows a spinner while extracting (hides editor)
 * 3. Loads the result into the editor for user to fill in answers
 */

import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering and format them for the user to fill in.

Output format:
- List each question on its own line, prefixed with "Q: "
- After each question, add a blank line for the answer prefixed with "A: "
- If no questions are found, output "No questions found in the last message."
- When there is important context needed to answer a question, use quote characters (">") and add it into the question block as additional lines.

Example output:
Q: What is your preferred database?
> we can only configure MySQL and PostgreSQL because of what is implemented.
A: 

Q: Should we use TypeScript or JavaScript?
A: 

Keep questions in the order they appeared. Be concise.`;

const HAIKU_MODEL_ID = "claude-haiku-4-5";

/**
 * Check if the current model is a Claude Opus or Sonnet model from Anthropic provider.
 * If so, try to use claude-haiku-4-5 instead for cost efficiency.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: { find: (provider: string, modelId: string) => Model<Api> | undefined; getApiKey: (model: Model<Api>) => Promise<string | undefined> },
): Promise<Model<Api>> {
	// Only consider switching if the provider is anthropic and the model is opus or sonnet
	if (currentModel.provider !== "anthropic") {
		return currentModel;
	}

	const modelId = currentModel.id.toLowerCase();
	const isOpusOrSonnet = modelId.includes("opus") || modelId.includes("sonnet");
	if (!isOpusOrSonnet) {
		return currentModel;
	}

	// Try to find and use claude-haiku-4-5
	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) {
		return currentModel;
	}

	// Check if we have an API key for the haiku model
	const apiKey = await modelRegistry.getApiKey(haikuModel);
	if (!apiKey) {
		return currentModel;
	}

	return haikuModel;
}

export default function (pi: ExtensionAPI) {
	const qnaHandler = async (ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("qna requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Find the last assistant message on the current branch
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			// Select the best model for extraction (prefer haiku for cost efficiency)
			const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

			// Run extraction with loader UI
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
				loader.onAbort = () => done(null);

				// Do the work
				const doExtract = async () => {
					const apiKey = await ctx.modelRegistry.getApiKey(extractionModel);
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					const response = await complete(
						extractionModel,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doExtract()
					.then(done)
					.catch(() => done(null));

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(result);
			ctx.ui.notify("Questions loaded. Edit and submit when ready.", "info");
	};

	pi.registerCommand("qna", {
		description: "Extract questions from last assistant message into editor",
		handler: (_args, ctx) => qnaHandler(ctx),
	});

	pi.registerShortcut("ctrl+,", {
		description: "Extract questions into editor",
		handler: qnaHandler,
	});
}
