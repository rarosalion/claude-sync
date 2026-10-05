# claude-sync

Guidance for AI agents working on this repo.

## Commits and releases

Every commit must be a Conventional Commit (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`, `style:` or `revert:`, optionally with a scope and a `!` for breaking changes). A merge to `main` automatically releases a new version computed from those messages, so the type you choose is the version bump: `fix:`/`perf:` is a patch, `feat:` a minor, `!` or a `BREAKING CHANGE:` footer a major, and the rest don't release. The `commit-lint` PR check rejects anything else. Never edit `version` in `package.json` by hand; the release workflow rewrites it (the CLI reads it at runtime via `src/version.ts`). See CONTRIBUTING.md.

## Checks before pushing

`npx tsc --noEmit`, `npm run lint` and `npx vitest run` must all pass. Open PRs against `rarosalion/claude-sync` only, never the upstream this repo was forked from.
