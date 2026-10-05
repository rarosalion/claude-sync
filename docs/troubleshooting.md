# Troubleshooting

## Common Issues

### "claude-sync is not configured on this device"

You need to run the init wizard first:

```bash
claude-sync init
```

### "Git repo not initialized"

The git backend needs a repo. Either:
1. Re-run `claude-sync init` with a remote URL
2. Or manually init: `git init ~/.claude-sync/repo`

### "Cannot connect via SSH" (rsync backend)

Verify SSH works independently:

```bash
ssh user@host echo ok
```

Common fixes:
- Ensure your SSH key is added to the agent: `ssh-add ~/.ssh/id_ed25519`
- Verify the host is in `~/.ssh/known_hosts`
- Check that `BatchMode=yes` doesn't interfere (test without it first)

### "Syncthing is not running"

Start Syncthing:
- **macOS**: `brew services start syncthing`
- **Linux**: `systemctl --user start syncthing`
- **Windows**: Start from the Start Menu

### "Push failed: needs pull first" (Git)

Another device pushed changes. Pull first:

```bash
claude-sync sync --pull
claude-sync sync --push
```

Or just:

```bash
claude-sync sync
```

This does both pull and push in the correct order.

### "Another sync is in progress"

A lock file exists at `~/.claude-sync/.claude-sync.lock`. This happens if a previous sync was interrupted.

If no sync is actually running, remove it:

```bash
rm ~/.claude-sync/.claude-sync.lock
```

### Sync stops with a conflict

The same lines changed on this device and on another one. Nothing was overwritten. Decide which side wins:

```bash
claude-sync sync --prefer local    # keep this device's version
claude-sync sync --prefer remote   # take the other device's version
```

A snapshot from before the sync is available via `claude-sync history` / `claude-sync restore`.

### "file(s) can run commands and were not applied"

Another device changed `settings.json` or something under `plugins/`. Review the files in `~/.claude-sync/incoming/`, then run `claude-sync sync --accept-incoming` or `claude-sync sync --reject-incoming`.

### Cloud storage not detected

If claude-sync can't find your cloud folder:

```bash
claude-sync init --backend cloud --cloud-provider dropbox --cloud-path /path/to/Dropbox
```

### "Unknown backend type: gitea"

Fixed in 1.1.0. Update claude-sync on every device.

### Slow sync

- **Git**: Check your network connection to the remote
- **Cloud**: Cloud providers sync in the background; files may take a few minutes
- **Syncthing**: Ensure both devices are online and paired
- **rsync**: Large diffs take longer; first sync is always the slowest

## Getting Help

1. Check `claude-sync status` for diagnostics
2. Run commands with `--json` for machine-readable output
3. Open an issue on GitHub with:
   - Your OS and Node.js version
   - Backend type
   - The error message
   - Output of `claude-sync status --json`
