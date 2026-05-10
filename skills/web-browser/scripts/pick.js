#!/usr/bin/env node

import { connect } from "./cdp.js";
import { applyActiveEmulation } from "./emulation-state.js";

const DEBUG = process.env.DEBUG === "1";
const log = DEBUG ? (...args) => console.error("[debug]", ...args) : () => {};

const message = process.argv.slice(2).join(" ");
if (!message) {
  console.log("Usage: pick.js 'message'");
  console.log("\nExample:");
  console.log('  pick.js "Click the submit button"');
  process.exit(1);
}

// Global timeout - 5 minutes for interactive picking
const globalTimeout = setTimeout(() => {
  console.error("✗ Global timeout exceeded (5m)");
  process.exit(1);
}, 300000);

const PICK_SCRIPT = `(message) => {
  if (!message) throw new Error("pick() requires a message parameter");
  return new Promise((resolve) => {
    const selections = [];
    const selectedElements = new Set();

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";

    const highlight = document.createElement("div");
    highlight.style.cssText = "position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.1s";
    overlay.appendChild(highlight);

    const banner = document.createElement("div");
    banner.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;padding:12px 24px;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:auto;z-index:2147483647";

    const updateBanner = () => {
      banner.textContent = message + " (" + selections.length + " selected, Cmd/Ctrl+click to add, Enter to finish, ESC to cancel)";
    };
    updateBanner();

    document.body.append(banner, overlay);

    const cleanup = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      banner.remove();
      selectedElements.forEach((el) => { el.style.outline = ""; });
    };

    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || overlay.contains(el) || banner.contains(el)) return;
      const r = el.getBoundingClientRect();
      highlight.style.cssText = "position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);top:" + r.top + "px;left:" + r.left + "px;width:" + r.width + "px;height:" + r.height + "px";
    };

    const buildElementInfo = (el) => {
      const parents = [];
      let current = el.parentElement;
      while (current && current !== document.body) {
        const parentInfo = current.tagName.toLowerCase();
        const id = current.id ? "#" + current.id : "";
        const cls = current.className ? "." + current.className.trim().split(/\\s+/).join(".") : "";
        parents.push(parentInfo + id + cls);
        current = current.parentElement;
      }
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        class: el.className || null,
        text: (el.textContent || "").trim().slice(0, 200) || null,
        html: el.outerHTML.slice(0, 500),
        parents: parents.join(" > "),
      };
    };

    const onClick = (e) => {
      if (banner.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || overlay.contains(el) || banner.contains(el)) return;

      if (e.metaKey || e.ctrlKey) {
        if (!selectedElements.has(el)) {
          selectedElements.add(el);
          el.style.outline = "3px solid #10b981";
          selections.push(buildElementInfo(el));
          updateBanner();
        }
      } else {
        cleanup();
        const info = buildElementInfo(el);
        resolve(selections.length > 0 ? selections : info);
      }
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        resolve(null);
      } else if (e.key === "Enter" && selections.length > 0) {
        e.preventDefault();
        cleanup();
        resolve(selections);
      }
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}`;

try {
  log("connecting...");
  const cdp = await connect(5000);

  log("getting pages...");
  const pages = await cdp.getPages();
  const page = pages.at(-1);

  if (!page) {
    console.error("✗ No active tab found");
    process.exit(1);
  }

  log("attaching to page...");
  const sessionId = await cdp.attachToPage(page.targetId);

  log("applying active emulation (if configured)...");
  await applyActiveEmulation(cdp, sessionId);

  log("waiting for user pick...");
  const expression = `(${PICK_SCRIPT})(${JSON.stringify(message)})`;
  const result = await cdp.evaluate(sessionId, expression, 300000);

  log("formatting result...");
  if (Array.isArray(result)) {
    for (let i = 0; i < result.length; i++) {
      if (i > 0) console.log("");
      for (const [key, value] of Object.entries(result[i])) {
        console.log(`${key}: ${value}`);
      }
    }
  } else if (typeof result === "object" && result !== null) {
    for (const [key, value] of Object.entries(result)) {
      console.log(`${key}: ${value}`);
    }
  } else {
    console.log(result);
  }

  log("closing...");
  cdp.close();
  log("done");
} catch (e) {
  console.error("✗", e.message);
  process.exit(1);
} finally {
  clearTimeout(globalTimeout);
  setTimeout(() => process.exit(0), 100);
}
