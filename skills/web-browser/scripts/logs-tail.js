#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_ROOT = join(homedir(), ".cache/agent-web/logs");

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

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

const argIndex = process.argv.indexOf("--file");
const filePath = argIndex !== -1 ? process.argv[argIndex + 1] : findLatestFile();
const follow = process.argv.includes("--follow");

if (!filePath) {
  console.error("✗ No log file found");
  process.exit(1);
}

function readAll() {
  if (!existsSync(filePath)) return;
  const data = readFileSync(filePath, "utf8");
  if (data.length > 0) process.stdout.write(data);
}

let offset = 0;

function readNew() {
  if (!existsSync(filePath)) return;
  const data = readFileSync(filePath, "utf8");
  if (data.length <= offset) return;
  const chunk = data.slice(offset);
  offset = data.length;
  process.stdout.write(chunk);
}

try {
  readAll();
  if (!follow) process.exit(0);
  offset = statSafe(filePath)?.size || 0;
  watch(filePath, { persistent: true }, () => readNew());
  console.log(`✓ tailing ${filePath}`);
} catch (e) {
  console.error("✗ tail failed:", e.message);
  process.exit(1);
}
