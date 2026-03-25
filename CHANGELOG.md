# Changelog

All notable changes to agent-stuff are documented here.

## Unreleased

* Fixed `intercepted-commands/python` and `intercepted-commands/python3` to skip pyenv/asdf/mise-style shim interpreters when selecting `UV_PYTHON`, preventing recursive `uv run` process chains.
* Fixed `intercepted-commands/python` and `intercepted-commands/python3` to avoid recursive `uv` spawn loops by resolving a uv-managed non-shim interpreter for `uv run --python`.

## 1.5.0

* Added a `multi-edit` extension that replaces `edit` with support for batched `multi` edits and Codex-style `patch` payloads.
* Added preflight validation before mutating files for both `multi` edits and `patch` operations in `multi-edit`.
* Added `/session-breakdown` views for cwd, day-of-week, and time-of-day breakdowns.
* Added `pi-share` support for `pi.dev` URLs and `#session_id` inputs.
* Improved day rendering in `/session-breakdown`.
* Fixed PDF handling in the `summarize` skill.
* Hardened `uv` command handling by blocking pip/poetry bypasses.
* Fixed `web-browser` startup behavior to avoid killing user Chrome instances.
* Updated README extension docs to include `pi-extensions/multi-edit.ts`.

## 1.4.0

* Added a prompt editor extension for managing prompt modes (create, rename, delete, and edit), with persistence and detection fixes.
* Added a loop-fixing mode to `/review` with improved blocking-aware detection, plus branch/commit filtering and related review flow improvements. (#10)
* Added new skills for native web search, cached repository checkout (`librarian`), Google Workspace, and Apple Mail.
* Added a CLI interface for session control and gated control tool registration behind `--session-control`.
* Added the `go-to-bed` late-night safety guard and improved auto-disable behavior.
* Improved `/files` labels by appending git status information.
* Improved `uv` command handling by blocking `py_compile` and suggesting AST-based syntax checks.

## 1.3.0

* Added `/session-breakdown` command with interactive TUI showing sessions, messages, tokens, and cost over the last 7/30/90 days with a GitHub-style contribution calendar.
* Added messages/tokens tracking and large-count abbreviations to `/session-breakdown`.
* Added progress reporting while analyzing sessions in `/session-breakdown`.
* Added `/context` command for viewing context overview.
* Added folder snapshot review mode to `/review`.
* Improved review rubric with lessons from codex.
* Added a `summarize` skill for converting files/URLs to Markdown via `markitdown`.

## 1.2.0

* Updated pi-extensions to use the new `ToolDefinition.execute` parameter order.
* Fixed notify extension notifications to render plain Markdown.

## 1.1.1

* Removed the deprecated `qna` extension.
* Added `uv` extension and skill for uv integration.

## 1.1.0

* Added project review guidelines and preserved review state across navigation.
* Added the `/diff` command to the unified file browser and merged diff/file workflows.
* Added new skills for commits, changelog updates, and frontend design.
* Expanded the whimsical "thinking" messages.
* Added prompts directory configuration support for Pi.
* Fixed reveal shortcut conflicts and improved the PR review editor flow.

## 1.0.5

* Fixed the release CI pipeline for the published package.

## 1.0.4

* Added the session control extension with socket rendering, output retrieval, and copy-todo text actions.
* Added support for session names and custom message types in session control.
* Improved control socket rendering and reconnection handling.
* Added control extension documentation.

## 1.0.3

* Added todo assignments and validation for todo identifiers.
* Added copy-to-clipboard workflows for todos and improved update UX.
* Switched answer tooling to prefer Codex mini and refined prompt refinement.
* Documented todos and refreshed README guidance.

## 1.0.2

* Introduced the todo manager extension (list/list-all, update, delete, and garbage collection).
* Added TODO-prefixed identifiers and refined the todo action menu behavior.
* Improved todo rendering and the refinement workflow ordering.
* Added support for append-only updates without requiring a body.
* Removed the unused codex-tuning extension.

## 1.0.1

* Added core extensions: /answer (Q&A), /review, /files, /reveal, /loop, and cwd history.
* Added skills for Sentry, GitHub, web browsing, tmux, ghidra, pi-share, and Austrian transit APIs.
* Added Pi themes including Night Owl and additional styling.
* Added and refined the commit extension and review workflow.
* Improved packaging and initial repository setup.
