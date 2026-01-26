Make a release of this repository.

Version or release type: "$ARGUMENTS"

## Step-by-Step Process:

### 1. Determine the target version

The `$ARGUMENTS` can be either:
- An explicit version number (e.g., `0.0.4`) - recommended for making a specific release
- A release type: `patch`, `minor`, or `major` - which will bump from the current version

If `$ARGUMENTS` is an explicit version (e.g., `0.0.4`):
- Use that version directly as `$NEW_VERSION`
- This is the recommended approach as it allows retrying failed releases

If `$ARGUMENTS` is a release type (`patch`, `minor`, or `major`):
- Determine what the new version will be by running:
  ```bash
  cd sdks/typescript
  CURRENT_VERSION=$(node -p "require('./package.json').version")
  NEW_VERSION=$(npm version $ARGUMENTS --no-git-tag-version | sed 's/^v//')
  git checkout package.json package-lock.json  # Revert the changes
  cd ../..
  echo "Will release version: $NEW_VERSION"
  ```
- Then use this `$NEW_VERSION` for the rest of the process

If no argument is provided, ask the user which version or type to use.

### 2. Update the changelog

Run the `/update-changelog` command to ensure the changelog is up to date with recent changes.

### 3. Verify the version number

Double-check that `$NEW_VERSION` is correct before proceeding.

### 4. Update CHANGELOG.md

Edit the `CHANGELOG.md` file:
- Change the `# Unreleased` heading to `# $NEW_VERSION`
- Add a new `# Unreleased` section at the top (empty for now)

### 5. Run the release script

Execute the release script with the explicit version number (NOT the release type):

```bash
./scripts/release.sh $NEW_VERSION
```

**Important:** Always pass the explicit version number (e.g., `0.0.4`) to the release script, not the release type (e.g., `patch`). This ensures that aborted releases can be retried without incrementing the version.

This script will:
- Update the version in `sdks/typescript/package.json` (or skip if already set)
- Update `package-lock.json`
- Create a commit with message "Release $NEW_VERSION"
- Create a git tag with the version number

### 6. Show push instructions

After the release script completes, show the user the commands to push:

```bash
git push origin main && git push origin $NEW_VERSION
```

**Important:** Do NOT automatically push. Let the user review the commit and tag first, then they can manually run the push commands.

## Notes

- The release script will check for a clean working directory
- It will verify that CHANGELOG.md has a section for the new version
- The user should review the commit and tag before pushing
