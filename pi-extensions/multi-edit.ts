/**
 * Multi-Edit Extension — replaces the built-in `edit` tool.
 *
 * Supports all original parameters (path, oldText, newText) plus a `multi`
 * parameter that accepts an array of {path, oldText, newText} objects for
 * batch editing.
 *
 * When both top-level params and `multi` are provided, the top-level edit
 * is treated as an implicit first item prepended to the multi list.
 *
 * For multiple edits to the same file, edits are applied sequentially — each
 * one reads the file (including changes from prior edits) and writes it back.
 * This reuses all of the built-in edit tool's fuzzy matching, BOM handling,
 * and diff generation.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditTool, type EditToolDetails } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const editItemSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

const multiEditSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute)" })),
	oldText: Type.Optional(Type.String({ description: "Exact text to find and replace (must match exactly)" })),
	newText: Type.Optional(Type.String({ description: "New text to replace the old text with" })),
	multi: Type.Optional(
		Type.Array(editItemSchema, {
			description: "Multiple edits to apply in sequence. Each item has path, oldText, and newText.",
		}),
	),
});

interface EditItem {
	path: string;
	oldText: string;
	newText: string;
}

interface EditResult {
	path: string;
	success: boolean;
	message: string;
	diff?: string;
	firstChangedLine?: number;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits. Supports a `multi` parameter for batch edits across one or more files.",
		promptSnippet:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		promptGuidelines: [
			"Use edit for precise changes (old text must match exactly)",
			"Use the `multi` parameter to apply multiple edits in a single tool call",
		],
		parameters: multiEditSchema,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path, oldText, newText, multi } = params;

			// Build the list of edits
			const edits: EditItem[] = [];

			// Top-level params become the implicit first edit
			const hasTopLevel =
				path !== undefined && oldText !== undefined && newText !== undefined;

			if (hasTopLevel) {
				edits.push({ path: path!, oldText: oldText!, newText: newText! });
			} else if (
				path !== undefined ||
				oldText !== undefined ||
				newText !== undefined
			) {
				// Partial top-level params are an error
				const missing: string[] = [];
				if (path === undefined) missing.push("path");
				if (oldText === undefined) missing.push("oldText");
				if (newText === undefined) missing.push("newText");
				throw new Error(
					`Incomplete top-level edit: missing ${missing.join(", ")}. ` +
						`Provide all three (path, oldText, newText) or use only the multi parameter.`,
				);
			}

			if (multi) {
				edits.push(...multi);
			}

			if (edits.length === 0) {
				throw new Error(
					"No edits provided. Supply path/oldText/newText or a multi array.",
				);
			}

			// Delegate to the built-in createEditTool for each edit
			const innerTool = createEditTool(ctx.cwd);
			const results: EditResult[] = [];

			for (let i = 0; i < edits.length; i++) {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const edit = edits[i];
				try {
					const result = await innerTool.execute(
						`${toolCallId}_${i}`,
						{ path: edit.path, oldText: edit.oldText, newText: edit.newText },
						signal,
					);

					const details = result.details as EditToolDetails | undefined;
					const text =
						result.content?.[0]?.type === "text"
							? result.content[0].text
							: `Edit ${i + 1} applied.`;

					results.push({
						path: edit.path,
						success: true,
						message: text,
						diff: details?.diff,
						firstChangedLine: details?.firstChangedLine,
					});
				} catch (err: any) {
					// On failure, report what succeeded and what failed
					results.push({
						path: edit.path,
						success: false,
						message: err.message ?? String(err),
					});

					// Stop on first error — remaining edits are not applied
					const summaryLines = formatResults(results, edits.length);
					throw new Error(summaryLines);
				}
			}

			// All edits succeeded
			if (results.length === 1) {
				// Single edit — return the same shape as the built-in tool
				const r = results[0];
				return {
					content: [{ type: "text" as const, text: r.message }],
					details: {
						diff: r.diff ?? "",
						firstChangedLine: r.firstChangedLine,
					},
				};
			}

			// Multiple edits — combined summary
			const combinedDiff = results
				.filter((r) => r.diff)
				.map((r) => r.diff)
				.join("\n");

			const firstChanged = results.find((r) => r.firstChangedLine !== undefined)
				?.firstChangedLine;

			const summary = results
				.map((r, i) => `${i + 1}. ${r.message}`)
				.join("\n");

			return {
				content: [
					{
						type: "text" as const,
						text: `Applied ${results.length} edit(s) successfully.\n${summary}`,
					},
				],
				details: {
					diff: combinedDiff,
					firstChangedLine: firstChanged,
				},
			};
		},
	});
}

function formatResults(results: EditResult[], totalEdits: number): string {
	const lines: string[] = [];

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const status = r.success ? "✓" : "✗";
		lines.push(`${status} Edit ${i + 1}/${totalEdits} (${r.path}): ${r.message}`);
	}

	const remaining = totalEdits - results.length;
	if (remaining > 0) {
		lines.push(`⊘ ${remaining} remaining edit(s) skipped due to error.`);
	}

	return lines.join("\n");
}
