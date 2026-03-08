#!/usr/bin/env bash
# mastodon.sh — Mastodon CLI wrapper for agent use
# Wraps `toot` (authenticated) and falls back to raw API (public data).
# All output is JSON for easy agent consumption.
set -euo pipefail

TOOT="uvx toot"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() { echo "Error: $*" >&2; exit 1; }

need_auth() {
  $TOOT auth >/dev/null 2>&1 || die "Not logged in. Run: uvx toot login -i <instance>"
}

# Parse instance + id from an account handle (user@instance) via API lookup
# Sets: INSTANCE, ACCOUNT_ID, ACCT
resolve_account() {
  local input="$1"

  # Full handle: user@instance
  if [[ "$input" == *@* ]]; then
    local user="${input%%@*}"
    INSTANCE="${input#*@}"
    local resp
    resp=$(curl -sf "https://${INSTANCE}/api/v1/accounts/lookup?acct=${user}" 2>/dev/null) \
      || die "Could not resolve ${input} — check instance and username"
    ACCOUNT_ID=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    ACCT="${user}@${INSTANCE}"
  else
    # Local handle — requires auth to know instance
    need_auth
    local base
    base=$($TOOT auth 2>/dev/null | grep -o 'https://[^ ]*' | head -1)
    if [[ -z "$base" ]]; then
      # fallback: use toot whois which requires auth
      $TOOT whois "$input" --json
      return 1  # signal caller to skip raw API
    fi
    INSTANCE="${base#https://}"
    INSTANCE="${INSTANCE%%/*}"
    local resp
    resp=$(curl -sf "https://${INSTANCE}/api/v1/accounts/lookup?acct=${input}" 2>/dev/null) \
      || die "Could not resolve ${input} on ${INSTANCE}"
    ACCOUNT_ID=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    ACCT="${input}@${INSTANCE}"
  fi
}

