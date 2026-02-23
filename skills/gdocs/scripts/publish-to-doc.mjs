#!/usr/bin/env node
/**
 * Publish a YouTube digest to a Google Doc — one tab per day, newest first.
 *
 * Usage:
 *   node publish-to-doc.mjs <file>              # publish file as today's tab
 *   node publish-to-doc.mjs --date 2026-02-22 <file>
 *   echo "content" | node publish-to-doc.mjs    # from stdin
 *   node publish-to-doc.mjs --create "Title"    # create a new doc
 *   node publish-to-doc.mjs --read              # dump all tabs (debug)
 *   node publish-to-doc.mjs --delete-tab "Tab 1" # delete a tab by title
 *
 * Markdown-ish formatting supported:
 *   ### Heading        → HEADING_3
 *   **bold text**      → bold
 *   - bullet item      → bullet list
 *   🔗 https://...     → clickable link
 *   Lines starting with ━ → HEADING_1 (date separators)
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, 'config.json');
const TOKEN_FILE = join(__dirname, 'token.json');

// ── Helpers ────────────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) { console.error('Missing config.json'); process.exit(1); }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

function getAuth(config) {
  if (!existsSync(TOKEN_FILE)) { console.error('Missing token.json — run auth.mjs first.'); process.exit(1); }
  const tokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, 'http://localhost');
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    writeFileSync(TOKEN_FILE, JSON.stringify({ ...tokens, ...newTokens }, null, 2));
  });
  return oauth2Client;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// ── Markdown → Google Docs requests ────────────────────────────────

/**
 * Parse simple markdown into plain text + formatting instructions.
 * Returns { text, formatOps[] } where formatOps are applied after insertion.
 *
 * Each formatOp: { type: 'heading'|'bold'|'bullet'|'link', start, end, ...data }
 */
function parseMarkdown(content) {
  const lines = content.split('\n');
  let text = '';
  const ops = [];

  for (const line of lines) {
    const lineStart = text.length;

    // Heading: ### Title
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length; // 1-6
      const headingText = headingMatch[2];
      text += headingText + '\n';
      ops.push({ type: 'heading', start: lineStart, end: lineStart + headingText.length + 1, level });
      continue;
    }

    // Date separator: lines starting with ━
    if (line.match(/^━/)) {
      text += line + '\n';
      ops.push({ type: 'heading', start: lineStart, end: lineStart + line.length + 1, level: 1 });
      continue;
    }

    // Bullet: - text
    const bulletMatch = line.match(/^[-•]\s+(.+)$/);
    if (bulletMatch) {
      text += bulletMatch[1] + '\n';
      ops.push({ type: 'bullet', start: lineStart, end: lineStart + bulletMatch[1].length + 1 });
      continue;
    }

    // Regular line (may contain **bold** and URLs)
    text += line + '\n';
  }

  // Find **bold** spans in the assembled text
  const boldRe = /\*\*(.+?)\*\*/g;
  let match;
  // We need to strip the ** markers and adjust indices
  // Do this in a second pass
  const boldSpans = [];
  while ((match = boldRe.exec(text)) !== null) {
    boldSpans.push({ fullStart: match.index, fullEnd: match.index + match[0].length, innerText: match[1] });
  }

  // Rebuild text with ** stripped, adjusting all offsets
  let strippedText = '';
  let offset = 0;
  const offsetMap = []; // maps original index → stripped index
  let boldIdx = 0;
  let i = 0;
  const strippedBoldOps = [];

  while (i < text.length) {
    if (boldIdx < boldSpans.length && i === boldSpans[boldIdx].fullStart) {
      const span = boldSpans[boldIdx];
      const strippedStart = strippedText.length;
      strippedText += span.innerText;
      strippedBoldOps.push({ type: 'bold', start: strippedStart, end: strippedStart + span.innerText.length });
      i = span.fullEnd;
      boldIdx++;
    } else {
      strippedText += text[i];
      i++;
    }
  }

  // Adjust ops for the stripped positions
  // We need a mapping from original positions to stripped positions
  // Rebuild the mapping
  const origToStripped = new Array(text.length + 1);
  let si = 0;
  boldIdx = 0;
  for (let oi = 0; oi <= text.length; oi++) {
    if (boldIdx < boldSpans.length && oi === boldSpans[boldIdx].fullStart) {
      // Map fullStart → stripped position
      origToStripped[oi] = si;
      // Skip the opening **
      origToStripped[oi + 1] = si;
      origToStripped[oi + 2] = si;
      // Map inner chars
      for (let k = 0; k < boldSpans[boldIdx].innerText.length; k++) {
        origToStripped[oi + 2 + k] = si + k;
      }
      si += boldSpans[boldIdx].innerText.length;
      // Map closing **
      const closeStart = oi + 2 + boldSpans[boldIdx].innerText.length;
      origToStripped[closeStart] = si;
      origToStripped[closeStart + 1] = si;
      oi = closeStart + 1; // will be incremented by for loop
      boldIdx++;
    } else {
      origToStripped[oi] = si;
      si++;
    }
  }

  // Remap heading/bullet ops
  const adjustedOps = ops.map(op => ({
    ...op,
    start: origToStripped[op.start] ?? op.start,
    end: origToStripped[op.end] ?? op.end,
  }));

  // Find URLs in the stripped text and create link ops
  const urlRe = /(https?:\/\/[^\s)\]]+)/g;
  while ((match = urlRe.exec(strippedText)) !== null) {
    adjustedOps.push({ type: 'link', start: match.index, end: match.index + match[0].length, url: match[0] });
  }

  return { text: strippedText, ops: [...adjustedOps, ...strippedBoldOps] };
}

