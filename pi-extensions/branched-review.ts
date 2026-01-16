/**
 * Branched Review Extension
 *
 * Provides a `/revy` command that runs a code review in a fresh, isolated context
 * (conceptually "branching" from the start of the session). After the review completes,
 * the user is asked if they want to bring the review findings back into the main
 * conversation as a summarized message.
 *
 * This is useful when you want a "clean" review perspective without the accumulated
 * context of the current conversation influencing the review.
 *
 * Usage:
 * - `/revy` - show interactive selector (same as /review)
 * - `/revy uncommitted` - review uncommitted changes
 * - `/revy branch main` - review against main branch
 * - `/revy commit abc123` - review specific commit
 * - `/revy custom "check for security issues"` - custom instructions
 */

import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, BorderedLoader } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

// Review target types (matching review.ts)
type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string }
	| { type: "custom"; instructions: string };

// Prompts (adapted from review.ts / Codex)
const UNCOMMITTED_PROMPT =
	"Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. The diff output below shows the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT_FALLBACK =
	"Review the code changes against the base branch '{branch}'. The diff output below shows changes that would be merged into {branch}. Provide prioritized, actionable findings.";

const COMMIT_PROMPT_WITH_TITLE =
	'Review the code changes introduced by commit {sha} ("{title}"). The diff output below shows the changes in this commit. Provide prioritized, actionable findings.';

const COMMIT_PROMPT = "Review the code changes introduced by commit {sha}. The diff output below shows the changes. Provide prioritized, actionable findings.";

// The detailed review rubric (adapted from Codex's review_prompt.md)
const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code (not speculation).
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Explicitly state scenarios/environments where the issue arises.
6. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
7. Write for quick comprehension without close reading.
8. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Call out newly added dependencies explicitly and explain why they're needed.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Favor fail-fast behavior; avoid logging-and-continue patterns that hide errors.
4. Prefer predictable production behavior; crashing is better than silent degradation.
5. Treat back pressure handling as critical to system stability.
6. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Keep line references as short as possible (avoid ranges over 5-10 lines).
3. At the end, provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
4. Ignore trivial style issues unless they obscure meaning or violate documented standards.

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue.`;

// Model selection - prefer Sonnet for reviews (good balance of quality and cost)
const SONNET_MODEL_ID = "claude-sonnet-4-20250514";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

// Review preset options
const REVIEW_PRESETS = [
	{ value: "baseBranch", label: "Review against a base branch", description: "(PR Style)" },
	{ value: "uncommitted", label: "Review uncommitted changes", description: "" },
	{ value: "commit", label: "Review a commit", description: "" },
	{ value: "custom", label: "Custom review instructions", description: "" },
] as const;

/**
 * Get the merge base between HEAD and a branch
 */
async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	try {
		// First try to get the upstream tracking branch
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

		// Fall back to using the branch directly
		const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", branch]);
		if (code === 0 && mergeBase.trim()) {
			return mergeBase.trim();
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Get git diff for uncommitted changes
 */
async function getUncommittedDiff(pi: ExtensionAPI): Promise<string> {
	// Get staged + unstaged changes
	const { stdout: diffOutput } = await pi.exec("git", ["diff", "HEAD"]);

	// Also get untracked files list
	const { stdout: untrackedFiles } = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"]);

	let result = "";
	if (diffOutput.trim()) {
		result += "=== Staged and Unstaged Changes ===\n" + diffOutput + "\n";
	}
	if (untrackedFiles.trim()) {
		result += "\n=== Untracked Files ===\n" + untrackedFiles;
	}

	return result || "No changes found.";
}

/**
 * Get git diff for a branch comparison
 */
async function getBranchDiff(pi: ExtensionAPI, mergeBase: string): Promise<string> {
	const { stdout, code } = await pi.exec("git", ["diff", mergeBase]);
	if (code !== 0 || !stdout.trim()) {
		return "No changes found compared to base branch.";
	}
	return stdout;
}

/**
 * Get git diff for a specific commit
 */
async function getCommitDiff(pi: ExtensionAPI, sha: string): Promise<string> {
	const { stdout, code } = await pi.exec("git", ["show", sha, "--format="]);
	if (code !== 0 || !stdout.trim()) {
		return `Could not get diff for commit ${sha}.`;
	}
	return stdout;
}

/**
 * Get list of local branches
 */
async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.filter((b) => b.trim());
}

/**
 * Get list of recent commits
 */
async function getRecentCommits(pi: ExtensionAPI, limit: number = 10): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("git", ["log", `--oneline`, `-n`, `${limit}`]);
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

/**
 * Get the default branch (main or master)
 */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	// Try to get from remote HEAD
	const { stdout, code } = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim().replace("origin/", "");
	}

	// Fall back to checking if main or master exists
	const branches = await getLocalBranches(pi);
	if (branches.includes("main")) return "main";
	if (branches.includes("master")) return "master";

	return "main"; // Default fallback
}

/**
 * Build the full review prompt with diff context
 */
async function buildFullReviewPrompt(pi: ExtensionAPI, target: ReviewTarget): Promise<string> {
	let instructionPrompt: string;
	let diffContent: string;

	switch (target.type) {
		case "uncommitted":
			instructionPrompt = UNCOMMITTED_PROMPT;
			diffContent = await getUncommittedDiff(pi);
			break;

		case "baseBranch": {
			const mergeBase = await getMergeBase(pi, target.branch);
			if (mergeBase) {
				instructionPrompt = BASE_BRANCH_PROMPT_WITH_MERGE_BASE
					.replace(/{baseBranch}/g, target.branch)
					.replace(/{mergeBaseSha}/g, mergeBase);
				diffContent = await getBranchDiff(pi, mergeBase);
			} else {
				instructionPrompt = BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
				// Try direct diff as fallback
				const { stdout } = await pi.exec("git", ["diff", target.branch]);
				diffContent = stdout || "Could not determine diff against branch.";
			}
			break;
		}

		case "commit":
			if (target.title) {
				instructionPrompt = COMMIT_PROMPT_WITH_TITLE
					.replace("{sha}", target.sha)
					.replace("{title}", target.title);
			} else {
				instructionPrompt = COMMIT_PROMPT.replace("{sha}", target.sha);
			}
			diffContent = await getCommitDiff(pi, target.sha);
			break;

		case "custom":
			instructionPrompt = target.instructions;
			// For custom, get uncommitted diff as context
			diffContent = await getUncommittedDiff(pi);
			break;
	}

	// Combine everything into the full prompt
	return `${REVIEW_RUBRIC}

