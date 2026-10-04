# Changelog

## 1.1.0 (2026-10-04)

Security and correctness release. **Everyone should upgrade on every device.** If you used a hosted remote with an earlier version, see "Action needed" below.

### Security

- **Credentials and secrets are never synced.** Earlier versions copied all of `~/.claude`, including `.credentials.json` (the Claude Code login), shell snapshots, IDE auth tokens and `.env` files, to the sync target. A fixed never-synced list now applies in every backend and both directions, and copies left in the sync target by older versions are deleted on the next sync.
- **No code execution through the sync target.** `settings.json` (hooks) and `plugins/` from other devices used to be applied automatically, also by the session-start hook, so anyone able to write to the remote could run commands on every device. Remote changes to them are now held in `~/.claude-sync/incoming/` until you run `claude-sync sync --accept-incoming`.
- **Encryption at rest was advertised but never applied.** The prompt is gone and the docs say plainly that it is not implemented; `--encrypt` prints a notice.
- Custom backend: placeholders are inserted shell-quoted, and commands receive a filtered staging copy instead of `~/.claude`.
- Credentials embedded in a remote URL (Gitea token) are removed from error messages.
- The never-synced list matches case-insensitively.

### Fixed

- **Data loss on sync (git, gitea):** a pull overwrote local edits that had not been pushed yet. Each sync now commits local state first, merges with git's three-way merge and applies only what changed.
- **Deletions were never synced** (git, gitea). They are now, based on what this device had at its last sync; a new device never deletes anything on its first sync.
- **Upgrading devices keep their edits:** a local repo created by an earlier version commits this device's edits first on the first 1.1 sync and deletes nothing; deletions propagate from the second sync on.
- **Merge conflicts broke the local repo** (and the gitea backend ran `git reset --hard`, discarding local commits). Conflicts now abort cleanly, leave `~/.claude` untouched and can be resolved with `--prefer local|remote`.
- **Appends to the same memory file** from two devices are both kept (git `union` merge for memory files, activity logs and `.jsonl` transcripts).
- **The gitea backend crashed** every command except `init` ("Unknown backend type: gitea").
- **Selective sync** (`config --include/--exclude`) was saved but never applied; it now is.
- **Session hooks could not be used**: there was no command to run them. `claude-sync hook session-start|session-end` now exists (see the README for the Claude Code hook configuration).
- **rsync backend** used `--delete` in both directions, deleting other devices' files on push and unsynced local files on pull.
- Commits failed on machines without a global git identity.
- Config and device registry are written atomically.
- `npm install` failed (`@typescript-eslint` v7 with eslint 9); lint had no configuration. The build no longer ships compiled tests.
- Version numbers were inconsistent (0.1.0 / 0.2.0); the CLI now reads the version from `package.json`.
- `package.json` pointed to a different GitHub repository.

### Changed

- Cloud storage, Syncthing, rsync and custom backends are marked **experimental**: they copy files (last copy wins) and do not sync deletions.
- `claude-sync sync --force` is kept as an alias for `--prefer local`.
- Custom backend commands: do not put your own quotes around `{path}`, `{home}` or `{hostname}` any more.
- CI runs typecheck, lint, tests and build on Node 18, 20, 22 and 24.

### Action needed if you used an earlier version with a hosted remote

1. Upgrade on every device and run `claude-sync sync` once; this removes the leaked files from the current state of the remote.
2. Log out and back in to Claude Code on your devices to replace the old login.
3. Remove the files from the remote's history, for example `git filter-repo --path .credentials.json --path-glob 'shell-snapshots/*' --path-glob 'ide/*' --invert-paths`, then force-push.

## 1.0.0 (2026-03-18)

- Initial release.
