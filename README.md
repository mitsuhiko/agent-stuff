# Agent Stuff

Armin's personal [Pi Coding Agent](https://buildwithpi.ai/) package: reusable skills, extensions, prompt commands, themes, and a few supporting utilities that I use across projects.

The package is published to npm as [`mitsupi`](https://www.npmjs.com/package/mitsupi). The Pi package manifest in [`package.json`](package.json) exports:

- [`extensions`](extensions) as Pi extensions
- [`skills`](skills) as agent skills
- [`themes`](themes) as Pi themes
- [`commands`](commands) as prompt commands

Most items are tuned for my workflow and environment, so expect to adjust paths, credentials, or defaults before reusing them elsewhere.

## Prompt Commands

Prompt commands live in [`commands`](commands):

- [`/discuss`](commands/discuss.md) - Planning interviewer mode. It inspects the project first, asks focused questions in short rounds, and stops once the plan is clear enough to implement.

## Skills

Skills live in [`skills`](skills). Each skill has a `SKILL.md` plus any helper scripts it needs.

- [`/anachb`](skills/anachb) - Query Austrian public transport via VOR AnachB: station search, real-time departures, routes, and disruptions.
- [`/apple-mail`](skills/apple-mail) - Search and read Apple Mail's local storage, including raw messages and attachment extraction.
- [`/commit`](skills/commit) - Guidance for making concise git commits with good subjects and bodies.
- [`/frontend-design`](skills/frontend-design) - Create distinctive, production-ready frontend UI with strong visual direction.
- [`/ghidra`](skills/ghidra) - Run Ghidra headless analysis for binaries, functions, strings, symbols, call graphs, and decompilation.
- [`/github`](skills/github) - Use the `gh` CLI for GitHub issues, pull requests, runs, and API queries.
- [`/google-workspace`](skills/google-workspace) - Access Drive, Docs, Calendar, Gmail, Sheets, Slides, Chat, and People APIs through local helper scripts.
- [`/librarian`](skills/librarian) - Cache and refresh remote git repositories under `~/.cache/checkouts/<host>/<org>/<repo>`.
- [`/native-web-search`](skills/native-web-search) - Trigger native web search with concise summaries and source URLs.
- [`/oebb-scotty`](skills/oebb-scotty) - Plan Austrian rail journeys and check ÖBB Scotty station departures, arrivals, trips, and disruptions.
- [`/openscad`](skills/openscad) - Create/render OpenSCAD models, preview angles, extract parameters, validate syntax, and export STL files.
- [`/pi-share`](skills/pi-share) - Fetch and parse shared Pi session transcripts from pi-share URLs.
- [`/sentry`](skills/sentry) - Fetch and analyze Sentry issues, events, transactions, and logs.
- [`/summarize`](skills/summarize) - Convert URLs or local documents to Markdown with `uvx markitdown`, optionally summarizing them.
- [`/tmux`](skills/tmux) - Remote-control tmux sessions for interactive CLIs by sending keystrokes and scraping pane output.
- [`/update-changelog`](skills/update-changelog) - Guidance for updating changelogs with notable user-facing changes.
- [`/uv`](skills/uv) - Prefer `uv` for Python projects, scripts, dependencies, and builds.
- [`/web-browser`](skills/web-browser) - Automate Chrome/Chromium through the Chrome DevTools Protocol.

## Extensions

Pi extensions live in [`extensions`](extensions):

- [`answer.ts`](extensions/answer.ts) - `/answer` plus `ctrl+.` to extract questions from the last assistant message and answer them in an interactive Q&A flow.
- [`btw.ts`](extensions/btw.ts) - `/btw` side-chat popover for quick tangential questions, with thread restore/reset behavior.
- [`control.ts`](extensions/control.ts) - Session control sockets, `/control-sessions`, and the `send_to_session` / `list_sessions` tools for communicating with other live Pi sessions.
- [`files.ts`](extensions/files.ts) - `/files` browser with git status and session references, plus shortcuts to browse, reveal, and Quick Look referenced files.
- [`goal.ts`](extensions/goal.ts) - `/goal` long-running objective mode with automatic continuation and the `get_goal`, `create_goal`, and `update_goal` tools.
- [`unified-edit.ts`](extensions/unified-edit.ts) - Replaces `edit` with a single text payload supporting marked row edit scripts and Codex-style patches with preflight validation.
- [`no-sleep.ts`](extensions/no-sleep.ts) - `/no-sleep` macOS `caffeinate` integration to prevent sleep while an agent or session is active.
- [`notify.ts`](extensions/notify.ts) - Native terminal desktop notification when the agent finishes and is ready for input.
- [`prompt-editor.ts`](extensions/prompt-editor.ts) - `/mode`, `ctrl+shift+m`, and `ctrl+space` prompt-mode selector with persistence and shortcuts.
- [`review.ts`](extensions/review.ts) - `/review` and `/end-review` for reviewing uncommitted changes, branches, commits, PRs, or folder snapshots.
- [`session-breakdown.ts`](extensions/session-breakdown.ts) - `/session-breakdown` TUI for 7/30/90-day session usage, token, model, and cost analysis.
- [`split-fork.ts`](extensions/split-fork.ts) - `/split-fork` to branch the current session into a new Pi process in a right-hand Ghostty split.
- [`todos.ts`](extensions/todos.ts) - `/todos` TUI plus `todo` tool for file-backed tasks in `.pi/todos` or `PI_TODO_PATH`.
- [`trust-github-repos.ts`](extensions/trust-github-repos.ts) - Automatically trusts GitHub checkouts owned by `earendil-works` or `mitsuhiko`.
- [`uv.ts`](extensions/uv.ts) - Replaces the bash tool with a `uv`-aware version that injects Python command shims and blocks common non-`uv` workflows.
- [`whimsical.ts`](extensions/whimsical.ts) - Replaces the default thinking/status text with random whimsical phrases.

## Themes

Custom themes live in [`themes`](themes):

- [`dayowl.json`](themes/dayowl.json) - Light Day Owl-inspired theme.
- [`modern-dark.json`](themes/modern-dark.json) - Dark orange/blue-gray theme.
- [`nightowl.json`](themes/nightowl.json) - Night Owl-inspired theme.

## Support Files and Utilities

- [`intercepted-commands`](intercepted-commands) - Shell shims for `pip`, `pip3`, `poetry`, `python`, and `python3`. These are used by [`extensions/uv.ts`](extensions/uv.ts) to nudge agents toward `uv`.
- [`analyze-edits.py`](analyze-edits.py) - `uv run` script for analyzing `edit` tool usage in Pi session JSONL files.
- [`.github/workflows/npm-publish.yml`](.github/workflows/npm-publish.yml) - Publishes the npm package on semver tags when the tag matches `package.json`.

## Development

Install dependencies with npm:

```sh
npm install
```

Release notes for this repository are in [`CHANGELOG.md`](CHANGELOG.md). The package currently relies on Pi to load TypeScript extensions directly from the paths declared in [`package.json`](package.json).
