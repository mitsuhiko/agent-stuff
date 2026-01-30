/**
 * Code Review Extension (inspired by Codex's review feature)
 *
 * Provides a `/review` command that prompts the agent to review code changes.
 * Supports multiple review modes:
 * - Review a GitHub pull request (checks out the PR locally)
 * - Review against a base branch (PR style)
 * - Review uncommitted changes
 * - Review a specific commit
 * - Custom review instructions
 *
 * Usage:
 * - `/review` - show interactive selector
 * - `/review pr 123` - review PR #123 (checks out locally)
 * - `/review pr https://github.com/owner/repo/pull/123` - review PR from URL
 * - `/review uncommitted` - review uncommitted changes directly
 * - `/review branch main` - review against main branch
 * - `/review commit abc123` - review specific commit
 * - `/review custom "check for security issues"` - custom instructions
 *
 * Project-specific review guidelines:
 * - If a REVIEW_GUIDELINES.md file exists in the same directory as .pi,
 *   its contents are appended to the review prompt.
 *
 * Note: PR review requires a clean working tree (no uncommitted changes to tracked files).
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, BorderedLoader } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, Key } from "@mariozechner/pi-tui";
import path from "node:path";
import { promises as fs } from "node:fs";

// State to track fresh session review (where we branched from).
// Module-level state means only one review can be active at a time.
// This is intentional - the UI and /end-review command assume a single active review.
let reviewOriginId: string | undefined = undefined;

const REVIEW_STATE_TYPE = "review-session";

type ReviewSessionState = {
	active: boolean;
	originId?: string;
};

function setReviewWidget(ctx: ExtensionContext, active: boolean) {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setWidget("review", undefined);
		return;
	}

	ctx.ui.setWidget("review", (_tui, theme) => {
		const text = new Text(theme.fg("warning", "Review session active, return with /end-review"), 0, 0);
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

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
	let state: ReviewSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
			state = entry.data as ReviewSessionState | undefined;
		}
	}

	return state;
}

function applyReviewState(ctx: ExtensionContext) {
	const state = getReviewState(ctx);

	if (state?.active && state.originId) {
		reviewOriginId = state.originId;
		setReviewWidget(ctx, true);
		return;
	}

	reviewOriginId = undefined;
	setReviewWidget(ctx, false);
}

// Review target types (matching Codex's approach)
type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string }
	| { type: "custom"; instructions: string }
	| { type: "pullRequest"; prNumber: number; baseBranch: string; title: string };

// Prompts (adapted from Codex)
const UNCOMMITTED_PROMPT =
	"Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT_FALLBACK =
	"Review the code changes against the base branch '{branch}'. Start by finding the merge diff between the current branch and {branch}'s upstream e.g. (`git merge-base HEAD \"$(git rev-parse --abbrev-ref \"{branch}@{upstream}\")\"`), then run `git diff` against that SHA to see what changes we would merge into the {branch} branch. Provide prioritized, actionable findings.";

const COMMIT_PROMPT_WITH_TITLE =
	'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.';

const COMMIT_PROMPT = "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT =
	'Review pull request #{prNumber} ("{title}") against the base branch \'{baseBranch}\'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.';

const PULL_REQUEST_PROMPT_FALLBACK =
	'Review pull request #{prNumber} ("{title}") against the base branch \'{baseBranch}\'. Start by finding the merge base between the current branch and {baseBranch} (e.g., `git merge-base HEAD {baseBranch}`), then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.';

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
7. Ensure that errors are always checked against codes or stable identifiers, never error messages.

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

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
			if (guidelineStats?.isFile()) {
				try {
					const content = await fs.readFile(guidelinesPath, "utf8");
					const trimmed = content.trim();
					return trimmed ? trimmed : null;
				} catch {
					return null;
				}
			}
			return null;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

/**
 * Get the merge base between HEAD and a branch
 */
async function getMergeBase(
	pi: ExtensionAPI,
	branch: string,
): Promise<string | null> {
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
 * Check if there are uncommitted changes (staged, unstaged, or untracked)
 */
async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	return code === 0 && stdout.trim().length > 0;
}

