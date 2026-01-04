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

## PI Coding Agent Hooks

Custom hooks for the PI Coding Agent can be found in the [`pi-hooks`](pi-hooks) folder:

* [`qna.ts`](pi-hooks/qna.ts) - Extracts questions from the last assistant message into the editor for easy answering. Uses Claude Haiku for cost-efficient extraction when available.
* [`answer.ts`](pi-hooks/answer.ts) - Alternative to `qna.ts` with a custom interactive TUI for answering questions one by one.

## PI Coding Agent Themes

This repository includes custom themes for the PI Coding Agent. The themes can be found in the [`pi-themes`](pi-themes) folder and customize the appearance and behavior of the agent interface.
