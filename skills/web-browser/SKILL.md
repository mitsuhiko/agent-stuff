---
name: web-browser
description: "Allows to interact with web pages by performing actions such as clicking buttons, filling out forms, and navigating links. It works by remote controlling Google Chrome or Chromium browsers using the Chrome DevTools Protocol (CDP). When Claude needs to browse the web, it can use this skill to do so."
license: Stolen from Mario
---

# Web Browser Skill

Minimal CDP tools for collaborative site exploration.

## Start Chrome

```bash
./scripts/start.js                  # Isolated reusable profile (default)
./scripts/start.js --profile        # Copy your profile into isolated cache
./scripts/start.js --reset-profile  # Clear selected cached profile before launch
```

Starts Chrome with remote debugging (default port `:9222`).

Profile behavior:
- Default mode uses: `~/.cache/agent-web/browser/fresh-profile`
- `--profile` mode uses: `~/.cache/agent-web/browser/profile-copy`
- The skill **does not attach to your live Chrome profile directly**
- If `:9222` is already used by an unknown instance, start will fail instead of reusing it

If Chrome is installed in a non-standard location, set:

```bash
BROWSER_BIN=/path/to/chrome ./scripts/start.js
```

Optional debug endpoint override:

```bash
BROWSER_DEBUG_PORT=9333 ./scripts/start.js
```

## Navigate

```bash
./scripts/nav.js https://example.com
./scripts/nav.js https://example.com --new
```

Navigate current tab or open new tab.

## Device Emulation (Mobile)

```bash
./scripts/emulate.js --list
./scripts/emulate.js iphone-14
./scripts/emulate.js pixel-7 --landscape
./scripts/emulate.js --reset
```

Set an active device emulation preference (viewport, DPR, touch, UA) for browser skill commands. Use `--reset` to clear.

Commands like `nav.js`, `eval.js`, `pick.js`, `dismiss-cookies.js`, and `screenshot.js` automatically apply the active preference.

## Evaluate JavaScript

```bash
./scripts/eval.js 'document.title'
./scripts/eval.js 'document.querySelectorAll("a").length'
./scripts/eval.js 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(link => !link.href.startsWith("https://")))'
```

Execute JavaScript in active tab (async context). Be careful with string escaping, best to use single quotes.

## Screenshot

```bash
./scripts/screenshot.js
./scripts/screenshot.js --full-page
./scripts/screenshot.js --device iphone-14
./scripts/screenshot.js --device pixel-7 --full-page
```

Takes a screenshot and returns a temp file path.

- Default: current viewport
- `--full-page`: captures full document height
- `--device <preset>`: temporary mobile emulation for that screenshot only

## Pick Elements

```bash
./scripts/pick.js "Click the submit button"
```

Interactive element picker. Click to select, Cmd/Ctrl+Click for multi-select, Enter to finish.

## Dismiss Cookie Dialogs

```bash
./scripts/dismiss-cookies.js          # Accept cookies
./scripts/dismiss-cookies.js --reject # Reject cookies (where possible)
```

Automatically dismisses EU cookie consent dialogs.

Run after navigating to a page:
```bash
./scripts/nav.js https://example.com && ./scripts/dismiss-cookies.js
```

## Quick Mobile Debug Flow

```bash
./scripts/start.js
./scripts/nav.js https://example.com
./scripts/emulate.js iphone-14
./scripts/nav.js https://example.com      # reload with mobile UA
./scripts/dismiss-cookies.js
./scripts/screenshot.js --full-page
```

## Background Logging (Console + Errors + Network)

Automatically started by `start.js` and writes JSONL logs to:

```
~/.cache/agent-web/logs/YYYY-MM-DD/<targetId>.jsonl
```

Manually start:
```bash
./scripts/watch.js
```

Tail latest log:
```bash
./scripts/logs-tail.js           # dump current log and exit
./scripts/logs-tail.js --follow  # keep following
```

Summarize network responses:
```bash
./scripts/net-summary.js
```
