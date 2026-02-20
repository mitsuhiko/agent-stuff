#!/usr/bin/env node

const vm = require('node:vm');
const util = require('node:util');

const {
  DEFAULT_VERSIONS,
  authorize,
  formatScopes,
  getGoogleApis,
  loadToken,
  resolveAuthMode,
} = require('./common');

function printHelp() {
  console.log(`Google Workspace API helper (exec-only)

Usage:
  node scripts/workspace.js exec [--script 'return 1'] [--timeout 30000] [--scopes s1,s2]

Example:
  node scripts/workspace.js exec <<'JS'
  const me = await workspace.whoAmI();
  const files = await workspace.call('drive', 'files.list', {
    pageSize: 3,
    fields: 'files(id,name)'
  });
  return { me, files: files.files };
  JS
`);
}

function parseTimeout(raw) {
  if (!raw) {
    throw new Error('--timeout requires a value');
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('--timeout must be a positive number of milliseconds');
  }

  return Math.min(Math.floor(numeric), 5 * 60_000);
}

function parseOptions(argv) {
  const positional = [];
  const options = {
    scopes: undefined,
    timeout: undefined,
    script: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--scopes') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--scopes requires a value');
      }
      options.scopes = formatScopes(value);
      i += 1;
      continue;
    }

    if (arg === '--timeout') {
      options.timeout = parseTimeout(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === '--script') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('--script requires a value');
      }
      options.script = value;
      i += 1;
      continue;
    }

    positional.push(arg);
  }

  return { positional, options };
}

function resolveMethod(root, methodPath) {
  const parts = methodPath.split('.').filter(Boolean);
  if (parts.length === 0) {
    throw new Error('method.path is empty');
  }

  let parent = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    parent = parent?.[parts[i]];
    if (!parent) {
      throw new Error(`Invalid method path (missing segment: ${parts[i]})`);
    }
  }

  const methodName = parts[parts.length - 1];
  const method = parent?.[methodName];

  if (typeof method !== 'function') {
    throw new Error(
      `Invalid method path: ${methodPath}. Final segment is not callable.`,
    );
  }

  return { parent, method };
}

async function callApi({
  service,
  methodPath,
  params,
  version,
  scopes,
  authClient,
}) {
  const google = getGoogleApis();
  const factory = google[service];
  if (typeof factory !== 'function') {
    throw new Error(`Unknown Google API service: ${service}`);
  }

  const auth =
    authClient ||
    (await authorize({
      interactive: true,
      scopes: scopes && scopes.length > 0 ? scopes : undefined,
    }));

  const api = factory({
    version: version || DEFAULT_VERSIONS[service] || 'v1',
    auth,
  });

  const { parent, method } = resolveMethod(api, methodPath);
  const response = await method.call(parent, params || {});
  return response?.data ?? response;
}

function getServiceClient({ google, auth, service, version }) {
  const factory = google[service];
  if (typeof factory !== 'function') {
    throw new Error(`Unknown Google API service: ${service}`);
  }

  return factory({
    version: version || DEFAULT_VERSIONS[service] || 'v1',
    auth,
  });
}

function createWorkspaceHelper({ auth, google }) {
  return {
    versions: { ...DEFAULT_VERSIONS },

    async call(service, methodPath, params = {}, options = {}) {
      return callApi({
        service,
        methodPath,
        params,
        version: options.version,
        authClient: auth,
      });
    },

    service(service, options = {}) {
      return getServiceClient({
        google,
        auth,
        service,
        version: options.version,
      });
    },

    async whoAmI() {
      const oauth2 = google.oauth2({ version: 'v2', auth });
      const response = await oauth2.userinfo.get();
      return response?.data ?? response;
    },
  };
}

function formatLogArg(value) {
  if (typeof value === 'string') {
    return value;
  }

  return util.inspect(value, {
    depth: 6,
    maxArrayLength: 200,
    breakLength: 120,
    compact: 2,
  });
}

function createExecutionConsole(logs) {
  const write = (level, args) => {
    logs.push({
      level,
      message: args.map(formatLogArg).join(' '),
      timestamp: new Date().toISOString(),
    });
  };

  return {
    log: (...args) => write('log', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => write('debug', args),
  };
}

function normalizeForJson(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return `${value}n`;
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForJson(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = normalizeForJson(nested, seen);
    }
    return output;
  }

  return value;
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Execution timed out after ${Math.round(timeoutMs)}ms.`));
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function readStdinText() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function errorPayload(error, logs, timeoutMs) {
  return {
    ok: false,
    timeoutMs,
    logs,
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: error?.stack || null,
    },
  };
}

async function cmdExec(args, options) {
  let script = options.script;

  if (!script && args.length > 0) {
    script = args.join(' ');
  }

  if (!script) {
    script = await readStdinText();
  }

  script = String(script || '').trim();

  if (!script) {
    throw new Error(
      'Usage: exec [--script "..."] (or pipe script via stdin / heredoc)',
    );
  }

  const timeoutMs = options.timeout || 30_000;
  const logs = [];

  try {
    const auth = await authorize({
      interactive: true,
      scopes: options.scopes && options.scopes.length > 0
        ? options.scopes
        : undefined,
    });

    const google = getGoogleApis();
    const workspace = createWorkspaceHelper({ auth, google });

    const context = vm.createContext({
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      console: createExecutionConsole(logs),
      auth,
      google,
      workspace,
    });

    const wrappedScript = `
(async () => {
${script}
})()
`;

    const compiled = new vm.Script(wrappedScript, {
      filename: 'workspace-exec.js',
      displayErrors: true,
    });

    const resultPromise = Promise.resolve(
      compiled.runInContext(context, {
        timeout: Math.min(timeoutMs, 60_000),
        displayErrors: true,
      }),
    );

    const result = await withTimeout(resultPromise, timeoutMs);
    const token = loadToken();

    console.log(
      JSON.stringify(
        {
          ok: true,
          authMode: resolveAuthMode(token),
          timeoutMs,
          logs,
          result: normalizeForJson(result),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(JSON.stringify(errorPayload(error, logs, timeoutMs), null, 2));
    process.exitCode = 1;
  }
}

async function main() {
  const { positional, options } = parseOptions(process.argv.slice(2));
  const [command, ...args] = positional;

  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    printHelp();
    return;
  }

  if (command !== 'exec') {
    throw new Error(`Unknown command: ${command}. Only 'exec' is supported.`);
  }

  await cmdExec(args, options);
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