/**
 * Check if there are changes that would prevent switching branches
 * (staged or unstaged changes to tracked files - untracked files are fine)
 */
async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
	// Check for staged or unstaged changes to tracked files
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	if (code !== 0) return false;

	// Filter out untracked files (lines starting with ??)
	const lines = stdout.trim().split("\n").filter((line) => line.trim());
	const trackedChanges = lines.filter((line) => !line.startsWith("??"));
	return trackedChanges.length > 0;
}

/**
 * Parse a PR reference (URL or number) and return the PR number
 */
function parsePrReference(ref: string): number | null {
	const trimmed = ref.trim();

	// Try as a number first
	const num = parseInt(trimmed, 10);
	if (!isNaN(num) && num > 0) {
		return num;
	}

	// Try to extract from GitHub URL
	// Formats: https://github.com/owner/repo/pull/123
	//          github.com/owner/repo/pull/123
	const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
	if (urlMatch) {
		return parseInt(urlMatch[1], 10);
	}

	return null;
}

/**
 * Get PR information from GitHub CLI
 */
async function getPrInfo(pi: ExtensionAPI, prNumber: number): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
	const { stdout, code } = await pi.exec("gh", [
		"pr", "view", String(prNumber),
		"--json", "baseRefName,title,headRefName",
	]);

	if (code !== 0) return null;

	try {
		const data = JSON.parse(stdout);
		return {
			baseBranch: data.baseRefName,
			title: data.title,
			headBranch: data.headRefName,
		};
	} catch {
		return null;
	}
}

/**
 * Checkout a PR using GitHub CLI
 */
async function checkoutPr(pi: ExtensionAPI, prNumber: number): Promise<{ success: boolean; error?: string }> {
	const { stdout, stderr, code } = await pi.exec("gh", ["pr", "checkout", String(prNumber)]);

	if (code !== 0) {
		return { success: false, error: stderr || stdout || "Failed to checkout PR" };
	}

	return { success: true };
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim();
	}
	return null;
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
 * Build the review prompt based on target
 */
async function buildReviewPrompt(pi: ExtensionAPI, target: ReviewTarget): Promise<string> {
	switch (target.type) {
		case "uncommitted":
			return UNCOMMITTED_PROMPT;

		case "baseBranch": {
			const mergeBase = await getMergeBase(pi, target.branch);
			if (mergeBase) {
				return BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(
					/{mergeBaseSha}/g,
					mergeBase,
				);
			}
			return BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
		}

		case "commit":
			if (target.title) {
				return COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace("{title}", target.title);
			}
			return COMMIT_PROMPT.replace("{sha}", target.sha);

		case "custom":
			return target.instructions;

		case "pullRequest": {
			const mergeBase = await getMergeBase(pi, target.baseBranch);
			if (mergeBase) {
				return PULL_REQUEST_PROMPT
					.replace(/{prNumber}/g, String(target.prNumber))
					.replace(/{title}/g, target.title)
					.replace(/{baseBranch}/g, target.baseBranch)
					.replace(/{mergeBaseSha}/g, mergeBase);
			}
			return PULL_REQUEST_PROMPT_FALLBACK
				.replace(/{prNumber}/g, String(target.prNumber))
				.replace(/{title}/g, target.title)
				.replace(/{baseBranch}/g, target.baseBranch);
		}
	}
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

		case "pullRequest": {
			const shortTitle = target.title.length > 30 ? target.title.slice(0, 27) + "..." : target.title;
			return `PR #${target.prNumber}: ${shortTitle}`;
		}
	}
}

// Review preset options for the selector
const REVIEW_PRESETS = [
	{ value: "pullRequest", label: "Review a pull request", description: "(GitHub PR)" },
	{ value: "baseBranch", label: "Review against a base branch", description: "(local)" },
	{ value: "uncommitted", label: "Review uncommitted changes", description: "" },
	{ value: "commit", label: "Review a commit", description: "" },
	{ value: "custom", label: "Custom review instructions", description: "" },
] as const;

