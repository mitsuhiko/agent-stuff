# Agent Stuff

This repository contains skills and extensions that I use in some form with projects.  Note that I usually fine-tune these for projects so they might not work without modification for you.

It is released on npm as `mitsupi` for use with the [Pi](https://buildwithpi.ai/) package loader.

## Skills

All skill files are in the [`skills`](skills) folder:

* [`/commit`](skills/commit) - Claude Skill for creating git commits using concise Conventional Commits-style subjects
* [`/update-changelog`](skills/update-changelog) - Claude Skill for updating changelogs with notable user-facing changes
* [`/ghidra`](skills/ghidra) - Claude Skill for reverse engineering binaries using Ghidra's headless analyzer
* [`/github`](skills/github) - Claude Skill for interacting with GitHub via the `gh` CLI (issues, PRs, runs, and APIs)
* [`/openscad`](skills/openscad) - Claude Skill for creating and rendering OpenSCAD 3D models and exporting STL files
* [`/web-browser`](skills/web-browser) - Claude Skill for using Puppeteer in a Node environment to browse the web
* [`/tmux`](skills/tmux) - Claude Skill for driving tmux directly with keystrokes and pane output scraping
* [`/sentry`](skills/sentry) - Alternative way to access Sentry as a Claude Skill for reading issues
* [`/pi-share`](skills/pi-share) - Claude Skill for loading and parsing session transcripts from shittycodingagent.ai
* [`/anachb`](skills/anachb) - Claude Skill for querying Austrian public transport (VOR AnachB) for departures, routes, and disruptions
* [`/oebb-scotty`](skills/oebb-scotty) - Claude Skill for Austrian rail travel planning via ÖBB Scotty API
* [`/frontend-design`](skills/frontend-design) - Claude Skill for designing and implementing distinctive frontend interfaces
* [`/uv`](skills/uv) - Claude Skill for using `uv` for Python dependency management and script execution
* [`/mermaid`](skills/mermaid) - Claude Skill for creating and validating Mermaid diagrams with the official Mermaid CLI

## PI Coding Agent Extensions

Custom extensions for the PI Coding Agent can be found in the [`pi-extensions`](pi-extensions) folder. The package also ships an extra extension focused on increasing reliability:

* [`answer.ts`](pi-extensions/answer.ts) - Interactive TUI for answering questions one by one.
* [`review.ts`](pi-extensions/review.ts) - Code review command inspired by Codex. Supports reviewing uncommitted changes, against a base branch (PR style), specific commits, or with custom instructions. Includes Ctrl+R shortcut.
* [`loop.ts`](pi-extensions/loop.ts) - Runs a prompt loop for rapid iterative coding with optional auto-continue control.
* [`files.ts`](pi-extensions/files.ts) - Unified file browser that merges git status (dirty first) with session references, plus reveal/open/edit and diff actions.
* [`cwd-history.ts`](pi-extensions/cwd-history.ts) - Displays and manages recent working directory history inside the PI Coding Agent.
* [`codex-tuning.ts`](pi-extensions/codex-tuning.ts) - Codex tuning helper for collecting samples and tagging outcomes during agent sessions.
* [`todos.ts`](pi-extensions/todos.ts) - Todo manager extension with file-backed storage and a TUI for listing and editing todos.
* [`notify.ts`](pi-extensions/notify.ts) - Sends native desktop notifications when the agent finishes (OSC 777 compatible terminals).
* [`whimsical.ts`](pi-extensions/whimsical.ts) - Replaces the default "Thinking..." message with random whimsical phrases like "Reticulating splines...", "Consulting the void...", or "Bribing the compiler...".
* [`session-breakdown.ts`](pi-extensions/session-breakdown.ts) - Interactive TUI to analyze the last 7/30/90 days of Pi session usage (sessions + cost by model) with a GitHub-style usage graph.

## PI Coding Agent Themes

This repository includes custom themes for the PI Coding Agent. The themes can be found in the [`pi-themes`](pi-themes) folder and customize the appearance and behavior of the agent interface.

## Plumbing Commands

These command files need customization before use. They live in [`plumbing-commands`](plumbing-commands):

* [`/make-release`](plumbing-commands/make-release.md) - Automates repository release with version management

### Release Management

The plumbing release commands do not work without tuning!  But you can put claude to them and derive actually working ones.  I for instance use them in [absurd](h>
