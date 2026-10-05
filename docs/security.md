# Security

claude-sync moves the contents of `~/.claude` between your devices. That directory holds memory, skills and settings, and on some systems also your Claude Code login. This page describes what claude-sync does to keep that safe, and what it does not do (yet).

## Principles

1. **Your data stays on infrastructure you choose.** No telemetry, no third-party servers.
2. **Credentials never leave the device.**
3. **A sync target is not trusted to run code on your machines.**
4. **Nothing is overwritten silently.** Conflicts stop the sync; a snapshot is taken first.

## Never synced

These paths are excluded in both directions, in every backend, whatever the selective-sync configuration says. They are matched against every path segment:

| Pattern | Why |
|---------|-----|
| `.credentials.json` | Claude Code login (OAuth tokens) |
| `settings.local.json` | Per-machine settings by Claude Code convention |
| `.env`, `.env.*` | Secrets in dotenv files (`.env.example`, `.env.sample`, `.env.template` are allowed) |
| `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ecdsa*`, `id_ed25519*` | Keys and certificates |
| `shell-snapshots/`, `session-env/` | Captured shell environments, which can contain exported tokens |
| `ide/` | IDE connection lock files with auth tokens |
| `statsig/` | Device-specific cache |

Copies of these files that older versions placed in the sync target (the git working tree, the cloud or Syncthing folder) are deleted from it on the next sync. **They remain in git history.** If you used a hosted remote with a version before 1.1.0, log out and back in to Claude Code to replace the login, and rewrite the remote's history (for example with `git filter-repo --path .credentials.json --invert-paths`).

## Files that can run commands

`~/.claude/settings.json` can define hooks (shell commands Claude Code runs on events), and `~/.claude/plugins/` can contain plugin hooks and MCP servers. If claude-sync applied remote changes to them automatically, anyone with write access to your sync target could run code on every device.

So when another device changes them, claude-sync:

1. leaves your local version untouched,
2. stores the incoming version in `~/.claude-sync/incoming/`,
3. tells you (in `claude-sync sync` output and in the session-start hook message).

After reviewing the files, run `claude-sync sync --accept-incoming` to apply them or `--reject-incoming` to discard them. A new device also has to accept them once. Your own local changes to these files are synced normally.

## Encryption at rest

**Not implemented yet.** Files are stored unencrypted in the sync target. Until it is, use a private repository or a storage location only you can read. The `--encrypt` flags print a notice and change nothing.

## Encryption in transit

This depends on the backend and is handled by the underlying tool:

- **Git / Gitea**: SSH or HTTPS
- **Cloud storage**: the provider's client (TLS)
- **Syncthing**: TLS between devices
- **rsync**: SSH

## Backend notes

### Git / Gitea

- Use a **private** repository.
- The Gitea backend stores your access token in the clone URL inside `~/.claude-sync/gitea-repo/.git/config` (file permissions of your home directory apply).

### Cloud storage, Syncthing, rsync, custom (experimental)

- They copy files; they do not merge. The last copy wins and deletions are not propagated.
- The never-synced list and the held-files rule apply to them as well.
- The custom backend passes a filtered staging copy to your commands, never `~/.claude` itself. Placeholders are inserted shell-quoted.

## Local files

| Path | Content |
|------|---------|
| `~/.claude-sync/config.json` | Configuration (written atomically) |
| `~/.claude-sync/devices.json` | Device registry |
| `~/.claude-sync/snapshots/` | Local snapshots taken before each sync; they contain everything in `~/.claude`, including credentials, and never leave the device |
| `~/.claude-sync/incoming/` | Held `settings.json` / `plugins/` changes awaiting review |

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) instead of a public issue.
