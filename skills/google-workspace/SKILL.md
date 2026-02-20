---
name: google-workspace
description: "Access Google Workspace APIs (Drive, Docs, Calendar, Gmail, Sheets, Slides, Chat, People) via local helper scripts without MCP. Handles OAuth login and direct API calls."
---

# Google Workspace

Use this skill for Google Workspace tasks (Gmail, Drive, Calendar, Docs, Sheets, etc.).

## Files

- `scripts/auth.js` — OAuth login/status/clear
- `scripts/workspace.js` — JavaScript execution based API runner

## Usage

Always use `exec`.

```bash
node scripts/workspace.js exec <<'JS'
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
5. Use `scripts/auth.js` if you get auth errors.

## Short Gmail counting example

```bash
node scripts/workspace.js exec <<'JS'
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
node scripts/auth.js login
```

Notes:

- Dependencies auto-install on first run.
- Default auth mode is **cloud** (no local `credentials.json` needed).
- Optional local mode: `GOOGLE_WORKSPACE_AUTH_MODE=local` and credentials at `~/.pi/google-workspace/credentials.json`.
- Useful diagnostics:

```bash
node scripts/auth.js status
node scripts/auth.js clear
```
