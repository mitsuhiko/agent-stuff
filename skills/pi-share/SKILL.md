---
name: pi-share
description: "Load and parse session transcripts from shittycodingagent.ai (pi-share) URLs. Fetches gists, decodes embedded session data, and extracts conversation history."
---

# pi-share / shittycodingagent.ai Session Loader

Load and parse session transcripts from shittycodingagent.ai (pi-share) URLs.

## When to Use

**Loading sessions:** Use this skill when the user provides a URL like:
- `https://shittycodingagent.ai/session/?<gist_id>`
- Or just a gist ID like `46aee35206aefe99257bc5d5e60c6121`

**Human summaries:** Use `--human-summary` when the user asks you to:
- Summarize what a human did in a pi/coding agent session
- Understand how a user interacted with an agent
- Analyze user behavior, steering patterns, or prompting style
- Get a human-centric view of a session (not what the agent did, but what the human did)

The human summary focuses on: initial goals, re-prompts, steering/corrections, interventions, and overall prompting style.

## How It Works

1. Session exports are stored as GitHub Gists
2. The URL contains a gist ID after the `?`
3. The gist contains a `session.html` file with base64-encoded session data
4. The helper script fetches and decodes this to extract the full conversation

## Usage

```bash
# Get full session data (default)
node ~/.pi/agent/skills/pi-share/fetch-session.mjs "<url-or-gist-id>"

# Get just the header
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --header

# Get entries as JSON lines (one entry per line)
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --entries

# Get the system prompt
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --system

# Get tool definitions
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --tools

# Get human-centric summary (what did the human do in this session?)
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --human-summary
```

## Human Summary

The `--human-summary` flag generates a ~300 word summary focused on the human's experience:
- What was their initial goal?
- How often did they re-prompt or steer the agent?
- What kind of interventions did they make? (corrections, clarifications, frustration)
- How specific or vague were their instructions?

This uses claude-haiku-4-5 via `pi -p` to analyze the condensed session transcript.

## Session Data Structure

The decoded session contains:

```typescript
interface SessionData {
  header: {
    type: "session";
    version: number;
    id: string;           // Session UUID
    timestamp: string;    // ISO timestamp
    cwd: string;          // Working directory
  };
  entries: SessionEntry[];  // Conversation entries (JSON lines format)
  leafId: string | null;    // Current branch leaf
  systemPrompt?: string;    // System prompt text
  tools?: { name: string; description: string }[];
}
```

Entry types include:
- `message` - User/assistant/toolResult messages with content blocks
- `model_change` - Model switches  
- `thinking_level_change` - Thinking mode changes
- `compaction` - Context compaction events

Message content block types:
- `text` - Text content
- `toolCall` - Tool invocation with `toolName` and `args`
- `thinking` - Model thinking content
- `image` - Embedded images

## Example: Analyze a Session

```bash
# Pipe entries through jq to filter
node ~/.pi/agent/skills/pi-share/fetch-session.mjs "<url>" --entries | jq 'select(.type == "message" and .message.role == "user")'

# Count tool calls
node ~/.pi/agent/skills/pi-share/fetch-session.mjs "<url>" --entries | jq -s '[.[] | select(.type == "message") | .message.content[]? | select(.type == "toolCall")] | length'
```
