#!/usr/bin/env node

import { connect } from "./cdp.js";
import {
  applyDevicePreset,
  clearDeviceEmulation,
  listDevicePresets,
  resolveDevicePreset,
} from "./devices.js";
import {
  clearEmulationPreference,
  writeEmulationPreference,
} from "./emulation-state.js";

const DEBUG = process.env.DEBUG === "1";
const log = DEBUG ? (...args) => console.error("[debug]", ...args) : () => {};

const args = process.argv.slice(2);
const landscape = args.includes("--landscape");
const reset = args.includes("--reset");
const list = args.includes("--list");

let deviceName = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--landscape" || arg === "--reset" || arg === "--list") {
    continue;
  }
  if (arg.startsWith("--")) {
    console.log("Usage: emulate.js <device> [--landscape]");
    console.log("       emulate.js --reset");
    console.log("       emulate.js --list");
    process.exit(1);
  }
  if (deviceName) {
    console.error("✗ Only one device preset can be provided");
    process.exit(1);
  }
  deviceName = arg;
}

if (list) {
  const presets = listDevicePresets();
  for (const preset of presets) {
    console.log(
      `${preset.id.padEnd(12)} ${preset.width}x${preset.height} @${preset.deviceScaleFactor}x (${preset.title})`,
    );
  }
  process.exit(0);
}

if (reset && landscape) {
  console.error("✗ --landscape cannot be combined with --reset");
  process.exit(1);
}

if ((reset && deviceName) || (!reset && !deviceName)) {
  console.log("Usage: emulate.js <device> [--landscape]");
  console.log("       emulate.js --reset");
  console.log("       emulate.js --list");
  console.log("\nExamples:");
  console.log("  emulate.js --list");
  console.log("  emulate.js iphone-14");
  console.log("  emulate.js pixel-7 --landscape");
  console.log("  emulate.js --reset");
  process.exit(1);
}

const preset = reset ? null : resolveDevicePreset(deviceName);
if (!reset && !preset) {
  console.error(`✗ Unknown device preset: ${deviceName}`);
  console.error("  Available presets:");
  for (const item of listDevicePresets()) {
    console.error(`  - ${item.id}`);
  }
  process.exit(1);
}

// Global timeout
const globalTimeout = setTimeout(() => {
  console.error("✗ Global timeout exceeded (20s)");
  process.exit(1);
}, 20000);

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

  if (reset) {
    log("clearing emulation...");
    await clearDeviceEmulation(cdp, sessionId);
    clearEmulationPreference();
    console.log("✓ Cleared device emulation");
  } else {
    log("applying emulation...");
    const metrics = await applyDevicePreset(cdp, sessionId, preset, {
      landscape,
    });
    writeEmulationPreference({ device: preset.id, landscape });
    console.log(
      `✓ Emulating ${preset.title} (${preset.id}) at ${metrics.width}x${metrics.height} @${metrics.deviceScaleFactor}x${metrics.landscape ? " landscape" : ""}`,
    );
    console.log("  Saved as active emulation for subsequent skill commands");
    console.log("  Tip: reload the page if you need mobile UA-dependent responses");
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
