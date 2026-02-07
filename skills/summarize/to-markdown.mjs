#!/usr/bin/env node
/**
 * Convert a URL or local file to Markdown using `uvx markitdown`.
 * Optionally summarize the produced Markdown via `pi` (claude-haiku-4-5).
 *
 * Note: `markitdown` can fetch URLs on its own; this script mainly adds:
 *   - optional writing to a temp file / specific output path
 *   - optional summarization via `pi`
 *   - ability to add a *custom summary prompt/context* (highly recommended)
 *
 * Usage:
 *   node to-markdown.mjs <url-or-path> [--out <file>] [--tmp] [--summary [prompt]] [--prompt <prompt>]
 *
 * Examples:
 *   node to-markdown.mjs https://example.com
 *   node to-markdown.mjs ./spec.pdf --tmp
 *   node to-markdown.mjs ./spec.pdf --summary "Summarize focusing on security and compliance requirements."
 *   node to-markdown.mjs ./spec.pdf --summary --prompt "Extract API endpoints and auth details."
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const argv = process.argv.slice(2);

function usageAndExit(code = 1) {
  console.error('Usage: node to-markdown.mjs <url-or-path> [--out <file>] [--tmp] [--summary [prompt]] [--prompt <prompt>]');
  process.exit(code);
}

function isFlag(s) {
  return typeof s === 'string' && s.startsWith('--');
}

function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function safeName(s) {
  return (s || 'document').replace(/[^a-z0-9._-]+/gi, '_');
}

function getInputBasename(s) {
  if (isUrl(s)) {
    const u = new URL(s);
    const b = basename(u.pathname);
    return safeName(b || 'document');
  }
  return safeName(basename(s));
}

function makeTmpMdPath(input) {
  const dir = join(tmpdir(), 'pi-summarize-out');
  ensureDir(dir);
  const base = getInputBasename(input);
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(16).slice(2, 8);
  return join(dir, `${base}-${stamp}-${rand}.md`);
}

// --- args parsing ---
let input = null;
let outPath = null;
let writeTmp = false;
let doSummary = false;
let summaryPrompt = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];

  if (a === '--out') {
    outPath = argv[i + 1] ?? null;
    if (!outPath || isFlag(outPath)) {
      console.error('Expected a value after --out');
      process.exit(1);
    }
    i++;
    continue;
  }

  if (a === '--tmp') {
    writeTmp = true;
    continue;
  }

  if (a === '--prompt' || a === '--summary-prompt') {
    summaryPrompt = argv[i + 1] ?? null;
    if (!summaryPrompt || isFlag(summaryPrompt)) {
      console.error(`Expected a value after ${a}`);
      process.exit(1);
    }
    i++;
    continue;
  }

  if (a === '--summary') {
    doSummary = true;

    // Allow: --summary "extra instructions" (only if next token isn't a flag and input is already known)
    const next = argv[i + 1];
    if (input && next && !isFlag(next) && summaryPrompt == null) {
      summaryPrompt = next;
      i++;
    }
    continue;
  }

  if (isFlag(a)) {
    console.error(`Unknown flag: ${a}`);
    usageAndExit(1);
  }

  if (!input) {
    input = a;
  } else {
    // Extra bare arg. If summary is enabled and no prompt yet, treat as prompt for convenience.
    if (doSummary && summaryPrompt == null) {
      summaryPrompt = a;
    } else {
      console.error(`Unexpected argument: ${a}`);
      usageAndExit(1);
    }
  }
}

if (!input) usageAndExit(1);

function runMarkitdown(arg) {
  const result = spawnSync('uvx', ['markitdown', arg], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024
  });

  if (result.error) {
    throw new Error(`Failed to run uvx markitdown: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`markitdown failed for ${arg}${stderr ? `\n${stderr}` : ''}`);
  }
  return result.stdout;
}

function summarizeWithPi(markdown, { mdPathForNote = null, extraPrompt = null } = {}) {
  const MAX_CHARS = 140_000;
  let truncated = false;
  let body = markdown;
  if (body.length > MAX_CHARS) {
    // Keep start + end for better summaries.
    const head = body.slice(0, 110_000);
    const tail = body.slice(-20_000);
    body = `${head}\n\n[...TRUNCATED ${body.length - (head.length + tail.length)} chars...]\n\n${tail}`;
    truncated = true;
  }

  const note = mdPathForNote ? `\n\n(Generated markdown file: ${mdPathForNote})\n` : '';
  const truncNote = truncated ? '\n\nNote: Input was truncated due to size.' : '';

  const contextBlock = extraPrompt
    ? `\n\nUser-provided context / instructions (follow these closely):\n${extraPrompt}\n`
    : `\n\nNo extra context was provided. If the summary seems misaligned, ask the user for what to focus on (goals, audience, what to extract).\n`;

  const prompt = `You are summarizing a document that has been converted to Markdown.${note}
${contextBlock}
Please produce:
- A short 1-paragraph executive summary
- 8-15 bullet points of key facts / decisions / requirements
- A section "Open questions / missing info" (bullets)

Be concise. Preserve important numbers, names, and constraints.
${truncNote}

--- BEGIN DOCUMENT (Markdown) ---
${body}
--- END DOCUMENT ---`;

  const result = spawnSync('pi', [
    '--provider', 'anthropic',
    '--model', 'claude-haiku-4-5',
    '--no-tools',
    '--no-session',
    '-p',
    prompt
  ], {
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000
  });

  if (result.error) {
    throw new Error(`Failed to run pi: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`pi failed${stderr ? `\n${stderr}` : ''}`);
  }
  return (result.stdout || '').trim();
}

async function main() {
  if (!isUrl(input) && !existsSync(input)) {
    throw new Error(`File not found: ${input}`);
  }

  const md = runMarkitdown(input);

  // If the user requested an explicit output file, write it there.
  if (outPath) {
    writeFileSync(outPath, md, 'utf-8');
  }

  // When summarizing we *always* write a temp markdown file and always return its path as a hint.
  // When --tmp is passed, we write a temp file as well.
  let tmpMdPath = null;
  if (writeTmp || doSummary) {
    tmpMdPath = makeTmpMdPath(input);
    writeFileSync(tmpMdPath, md, 'utf-8');
  }

  if (writeTmp && tmpMdPath) {
    // When only asked for tmp path, print path and exit.
    if (!doSummary && !outPath) {
      console.log(tmpMdPath);
      return;
    }
  }

  if (doSummary) {
    const summary = summarizeWithPi(md, { mdPathForNote: tmpMdPath ?? outPath, extraPrompt: summaryPrompt });
    process.stdout.write(summary);
    if (tmpMdPath) {
      process.stdout.write(`\n\n[Hint: Full document Markdown saved to: ${tmpMdPath}]\n`);
    }
    return;
  }

  process.stdout.write(md);
}

main().catch(err => {
  console.error(err?.message || String(err));
  process.exit(1);
});
