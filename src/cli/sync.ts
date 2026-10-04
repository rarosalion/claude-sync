/**
 * Manual sync command — push and/or pull on demand
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { loadConfig, getBackend, transferOptions } from './helpers.js';
import { SnapshotManager } from '../core/snapshot.js';
import { DeviceRegistry } from '../core/device-registry.js';
import { applyHeld } from '../core/sync-filter.js';
import { DEFAULT_HELD_DIR } from '../backends/git-sync.js';
import type { SyncResult } from '../types.js';

interface SyncOptions {
  push?: boolean;
  pull?: boolean;
  force?: boolean;
  dryRun?: boolean;
  prefer?: string;
  acceptIncoming?: boolean;
  rejectIncoming?: boolean;
}

function printFiles(files: string[]): void {
  for (const file of files.slice(0, 10)) console.log(chalk.dim(`    ${file}`));
  if (files.length > 10) console.log(chalk.dim(`    ... and ${files.length - 10} more`));
}

function printResult(result: SyncResult, verb: 'Pulled' | 'Pushed'): void {
  if (!result.success) {
    console.log(chalk.red(`  ${verb === 'Pulled' ? 'Pull' : 'Push'} failed: ${result.error}`));
    printFiles(result.conflicts.map((c) => c.filePath));
    return;
  }
  if (result.filesChanged.length === 0) {
    console.log(chalk.dim(verb === 'Pulled' ? '  Already up to date.' : '  Nothing to push.'));
  } else {
    console.log(chalk.green(`  ${verb} ${result.filesChanged.length} file(s) in ${result.duration}ms`));
    printFiles(result.filesChanged);
  }
  if (result.held && result.held.length > 0) {
    console.log('');
    console.log(chalk.yellow(`  ${result.held.length} file(s) can run commands and were not applied:`));
    printFiles(result.held);
    console.log(chalk.dim(`  Review them in ${DEFAULT_HELD_DIR}, then run`));
    console.log(chalk.dim("  'claude-sync sync --accept-incoming' or 'claude-sync sync --reject-incoming'."));
  }
}

async function handleIncoming(claudeDir: string, accept: boolean): Promise<void> {
  if (accept) {
    const applied = await applyHeld(DEFAULT_HELD_DIR, claudeDir);
    console.log(applied.length ? chalk.green(`  Applied ${applied.length} held file(s).`) : chalk.dim('  Nothing was held.'));
    printFiles(applied);
  } else {
    await fs.rm(DEFAULT_HELD_DIR, { recursive: true, force: true });
    console.log(chalk.dim('  Discarded held files. The next sync pushes your local versions.'));
  }
  console.log('');
}

export async function syncCommand(options: SyncOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) return;

  const claudeDir = path.join(os.homedir(), '.claude');
  if (options.acceptIncoming || options.rejectIncoming) {
    await handleIncoming(claudeDir, Boolean(options.acceptIncoming));
    return;
  }

  if (options.prefer && options.prefer !== 'local' && options.prefer !== 'remote') {
    console.log(chalk.red("  --prefer must be 'local' or 'remote'."));
    return;
  }
  // --force predates --prefer and keeps working as 'prefer local'.
  const prefer = (options.prefer ?? (options.force ? 'local' : undefined)) as 'local' | 'remote' | undefined;
  const backend = getBackend(config.backend);
  const transfer = transferOptions(config, prefer);
  const doPush = options.push || !options.pull;
  const doPull = options.pull || !options.push;

  if (options.dryRun) {
    const status = await backend.status();
    console.log(chalk.dim(`  [dry-run] ${status.availableUpdates} remote update(s), ${status.pendingChanges} local change(s).`));
    return;
  }

  // One safety snapshot before anything can change ~/.claude.
  await new SnapshotManager()
    .create(claudeDir, config.deviceId, config.deviceName, 'pre-sync backup')
    .catch(() => undefined);

  let ok = true;
  if (doPull) {
    console.log(chalk.cyan('  Pulling remote changes...'));
    const result = await backend.pull(claudeDir, transfer);
    printResult(result, 'Pulled');
    ok = result.success;
    console.log('');
  }

  if (doPush && ok) {
    console.log(chalk.cyan('  Pushing local changes...'));
    const result = await backend.push(claudeDir, transfer);
    printResult(result, 'Pushed');
    ok = result.success;
    console.log('');
  }

  if (ok) await new DeviceRegistry().updateLastSync(config.deviceId);
  if (!ok) process.exitCode = 1;
}
