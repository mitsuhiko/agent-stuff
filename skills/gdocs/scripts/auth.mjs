#!/usr/bin/env node
/**
 * One-time OAuth2 setup for Google Docs/Drive access.
 *
 * Reuses the OAuth client credentials from the existing gcalcli setup.
 * Requests only docs + drive.file scopes (least privilege).
 *
 * Usage:
 *   node auth.mjs
 *
 * Follow the prompts — open the URL in your browser, authorize,
 * then paste the redirect URL back here.
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, 'config.json');
const TOKEN_FILE = join(__dirname, 'token.json');

// Load config (has client_id and client_secret)
if (!existsSync(CONFIG_FILE)) {
  console.error('Missing config.json — create it first with client_id and client_secret.');
  process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));

const SCOPES = [
  'https://www.googleapis.com/auth/documents',   // read/write docs
  'https://www.googleapis.com/auth/drive.file',   // create/access files created by this app
];

const oauth2Client = new google.auth.OAuth2(
  config.client_id,
  config.client_secret,
  'http://localhost'  // desktop app redirect
);

// Check if already authed
if (existsSync(TOKEN_FILE)) {
  console.log('Token already exists at', TOKEN_FILE);
  console.log('Delete it and re-run to re-authorize.');
  process.exit(0);
}

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n🔐 Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('After authorizing, your browser will redirect to');
console.log('http://localhost?code=... (the page won\'t load — that\'s OK).');
console.log('Copy the FULL URL from your browser\'s address bar and paste it below.');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the redirect URL (or just the code): ', async (input) => {
  rl.close();

  let code = input.trim();

  // Extract code from full URL if pasted
  if (code.startsWith('http')) {
    try {
      const url = new URL(code);
      code = url.searchParams.get('code');
    } catch {
      console.error('Could not parse URL. Try pasting just the code parameter.');
      process.exit(1);
    }
  }

  if (!code) {
    console.error('No code provided.');
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log('\n✅ Token saved to', TOKEN_FILE);
    console.log('Scopes:', tokens.scope);
    console.log('\nYou can now use publish-to-doc.mjs');
  } catch (err) {
    console.error('\n❌ Failed to exchange code for token:', err.message);
    process.exit(1);
  }
});
