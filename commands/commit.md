Create a git commit for the current changes using a concise Conventional Commits-style subject.

## Format

`<type>(<scope>): <summary>`

- `type` REQUIRED. Use `feat` for new features, `fix` for bug fixes. Other common types: `docs`, `refactor`, `chore`, `test`, `perf`.
- `scope` OPTIONAL. Short noun in parentheses for the affected area (e.g., `api`, `parser`, `ui`).
- `summary` REQUIRED. Short, imperative, <= 72 chars, no trailing period.

## Notes

- Body is OPTIONAL. If needed, add a blank line after the subject and write short paragraphs.
- Do NOT include breaking-change markers or footers.
- Do NOT add sign-offs (no `Signed-off-by`).
- Only commit; do NOT push.
- If it is unclear whether a file should be included, ask the user which files to commit.

## Steps

1. Review `git status` and `git diff` to understand the current changes.
2. (Optional) Run `git log -n 50 --pretty=format:%s` to see commonly used scopes.
3. If there are ambiguous extra files, ask the user for clarification before committing.
4. Run `git commit -m "<subject>"` (and `-m "<body>"` if needed).
