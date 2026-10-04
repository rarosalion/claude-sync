<div align="center">

# claude-sync

> **[🚀 Live Demo](https://claude-sync-demo.pages.dev)** — Try it in your browser, no installation needed.

### One Claude brain across all your devices

**Switch machines, keep the context.** Your Claude Code memory, skills, and settings follow you everywhere.

[![CI](https://github.com/renefichtmueller/claude-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/renefichtmueller/claude-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Quick Start](#quick-start) | [The Problem](#the-problem) | [Features](#features) | [Backends](#sync-backends) | [Docs](docs/)

</div>

> [!IMPORTANT]
> **Upgrading from a version before 1.1.0?** Older versions synced `~/.claude/.credentials.json` (your Claude Code login), shell snapshots and IDE tokens to the sync target, and applied `settings.json` from other devices without asking. 1.1.0 stops that and removes those files from the sync target on the next sync. If you used a hosted remote, log out and back in to Claude Code to replace the old login, and purge the files from the remote's history (for example with `git filter-repo`). See [CHANGELOG.md](CHANGELOG.md).

---

## Quick Start

```bash
# 1. Install (the npm name "claude-sync" belongs to an unrelated package)
git clone https://github.com/renefichtmueller/claude-sync.git
cd claude-sync && npm install && npm install -g .

# 2. Set up (interactive wizard, or pass flags)
claude-sync init

# 3. Sync
claude-sync sync
```

To sync automatically when Claude Code sessions start and end, add the [session hooks](#auto-sync-on-session-startend).

---

## The Problem

You're a vibecoder. You work on your desktop at home in the evening. You switch to your laptop during the day. Maybe you have a work machine too.

Every time you switch:

- **Monday morning, open laptop:** "What framework are we using again?" *(Claude asks for the fifth time)*
- **Switch to desktop:** All the context from your laptop session? Gone.
- **New machine:** Spend 30 minutes re-explaining your projects, preferences, and patterns.

Claude Code's `.claude/` directory stores everything — your memory, your skills, your project context, your preferences. But it's **local-only**. Switch devices and Claude has amnesia.

## The Solution

| | Without claude-sync | With claude-sync |
|---|---|---|
| **Switch devices** | Re-explain everything | Claude already knows |
| **New machine** | 30 min setup | `claude-sync init` (30 sec) |
| **Memory** | Lost on each device | Merged across all devices |
| **Skills** | Device-specific | Available everywhere |
| **Settings** | Manual copy | Synced; changes from other devices need one confirmation |
| **Activity logs** | Fragmented | Appends from all devices are kept |
| **Project context** | Starts fresh | Picks up where you left off |

---

## Features

### Zero-Config Setup

One command. Detects your OS, suggests the best sync method, sets up everything.

```
claude-sync init

  ? What's this device's name? [MacBook-Pro]
  ? How do you want to sync?
    > Git (recommended)
      iCloud / Dropbox / OneDrive
      Syncthing (P2P)
      rsync over SSH
      Custom command

  Setup complete!
```

### How syncing works

Git and Gitea are the recommended backends. Every sync:

1. commits this device's current state, including files you deleted since the last sync,
2. merges the other devices' changes with git's three-way merge,
3. applies only what the merge changed to `~/.claude`, then pushes.

| Situation | What happens |
|-----------|--------------|
| Different files changed on two devices | Both changes are kept |
| Two devices appended to the same memory file or activity log | Both sides are kept (git `union` merge) |
| The same lines changed on two devices | Sync stops, nothing is overwritten. Run `claude-sync sync --prefer local` or `--prefer remote` |
| A file was deleted on another device | It is deleted here too (git backends) |
| A new device joins | It takes over the shared state and adds its own files; nothing is deleted on the first sync |

A snapshot of `~/.claude` is taken before every sync (see [Backup & History](#backup--history)).

### Never synced

These stay on the device, whatever your configuration says: `.credentials.json`, `settings.local.json`, `.env` / `.env.*` (examples are allowed), `*.pem`, `*.key`, SSH keys, `shell-snapshots/`, `session-env/`, `ide/` and `statsig/`.

### Changes that can run commands

`settings.json` (hooks) and `plugins/` (plugin hooks and MCP servers) can make Claude Code run commands. When another device changes them, claude-sync does not apply the change. It stores it in `~/.claude-sync/incoming/` and tells you; after reviewing, run `claude-sync sync --accept-incoming` (or `--reject-incoming`). Whoever can write to your sync target therefore cannot run code on your machines unnoticed.

### Selective Sync

Don't want to sync everything? Pick what matters:

```bash
claude-sync config --include projects,skills,CLAUDE.md --exclude todos
```

Include and exclude lists apply to this device only: it stops sending and receiving those paths. Files already in the sync target stay there for your other devices; to remove them everywhere, delete them on a device that syncs them.

### Device Registry

See all your machines at a glance:

```bash
claude-sync devices

  Desktop-Home   (this device)
    OS: macOS  |  Last sync: 2 min ago  |  Last seen: just now

  MacBook-Pro
    OS: macOS  |  Last sync: 1 hour ago  |  Last seen: 1 hour ago

  Work-PC
    OS: Linux  |  Last sync: yesterday  |  Last seen: yesterday
```

### Sync Status

Always know where you stand:

```bash
claude-sync status

  Connected via git
  Device:     MacBook-Pro
  Last sync:  2 min ago
  Everything is up to date.
```

Or get a compact status for shell prompts:

```bash
claude-sync status --short
# [synced]
# [2 changes pending]
# [3 updates available]
```

### Auto-Sync on Session Start/End

Pull when a Claude Code session starts, push when it ends. Enable it in claude-sync, then add the hooks to `~/.claude/settings.json`:

```bash
claude-sync config --auto-sync
```

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "claude-sync hook session-start" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "claude-sync hook session-end" }] }]
  }
}
```

### Encryption at Rest

Not implemented yet. Files are synced unencrypted, so use a private remote you control. The `--encrypt` flag only prints this notice.

### Backup & History

A local snapshot is taken before every sync. Roll back to any point in time:

```bash
claude-sync history
  a1b2c3  Mar 15, 2025, 10:30 AM  (2 days ago)
    42 files, 1.2 MB — from Desktop-Home

