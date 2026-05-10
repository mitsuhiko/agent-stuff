#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const CONFIG_DIR =
  process.env.GOOGLE_WORKSPACE_CONFIG_DIR ||
  path.join(os.homedir(), '.pi', 'google-workspace');

const CREDENTIALS_PATH =
  process.env.GOOGLE_WORKSPACE_CREDENTIALS ||
  path.join(CONFIG_DIR, 'credentials.json');

const TOKENS_DIR =
  process.env.GOOGLE_WORKSPACE_TOKENS_DIR || path.join(CONFIG_DIR, 'tokens');

const SKILL_ROOT = path.join(__dirname, '..');

const DEFAULT_CLIENT_ID =
  '338689075775-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com';
const DEFAULT_CLOUD_FUNCTION_URL =
  'https://google-workspace-extension.geminicli.com';

const REQUIRED_IDENTITY_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.memberships',
  ...REQUIRED_IDENTITY_SCOPES,
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

const DEFAULT_VERSIONS = {
  calendar: 'v3',
  chat: 'v1',
  docs: 'v1',
  drive: 'v3',
  gmail: 'v1',
  people: 'v1',
  sheets: 'v4',
  slides: 'v1',
};

let runtimeDeps;

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function ensureTokensDir() {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function installDependencies() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.error('ℹ️  Installing Google Workspace skill dependencies...');

  const result = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: SKILL_ROOT,
    stdio: 'inherit',
  });

  if (result.error) {
    throw new Error(`Failed to run npm install: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status}`);
  }
}

function loadRuntimeDeps() {
  if (runtimeDeps) {
    return runtimeDeps;
  }

  try {
    const { google } = require('googleapis');
    const { authenticate } = require('@google-cloud/local-auth');
    runtimeDeps = { google, authenticate };
    return runtimeDeps;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      installDependencies();
      const { google } = require('googleapis');
      const { authenticate } = require('@google-cloud/local-auth');
      runtimeDeps = { google, authenticate };
      return runtimeDeps;
    }
    throw error;
  }
}

function getGoogleApis() {
  return loadRuntimeDeps().google;
}

function getWorkspaceClientConfig() {
  return {
    clientId:
      process.env.GOOGLE_WORKSPACE_CLIENT_ID ||
      process.env.WORKSPACE_CLIENT_ID ||
      DEFAULT_CLIENT_ID,
    cloudFunctionUrl:
      process.env.GOOGLE_WORKSPACE_CLOUD_FUNCTION_URL ||
      process.env.WORKSPACE_CLOUD_FUNCTION_URL ||
      DEFAULT_CLOUD_FUNCTION_URL,
  };
}

function credentialsExist() {
  return fs.existsSync(CREDENTIALS_PATH);
}

function normalizeEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Email is required. Pass --email <account@example.com>.');
  }

  if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) {
    throw new Error(`Invalid email address: ${email}`);
  }

  return normalized;
}

function tokenFilenameForEmail(email) {
  return `${encodeURIComponent(normalizeEmail(email))}.json`;
}

function tokenPathForEmail(email) {
  return path.join(TOKENS_DIR, tokenFilenameForEmail(email));
}

function tokenExists(email) {
  return fs.existsSync(tokenPathForEmail(email));
}

function loadCredentialsFile() {
  if (!credentialsExist()) {
    throw new Error(
      `Missing OAuth credentials file at ${CREDENTIALS_PATH}. ` +
        'Create a Google OAuth Desktop client and save the JSON there.',
    );
  }
  return readJson(CREDENTIALS_PATH);
}

function loadToken(email) {
  const tokenPath = tokenPathForEmail(email);
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  return readJson(tokenPath);
}

function decodeEmailFromTokenFilename(filename) {
  if (!filename.endsWith('.json')) {
    return null;
  }

  try {
    return normalizeEmail(decodeURIComponent(filename.slice(0, -5)));
  } catch {
    return null;
  }
}