---

## Review Task

${instructionPrompt}

## Code Changes

\`\`\`diff
${diffContent}
\`\`\``;
}

/**
 * Get user-facing hint for the review target
 */
function getUserFacingHint(target: ReviewTarget): string {
	switch (target.type) {
		case "uncommitted":
			return "current changes";
		case "baseBranch":
			return `changes against '${target.branch}'`;
		case "commit": {
			const shortSha = target.sha.slice(0, 7);
			return target.title ? `commit ${shortSha}: ${target.title}` : `commit ${shortSha}`;
		}
		case "custom":
			return target.instructions.length > 40 ? target.instructions.slice(0, 37) + "..." : target.instructions;
	}
}

/**
 * Select the best model for the isolated review
 * Prefer Sonnet for quality, fall back to current model
 */
async function selectReviewModel(
	currentModel: Model<Api>,
	modelRegistry: {
		find: (provider: string, modelId: string) => Model<Api> | undefined;
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	},
): Promise<{ model: Model<Api>; apiKey: string } | null> {
	// Try to use Sonnet for good quality reviews
	if (currentModel.provider === "anthropic") {
		const sonnetModel = modelRegistry.find("anthropic", SONNET_MODEL_ID);
		if (sonnetModel) {
			const apiKey = await modelRegistry.getApiKey(sonnetModel);
			if (apiKey) {
				return { model: sonnetModel, apiKey };
			}
		}
	}

	// Fall back to current model
	const apiKey = await modelRegistry.getApiKey(currentModel);
	if (!apiKey) return null;
	return { model: currentModel, apiKey };
}