/**
 * Build Google Docs API requests to insert and format content in a tab.
 */
function buildRequests(tabId, content) {
  const { text, ops } = parseMarkdown(content);
  const requests = [];

  // 1. Insert all text at index 1
  requests.push({
    insertText: {
      location: { index: 1, tabId },
      text,
    },
  });

  // 2. Apply formatting (offsets are relative to index 1)
  const BASE = 1; // text starts at index 1 in the doc

  for (const op of ops) {
    const start = BASE + op.start;
    const end = BASE + op.end;

    switch (op.type) {
      case 'heading': {
        const namedStyle = op.level <= 1 ? 'HEADING_1'
          : op.level === 2 ? 'HEADING_2'
          : op.level === 3 ? 'HEADING_3'
          : op.level === 4 ? 'HEADING_4'
          : 'HEADING_5';
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: start, endIndex: end, tabId },
            paragraphStyle: { namedStyleType: namedStyle },
            fields: 'namedStyleType',
          },
        });
        break;
      }
      case 'bold':
        requests.push({
          updateTextStyle: {
            range: { startIndex: start, endIndex: end, tabId },
            textStyle: { bold: true },
            fields: 'bold',
          },
        });
        break;
      case 'bullet':
        requests.push({
          createParagraphBullets: {
            range: { startIndex: start, endIndex: end, tabId },
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
          },
        });
        break;
      case 'link':
        requests.push({
          updateTextStyle: {
            range: { startIndex: start, endIndex: end, tabId },
            textStyle: { link: { url: op.url } },
            fields: 'link',
          },
        });
        break;
    }
  }

  return requests;
}

// ── Commands ───────────────────────────────────────────────────────

async function createDoc(auth, title) {
  const docs = google.docs({ version: 'v1', auth });
  const doc = await docs.documents.create({ requestBody: { title } });
  const docId = doc.data.documentId;
  console.log(`✅ Created: ${title}`);
  console.log(`   ID:  ${docId}`);
  console.log(`   URL: https://docs.google.com/document/d/${docId}/edit`);
  const config = loadConfig();
  config.doc_id = docId;
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`   Saved doc_id to config.json`);
  return docId;
}

async function listTabs(auth, docId) {
  const docs = google.docs({ version: 'v1', auth });
  const doc = await docs.documents.get({ documentId: docId, includeTabsContent: true });
  const tabs = doc.data.tabs || [];

  function printTab(tab, depth = 0) {
    const props = tab.tabProperties || {};
    const indent = '  '.repeat(depth);
    console.log(`${indent}📑 "${props.title || '(untitled)'}" [id: ${props.tabId}, index: ${props.index}]`);
    for (const child of tab.childTabs || []) {
      printTab(child, depth + 1);
    }
  }

  console.log(`Tabs in doc ${docId}:`);
  for (const tab of tabs) printTab(tab);
  return tabs;
}

