---
name: mastodon
description: "Interact with Mastodon and the Fediverse. Search accounts, browse profiles, read timelines, list followers/following, post statuses, and discover interesting accounts. Use when (1) looking up Mastodon/Fediverse accounts, (2) reading someone's posts, (3) finding who follows or is followed by an account, (4) discovering accounts to follow based on interests, (5) posting to Mastodon, (6) searching Mastodon content or hashtags, (7) analysing follower networks."
---

# Mastodon

Interact with Mastodon instances via `scripts/mastodon.sh`. Uses the public Mastodon API for reads and `toot` (Python CLI, via `uvx toot`) for authenticated operations.

## Tool

```bash
TOOL={baseDir}/scripts/mastodon.sh
```

## Setup

Login is required for search, posting, and some timeline views. Public reads (whois, followers, following, statuses) work without auth.

```bash
$TOOL login mastodon.social    # opens browser for OAuth
$TOOL whoami                   # verify
```

## Commands

```bash
# Account info
$TOOL whois user@instance                          # profile details
$TOOL whoami                                       # authenticated user

# Social graph
$TOOL followers user@instance [max]                # who follows them (default max: 200)
$TOOL following user@instance [max]                # who they follow (default max: 200)

# Reading posts
$TOOL statuses user@instance [limit] [excl_replies] [excl_reblogs]
                                                   # recent posts (default: 20, originals only)
$TOOL timeline user@instance [limit]               # timeline view (requires auth)
$TOOL thread <status_url_or_id>                    # full thread

# Search (requires auth)
$TOOL search "query" [accounts|statuses|hashtags] [limit]

# Write (requires auth)
$TOOL follow user@instance
$TOOL unfollow user@instance
$TOOL post "text" [public|unlisted|private|direct] [spoiler_text]

# Notifications
$TOOL notifications [limit]
```

All output is JSON. Account handles are `user@instance` format (e.g. `mitsuhiko@hachyderm.io`).

## Discovering Accounts

To help a user find interesting accounts to follow (e.g. among followers of someone):

1. Fetch the target's follower or following list:
   `$TOOL followers user@instance 200`
2. Filter candidates: skip bots (`bot: true`), locked accounts, and those with 0 statuses.
3. Sample recent posts from promising candidates (batch of 5-10 at a time):
   `$TOOL statuses candidate@instance 10`
4. Evaluate based on user's stated interests, post frequency, engagement, and content quality.
5. Present recommendations with reasoning, sample posts, and follower stats.

When lists are large (>200), work in batches and ask the user if they want to continue.