# Paginated fetch from Mastodon API (follows Link headers)
# Usage: paginated_fetch <url> <max_items>
paginated_fetch() {
  local url="$1"
  local max="${2:-200}"
  local collected=0
  local first=true

  echo "["
  while [[ -n "$url" && $collected -lt $max ]]; do
    local remaining=$((max - collected))
    # Add/update limit param
    if [[ "$url" == *"?"* ]]; then
      url="${url}&limit=${remaining}"
    else
      url="${url}?limit=${remaining}"
    fi

    local tmpfile
    tmpfile=$(mktemp)
    local body
    body=$(curl -sf -D "$tmpfile" "$url" 2>/dev/null) || { rm -f "$tmpfile"; break; }
    local headers
    headers=$(cat "$tmpfile")
    rm -f "$tmpfile"

    # Count items in this page
    local count
    count=$(echo "$body" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null) || break
    [[ "$count" -eq 0 ]] && break

    # Output items (strip outer brackets, add commas between pages)
    if $first; then
      first=false
    else
      echo ","
    fi
    echo "$body" | python3 -c "
import json, sys
items = json.load(sys.stdin)
for i, item in enumerate(items):
    if i > 0: print(',')
    print(json.dumps(item))
"
    collected=$((collected + count))

    # Extract next page URL from Link header (macOS-compatible)
    url=""
    local link_header
    link_header=$(echo "$headers" | grep -i '^link:' | head -1) || true
    if [[ -n "$link_header" ]]; then
      url=$(echo "$link_header" | python3 -c "
import sys, re
line = sys.stdin.read()
m = re.search(r'<(https://[^>]+)>;\s*rel=\"next\"', line)
if m: print(m.group(1))
" 2>/dev/null) || true
    fi
  done
  echo "]"
}

# Compact JSON: strip heavy fields (avatar, header, emojis, fields) from account objects
compact_accounts() {
  python3 -c "
import json, sys
data = json.load(sys.stdin)
keep = ['id','username','acct','display_name','locked','bot','discoverable',
        'created_at','note','url','followers_count','following_count',
        'statuses_count','last_status_at']
if isinstance(data, list):
    out = [{k: a[k] for k in keep if k in a} for a in data]
else:
    out = {k: data[k] for k in keep if k in data}
json.dump(out, sys.stdout, indent=2)
"
}

# Compact statuses: strip nested account objects, keep essentials
compact_statuses() {
  python3 -c "
import json, sys, re
data = json.load(sys.stdin)
out = []
for s in data:
    item = {
        'id': s['id'],
        'created_at': s['created_at'],
        'url': s.get('url',''),
        'visibility': s.get('visibility',''),
        'language': s.get('language',''),
        'content': re.sub(r'<[^>]+>', '', s.get('content','')),
        'reblogs_count': s.get('reblogs_count', 0),
        'favourites_count': s.get('favourites_count', 0),
        'replies_count': s.get('replies_count', 0),
        'tags': [t['name'] for t in s.get('tags', [])],
    }
    if s.get('spoiler_text'):
        item['spoiler_text'] = s['spoiler_text']
    if s.get('media_attachments'):
        item['media_count'] = len(s['media_attachments'])
    if s.get('card'):
        c = s['card']
        item['card'] = {'title': c.get('title',''), 'url': c.get('url','')}
    if s.get('account'):
        item['account'] = s['account'].get('acct','')
    out.append(item)
json.dump(out, sys.stdout, indent=2)
"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_login() {
  local instance="${1:-mastodon.social}"
  echo "Logging in to ${instance}..."
  $TOOT login -i "$instance"
}

cmd_whoami() {
  need_auth
  $TOOT whoami --json
}

cmd_whois() {
  [[ -z "${1:-}" ]] && die "Usage: mastodon.sh whois <user@instance>"
  resolve_account "$1"
  curl -sf "https://${INSTANCE}/api/v1/accounts/lookup?acct=${ACCT%%@*}" \
    | compact_accounts
}

cmd_followers() {
  local account="${1:-}" max="${2:-200}"
  [[ -z "$account" ]] && die "Usage: mastodon.sh followers <user@instance> [max]"
  resolve_account "$account"
  paginated_fetch "https://${INSTANCE}/api/v1/accounts/${ACCOUNT_ID}/followers" "$max" \
    | compact_accounts
}

cmd_following() {
  local account="${1:-}" max="${2:-200}"
  [[ -z "$account" ]] && die "Usage: mastodon.sh following <user@instance> [max]"
  resolve_account "$account"
  paginated_fetch "https://${INSTANCE}/api/v1/accounts/${ACCOUNT_ID}/following" "$max" \
    | compact_accounts
}

cmd_statuses() {
  local account="${1:-}" limit="${2:-20}"
  local exclude_replies="${3:-true}"
  local exclude_reblogs="${4:-true}"
  [[ -z "$account" ]] && die "Usage: mastodon.sh statuses <user@instance> [limit] [exclude_replies] [exclude_reblogs]"
  resolve_account "$account"
  local url="https://${INSTANCE}/api/v1/accounts/${ACCOUNT_ID}/statuses?limit=${limit}&exclude_replies=${exclude_replies}&exclude_reblogs=${exclude_reblogs}"
  curl -sf "$url" | compact_statuses
}

cmd_search() {
  need_auth
  local query="${1:-}" type="${2:-}" limit="${3:-20}"
  [[ -z "$query" ]] && die "Usage: mastodon.sh search <query> [accounts|statuses|hashtags] [limit]"
  local args=("$query" --json --limit "$limit")
  [[ -n "$type" ]] && args+=(--type "$type")
  $TOOT search "${args[@]}"
}

cmd_timeline() {
  local account="${1:-}" limit="${2:-20}"
  [[ -z "$account" ]] && die "Usage: mastodon.sh timeline <user@instance> [limit]"
  need_auth
  $TOOT timelines account "$account" --json --limit "$limit" --no-pager \
    | compact_statuses
}

cmd_follow() {
  [[ -z "${1:-}" ]] && die "Usage: mastodon.sh follow <user@instance>"
  need_auth
  $TOOT follow "$1"
}

cmd_unfollow() {
  [[ -z "${1:-}" ]] && die "Usage: mastodon.sh unfollow <user@instance>"
  need_auth
  $TOOT unfollow "$1"
}

cmd_post() {
  [[ -z "${1:-}" ]] && die "Usage: mastodon.sh post <text> [visibility] [spoiler]"
  need_auth
  local args=("$1")
  [[ -n "${2:-}" ]] && args+=(--visibility "$2")
  [[ -n "${3:-}" ]] && args+=(--spoiler-text "$3")
  $TOOT post "${args[@]}"
}

cmd_thread() {
  [[ -z "${1:-}" ]] && die "Usage: mastodon.sh thread <status_url_or_id>"
  need_auth
  $TOOT thread "$1" --json | compact_statuses
}

cmd_notifications() {
  need_auth
  local limit="${1:-20}"
  $TOOT notifications --json --limit "$limit"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

cmd="${1:-help}"
shift || true

case "$cmd" in
  login)          cmd_login "$@" ;;
  whoami)         cmd_whoami ;;
  whois)          cmd_whois "$@" ;;
  followers)      cmd_followers "$@" ;;
  following)      cmd_following "$@" ;;
  statuses)       cmd_statuses "$@" ;;
  search)         cmd_search "$@" ;;
  timeline)       cmd_timeline "$@" ;;
  follow)         cmd_follow "$@" ;;
  unfollow)       cmd_unfollow "$@" ;;
  post)           cmd_post "$@" ;;
  thread)         cmd_thread "$@" ;;
  notifications)  cmd_notifications "$@" ;;
  help|--help|-h)
    cat <<'EOF'
mastodon.sh — Mastodon CLI for agent use

Commands (all output JSON unless noted):
  login [instance]                         Log in via browser (default: mastodon.social)
  whoami                                   Show authenticated user
  whois <user@instance>                    Look up account details
  followers <user@instance> [max]          List followers (default max: 200)
  following <user@instance> [max]          List accounts followed (default max: 200)
  statuses <user@instance> [limit] [excl_replies] [excl_reblogs]
                                           Recent statuses (default: 20, original posts only)
  search <query> [type] [limit]            Search (type: accounts|statuses|hashtags)
  timeline <user@instance> [limit]         Account timeline (requires auth)
  follow <user@instance>                   Follow an account
  unfollow <user@instance>                 Unfollow an account
  post <text> [visibility] [spoiler]       Post a status (visibility: public|unlisted|private|direct)
  thread <status_url_or_id>                Show thread for a status
  notifications [limit]                    Show notifications

Auth: Most read commands work without auth (public API). Write commands and
search require auth via `toot login`.
EOF
    ;;
  *) die "Unknown command: $cmd. Run with 'help' for usage." ;;
esac
