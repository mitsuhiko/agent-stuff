#!/usr/bin/env node

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "./cdp.js";

const LOG_ROOT = join(homedir(), ".cache/agent-web/logs");
const PID_FILE = join(LOG_ROOT, ".pid");

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getDateDir() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return join(LOG_ROOT, `${yyyy}-${mm}-${dd}`);
}

function safeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function compactStack(stackTrace) {
  if (!stackTrace || !Array.isArray(stackTrace.callFrames)) return null;
  return stackTrace.callFrames.slice(0, 8).map((frame) => ({
    functionName: frame.functionName || null,
    url: frame.url || null,
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
  }));
}

function serializeRemoteObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const value =
    Object.prototype.hasOwnProperty.call(obj, "value")
      ? obj.value
      : obj.unserializableValue || obj.description || null;
  return {
    type: obj.type || null,
    subtype: obj.subtype || null,
    value,
    description: obj.description || null,
  };
}

ensureDir(LOG_ROOT);

if (existsSync(PID_FILE)) {
  try {
    const existing = Number(readFileSync(PID_FILE, "utf8").trim());
    if (existing && isProcessAlive(existing)) {
      console.log("✓ watch already running");
      process.exit(0);
    }
  } catch {
    // Ignore and overwrite stale pid.
  }
}

writeFileSync(PID_FILE, String(process.pid));

const dateDir = getDateDir();
ensureDir(dateDir);

const targetState = new Map();
const sessionToTarget = new Map();

function getStreamForTarget(targetId) {
  const state = targetState.get(targetId);
  if (state?.stream) return state.stream;
  const filename = `${safeFileName(targetId)}.jsonl`;
  const filepath = join(dateDir, filename);
  const stream = createWriteStream(filepath, { flags: "a" });
  if (state) state.stream = stream;
  return stream;
}

function writeLog(targetId, payload) {
  const stream = getStreamForTarget(targetId);
  const record = {
    ts: new Date().toISOString(),
    targetId,
    ...payload,
  };
  stream.write(`${JSON.stringify(record)}\n`);
}

async function enableSession(cdp, sessionId) {
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
}

async function attachToTarget(cdp, targetInfo) {
  if (targetInfo.type !== "page") return;
  if (targetState.has(targetInfo.targetId)) return;

  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: targetInfo.targetId,
    flatten: true,
  });

  targetState.set(targetInfo.targetId, {
    sessionId,
    url: targetInfo.url || null,
    title: targetInfo.title || null,
    stream: null,
  });
  sessionToTarget.set(sessionId, targetInfo.targetId);

  await enableSession(cdp, sessionId);
  writeLog(targetInfo.targetId, {
    type: "target.attached",
    url: targetInfo.url || null,
    title: targetInfo.title || null,
  });
}

async function main() {
  const cdp = await connect(5000);

  cdp.on("Target.targetCreated", async (params) => {
    try {
      await attachToTarget(cdp, params.targetInfo);
    } catch (e) {
      console.error("watch: attach error:", e.message);
    }
  });

  cdp.on("Target.targetDestroyed", (params) => {
    const targetId = params.targetId;
    const state = targetState.get(targetId);
    if (state?.stream) state.stream.end();
    targetState.delete(targetId);
    if (state?.sessionId) sessionToTarget.delete(state.sessionId);
  });

  cdp.on("Target.targetInfoChanged", (params) => {
    const info = params.targetInfo;
    const state = targetState.get(info.targetId);
    if (state) {
      state.url = info.url || state.url;
      state.title = info.title || state.title;
      writeLog(info.targetId, {
        type: "target.info",
        url: info.url || null,
        title: info.title || null,
      });
    }
  });

  cdp.on("Runtime.consoleAPICalled", (params, sessionId) => {
    const targetId = sessionToTarget.get(sessionId);
    if (!targetId) return;
    writeLog(targetId, {
      type: "console",
      level: params.type || null,
      args: (params.args || []).map(serializeRemoteObject),
      stack: compactStack(params.stackTrace),
    });
  });

  cdp.on("Runtime.exceptionThrown", (params, sessionId) => {
    const targetId = sessionToTarget.get(sessionId);
    if (!targetId) return;
    const details = params.exceptionDetails || {};
    writeLog(targetId, {
      type: "exception",
      text: details.text || null,
      description: details.exception?.description || null,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
      url: details.url || null,
      stack: compactStack(details.stackTrace),
    });
  });

  cdp.on("Log.entryAdded", (params, sessionId) => {
    const targetId = sessionToTarget.get(sessionId);
    if (!targetId) return;
    const entry = params.entry || {};
    writeLog(targetId, {
      type: "log",
      level: entry.level || null,
      source: entry.source || null,
      text: entry.text || null,
      url: entry.url || null,
      lineNumber: entry.lineNumber ?? null,
    });
  });

  cdp.on("Network.requestWillBeSent", (params, sessionId) => {
    const targetId = sessionToTarget.get(sessionId);
    if (!targetId) return;
    const request = params.request || {};
    writeLog(targetId, {
      type: "network.request",
      requestId: params.requestId,
      method: request.method || null,
      url: request.url || null,
      documentURL: params.documentURL || null,
      initiator: params.initiator?.type || null,
      hasPostData: !!request.hasPostData,
    });
  });

  cdp.on("Network.responseReceived", (params, sessionId) => {
    const targetId = sessionToTarget.get(sessionId);
    if (!targetId) return;
    const response = params.response || {};
    writeLog(targetId, {
      type: "network.response",
      requestId: params.requestId,
      url: response.url || null,
      status: response.status,
      statusText: response.statusText || null,
      mimeType: response.mimeType || null,
      fromDiskCache: !!response.fromDiskCache,
      fromServiceWorker: !!response.fromServiceWorker,
    });
  });

  cdp.on("Network.loadingFailed", (params, sessionId) => {
    const targetId = sessionToTarget.get(sessionId);
    if (!targetId) return;
    writeLog(targetId, {
      type: "network.failure",
      requestId: params.requestId,
      errorText: params.errorText || null,
      canceled: !!params.canceled,
    });
  });

  await cdp.send("Target.setDiscoverTargets", { discover: true });

  const pages = await cdp.getPages();
  for (const page of pages) {
    await attachToTarget(cdp, page);
  }

  console.log("✓ watch started");
}

try {
  await main();
} catch (e) {
  console.error("✗ watch failed:", e.message);
  process.exit(1);
}
