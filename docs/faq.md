# FAQ

## General

### What exactly does claude-sync sync?

Your `~/.claude/` directory. This is where Claude Code stores:
- **Memory files** — what Claude remembers about your projects
- **Skills** — custom commands and capabilities
- **Settings** — preferences and configuration
- **Activity logs** — session history
- **Project context** — per-project `.claude/` directories

### Does claude-sync sync my actual code?

No. claude-sync only touches `.claude/` directories. Your source code, git repos, and other files are untouched.

### Can I use claude-sync on Windows?

Yes. claude-sync uses cross-platform paths and works on macOS, Linux, and Windows. The Git and Custom backends work on all platforms. Cloud storage works wherever the provider's app is installed.

### How much disk space does it use?

Typically very little. `.claude/` directories are mostly small text files (markdown, JSON). Expect a few MB at most. Snapshots cover only what sync manages (not plugins, caches or session transcripts), are skipped when nothing has changed, and are pruned automatically after every snapshot: at most 30 are kept, and any older than 7 days go too (apart from the newest 3).

### Is it safe to use on a work machine?

Yes, with caveats:
- Use a **private** repo if using the Git backend
- Use a private sync target you control (encryption at rest is not implemented yet)
- Consider the **Syncthing** backend for maximum privacy (no cloud)
- Review your organization's policies on syncing tools

## Sync Behavior

### What happens if I edit on two devices at the same time?

With the Git and Gitea backends:
- Changes to different files, or appends to the same memory file or activity log, are combined automatically
- If the same lines changed on both devices, the sync stops without overwriting anything; run `claude-sync sync --prefer local` or `--prefer remote`
- Changes to `settings.json` and `plugins/` from another device are held for your review

The experimental backends (cloud, Syncthing, rsync, custom) copy files: the last copy wins.

### How often does it sync?

Depends on your configuration:
- **Auto-sync**: Pulls on session start, pushes on session end, via Claude Code hooks (see the README)
- **File watcher**: Not implemented yet
- **Manual**: Run `claude-sync sync` whenever you want

### Can I sync only specific files?

Yes, use selective sync:

```bash
claude-sync config --include projects,skills,CLAUDE.md --exclude todos
```

The lists apply to this device only. Files already in the sync target stay there for your other devices; delete them on a device that syncs them to remove them everywhere.

### What if I lose internet during sync?

- **Git**: Changes are committed locally. They'll push when you're back online.
- **Cloud**: Your cloud app handles offline queuing.
- **Syncthing**: Syncs when devices reconnect.
- **rsync**: Fails gracefully. Retry when connected.

### Can I undo a sync?

Yes. Every sync creates a snapshot:

```bash
claude-sync history        # See available snapshots
claude-sync restore <id>   # Roll back
```

A backup of the current state is always saved before restoring.

## Backends

### Can I switch backends later?

Yes. Run `claude-sync init` again and choose a different backend. Your local `.claude/` directory stays intact.

### Can I use multiple backends simultaneously?

Not currently. claude-sync uses one backend at a time. If you need this, consider the Custom backend with a script that syncs to multiple targets.

### Does the Git backend create a lot of commits?

One commit per push. If you have auto-sync enabled, that's roughly one commit per Claude Code session. You can prune history on the remote if needed.

### Do I need a GitHub account for the Git backend?

No. Any Git remote works — GitHub, GitLab, Bitbucket, Gitea, a bare repo on your own server, etc.

## Privacy & Security

### Does claude-sync send data to Anthropic or any third party?

No. Zero telemetry, zero analytics, zero data collection. Everything stays between your devices and your chosen backend.

### Is my data encrypted in transit?

- **Git over SSH**: Yes (SSH encryption)
- **Cloud storage**: Yes (provider's encryption)
- **Syncthing**: Yes (TLS)
- **rsync over SSH**: Yes (SSH encryption)

### Is my data encrypted at rest?

Not yet. Encryption at rest is not implemented, so files are stored as-is in the sync target. Use a private repository or storage only you can access. Credentials such as `~/.claude/.credentials.json` are never synced.