function listAccounts() {
  if (!fs.existsSync(TOKENS_DIR)) {
    return [];
  }

  const results = [];
  const entries = fs.readdirSync(TOKENS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const tokenPath = path.join(TOKENS_DIR, entry.name);
    const emailFromFilename = decodeEmailFromTokenFilename(entry.name);

    let token;
    try {
      token = readJson(tokenPath);
    } catch (error) {
      results.push({
        email: emailFromFilename,
        path: tokenPath,
        error: `Failed to read token JSON: ${error.message}`,
      });
      continue;
    }

    let email = emailFromFilename;
    if (token && token.__email) {
      try {
        email = normalizeEmail(token.__email);
      } catch {
        // Ignore malformed __email metadata and keep filename-derived email.
      }
    }

    const expiryDate = token.expiry_date || null;

    results.push({
      email,
      path: tokenPath,
      authMode: token.__authMode === 'local' || token.__authMode === 'cloud'
        ? token.__authMode
        : null,
      hasAccessToken: Boolean(token.access_token),
      hasRefreshToken: Boolean(token.refresh_token),
      scopes: formatScopes(token.scope),
      expiryDate,
      expired: expiryDate ? expiryDate < Date.now() : null,
    });
  }

  return results.sort((a, b) => {
    const left = a.email || '';
    const right = b.email || '';
    return left.localeCompare(right);
  });
}

function createOAuthClientFromCredentials(credentialsJson) {
  const creds = credentialsJson.installed || credentialsJson.web;
  if (!creds) {
    throw new Error(
      'Invalid credentials.json: expected an "installed" or "web" key.',
    );
  }

  if (!creds.client_id || !creds.client_secret) {
    throw new Error(
      'Invalid credentials.json: missing client_id or client_secret.',
    );
  }

  const redirectUri = Array.isArray(creds.redirect_uris)
    ? creds.redirect_uris[0]
    : undefined;

  const google = getGoogleApis();
  return new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    redirectUri || 'http://localhost',
  );
}

function createCloudOAuthClient() {
  const google = getGoogleApis();
  const { clientId } = getWorkspaceClientConfig();
  return new google.auth.OAuth2({ clientId });
}

function resolveAuthMode(token) {
  const forced = process.env.GOOGLE_WORKSPACE_AUTH_MODE;
  if (forced === 'local' || forced === 'cloud') {
    return forced;
  }

  if (token && (token.__authMode === 'local' || token.__authMode === 'cloud')) {
    return token.__authMode;
  }

  if (credentialsExist()) {
    return 'local';
  }

  return 'cloud';
}

function saveToken(email, token, mode) {
  ensureConfigDir();
  ensureTokensDir();

  const normalizedEmail = normalizeEmail(email);
  const tokenPath = tokenPathForEmail(normalizedEmail);

  const payload = {
    ...token,
    __authMode: mode,
    __email: normalizedEmail,
  };

  fs.writeFileSync(tokenPath, JSON.stringify(payload, null, 2));
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Non-POSIX file systems can fail chmod. Ignore.
  }
}

function clearToken(email) {
  const tokenPath = tokenPathForEmail(email);
  if (fs.existsSync(tokenPath)) {
    fs.rmSync(tokenPath);
  }
}

function isExpiringSoon(credentials) {
  if (!credentials || !credentials.expiry_date) {
    return false;
  }
  return credentials.expiry_date < Date.now() + 60_000;
}

