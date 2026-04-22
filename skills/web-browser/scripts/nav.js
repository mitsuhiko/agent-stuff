#!/usr/bin/env node

import { connect } from "./cdp.js";
import { applyActiveEmulation } from "./emulation-state.js";

const DEBUG = process.env.DEBUG === "1";
const log = DEBUG ? (...args) => console.error("[debug]", ...args) : () => {};

const url = process.argv[2];
const newTab = process.argv[3] === "--new";

if (!url) {
  console.log("Usage: nav.js <url> [--new]");
  console.log("\nExamples:");
  console.log("  nav.js https://example.com       # Navigate current tab");
  console.log("  nav.js https://example.com --new # Open in new tab");
  process.exit(1);
}

// Global timeout
const globalTimeout = setTimeout(() => {
  console.error("✗ Global timeout exceeded (45s)");
  process.exit(1);
}, 45000);

try {
  log("connecting...");
  const cdp = await connect(5000);

  log("getting pages...");
  let targetId;

  if (newTab) {
    log("creating new tab...");
    const { targetId: newTargetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    targetId = newTargetId;
  } else {
    const pages = await cdp.getPages();
    const page = pages.at(-1);
    if (!page) {
      console.error("✗ No active tab found");
      process.exit(1);
    }
    targetId = page.targetId;
  }

  log("attaching to page...");
  const sessionId = await cdp.attachToPage(targetId);

  log("applying active emulation (if configured)...");
  const activeEmulation = await applyActiveEmulation(cdp, sessionId);

  log("navigating...");
  await cdp.navigate(sessionId, url);

  console.log(newTab ? "✓ Opened:" : "✓ Navigated to:", url);
  if (activeEmulation) {
    console.log(
      `  emulation: ${activeEmulation.preset.id}${activeEmulation.landscape ? " (landscape)" : ""}`,
    );
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
