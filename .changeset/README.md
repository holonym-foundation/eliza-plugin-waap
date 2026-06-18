# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).

To record a change for the next release, run:

```bash
pnpm changeset
```

Pick the bump type (patch / minor / major) and write a short summary. Commit the
generated `.changeset/*.md` file with your PR. When it merges to `main`, the
Release workflow opens (or updates) a **"Version Packages"** PR that bumps the
version and updates `CHANGELOG.md`. Merging that PR publishes to npm.
