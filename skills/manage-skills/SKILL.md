---
name: manage-skills
description: Manage Agent Code skills across multiple repositories. Use when (1) syncing skills from multiple repos, (2) checking skill source freshness, (3) listing available skills and their sources, (4) disabling or pinning specific skills, (5) user mentions "link skills", "pull skills", "manage skills", "skill sources", or asks about available skills
---

# Skill Management

Manages symlinks from multiple skill source repositories into `~/.claude/skills/`.

Supports non-standard Claude home dirs via `CLAUDE_CONFIG_DIR` env var (defaults to `~/.claude`).
Example: `CLAUDE_CONFIG_DIR=~/pgs/.claude scripts/sync-skills.sh link`

## Commands

Run via `scripts/sync-skills.sh` in this skill directory:

| Command | Action |
|---------|--------|
| `link` | Create symlinks from sources |
| `status` | Show source freshness (org/repo labels), skill counts, shadow count |
| `list` | Show all skills with org/repo labels, shadow indicators |
| `pull` | Git pull sources, then link |
| `link --dry-run` | Preview link without changes |
| `pull --dry-run` | Preview pull without changes |

## Config Files

All in `$CLAUDE_CONFIG_DIR` (default `~/.claude/`):

| File | Format | Purpose |
|------|--------|---------|
| `skill-sources.txt` | One path per line | Source dirs, order = priority |
| `disabled-skills.txt` | One name per line | Skills to skip |
| `pinned-skills.txt` | `name path` per line | Force specific source |

Use `~` for home directory. Lines starting with `#` are comments.

## Priority Order

1. Manual overrides (real directories in `~/.claude/skills/`)
2. Pinned skills (`pinned-skills.txt`)
3. Sources in order (first match wins)

Disabled skills are removed regardless of source.

When a skill exists in multiple sources, only the first source wins. The others are "shadowed" — `status` shows the shadow count and `list` shows which sources are shadowed per skill. Sources are displayed as `org/repo` labels (parsed from git remote) for readability.

**Multi-path detection:** When the same git repo appears multiple times in `skill-sources.txt` (different subdirs), `status` marks them as `[multi-path]`. This is fine if each path contains different skills, but may indicate config duplication if unintentional.

**Fork detection:** For repos with an `upstream` remote (forks), `status` shows `[upstream: N new]` when the upstream has commits not yet synced. Use `gh repo sync` or the GitHub "Sync fork" button to pull upstream changes.

## Common Tasks

**Check status:**
```bash
scripts/sync-skills.sh status
```

**Disable a skill:**
```bash
echo "noisy-skill" >> ~/.claude/disabled-skills.txt
scripts/sync-skills.sh link
```

**Pin to specific source:**
```bash
echo "my-skill ~/my-fork/skills/my-skill" >> ~/.claude/pinned-skills.txt
scripts/sync-skills.sh link
```

**Add new source repo:**
```bash
echo "~/repos/new-skills-repo" >> ~/.claude/skill-sources.txt
scripts/sync-skills.sh link
```

**Preview changes:**
```bash
scripts/sync-skills.sh link --dry-run
```

**Pull all sources:**
```bash
scripts/sync-skills.sh pull
```

## Adding a Branch as Source (Git Worktrees)

When user provides a GitHub URL pointing to a specific branch (e.g., `https://github.com/org/repo/tree/branch-name/skills`):

1. **Check if repo is already cloned** — look in `~/.claude/skill-sources.txt` and common clone locations
2. **If already cloned**, use `git worktree` to create a separate working directory for the branch:
   ```bash
   cd ~/repos/<repo>
   git fetch origin
   git worktree add ~/repos/<repo>--<branch> origin/<branch>
   cd ~/repos/<repo>--<branch>
   git checkout -b <branch> --track origin/<branch>
   ```
   Convention: name worktree dirs `<repo>--<branch>` (double dash separator).
3. **If not cloned**, clone first, then create worktree (or clone directly to the branch)
4. **Add to sources**: `echo "~/repos/<repo>--<branch>/skills" >> ~/.claude/skill-sources.txt`
5. **Run link**: `scripts/sync-skills.sh link`

`status` and `list` show `@branch` suffix in labels for non-default branches.
`pull` updates each worktree independently (pulls the tracked branch).

## Adding a GitHub Repo as Source

When user provides a GitHub URL (e.g., "add https://github.com/xero-internal/ai-enablement-sandbox as a skill source"):

⚠️ **ALWAYS check `~/.claude/skill-sources.txt` first to infer clone location, then ASK user to confirm before cloning. Do NOT invent paths.**

1. **Extract repo name** from URL (e.g., `ai-enablement-sandbox`)

2. **Determine clone location** (REQUIRED - do not skip):
   - Read `~/.claude/skill-sources.txt` to see existing source paths
   - Find common parent directory (e.g., `~/repos/`, `~/pgs/`)
   - **ASK user**: "Clone to ~/repos/<name>?"
   - **Wait for confirmation** before proceeding

3. **Clone the repo** (only after user confirms location):
   ```bash
   gh repo clone <url> <path>
   ```

4. **Find skills directory** - Look for directories containing SKILL.md:
   ```bash
   find <repo-path> -name "SKILL.md" -type f | head -5
   ```
   Common locations: `skills/`, `experimental-skills/`, or repo root

5. **Add to sources** - Append the skills directory path to `~/.claude/skill-sources.txt`

6. **Run link**:
   ```bash
   ~/.claude/skills/manage-skills/scripts/sync-skills.sh link
   ```

7. **Report** - Show count of new skills added

## Bootstrap

First-time setup (before this skill is available):
```bash
~/repos/payments-ai-lab/experimental-skills/manage-skills/scripts/sync-skills.sh
```