async function deleteTabByTitle(auth, docId, title) {
  const docs = google.docs({ version: 'v1', auth });
  const doc = await docs.documents.get({ documentId: docId, includeTabsContent: true });
  const tabs = doc.data.tabs || [];

  function findTab(tabs) {
    for (const tab of tabs) {
      if ((tab.tabProperties?.title || '') === title) return tab.tabProperties.tabId;
      const found = findTab(tab.childTabs || []);
      if (found) return found;
    }
    return null;
  }

  const tabId = findTab(tabs);
  if (!tabId) { console.error(`Tab "${title}" not found.`); process.exit(1); }

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: [{ deleteTab: { tabId } }] },
  });
  console.log(`✅ Deleted tab "${title}" (${tabId})`);
}

async function publishToTab(auth, docId, content, dateStr) {
  const docs = google.docs({ version: 'v1', auth });

  // Check if tab for this date already exists
  const doc = await docs.documents.get({ documentId: docId, includeTabsContent: true });
  const existingTabs = doc.data.tabs || [];
  let tabId = null;

  function findTabByTitle(tabs) {
    for (const tab of tabs) {
      if ((tab.tabProperties?.title || '') === dateStr) return tab.tabProperties.tabId;
      const found = findTabByTitle(tab.childTabs || []);
      if (found) return found;
    }
    return null;
  }

  tabId = findTabByTitle(existingTabs);

  if (tabId) {
    // Tab exists — clear it and rewrite
    const tabDoc = existingTabs.find(t => t.tabProperties?.tabId === tabId);
    const body = tabDoc?.documentTab?.body;
    if (body?.content) {
      const lastEl = body.content[body.content.length - 1];
      const endIndex = lastEl.endIndex;
      if (endIndex > 2) {
        await docs.documents.batchUpdate({
          documentId: docId,
          requestBody: {
            requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1, tabId } } }],
          },
        });
      }
    }
    console.log(`♻️  Updating existing tab "${dateStr}"`);
  } else {
    // Create new tab at index 0 (top)
    const result = await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{
          addDocumentTab: {
            tabProperties: {
              title: dateStr,
              index: 0,
              iconEmoji: '📺',
            },
          },
        }],
      },
    });
    tabId = result.data.replies[0].addDocumentTab.tabProperties.tabId;
    console.log(`📑 Created tab "${dateStr}" (${tabId})`);
  }

  // Insert and format content
  const requests = buildRequests(tabId, content);
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  });

  console.log(`✅ Published ${content.length} chars to tab "${dateStr}"`);
  console.log(`   https://docs.google.com/document/d/${docId}/edit#tab=${tabId}`);
}

// ── Main ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const config = loadConfig();
const auth = getAuth(config);

if (args.includes('--create')) {
  const idx = args.indexOf('--create');
  const title = args[idx + 1] || '📺 YouTube Digest';
  await createDoc(auth, title);

} else if (args.includes('--read')) {
  if (!config.doc_id) { console.error('No doc_id in config.json.'); process.exit(1); }
  await listTabs(auth, config.doc_id);

} else if (args.includes('--delete-tab')) {
  if (!config.doc_id) { console.error('No doc_id in config.json.'); process.exit(1); }
  const idx = args.indexOf('--delete-tab');
  const title = args[idx + 1];
  if (!title) { console.error('Usage: --delete-tab "Tab Title"'); process.exit(1); }
  await deleteTabByTitle(auth, config.doc_id, title);

} else {
  // Publish mode
  if (!config.doc_id) { console.error('No doc_id in config.json. Run with --create first.'); process.exit(1); }

  // Parse --date flag
  let dateStr;
  const dateIdx = args.indexOf('--date');
  if (dateIdx !== -1) {
    dateStr = args[dateIdx + 1];
    args.splice(dateIdx, 2);
  } else {
    // Default to today in NZST
    dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
  }

  let content;
  const fileArg = args.find(a => !a.startsWith('-'));
  if (fileArg) {
    content = readFileSync(fileArg, 'utf-8');
  } else if (!process.stdin.isTTY) {
    content = await readStdin();
  } else {
    console.error('Usage: node publish-to-doc.mjs [--date YYYY-MM-DD] <file>');
    console.error('       echo "text" | node publish-to-doc.mjs');
    console.error('       node publish-to-doc.mjs --create "Title"');
    console.error('       node publish-to-doc.mjs --read');
    console.error('       node publish-to-doc.mjs --delete-tab "Tab 1"');
    process.exit(1);
  }

  content = content.trim();
  if (!content) { console.error('Empty content.'); process.exit(1); }

  await publishToTab(auth, config.doc_id, content, dateStr);
}
