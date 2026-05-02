#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_ROOT = join(homedir(), ".cache/agent-web/logs");

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function findLatestFile() {
  if (!existsSync(LOG_ROOT)) return null;
  const dirs = readdirSync(LOG_ROOT)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .map((name) => join(LOG_ROOT, name))
    .filter((path) => statSafe(path)?.isDirectory())
    .sort();
  if (dirs.length === 0) return null;
  const latestDir = dirs[dirs.length - 1];
  const files = readdirSync(latestDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(latestDir, name))
    .map((path) => ({ path, mtime: statSafe(path)?.mtimeMs || 0 }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path || null;
}

const argIndex = process.argv.indexOf("--file");
const filePath = argIndex !== -1 ? process.argv[argIndex + 1] : findLatestFile();

if (!filePath) {
  console.error("✗ No log file found");
  process.exit(1);
}

const statusCounts = new Map();
const failures = [];
let totalResponses = 0;
let totalRequests = 0;

try {
  const data = readFileSync(filePath, "utf8");
  const lines = data.split("\n").filter(Boolean);
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "network.request") {
      totalRequests += 1;
    } else if (entry.type === "network.response") {
      totalResponses += 1;
      const status = String(entry.status ?? "unknown");
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    } else if (entry.type === "network.failure") {
      failures.push({
        requestId: entry.requestId,
        errorText: entry.errorText,
      });
    }
  }
} catch (e) {
  console.error("✗ summary failed:", e.message);
  process.exit(1);
}

console.log(`file: ${filePath}`);
console.log(`requests: ${totalRequests}`);
console.log(`responses: ${totalResponses}`);

const statuses = Array.from(statusCounts.entries()).sort(
  (a, b) => Number(a[0]) - Number(b[0]),
);
for (const [status, count] of statuses) {
  console.log(`status ${status}: ${count}`);
}

if (failures.length > 0) {
  console.log("failures:");
  for (const failure of failures.slice(0, 10)) {
    console.log(`- ${failure.errorText || "unknown"} (${failure.requestId})`);
  }
  if (failures.length > 10) {
    console.log(`- ... ${failures.length - 10} more`);
  }
}