claude-sync restore a1b2c3
```

### Works with claude-cortex

If you use [claude-cortex](https://github.com/renefichtmueller/claude-cortex) for memory, its files live in `~/.claude` and are synced like everything else:

- **claude-cortex** = better memory *on one device*
- **claude-sync** = same memory *across all devices*

### Not implemented yet

- Encryption at rest
- The real-time file watcher (`watchEnabled` is stored but nothing runs it); use the session hooks

---

## Sync Backends

| Backend | Status | Merges, conflicts, deletions | Best For |
|---------|--------|------------------------------|----------|
| **Git** | Recommended | Yes | Developers who want version history |
| **Gitea** | Recommended | Yes | Self-hosted Git, auto-creates the repo |
| **iCloud/Dropbox/OneDrive** | Experimental | No: last copy wins, deletions are not synced | Single-user setups |
| **Syncthing** | Experimental | No: last copy wins, deletions are not synced | No cloud |
| **rsync/SSH** | Experimental | No: last copy wins, deletions are not synced | Direct machine-to-machine |
| **Custom** | Experimental | Depends on your commands | Existing sync infrastructure |

All backends apply the never-synced list and hold `settings.json` / `plugins/` changes for review.

### Git (Recommended)

Auto-commits and pushes `.claude/` to a private repo. Best balance of version history, speed, and portability.

```bash
claude-sync init --backend git --remote-url git@github.com:you/claude-sync-data.git
```

### Cloud Storage

Syncs via Dropbox, iCloud, or OneDrive. Auto-detects your cloud folder.

```bash
claude-sync init --backend cloud --cloud-provider icloud
```

### Syncthing

P2P sync between your devices. No cloud, no third party. Maximum privacy.

```bash
claude-sync init --backend syncthing
```

### rsync over SSH

Direct machine-to-machine sync. For users who already have SSH set up.

```bash
claude-sync init --backend rsync --rsync-target me@server:~/.claude-sync-data
```

### Custom

Bring your own sync command. `{path}` is a filtered staging copy (push) or an empty staging folder (pull), never `~/.claude` itself. Placeholders are inserted shell-quoted, so do not add your own quotes around them.

```bash
claude-sync init --backend custom \
  --push-cmd "rclone sync {path} remote:claude-backup" \
  --pull-cmd "rclone sync remote:claude-backup {path}"
