---
name: github
description: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, `gh stack`, and `gh api` for issues, PRs, stacked PRs, CI runs, and advanced queries."
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory, or use URLs directly.

## Pull Requests

Check CI status on a PR:
```bash
gh pr checks 55 --repo owner/repo
```

List recent workflow runs:
```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:
```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:
```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## Stacked Pull Requests

GitHub provides stacked PR commands through the official `github/gh-stack` extension. Check whether it is installed:

```bash
gh stack --help
```

If it is missing, ask before installing it because installation changes the user's CLI environment:

```bash
gh extension install github/gh-stack
```

Check whether a PR belongs to a GitHub stack:

```bash
gh api repos/owner/repo/pulls/42 --jq '.stack'
gh api "repos/owner/repo/stacks?pull_request=42"
```

Stack commands operate on a local repository and require a clean worktree. Check out an existing remote stack, inspect it, then rebase and push it:

```bash
gh stack checkout 7
gh stack view --short
gh stack rebase
gh stack push
```

Use `gh stack sync` to fetch, cascade the rebase from trunk upward, push rewritten branches with leases, and synchronize PR stack metadata in one command. It changes local history and remote branches, so ask before running it.

Do not use `gh pr update-branch --rebase` for a multi-PR stack because it updates only one PR branch. The website's "Rebase stack" button performs a server-side operation; there is no documented CLI command or public API operation that directly invokes that button.

`gh stack push` uses explicit per-branch force-with-lease checks but is not atomic. When every branch must update together, use one manual `git push --atomic` with an exact `--force-with-lease` value for each branch.

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other subcommands.

Get PR with specific fields:
```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

## JSON Output

Most commands support `--json` for structured output.  You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
