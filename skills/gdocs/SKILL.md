---
name: gdocs
description: Google Docs CLI for creating documents, managing tabs, and publishing rich-formatted content. Use when asked to (1) create or write to a Google Doc, (2) organize content by date or topic using document tabs, (3) convert markdown to formatted Google Docs (headings, bold, bullets, links), (4) manage document tabs (create, list, delete, reorder), (5) build a daily digest, journal, or log in Google Docs, or (6) read Google Doc content programmatically.
---

# gdocs

Node.js scripts for Google Docs: create documents, manage tabs, and publish markdown as richly formatted content. One tab per entry, newest first, with headings, bold, bullets, and clickable links rendered natively.

## Setup (one-time)

### 1. Google Cloud Console

Enable these APIs in the user's GCP project:

- **Google Docs API**: https://console.cloud.google.com/apis/api/docs.googleapis.com
- **Google Drive API**: https://console.cloud.google.com/apis/api/drive.googleapis.com

Requires an **OAuth 2.0 Desktop client** (Credentials → Create Credentials → OAuth client ID → Desktop app).

If the user already has a Desktop OAuth client from another Google tool (gccli, gcalcli, gog), reuse it — scopes are requested at auth time, not baked into the client.

### 2. Create config.json

```bash
cat > {scriptDir}/config.json << 'EOF'
{
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET"
}
EOF
```

To find existing credentials on the system:

```bash
# gcalcli (Python)
python3 -c "import json; d=json.load(open('$HOME/.gcalcli_oauth')); print('client_id:', d['client_id']); print('client_secret:', d['client_secret'])" 2>/dev/null

# gccli / gdcli / gmcli (@mariozechner Node CLIs)
cat ~/.gccli/credentials.json 2>/dev/null || cat ~/.gdcli/credentials.json 2>/dev/null
```

### 3. Authenticate

```bash
node {scriptDir}/auth.mjs
```

Prints an OAuth URL. User opens it in their browser, authorizes, and pastes the redirect URL back (works on headless servers). Saves `token.json` which auto-refreshes thereafter.

Scopes requested: `documents` (read/write) + `drive.file` (create files).

### 4. Create a document

```bash
node {scriptDir}/publish-to-doc.mjs --create "📺 YouTube Digest"
```

Saves `doc_id` to `config.json`. The `drive.file` scope means only this app can see the doc initially — remind the user to share it with themselves via the Google Docs sharing UI.

### 5. Clean up default tab

New docs include a "Tab 1". Delete it after creating the first real tab:

```bash
node {scriptDir}/publish-to-doc.mjs --delete-tab "Tab 1"
```

## Commands

### Publish content to a tab

```bash
# From file — tab named with today's date (Pacific/Auckland)
node {scriptDir}/publish-to-doc.mjs digest.md

# From stdin with explicit date
echo "### My Heading
**Bold** content
- Bullet one
- Bullet two
🔗 https://example.com" | node {scriptDir}/publish-to-doc.mjs --date 2026-02-22

# From file with explicit date
node {scriptDir}/publish-to-doc.mjs --date 2026-02-22 summary.md
```

Creates a tab titled `2026-02-22` with 📺 emoji at index 0 (newest on top). If the tab already exists, it clears and rewrites it (idempotent).

### List tabs

```bash
node {scriptDir}/publish-to-doc.mjs --read
```

### Delete a tab

```bash
node {scriptDir}/publish-to-doc.mjs --delete-tab "2026-02-20"
```

### Create a new document

```bash
node {scriptDir}/publish-to-doc.mjs --create "Title"
```

## Markdown → Google Docs formatting

| Markdown | Rendered as |
|----------|-------------|
| `# Heading` through `##### Heading` | HEADING_1 through HEADING_5 |
| `**text**` | **Bold** |
| `- item` or `• item` | Bulleted list |
| `https://...` URLs | Clickable hyperlink |
| Lines starting with `━` | HEADING_1 (visual separator) |

Headings appear in the document outline sidebar for navigation.

## Customization

**Timezone**: The default date for `--date` uses `Pacific/Auckland`. Edit the `toLocaleDateString` timezone in `publish-to-doc.mjs` to change it.

**Tab emoji**: Default is 📺. Change the `iconEmoji` in `publish-to-doc.mjs`.

## Files

| File | Purpose |
|------|---------|
| `scripts/auth.mjs` | One-time OAuth2 headless auth flow |
| `scripts/publish-to-doc.mjs` | All doc operations: create, publish, list, delete tabs |