```

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `claude-sync init` | Interactive setup wizard |
| `claude-sync sync` | Manual sync (push + pull) |
| `claude-sync sync --push` | Push local changes only |
| `claude-sync sync --pull` | Pull remote changes only |
| `claude-sync sync --prefer local\|remote` | Resolve conflicts with this side |
| `claude-sync sync --accept-incoming` | Apply held `settings.json` / `plugins/` changes |
| `claude-sync sync --reject-incoming` | Discard held changes |
| `claude-sync sync --dry-run` | Show what would change |
| `claude-sync hook session-start\|session-end` | Run from Claude Code hooks |
| `claude-sync status` | Show sync status |
| `claude-sync status --short` | Compact status (for prompts) |
| `claude-sync devices` | List connected devices |
| `claude-sync devices --remove <id>` | Remove a device |
| `claude-sync config` | View configuration |
| `claude-sync config --include <patterns>` | Set include patterns |
| `claude-sync config --exclude <patterns>` | Set exclude patterns |
| `claude-sync config --auto-sync` | Enable auto-sync |
| `claude-sync history` | View snapshots |
| `claude-sync history --prune 20` | Keep only 20 most recent |
| `claude-sync restore <id>` | Restore from snapshot |

---

## How It Works

```
Your Devices                    Sync Target
                               (Git repo / Cloud / P2P)

 Desktop        push
 ~/.claude/ ──────────────>  ┌──────────────────┐
                             │                  │
 Laptop         pull         │   Shared State   │
 ~/.claude/ <──────────────  │                  │
                             │  memory/         │
 Work PC        push/pull    │  skills/         │
 ~/.claude/ <─────────────>  │  settings/       │
                             │  projects/       │
                             └──────────────────┘
```

1. **Session starts** on any device: claude-sync pulls the latest state
2. **You work** with Claude Code. Memory, skills, context accumulate in `.claude/`
3. **Session ends**: claude-sync pushes your changes
4. **Switch devices**: Step 1 again. Claude knows everything.

When two devices change the same lines, sync stops and asks you to choose instead of overwriting.

---

## Configuration

Configuration is stored in `~/.claude-sync/config.json`:

```json
{
  "version": 1,
  "deviceId": "a1b2c3d4e5f6",
  "deviceName": "MacBook-Pro",
  "backend": {
    "type": "git",
    "remoteUrl": "git@github.com:you/claude-sync-data.git",
    "branch": "main"
  },
  "encryption": {
    "enabled": false
  },
  "autoSync": {
    "onSessionStart": true,
    "onSessionEnd": true,
    "watchEnabled": false,
    "watchDebounceMs": 2000
  },
  "selective": {
    "mode": "all",
    "include": [],
    "exclude": []
  }
}
```

---

## Security

- **Credentials never leave the device**: see [Never synced](#never-synced)
- **No remote code execution through sync**: `settings.json` and `plugins/` changes are held for review
- **Encryption at rest**: not implemented yet; use a private remote
- **No telemetry**: zero data collection, zero phone-home
- **SSH key auth**: rsync backend uses SSH keys, never passwords

See [docs/security.md](docs/security.md) for details.

---

## Requirements

- **Node.js** >= 18
- **Git** (for git backend)
- **rsync** (for rsync backend)
- **Syncthing** (for syncthing backend)

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT. See [LICENSE](LICENSE).

---

<div align="center">

**If claude-sync helps you vibe across devices, give it a star!**

Built for vibecoders who refuse to repeat themselves.

</div>
