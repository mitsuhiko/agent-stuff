# Agent Stuff

This repository contains skills and extensions that I use across projects. Note that I often fine-tune these for specific repos, so some items may need small adjustments before reuse.

It is released on npm as `mitsupi` for use with the [Pi](https://buildwithpi.ai/) package loader.

## Skills

All skills live in the [`skills`](skills) folder:

* [`/anachb`](skills/anachb) - Query Austrian public transport (VOR AnachB) for departures, routes, and disruptions.
* [`/apple-mail`](skills/apple-mail) - Search/read Apple Mail local storage and extract attachments.
* [`/commit`](skills/commit) - Create git commits using concise Conventional Commits-style subjects.
* [`/frontend-design`](skills/frontend-design) - Design and implement distinctive frontend interfaces.
* [`/ghidra`](skills/ghidra) - Reverse engineer binaries using Ghidra's headless analyzer.
* [`/github`](skills/github) - Interact with GitHub using the `gh` CLI (issues, PRs, runs, APIs).
* [`/google-workspace`](skills/google-workspace) - Access Google Workspace APIs via local helper scripts.
* [`/librarian`](skills/librarian) - Cache and refresh remote git repositories in `~/.cache/checkouts`.
* [`/mermaid`](skills/mermaid) - Create and validate Mermaid diagrams with Mermaid CLI tooling.
* [`/native-web-search`](skills/native-web-search) - Trigger native web search with concise summaries and source URLs.
* [`/oebb-scotty`](skills/oebb-scotty) - Plan Austrian rail journeys via ÖBB Scotty API.
* [`/openscad`](skills/openscad) - Create/render OpenSCAD models and export STL files.
* [`/pi-share`](skills/pi-share) - Load and parse session transcripts from shittycodingagent.ai/buildwithpi URLs.
* [`/sentry`](skills/sentry) - Fetch and analyze Sentry issues, events, transactions, and logs.
* [`/summarize`](skills/summarize) - Convert files/URLs to Markdown via `uvx markitdown` and summarize.
* [`/tmux`](skills/tmux) - Drive tmux sessions via keystrokes and pane output scraping.
* [`/update-changelog`](skills/update-changelog) - Update changelogs with notable user-facing changes.
* [`/uv`](skills/uv) - Use `uv` for Python dependency management and script execution.
* [`/web-browser`](skills/web-browser) - Browser automation via Chrome/Chromium CDP.

## Pi Coding Agent Extensions

Custom extensions for Pi Coding Agent are in [`pi-extensions`](pi-extensions):

* [`answer.ts`](pi-extensions/answer.ts) - Interactive TUI for answering questions one by one.
* [`context.ts`](pi-extensions/context.ts) - Context breakdown (extensions, skills, AGENTS.md/CLAUDE.md) + token usage, including loaded-skill highlighting.
* [`control.ts`](pi-extensions/control.ts) - Session control helpers (list controllable sessions, etc.).
* [`files.ts`](pi-extensions/files.ts) - Unified file browser with git status + session references and reveal/open/edit/diff actions.
* [`go-to-bed.ts`](pi-extensions/go-to-bed.ts) - Late-night safety guard with explicit confirmation after midnight.
* [`loop.ts`](pi-extensions/loop.ts) - Prompt loop for rapid iterative coding with optional auto-continue.
* [`notify.ts`](pi-extensions/notify.ts) - Native desktop notifications when the agent finishes.
* [`prompt-editor.ts`](pi-extensions/prompt-editor.ts) - In-editor prompt mode selector with persistence, history, config, and shortcuts.
* [`review.ts`](pi-extensions/review.ts) - Code review command (working tree, PR-style diff, commits, custom instructions, optional fix loop).
* [`session-breakdown.ts`](pi-extensions/session-breakdown.ts) - TUI for 7/30/90-day session and cost analysis with usage graph.
* [`todos.ts`](pi-extensions/todos.ts) - Todo manager extension with file-backed storage and TUI.
* [`uv.ts`](pi-extensions/uv.ts) - Helpers for uv-based Python workflows.
* [`whimsical.ts`](pi-extensions/whimsical.ts) - Replaces the default thinking message with random whimsical phrases.

## Pi Coding Agent Themes

Custom themes are in [`pi-themes`](pi-themes):

* [`nightowl.json`](pi-themes/nightowl.json) - Night Owl-inspired theme.

## Plumbing Commands

These command files need customization before use. They live in [`plumbing-commands`](plumbing-commands):

* [`/make-release`](plumbing-commands/make-release.md) - Automates repository release with version management.

## Intercepted Commands

Command wrappers live in [`intercepted-commands`](intercepted-commands):

* [`pip`](intercepted-commands/pip)
* [`pip3`](intercepted-commands/pip3)
* [`poetry`](intercepted-commands/poetry)
* [`python`](intercepted-commands/python)
* [`python3`](intercepted-commands/python3)
