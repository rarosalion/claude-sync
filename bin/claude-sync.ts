#!/usr/bin/env node

/**
 * claude-sync CLI — One Claude brain across all your devices
 */

import { Command } from 'commander';
import { initCommand } from '../src/cli/init.js';
import { syncCommand } from '../src/cli/sync.js';
import { statusCommand } from '../src/cli/status.js';
import { devicesCommand } from '../src/cli/devices.js';
import { configCommand } from '../src/cli/config.js';
import { historyCommand } from '../src/cli/history.js';
import { restoreCommand } from '../src/cli/restore.js';
import { onSessionStart } from '../src/hooks/session-start.js';
import { onSessionEnd } from '../src/hooks/session-end.js';
import { VERSION } from '../src/index.js';

const program = new Command();

program
  .name('claude-sync')
  .description('Sync your Claude Code .claude/ directory across all your devices')
  .version(VERSION);

program
  .command('init')
  .description('Set up claude-sync on this device (interactive wizard)')
  .option('--backend <type>', 'Sync backend: git, cloud, syncthing, rsync, custom')
  .option('--device-name <name>', 'Name for this device')
  .option('--remote-url <url>', 'Git remote URL (for git backend)')
  .option('--cloud-provider <provider>', 'Cloud provider: dropbox, icloud, onedrive')
  .option('--cloud-path <path>', 'Path to cloud storage folder')
  .option('--rsync-target <target>', 'rsync target (user@host:/path)')
  .option('--ssh-key <path>', 'SSH key path (for rsync backend)')
  .option('--push-cmd <command>', 'Custom push command')
  .option('--pull-cmd <command>', 'Custom pull command')
  .option('--encrypt', 'Enable encryption at rest')
  .option('--no-auto-sync', 'Disable auto-sync on session start/end')
  .option('--no-watch', 'Disable real-time file watching')
  .action(initCommand);

program
  .command('sync')
  .description('Manually sync now (push and pull)')
  .option('--push', 'Push local changes only')
  .option('--pull', 'Pull remote changes only')
  .option('--force', 'Force sync, overwriting conflicts')
  .option('--dry-run', 'Show what would change without syncing')
  .action(syncCommand);

program
  .command('status')
  .description('Show current sync status')
  .option('--json', 'Output as JSON')
  .option('--short', 'Show compact status line')
  .action(statusCommand);

program
  .command('devices')
  .description('List and manage connected devices')
  .option('--remove <id>', 'Remove a device from the registry')
  .option('--json', 'Output as JSON')
  .action(devicesCommand);

program
  .command('config')
  .description('View or update configuration')
  .option('--include <patterns>', 'Set include patterns (comma-separated)')
  .option('--exclude <patterns>', 'Set exclude patterns (comma-separated)')
  .option('--encrypt', 'Enable encryption')
  .option('--no-encrypt', 'Disable encryption')
  .option('--auto-sync', 'Enable auto-sync')
  .option('--no-auto-sync', 'Disable auto-sync')
  .option('--watch', 'Enable file watcher')
  .option('--no-watch', 'Disable file watcher')
  .option('--json', 'Output as JSON')
  .option('--reset', 'Reset configuration to defaults')
  .action(configCommand);

program
  .command('history')
  .description('View sync history and snapshots')
  .option('--limit <n>', 'Number of entries to show', '10')
  .option('--prune <n>', 'Keep only the N most recent snapshots')
  .option('--json', 'Output as JSON')
  .action(historyCommand);

program
  .command('restore <snapshot>')
  .description('Restore .claude/ from a snapshot (date or ID)')
  .option('--force', 'Skip confirmation prompt')
  .action(restoreCommand);

// onSessionStart/onSessionEnd (src/hooks/) existed since early versions but were never
// reachable from the CLI at all - their own doc comments say "claude-sync hook:start"/
// "claude-sync hook:end", but no such commands were ever registered here, so autoSync's
// onSessionStart/onSessionEnd config was silently unactionable regardless of setting. Fixed
// 2026-09-12. Intended for a host's own automation to invoke directly (a shell profile, a cron/
// systemd timer, or Claude Code's own SessionStart/SessionEnd hooks in settings.json) - this CLI
// exposes them, it doesn't register itself into anything automatically.
program
  .command('hook:start')
  .description('Pull latest changes - for use as a SessionStart hook (shell profile, Claude Code settings.json, etc.)')
  .action(async () => {
    const result = await onSessionStart();
    if (result) console.log(result);
  });

program
  .command('hook:end')
  .description('Push local changes - for use as a SessionEnd hook (shell profile, Claude Code settings.json, etc.)')
  .action(async () => {
    const result = await onSessionEnd();
    if (result) console.log(result);
  });

program.parse();
