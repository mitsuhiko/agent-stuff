# Agent Notes

## Releases

1. Run `npm version <patch|minor|major>` and verify `package.json` updates.
2. Update `CHANGELOG.md` for the release.
3. Commit the release changes and tag with the same version.
4. Push commits and tags, then publish with `npm publish` if needed.

## Extensions

Pi extensions live in `./pi-extensions`. When working in this repo, add or update extensions there. You can consult the `pi-mono` for reference, but do not modify code in `pi-mono`.