function openUrlInBrowser(targetUrl) {
  let command;
  let args;

  if (process.platform === 'darwin') {
    command = 'open';
    args = [targetUrl];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', targetUrl];
  } else {
    command = 'xdg-open';
    args = [targetUrl];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function refreshViaCloudFunction(refreshToken) {
  const { cloudFunctionUrl } = getWorkspaceClientConfig();

  const response = await fetch(`${cloudFunctionUrl}/refreshToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloud token refresh failed: ${response.status} ${body}`);
  }

  return response.json();
}

function mergeWithIdentityScopes(scopes) {
  return Array.from(new Set([...formatScopes(scopes), ...REQUIRED_IDENTITY_SCOPES]));
}

async function fetchAuthenticatedEmail(authClient) {
  const google = getGoogleApis();
  const oauth2 = google.oauth2({ version: 'v2', auth: authClient });
  const response = await oauth2.userinfo.get();
  const email = response?.data?.email;
  if (!email) {
    throw new Error(
      'Authentication succeeded, but Google did not return an email address. ' +
        'Ensure userinfo.email scope is granted.',
    );
  }
  return normalizeEmail(email);
}

async function ensureExpectedEmail(authClient, expectedEmail) {
  const normalizedExpectedEmail = normalizeEmail(expectedEmail);
  const authenticatedEmail = await fetchAuthenticatedEmail(authClient);

  if (authenticatedEmail !== normalizedExpectedEmail) {
    throw new Error(
      `Authenticated as ${authenticatedEmail}, but expected ${normalizedExpectedEmail}. ` +
        'Sign in with the requested account and retry.',
    );
  }

  return authenticatedEmail;
}

async function interactiveLoginLocal(scopes, email) {
  const { authenticate } = loadRuntimeDeps();
  console.error('ℹ️  Opening browser for Google OAuth login (local credentials)...');

  const authClient = await authenticate({
    keyfilePath: CREDENTIALS_PATH,
    scopes: mergeWithIdentityScopes(scopes),
  });

  if (!authClient.credentials || !authClient.credentials.access_token) {
    throw new Error('Authentication failed: no access token returned.');
  }

  const normalizedEmail = await ensureExpectedEmail(authClient, email);
  saveToken(normalizedEmail, authClient.credentials, 'local');
  return authClient;
}

async function interactiveLoginCloud(scopes, email) {
  const client = createCloudOAuthClient();
  const { cloudFunctionUrl } = getWorkspaceClientConfig();

  const host = process.env.GOOGLE_WORKSPACE_CALLBACK_HOST || 'localhost';
  const port = await getAvailablePort();
  const callbackUrl = `http://${host}:${port}/oauth2callback`;

  const csrfToken = crypto.randomBytes(32).toString('hex');
  const statePayload = {
    uri: callbackUrl,
    manual: false,
    csrf: csrfToken,
  };
  const state = Buffer.from(JSON.stringify(statePayload), 'utf8').toString(
    'base64',
  );

  const authUrl = client.generateAuthUrl({
    redirect_uri: cloudFunctionUrl,
    access_type: 'offline',
    scope: mergeWithIdentityScopes(scopes),
    state,
    prompt: 'consent',
  });

  console.error('ℹ️  Opening browser for Google OAuth login...');
  try {
    openUrlInBrowser(authUrl);
  } catch {
    console.error('⚠️  Could not auto-open browser. Open this URL manually:');
    console.error(authUrl);
  }

  const loginTimeoutMs = 5 * 60 * 1000;

  const credentials = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close(() => {
        reject(
          new Error(
            'Authentication timed out after 5 minutes. Please try again.',
          ),
        );
      });
    }, loginTimeoutMs);

    const server = http.createServer((req, res) => {
      try {
        if (!req.url || !req.url.startsWith('/oauth2callback')) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const parsed = new URL(req.url, `http://${host}:${port}`);
        const returnedState = parsed.searchParams.get('state');
        if (returnedState !== csrfToken) {
          res.statusCode = 400;
          res.end('State mismatch.');
          clearTimeout(timer);
          server.close(() => {
            reject(new Error('OAuth state mismatch.'));
          });
          return;
        }

        const errorCode = parsed.searchParams.get('error');
        if (errorCode) {
          const description =
            parsed.searchParams.get('error_description') ||
            'No additional details';
          res.statusCode = 400;
          res.end('Authentication failed.');
          clearTimeout(timer);
          server.close(() => {
            reject(new Error(`Google OAuth error: ${errorCode}. ${description}`));
          });
          return;
        }

        const accessToken = parsed.searchParams.get('access_token');
        const refreshToken = parsed.searchParams.get('refresh_token');
        const scope = parsed.searchParams.get('scope');
        const tokenType = parsed.searchParams.get('token_type');
        const expiryDateRaw = parsed.searchParams.get('expiry_date');

        if (!accessToken || !expiryDateRaw) {
          res.statusCode = 400;
          res.end('Authentication failed: missing tokens.');
          clearTimeout(timer);
          server.close(() => {
            reject(
              new Error('Authentication failed: callback did not include tokens.'),
            );
          });
          return;
        }

        const expiryDate = Number.parseInt(expiryDateRaw, 10);
        if (Number.isNaN(expiryDate)) {
          res.statusCode = 400;
          res.end('Authentication failed: invalid expiry date.');
          clearTimeout(timer);
          server.close(() => {
            reject(
              new Error('Authentication failed: callback expiry_date is invalid.'),
            );
          });
          return;
        }

        const creds = {
          access_token: accessToken,
          refresh_token: refreshToken || null,
          scope: scope || undefined,
          token_type: tokenType || undefined,
          expiry_date: expiryDate,
        };

        res.end('Authentication successful. You can close this tab.');

        clearTimeout(timer);
        server.close(() => {
          resolve(creds);
        });
      } catch (error) {
        clearTimeout(timer);
        server.close(() => {
          reject(error);
        });
      }
    });

    server.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`OAuth callback server error: ${error.message}`));
    });

    server.listen(port, host, () => {
      // listener started
    });
  });

  client.setCredentials(credentials);
  const normalizedEmail = await ensureExpectedEmail(client, email);
  saveToken(normalizedEmail, credentials, 'cloud');
  return client;
}

