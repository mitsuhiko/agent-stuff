---
name: web-browser
description: "Automate and interact with web pages through Chrome or Chromium using the Chrome DevTools Protocol (CDP): navigate, click, fill forms, inspect content, take screenshots, and debug console or network activity. Use when an agent needs a real browser. Prefer headless Chrome unless visible browser interaction is required."
license: Stolen from Mario
---

# Web Browser Skill

Minimal CDP tools for collaborative site exploration.

## Start Chrome (Prefer Headless)

```bash
./scripts/start.js --headless            # Recommended: isolated reusable profile
./scripts/start.js --headless --profile  # Headless with a copy of your profile
./scripts/start.js                       # Visible browser window when needed
./scripts/start.js --headless --reset-profile  # Clear cached profile before launch
```

Starts Chrome with remote debugging (default port `:9222`). **Agents should use `--headless` by default** because it is less disruptive and supports navigation, evaluation, screenshots, emulation, and logging. Use headed mode only when a person needs to see or interact with the browser, such as for `pick.js`, manual authentication, or debugging a headless-specific difference.

The start script only reuses a running browser when its profile and launch mode match. Close the running skill browser before switching between headless and headed mode.

Profile behavior:
- Default mode uses: `~/.cache/agent-web/browser/fresh-profile`
- `--profile` mode uses: `~/.cache/agent-web/browser/profile-copy`
- The skill **does not attach to your live Chrome profile directly**
- If `:9222` is already used by an unknown instance, start will fail instead of reusing it

If Chrome is installed in a non-standard location, set:

```bash
BROWSER_BIN=/path/to/chrome ./scripts/start.js --headless
```

Optional debug endpoint override:

```bash
BROWSER_DEBUG_PORT=9333 ./scripts/start.js --headless
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
./scripts/eval.js 'document.querySelector("button")?.click(); "clicked"'
./scripts/eval.js 'await Promise.resolve(document.title)'
./scripts/eval.js 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(link => !link.href.startsWith("https://")))'
```

Execute JavaScript in the active tab. Input can be an expression or statement list; the console-style completion value is printed and promises/top-level `await` are awaited. Be careful with string escaping, best to use single quotes.

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

Interactive element picker. Click to select, Cmd/Ctrl+Click for multi-select, Enter to finish. This requires headed Chrome; launch `start.js` without `--headless`.

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
./scripts/start.js --headless
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
