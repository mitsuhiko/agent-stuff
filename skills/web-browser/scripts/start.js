#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEBUG_HOST = process.env.BROWSER_DEBUG_HOST || "localhost";
const DEBUG_PORT = Number(process.env.BROWSER_DEBUG_PORT || 9222);

if (!Number.isInteger(DEBUG_PORT) || DEBUG_PORT < 1 || DEBUG_PORT > 65535) {
  console.error("✗ Invalid BROWSER_DEBUG_PORT (expected 1-65535)");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const useProfile = args.has("--profile");
const resetProfile = args.has("--reset-profile");

const unknownArgs = [...args].filter(
  (arg) => arg !== "--profile" && arg !== "--reset-profile",
);
if (unknownArgs.length > 0) {
  console.log("Usage: start.js [--profile] [--reset-profile]");
  console.log("\nOptions:");
  console.log(
    "  --profile       Copy your default Chrome profile into an isolated cache",
  );
  console.log("  --reset-profile Clear the selected cached profile before launch");
  console.log("\nExamples:");
  console.log("  start.js");
  console.log("  start.js --profile");
  console.log("  start.js --reset-profile");
  process.exit(1);
}

const HOME = process.env["HOME"] || homedir();
const CACHE_ROOT = join(HOME, ".cache", "agent-web");
const BROWSER_ROOT = join(CACHE_ROOT, "browser");
const FRESH_PROFILE_DIR = join(BROWSER_ROOT, "fresh-profile");
const PROFILE_COPY_DIR = join(BROWSER_ROOT, "profile-copy");
const STATE_FILE = join(BROWSER_ROOT, "state.json");

const mode = useProfile ? "profile-copy" : "fresh";
const userDataDir = useProfile ? PROFILE_COPY_DIR : FRESH_PROFILE_DIR;

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  ensureDir(BROWSER_ROOT);
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function clearState() {
  try {
    rmSync(STATE_FILE, { force: true });
  } catch {
    // ignore
  }
}

async function isDebugEndpointUp() {
  try {
    const response = await fetch(
      `http://${DEBUG_HOST}:${DEBUG_PORT}/json/version`,
    );
    return response.ok;
  } catch {
    return false;
  }
}

function resolveChromeBinary() {
  if (process.env.BROWSER_BIN && existsSync(process.env.BROWSER_BIN)) {
    return process.env.BROWSER_BIN;
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];

  return candidates.find((path) => existsSync(path)) || null;
}

ensureDir(BROWSER_ROOT);

if (resetProfile) {
  rmSync(userDataDir, { recursive: true, force: true });
}

const state = readState();
if (state?.pid && !isProcessAlive(state.pid)) {
  clearState();
}

if (await isDebugEndpointUp()) {
  const runningState = readState();

  if (
    runningState?.pid &&
    isProcessAlive(runningState.pid) &&
    runningState.port === DEBUG_PORT
  ) {
    if (
      runningState.mode === mode &&
      runningState.userDataDir === userDataDir
    ) {
      console.log(
        `✓ Chrome already running on :${DEBUG_PORT} (reusing ${mode} profile)`,
      );
      process.exit(0);
    }

    console.error(
      `✗ Chrome already running on :${DEBUG_PORT} in ${runningState.mode} mode`,
    );
    console.error("  Close it first before switching browser profile modes.");
    process.exit(1);
  }

  console.error(`✗ Debugging endpoint :${DEBUG_PORT} is already in use`);
  console.error(
    "  Refusing to reuse unknown instance to avoid attaching to your regular profile.",
  );
  console.error(
    `  Close the process using :${DEBUG_PORT} or set BROWSER_DEBUG_PORT to a different port.`,
  );
  process.exit(1);
}

ensureDir(userDataDir);

if (useProfile) {
  const sourceProfileDir = join(
    HOME,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );

  if (!existsSync(sourceProfileDir)) {
    console.error("✗ Could not find your local Chrome profile directory");
    console.error(`  Expected: ${sourceProfileDir}`);
    process.exit(1);
  }

  execSync(
    `rsync -a --delete --exclude 'Singleton*' --exclude 'DevToolsActivePort*' "${sourceProfileDir}/" "${userDataDir}/"`,
    { stdio: "pipe" },
  );
}

for (const staleFile of [
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "DevToolsActivePort",
  "DevToolsActivePort.lock",
]) {
  try {
    rmSync(join(userDataDir, staleFile), { force: true });
  } catch {
    // ignore
  }
}

const chromeBinary = resolveChromeBinary();

if (!chromeBinary) {
  console.error("✗ Could not find Chrome/Chromium binary");
  console.error("  Set BROWSER_BIN=/path/to/chrome and retry");
  process.exit(1);
}

const chromeArgs = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${userDataDir}`,
  "--profile-directory=Default",
  "--disable-search-engine-choice-screen",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=ProfilePicker",
  "--enable-automation",
];

const chromeProc = spawn(chromeBinary, chromeArgs, {
  detached: true,
  stdio: "ignore",
});
chromeProc.unref();

let connected = false;
for (let i = 0; i < 30; i++) {
  if (await isDebugEndpointUp()) {
    connected = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}

if (!connected) {
  console.error(`✗ Failed to connect to Chrome on :${DEBUG_PORT}`);
  console.error(`  Attempted binary: ${chromeBinary}`);
  process.exit(1);
}

writeState({
  pid: chromeProc.pid,
  mode,
  userDataDir,
  port: DEBUG_PORT,
  startedAt: new Date().toISOString(),
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const watcherPath = join(scriptDir, "watch.js");
spawn(process.execPath, [watcherPath], { detached: true, stdio: "ignore" }).unref();

console.log(
  `✓ Chrome started on :${DEBUG_PORT} with ${useProfile ? "profile-copy" : "fresh"} profile`,
);
if (!useProfile) {
  console.log(`  profile dir: ${userDataDir}`);
}