async function interactiveLogin(scopes, mode, email) {
  if (mode === 'local') {
    return interactiveLoginLocal(scopes, email);
  }
  return interactiveLoginCloud(scopes, email);
}

function stripInternalTokenFields(token) {
  if (!token || typeof token !== 'object') {
    return token;
  }
  const clone = { ...token };
  delete clone.__authMode;
  delete clone.__email;
  return clone;
}

async function authorize(options = {}) {
  const email = normalizeEmail(options.email);
  const scopes = mergeWithIdentityScopes(options.scopes || DEFAULT_SCOPES);
  const interactive = options.interactive !== false;

  ensureConfigDir();
  ensureTokensDir();
  loadRuntimeDeps();

  const token = loadToken(email);
  const mode = resolveAuthMode(token);

  const client =
    mode === 'local'
      ? createOAuthClientFromCredentials(loadCredentialsFile())
      : createCloudOAuthClient();

  if (!token) {
    if (!interactive) {
      throw new Error(
        `No token found for ${email} at ${tokenPathForEmail(email)}. ` +
          `Run: node scripts/auth.js login --email ${email}`,
      );
    }
    return interactiveLogin(scopes, mode, email);
  }

  if (token.__email) {
    const tokenEmail = normalizeEmail(token.__email);
    if (tokenEmail !== email) {
      throw new Error(
        `Token metadata mismatch. Requested ${email} but token is tagged as ${tokenEmail}. ` +
          `Delete it and sign in again: node scripts/auth.js clear --email ${email}`,
      );
    }
  }

  client.setCredentials(stripInternalTokenFields(token));

  if (!isExpiringSoon(client.credentials)) {
    return client;
  }

  if (client.credentials.refresh_token) {
    if (mode === 'local') {
      const refreshed = await client.refreshAccessToken();
      const merged = {
        ...refreshed.credentials,
        refresh_token:
          refreshed.credentials.refresh_token || client.credentials.refresh_token,
      };
      client.setCredentials(merged);
      saveToken(email, merged, 'local');
      return client;
    }

    const refreshed = await refreshViaCloudFunction(
      client.credentials.refresh_token,
    );
    const merged = {
      ...refreshed,
      refresh_token: client.credentials.refresh_token,
    };
    client.setCredentials(merged);
    saveToken(email, merged, 'cloud');
    return client;
  }

  if (!interactive) {
    throw new Error(
      `Token for ${email} is expired and no refresh token is available. ` +
        `Run: node scripts/auth.js login --email ${email}`,
    );
  }

  return interactiveLogin(scopes, mode, email);
}

function formatScopes(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return String(value)
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

module.exports = {
  CONFIG_DIR,
  CREDENTIALS_PATH,
  TOKENS_DIR,
  DEFAULT_SCOPES,
  DEFAULT_VERSIONS,
  REQUIRED_IDENTITY_SCOPES,
  authorize,
  clearToken,
  credentialsExist,
  formatScopes,
  getGoogleApis,
  getWorkspaceClientConfig,
  listAccounts,
  loadToken,
  normalizeEmail,
  resolveAuthMode,
  tokenExists,
  tokenPathForEmail,
};
