#!/usr/bin/env node

const {
  CREDENTIALS_PATH,
  TOKENS_DIR,
  DEFAULT_SCOPES,
  authorize,
  clearToken,
  credentialsExist,
  formatScopes,
  getWorkspaceClientConfig,
  listAccounts,
  loadToken,
  normalizeEmail,
  resolveAuthMode,
  tokenPathForEmail,
} = require('./common');

function printHelp() {
  console.log(`Google Workspace auth helper

Usage:
  node scripts/auth.js login --email user@example.com [--scopes scope1,scope2,...]
  node scripts/auth.js status --email user@example.com
  node scripts/auth.js clear --email user@example.com
  node scripts/auth.js accounts

Environment overrides:
  GOOGLE_WORKSPACE_CONFIG_DIR
  GOOGLE_WORKSPACE_CREDENTIALS
  GOOGLE_WORKSPACE_TOKENS_DIR
  GOOGLE_WORKSPACE_AUTH_MODE            (local|cloud)
  GOOGLE_WORKSPACE_CLIENT_ID            (cloud mode)
  GOOGLE_WORKSPACE_CLOUD_FUNCTION_URL   (cloud mode)
`);
}

function parseScopes(args) {
  const idx = args.indexOf('--scopes');
  if (idx === -1) {
    return DEFAULT_SCOPES;
  }

  const raw = args[idx + 1];
  if (!raw) {
    throw new Error('--scopes requires a value');
  }

  const scopes = formatScopes(raw);
  if (scopes.length === 0) {
    throw new Error('--scopes produced an empty scope list');
  }
  return scopes;
}

function parseRequiredEmail(args) {
  const idx = args.indexOf('--email');
  if (idx === -1) {
    throw new Error('Missing required --email <account@example.com>');
  }

  const raw = args[idx + 1];
  if (!raw) {
    throw new Error('--email requires a value');
  }

  return normalizeEmail(raw);
}

async function doLogin(args) {
  const email = parseRequiredEmail(args);
  const scopes = parseScopes(args);

  await authorize({ email, scopes, interactive: true });

  console.log('✅ Login successful. Token stored at:');
  console.log(`   ${tokenPathForEmail(email)}`);
}

function printTokenDetails(token) {
  const now = Date.now();
  const expiry = token.expiry_date || null;
  const expired = expiry ? expiry < now : null;
  const scopeCount = formatScopes(token.scope).length;

  console.log('Token details:');
  console.log(`  access_token: ${token.access_token ? 'present' : 'missing'}`);
  console.log(`  refresh_token: ${token.refresh_token ? 'present' : 'missing'}`);
  console.log(`  scopes: ${scopeCount}`);

  if (expiry) {
    console.log(`  expiry_date: ${new Date(expiry).toISOString()}`);
    console.log(`  expired: ${expired ? 'yes' : 'no'}`);
  } else {
    console.log('  expiry_date: n/a');
  }
}

function doStatus(args) {
  const email = parseRequiredEmail(args);

  console.log('Credentials file:');
  console.log(`  ${CREDENTIALS_PATH}`);
  console.log(`  Exists: ${credentialsExist() ? 'yes' : 'no'}`);

  const token = loadToken(email);
  const mode = resolveAuthMode(token);
  const workspaceCfg = getWorkspaceClientConfig();

  console.log('\nSelected account:');
  console.log(`  ${email}`);

  console.log('\nAuth mode:');
  console.log(`  ${mode}`);
  if (mode === 'cloud') {
    const maskedClientId = workspaceCfg.clientId.replace(/^[^-]+/, '***');
    console.log(`  clientId: ${maskedClientId}`);
    console.log(`  cloudFunctionUrl: ${workspaceCfg.cloudFunctionUrl}`);
  }

  console.log('\nToken file:');
  console.log(`  ${tokenPathForEmail(email)}`);
  console.log(`  Exists: ${token ? 'yes' : 'no'}`);

  if (!token) {
    console.log('\nTip: sign in with:');
    console.log(`  node scripts/auth.js login --email ${email}`);
    return;
  }

  console.log('');
  printTokenDetails(token);
}

function doAccounts() {
  const accounts = listAccounts();

  console.log('Token store:');
  console.log(`  ${TOKENS_DIR}`);

  if (accounts.length === 0) {
    console.log('\nNo signed-in accounts found.');
    return;
  }

  console.log(`\nSigned-in accounts (${accounts.length}):`);

  for (const account of accounts) {
    console.log('');
    console.log(`- email: ${account.email || '(unknown)'}`);
    console.log(`  tokenFile: ${account.path}`);

    if (account.error) {
      console.log(`  error: ${account.error}`);
      continue;
    }

    console.log(`  authMode: ${account.authMode || 'unknown'}`);
    console.log(`  access_token: ${account.hasAccessToken ? 'present' : 'missing'}`);
    console.log(`  refresh_token: ${account.hasRefreshToken ? 'present' : 'missing'}`);
    console.log(`  scopes: ${account.scopes.length}`);

    if (account.expiryDate) {
      console.log(`  expiry_date: ${new Date(account.expiryDate).toISOString()}`);
      console.log(`  expired: ${account.expired ? 'yes' : 'no'}`);
    } else {
      console.log('  expiry_date: n/a');
    }
  }
}

function doClear(args) {
  const email = parseRequiredEmail(args);
  clearToken(email);
  console.log(`✅ Token cleared for ${email}.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'login') {
    await doLogin(args);
    return;
  }

  if (command === 'status') {
    doStatus(args);
    return;
  }

  if (command === 'accounts') {
    doAccounts();
    return;
  }

  if (command === 'clear') {
    doClear(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
