# Agent Stuff

This repository contains command files and skills that I use in some form with projects.  Note that I usually fine-tune these for projects so they might not work without modification for you.

## Commands

All command files are in the [`commands`](commands) folder:

* [`/handoff`](commands/handoff.md) - Creates detailed handoff plan for session continuation
* [`/pickup`](commands/pickup.md) - Resumes work from previous handoff session
* [`/make-release`](commands/make-release.md) - Automates repository release with version management
* [`/update-changelog`](commands/update-changelog.md) - Updates changelog with recent commits

### Handoff/Pickup Usage

These are inspired by the idea of Ampcode to replace `/compact` with handoff.  I generally do this already by hand with copy/paste but this is an attempt of automating this:

```
/handoff "implement phase 1 of our plan"
```

It will write a handoff plan into .claude/handoffs which you can then continue in a new session:

```
/pickup name-of-handoff
```

### Release Management

The release management commands do not work without tuning!  But you can put claude to them and derive actually working ones.  I for instance use them in [absurd](https://github.com/earendil-works/absurd) and you can look at the repo to see them in use.

## Skills

All skill files are in the [`skills`](skills) folder:

* [`/ghidra`](skills/ghidra) - Claude Skill for reverse engineering binaries using Ghidra's headless analyzer
* [`/web-browser`](skills/web-browser) - Claude Skill for using Puppeteer in a Node environment to browse the web
* [`/tmux`](skills/tmux) - Claude Skill for driving tmux directly with keystrokes and pane output scraping
* [`/sentry`](skills/sentry) - Alternative way to access Sentry as a Claude Skill for reading issues
* [`/improve-skill`](skills/improve-skill) - Claude Skill for analyzing coding agent sessions to improve or create new skills
* [`/pi-share`](skills/pi-share) - Claude Skill for loading and parsing session transcripts from shittycodingagent.ai
* [`/anachb`](skills/anachb) - Claude Skill for querying Austrian public transport (VOR AnachB) for departures, routes, and disruptions
* [`/oebb-scotty`](skills/oebb-scotty) - Claude Skill for Austrian rail travel planning via ÖBB Scotty API

### Browser

In the [`skills/web-browser`](skills/web-browser) folder is a Claude Skill that helps it to use puppeteer in a node environment to browse the web.  This significantly improves on using a browser MCP.  You will need to go into the scripts folder once to run `npm i`.  This was stolen from [Mario Zechner](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/).

### tmux

In the [`skills/tmux`](skills/tmux) folder is a Claude Skill that lets it drive tmux directly for interactive CLI workflows (python, gdb, etc.) by sending keystrokes and scraping pane output.  It uses stock tmux on macOS/Linux and includes helper scripts in `scripts` to find sessions and wait for prompts.

### sentry

In the [`skills/sentry`](skills/sentry) folder there is an alternative way to access Sentry as a Claude Skill.  I found the other methods to talk to Sentry token inefficient and just not great.  Right now it can only read issues though and might not be ideal yet.

### improve-skill

In the [`skills/improve-skill`](skills/improve-skill) folder is a skill that helps analyze coding agent sessions to improve or create new skills.  It works with Claude Code, Pi, and Codex session files.  Ask the agent to "improve the sentry skill based on this session" or "create a new skill from this session" to use it.

### ghidra

In the [`skills/ghidra`](skills/ghidra) folder is a skill for automated reverse engineering using Ghidra's headless analyzer.  It can decompile binaries to C code, extract functions, strings, symbols, and analyze call graphs without needing the GUI.  Requires Ghidra installed (on macOS: `brew install --cask ghidra`).

### pi-share

In the [`skills/pi-share`](skills/pi-share) folder is a skill for loading and parsing session transcripts from shittycodingagent.ai (pi-share) URLs.  It fetches gists, decodes embedded session data, and extracts conversation history including messages, tool calls, and system prompts.

### anachb

In the [`skills/anachb`](skills/anachb) folder is a skill for querying Austrian public transport via the VOR AnachB API.  It includes shell scripts for searching stations, getting real-time departures, planning routes between locations, and checking service disruptions.  Covers all Austrian public transport including trains, U-Bahn, trams, and buses.

### oebb-scotty

In the [`skills/oebb-scotty`](skills/oebb-scotty) folder is a skill for Austrian rail travel planning via the ÖBB Scotty HAFAS API.  It documents how to search locations, plan trips between stations, get departure/arrival boards, and fetch service alerts.  Includes jq filters for extracting concise trip summaries from verbose API responses.

## PI Coding Agent Extensions

Custom extensions for the PI Coding Agent can be found in the [`pi-extensions`](pi-extensions) folder:

* [`qna.ts`](pi-extensions/qna.ts) - Extracts questions from the last assistant message into the editor for easy answering. Uses Claude Haiku for cost-efficient extraction when available.
* [`answer.ts`](pi-extensions/answer.ts) - Alternative to `qna.ts` with a custom interactive TUI for answering questions one by one.
* [`review.ts`](pi-extensions/review.ts) - Code review command inspired by Codex. Supports reviewing uncommitted changes, against a base branch (PR style), specific commits, or with custom instructions. Includes Ctrl+R shortcut.
* [`branched-review.ts`](pi-extensions/branched-review.ts) - Isolated code review via `/revy` command. Runs review in a fresh context (without conversation history affecting it), then offers to bring findings back into the main conversation as a summarized message. Useful for getting a "clean" review perspective. Includes Ctrl+B shortcut.
* [`loop.ts`](pi-extensions/loop.ts) - Runs a prompt loop for rapid iterative coding with optional auto-continue control.
* [`reveal.ts`](pi-extensions/reveal.ts) - Finder/Quick Look helper that browses session file references via Ctrl+F or `/files`, with Ctrl+R revealing the latest file and Ctrl+Shift+R opening Quick Look on macOS.
* [`codex-tuning.ts`](pi-extensions/codex-tuning.ts) - Codex tuning helper for collecting samples and tagging outcomes during agent sessions.

## PI Coding Agent Themes

This repository includes custom themes for the PI Coding Agent. The themes can be found in the [`pi-themes`](pi-themes) folder and customize the appearance and behavior of the agent interface.