export default function reviewExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		applyReviewState(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		applyReviewState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		applyReviewState(ctx);
	});

	/**
	 * Determine the smart default review type based on git state
	 */
	async function getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit"> {
		// Priority 1: If there are uncommitted changes, default to reviewing them
		if (await hasUncommittedChanges(pi)) {
			return "uncommitted";
		}

		// Priority 2: If on a feature branch (not the default branch), default to PR-style review
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);
		if (currentBranch && currentBranch !== defaultBranch) {
			return "baseBranch";
		}

		// Priority 3: Default to reviewing a specific commit
		return "commit";
	}

	/**
	 * Show the review preset selector
	 */
	async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		// Determine smart default and reorder items
		const smartDefault = await getSmartDefault();
		const items: SelectItem[] = REVIEW_PRESETS
			.slice() // copy to avoid mutating original
			.sort((a, b) => {
				// Put smart default first
				if (a.value === smartDefault) return -1;
				if (b.value === smartDefault) return 1;
				return 0;
			})
			.map((preset) => ({
				value: preset.value,
				label: preset.label,
				description: preset.description,
			}));

		while (true) {
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Select a review preset"))));

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

			// Handle each preset type
			switch (result) {
				case "uncommitted":
					return { type: "uncommitted" };

				case "baseBranch": {
					const target = await showBranchSelector(ctx);
					if (target) return target;
					break;
				}

				case "commit": {
					const target = await showCommitSelector(ctx);
					if (target) return target;
					break;
				}

				case "custom": {
					const target = await showCustomInput(ctx);
					if (target) return target;
					break;
				}

				case "pullRequest": {
					const target = await showPrInput(ctx);
					if (target) return target;
					break;
				}

				default:
					return null;
			}
		}
	}

	/**
	 * Show branch selector for base branch review
	 */
	async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const branches = await getLocalBranches(pi);
		const defaultBranch = await getDefaultBranch(pi);

		if (branches.length === 0) {
			ctx.ui.notify("No branches found", "error");
			return null;
		}

		// Sort branches with default branch first
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

			// Enable search
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

			// Enable search
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

	/**
	 * Show custom instructions input
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
	 * Show PR input and handle checkout
	 */
	async function showPrInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		// First check for pending changes that would prevent branch switching
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify("Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.", "error");
			return null;
		}

		// Get PR reference from user
		const prRef = await ctx.ui.editor(
			"Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):",
			"",
		);

		if (!prRef?.trim()) return null;

		const prNumber = parsePrReference(prRef);
		if (!prNumber) {
			ctx.ui.notify("Invalid PR reference. Enter a number or GitHub PR URL.", "error");
			return null;
		}

		// Get PR info from GitHub
		ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
		const prInfo = await getPrInfo(pi, prNumber);

		if (!prInfo) {
			ctx.ui.notify(`Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`, "error");
			return null;
		}

		// Check again for pending changes (in case something changed)
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify("Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.", "error");
			return null;
		}

		// Checkout the PR
		ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
		const checkoutResult = await checkoutPr(pi, prNumber);

		if (!checkoutResult.success) {
			ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, "error");
			return null;
		}

		ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");

		return {
			type: "pullRequest",
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		};
	}

	/**
	 * Execute the review
	 */
	async function executeReview(ctx: ExtensionCommandContext, target: ReviewTarget, useFreshSession: boolean): Promise<void> {
		// Check if we're already in a review
		if (reviewOriginId) {
			ctx.ui.notify("Already in a review. Use /end-review to finish first.", "warning");
			return;
		}

		// Handle fresh session mode
		if (useFreshSession) {
			// Store current position (where we'll return to)
			const originId = ctx.sessionManager.getLeafId() ?? undefined;
			if (!originId) {
				ctx.ui.notify("Failed to determine review origin. Try again from a session with messages.", "error");
				return;
			}
			reviewOriginId = originId;

			// Keep a local copy so session_tree events during navigation don't wipe it
			const lockedOriginId = originId;

			// Find the first user message in the session
			const entries = ctx.sessionManager.getEntries();
			const firstUserMessage = entries.find(
				(e) => e.type === "message" && e.message.role === "user",
			);

			if (!firstUserMessage) {
				ctx.ui.notify("No user message found in session", "error");
				reviewOriginId = undefined;
				return;
			}

			// Navigate to first user message to create a new branch from that point
			// Label it as "code-review" so it's visible in the tree
			try {
				const result = await ctx.navigateTree(firstUserMessage.id, { summarize: false, label: "code-review" });
				if (result.cancelled) {
					reviewOriginId = undefined;
					return;
				}
			} catch (error) {
				// Clean up state if navigation fails
				reviewOriginId = undefined;
				ctx.ui.notify(`Failed to start review: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			// Restore origin after navigation events (session_tree can reset it)
			reviewOriginId = lockedOriginId;

			// Clear the editor (navigating to user message fills it with the message text)
			ctx.ui.setEditorText("");

			// Show widget indicating review is active
			setReviewWidget(ctx, true);

			// Persist review state so tree navigation can restore/reset it
			pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId: lockedOriginId });
		}

		const prompt = await buildReviewPrompt(pi, target);
		const hint = getUserFacingHint(target);
		const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

		// Combine the review rubric with the specific prompt
		let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

		if (projectGuidelines) {
			fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`;
		}

		const modeHint = useFreshSession ? " (fresh session)" : "";
		ctx.ui.notify(`Starting review: ${hint}${modeHint}`, "info");

		// Send as a user message that triggers a turn
		pi.sendUserMessage(fullPrompt);
	}

	/**
	 * Parse command arguments for direct invocation
	 * Returns the target or a special marker for PR that needs async handling
	 */
	function parseArgs(args: string | undefined): ReviewTarget | { type: "pr"; ref: string } | null {
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

			case "pr": {
				const ref = parts[1];
				if (!ref) return null;
				return { type: "pr", ref };
			}

			default:
				return null;
		}
	}

	/**
	 * Handle PR checkout and return a ReviewTarget (or null on failure)
	 */
	async function handlePrCheckout(ctx: ExtensionContext, ref: string): Promise<ReviewTarget | null> {
		// First check for pending changes
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify("Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.", "error");
			return null;
		}

		const prNumber = parsePrReference(ref);
		if (!prNumber) {
			ctx.ui.notify("Invalid PR reference. Enter a number or GitHub PR URL.", "error");
			return null;
		}

		// Get PR info
		ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
		const prInfo = await getPrInfo(pi, prNumber);

		if (!prInfo) {
			ctx.ui.notify(`Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`, "error");
			return null;
		}

		// Checkout the PR
		ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
		const checkoutResult = await checkoutPr(pi, prNumber);

		if (!checkoutResult.success) {
			ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, "error");
			return null;
		}

		ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");

		return {
			type: "pullRequest",
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		};
	}

	// Register the /review command
	pi.registerCommand("review", {
		description: "Review code changes (PR, uncommitted, branch, commit, or custom)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Review requires interactive mode", "error");
				return;
			}

			// Check if we're already in a review
			if (reviewOriginId) {
				ctx.ui.notify("Already in a review. Use /end-review to finish first.", "warning");
				return;
			}

			// Check if we're in a git repository
			const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (code !== 0) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			// Try to parse direct arguments
			let target: ReviewTarget | null = null;
			let fromSelector = false;
			const parsed = parseArgs(args);

			if (parsed) {
				if (parsed.type === "pr") {
					// Handle PR checkout (async operation)
					target = await handlePrCheckout(ctx, parsed.ref);
					if (!target) {
						ctx.ui.notify("PR review failed. Returning to review menu.", "warning");
					}
				} else {
					target = parsed;
				}
			}

			// If no args or invalid args, show selector
			if (!target) {
				fromSelector = true;
			}

			while (true) {
				if (!target && fromSelector) {
					target = await showReviewSelector(ctx);
				}

				if (!target) {
					ctx.ui.notify("Review cancelled", "info");
					return;
				}

				// Determine if we should use fresh session mode
				// Check if this is a new session (no messages yet)
				const entries = ctx.sessionManager.getEntries();
				const messageCount = entries.filter((e) => e.type === "message").length;

				let useFreshSession = false;

				if (messageCount > 0) {
					// Existing session - ask user which mode they want
					const choice = await ctx.ui.select("Start review in:", ["Empty branch", "Current session"]);

					if (choice === undefined) {
						if (fromSelector) {
							target = null;
							continue;
						}
						ctx.ui.notify("Review cancelled", "info");
						return;
					}

					useFreshSession = choice === "Empty branch";
				}
				// If messageCount === 0, useFreshSession stays false (current session mode)

				await executeReview(ctx, target, useFreshSession);
				return;
			}
		},
	});

	// Custom prompt for review summaries - focuses on capturing review findings
	const REVIEW_SUMMARY_PROMPT = `We are switching to a coding session to continue working on the code. 
Create a structured summary of this review branch for context when returning later.
	
You MUST summarize the code review that was performed in this branch so that the user can act on it.

1. What was reviewed (files, changes, scope)
2. Key findings and their priority levels (P0-P3)
3. The overall verdict (correct vs needs attention)
4. Any action items or recommendations

YOU MUST append a message with this EXACT format at the end of your summary:

## Next Steps
1. [What should happen next to act on the review]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Code Review Findings

[P0] Short Title

File: path/to/file.ext:line_number

\`\`\`
affected code snippet
\`\`\`

Preserve exact file paths, function names, and error messages.
`;

	// Register the /end-review command
	pi.registerCommand("end-review", {
		description: "Complete review and return to original position",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("End-review requires interactive mode", "error");
				return;
			}

			// Check if we're in a fresh session review
			if (!reviewOriginId) {
				const state = getReviewState(ctx);
				if (state?.active && state.originId) {
					reviewOriginId = state.originId;
				} else if (state?.active) {
					setReviewWidget(ctx, false);
					pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
					ctx.ui.notify("Review state was missing origin info; cleared review status.", "warning");
					return;
				} else {
					ctx.ui.notify("Not in a review branch (use /review first, or review was started in current session mode)", "info");
					return;
				}
			}

			// Ask about summarization (Summarize is default/first option)
			const summaryChoice = await ctx.ui.select("Summarize review branch?", [
				"Summarize",
				"No summary",
			]);

			if (summaryChoice === undefined) {
				// User cancelled - keep state so they can call /end-review again
				ctx.ui.notify("Cancelled. Use /end-review to try again.", "info");
				return;
			}

			const wantsSummary = summaryChoice === "Summarize";
			const originId = reviewOriginId;

			if (wantsSummary) {
				// Show spinner while summarizing
				const result = await ctx.ui.custom<{ cancelled: boolean; error?: string } | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, "Summarizing review branch...");
					loader.onAbort = () => done(null);

					ctx.navigateTree(originId!, {
						summarize: true,
						customInstructions: REVIEW_SUMMARY_PROMPT,
						replaceInstructions: true,
					})
						.then(done)
						.catch((err) => done({ cancelled: false, error: err instanceof Error ? err.message : String(err) }));

					return loader;
				});

				if (result === null) {
					// User aborted - keep state so they can try again
					ctx.ui.notify("Summarization cancelled. Use /end-review to try again.", "info");
					return;
				}

				if (result.error) {
					// Real error - keep state so they can try again
					ctx.ui.notify(`Summarization failed: ${result.error}`, "error");
					return;
				}

				// Clear state only on success
				setReviewWidget(ctx, false);
				reviewOriginId = undefined;
				pi.appendEntry(REVIEW_STATE_TYPE, { active: false });

				if (result.cancelled) {
					ctx.ui.notify("Navigation cancelled", "info");
					return;
				}

				// Pre-fill prompt if editor is empty
				if (!ctx.ui.getEditorText().trim()) {
					ctx.ui.setEditorText("Act on the code review");
				}

				ctx.ui.notify("Review complete! Returned to original position.", "info");
			} else {
				// No summary - just navigate back
				try {
					const result = await ctx.navigateTree(originId!, { summarize: false });

					if (result.cancelled) {
						// Keep state so they can try again
						ctx.ui.notify("Navigation cancelled. Use /end-review to try again.", "info");
						return;
					}

					// Clear state only on success
					setReviewWidget(ctx, false);
					reviewOriginId = undefined;
					pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
					ctx.ui.notify("Review complete! Returned to original position.", "info");
				} catch (error) {
					// Keep state so they can try again
					ctx.ui.notify(`Failed to return: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
		},
	});
}
