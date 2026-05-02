---
name: google-workspace
description: "Access Google Workspace APIs (Drive, Docs, Calendar, Gmail, Sheets, Slides, Chat, People) via local helper scripts without MCP. Handles OAuth login and direct API calls."
---

# Google Workspace

Use this skill for Google Workspace tasks (Gmail, Drive, Calendar, Docs, Sheets, etc.).

## Files

- `scripts/auth.js` — OAuth login/status/clear + account enumeration
- `scripts/workspace.js` — JavaScript execution based API runner

## Account model (multi-account)

This skill is **profile-based by email address**.

- There is **no default account**.
- Every API call must specify `--email <account@example.com>`.
- Tokens are stored per-email under `~/.pi/google-workspace/tokens/`.

Before running API calls, discover available signed-in accounts:

```bash
node scripts/auth.js accounts
```

## Usage

Always use `exec` and always provide `--email`.

```bash
node scripts/workspace.js exec --email user@example.com <<'JS'
const me = await workspace.whoAmI();
const files = await workspace.call('drive', 'files.list', {
  pageSize: 5,
  fields: 'files(id,name,mimeType)',
});
return { me, files: files.files };
JS
```

Available inside exec scripts:

- `auth` (authorized OAuth client)
- `google` (`googleapis` root)
- `workspace.accountEmail` (selected profile email)
- `workspace.call(service, methodPath, params, {version})`
- `workspace.service(service, {version})`
- `workspace.whoAmI()`

Optional flags:

- `--timeout <ms>` (default 30000, max 300000)
- `--scopes s1,s2`
- `--script 'return 42'`

## Agent guidance

1. Prefer one `exec` script per user request.
2. Keep payloads small (`fields`, `maxResults`, minimal props).
3. Use `Promise.all` for independent requests.
4. Never print token contents.
5. If the user did not specify an account, run `node scripts/auth.js accounts` and choose/confirm an explicit email.
6. If auth fails, first run `node scripts/auth.js accounts` to see known profiles.
7. If account mismatch is possible, run `workspace.whoAmI()` in the selected profile.
8. On 401/403/unauthorized errors, switch account (`--email ...`) or re-login that specific profile.

## Unauthorized/account-switch playbook

If a request fails with unauthorized/forbidden/insufficient permissions:

1. Enumerate profiles:

```bash
node scripts/auth.js accounts
```

2. Retry with the intended account:

```bash
node scripts/workspace.js exec --email correct-user@example.com <<'JS'
return await workspace.whoAmI();
JS
```

3. If token is stale or missing scopes, re-login that account:

```bash
node scripts/auth.js login --email correct-user@example.com
```

4. Retry the original request with the same `--email`.

## Short Gmail counting example

```bash
node scripts/workspace.js exec --email user@example.com <<'JS'
const gmail = google.gmail({ version: 'v1', auth });

let trash = 0;
let pageToken;
do {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:trash',
    maxResults: 500,
    pageToken,
    fields: 'messages/id,nextPageToken',
  });
  trash += (res.data.messages || []).length;
  pageToken = res.data.nextPageToken;
} while (pageToken);

return { currentlyInTrash: trash };
JS
```

## Setup + auth

```bash
node scripts/auth.js login --email user@example.com
```

Notes:

- Dependencies auto-install on first run.
- Default auth mode is **cloud** (no local `credentials.json` needed).
- Optional local mode: `GOOGLE_WORKSPACE_AUTH_MODE=local` and credentials at `~/.pi/google-workspace/credentials.json`.
- Useful diagnostics:

```bash
node scripts/auth.js accounts
node scripts/auth.js status --email user@example.com
node scripts/auth.js clear --email user@example.com
```