/**
 * Select model for summarization (prefer Haiku for speed/cost)
 */
async function selectSummaryModel(
	ctx: ExtensionContext,
): Promise<{ model: Model<Api>; apiKey: string } | null> {
	if (!ctx.model) return null;

	if (ctx.model.provider === "anthropic") {
		const haikuModel = ctx.modelRegistry.find("anthropic", HAIKU_MODEL_ID);
		if (haikuModel) {
			const apiKey = await ctx.modelRegistry.getApiKey(haikuModel);
			if (apiKey) {
				return { model: haikuModel, apiKey };
			}
		}
	}

	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;
	return { model: ctx.model, apiKey };
}

/**
 * Summarize the review for injection into conversation
 */
async function summarizeReview(ctx: ExtensionContext, reviewText: string, hint: string): Promise<string> {
	const selection = await selectSummaryModel(ctx);
	if (!selection) {
		// Fallback: truncate if needed
		if (reviewText.length > 2000) {
			return `## Branched Review Summary (${hint})\n\n${reviewText.slice(0, 1800)}...\n\n[Review truncated for brevity]`;
		}
		return `## Branched Review Summary (${hint})\n\n${reviewText}`;
	}

	const summaryPrompt = `Summarize the following code review findings concisely.
Keep all P0/P1 issues verbatim. For P2/P3, you can be more brief.
Include the overall verdict. Format with markdown.

Review to summarize:
${reviewText}`;

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: summaryPrompt }],
		timestamp: Date.now(),
	};

	try {
		const response = await complete(
			selection.model,
			{
				systemPrompt: "You are a helpful assistant that summarizes code reviews concisely while preserving critical findings.",
				messages: [userMessage],
			},
			{ apiKey: selection.apiKey },
		);

		if (response.stopReason === "aborted" || response.stopReason === "error") {
			return `## Branched Review Results (${hint})\n\n${reviewText}`;
		}

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		return `## Branched Review Summary (${hint})\n\n${summary}`;
	} catch {
		return `## Branched Review Results (${hint})\n\n${reviewText}`;
	}
}

