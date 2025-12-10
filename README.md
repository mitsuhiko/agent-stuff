# Agent Commands

This repository contains command files and skills that I use in some form with projects.  Note that I usually fine-tune these for projects so they might not work without modification for you.

They are divided into two main categories:

* [`common`](common): These are global commands I share across projects.
* [`specific`](specific): These are commands tailored for specific projects and are mostly just for inspiration.
* [`skills`](skills): These are skills for Claude.

## Handoff/Pickup Commands

These are inspired by the idea of Ampcode to replace `/compact` with handoff.  I generally do this already by hand with copy/paste but this is an attempt of automating this:

* [`/handoff`](common/handoff.md) - Creates detailed handoff plan for session continuation
* [`/pickup`](common/pickup.md) - Resumes work from previous handoff session

They are used like this:

```
/handoff "implement phase 1 of our plan"
```

It will write a handoff plan into .claude/handoffs which you can then continue in a new session:

```
/pickup name-of-handoff
```

## Release Management

These are commands that do not work without tuning!  But you can put claude to them and derive actually working ones.  I for instsance use them in [absurd](https://github.com/earendil-works/absurd) and you can look at the repo to see them in use:

* [`/make-release`](specific/make-release.md) - Automates repository release with version management
* [`/update-changelog`](specific/update-changelog.md) - Updates changelog with recent commits

## Browser

In the [`skills/web-browser`](skills/web-browser) folder is a Claude Skill that helps it to use puppeteer in a node environment to browse the web.  This significantly improves on using a browser MCP.  You will need to go intot he tools folder once to run `npm i`.  This was stolen from [Mario Zechner](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/).

## tmux

In the [`skills/tmux`](skills/tmux) folder is a Claude Skill that lets it drive tmux directly for interactive CLI workflows (python, gdb, etc.) by sending keystrokes and scraping pane output.  It uses stock tmux on macOS/Linux and includes helper scripts in `tools` to find sessions and wait for prompts.

## sentry

In the [`skills/sentry`](skills/sentry) folder there is an alternative way to access Sentry as a Claude Skill.  I found the other methods to talk to Sentry token inefficient and just not great.  Right now it can only read issues though and might not be ideal yet.