export default function branchedReviewExtension(pi: ExtensionAPI) {
	/**
	 * Show the review preset selector
	 */
	async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const items: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
			value: preset.value,
			label: preset.label,
			description: preset.description,
		}));

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select review type (branched/isolated)"))));

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

		if (!result) return null;

		switch (result) {
			case "uncommitted":
				return { type: "uncommitted" };
			case "baseBranch":
				return await showBranchSelector(ctx);
			case "commit":
				return await showCommitSelector(ctx);
			case "custom":
				return await showCustomInput(ctx);
			default:
				return null;
		}
	}

	/**
	 * Show branch selector
	 */
	async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const branches = await getLocalBranches(pi);
		const defaultBranch = await getDefaultBranch(pi);

		if (branches.length === 0) {
			ctx.ui.notify("No branches found", "error");
			return null;
		}

		// Sort with default first
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

	/**
	 * Show commit selector
	 */
	async function showCommitSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
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
				done(commit ?? null);
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

	/**
	 * Show custom input
	 */
	async function showCustomInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const result = await ctx.ui.editor(
			"Enter review instructions:",
			"Review the code for security vulnerabilities and potential bugs...",
		);

		if (!result?.trim()) return null;
		return { type: "custom", instructions: result.trim() };
	}

	/**
	 * Run the isolated review and show results
	 */
	async function runBranchedReview(ctx: ExtensionContext, target: ReviewTarget): Promise<void> {
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const hint = getUserFacingHint(target);

		// Run the review in an isolated LLM call (this is the "branched" aspect)
		const reviewResult = await ctx.ui.custom<{ text: string; aborted: boolean }>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Running branched review: ${hint}...`);
			loader.onAbort = () => done({ text: "", aborted: true });

			const doReview = async () => {
				// Select the review model
				const selection = await selectReviewModel(ctx.model!, ctx.modelRegistry);
				if (!selection) {
					throw new Error("Could not get API key for model");
				}

				// Build the full prompt with diff context
				const fullPrompt = await buildFullReviewPrompt(pi, target);

				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: fullPrompt }],
					timestamp: Date.now(),
				};

				// Run the review in isolation
				const response = await complete(
					selection.model,
					{
						systemPrompt: "You are an expert code reviewer. Analyze the provided code changes thoroughly.",
						messages: [userMessage],
					},
					{ apiKey: selection.apiKey, signal: loader.signal },
				);

				if (response.stopReason === "aborted") {
					return { text: "", aborted: true };
				}

				const text = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return { text, aborted: false };
			};

			doReview()
				.then(done)
				.catch((err) => {
					ctx.ui.notify(`Review failed: ${err.message}`, "error");
					done({ text: "", aborted: true });
				});

			return loader;
		});

		if (reviewResult.aborted || !reviewResult.text) {
			ctx.ui.notify("Review cancelled", "info");
			return;
		}

		// Show results and ask if user wants to bring them into conversation
		const action = await ctx.ui.custom<"inject" | "copy" | "discard" | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`Branched Review Complete: ${hint}`))));
			container.addChild(new Text(""));

			// Show a preview of the review (truncated)
			const preview = reviewResult.text.length > 500
				? reviewResult.text.slice(0, 500) + "..."
				: reviewResult.text;
			const previewLines = preview.split("\n").map((line) => new Text(theme.fg("muted", line)));
			for (const line of previewLines.slice(0, 15)) {
				container.addChild(line);
			}
			if (previewLines.length > 15) {
				container.addChild(new Text(theme.fg("dim", `... and ${previewLines.length - 15} more lines`)));
			}

			container.addChild(new Text(""));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			const items: SelectItem[] = [
				{ value: "inject", label: "Bring into conversation", description: "(summarize and inject)" },
				{ value: "copy", label: "Copy to clipboard", description: "" },
				{ value: "discard", label: "Discard", description: "" },
			];

			const selectList = new SelectList(items, 3, {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(item.value as "inject" | "copy" | "discard");
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
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

		if (!action || action === "discard") {
			ctx.ui.notify("Review discarded", "info");
			return;
		}

		if (action === "copy") {
			// Put the review in the editor so user can copy it
			ctx.ui.setEditorText(reviewResult.text);
			ctx.ui.notify("Review loaded into editor - copy from there", "info");
			return;
		}

		if (action === "inject") {
			// Summarize and inject into conversation
			ctx.ui.notify("Summarizing review for injection...", "info");

			const summary = await summarizeReview(ctx, reviewResult.text, hint);

			// Send as a custom message that the user can reference
			pi.sendMessage(
				{
					customType: "branched-review",
					content: summary,
					display: true,
				},
				{
					deliverAs: "followUp",
					triggerTurn: false,
				},
			);

			ctx.ui.notify("Review findings added to conversation", "info");
		}
	}

	/**
	 * Parse command arguments
	 */
	function parseArgs(args: string | undefined): ReviewTarget | null {
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

			case "custom": {
				const instructions = parts.slice(1).join(" ");
				if (!instructions) return null;
				return { type: "custom", instructions };
			}

			default:
				return null;
		}
	}

	// Register the /revy command
	pi.registerCommand("revy", {
		description: "Run code review in isolated/branched context, then optionally bring results back",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Branched review requires interactive mode", "error");
				return;
			}

			// Check if we're in a git repository
			const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (code !== 0) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			// Try to parse direct arguments
			let target = parseArgs(args);

			// If no args, show selector
			if (!target) {
				target = await showReviewSelector(ctx);
			}

			if (!target) {
				ctx.ui.notify("Review cancelled", "info");
				return;
			}

			await runBranchedReview(ctx, target);
		},
	});

	// Also register a keyboard shortcut (ctrl+b for "branched" review)
	pi.registerShortcut("ctrl+b", {
		description: "Run branched review (isolated context)",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;

			const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (code !== 0) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			const target = await showReviewSelector(ctx);
			if (target) {
				await runBranchedReview(ctx, target);
			}
		},
	});
}
