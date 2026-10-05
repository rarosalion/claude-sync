/**
 * Shared CLI helpers — config loading, backend creation
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { CONFIG_DIR, CONFIG_FILE } from '../types.js';
import type { SyncConfig, BackendConfig, SyncBackend, TransferOptions } from '../types.js';
import { GitBackend } from '../backends/git.js';
import { GiteaBackend } from '../backends/gitea.js';
import { DEFAULT_HELD_DIR } from '../backends/git-sync.js';
import { createSyncFilter } from '../core/sync-filter.js';
import { writeFileAtomic } from '../core/atomic.js';
import { CloudBackend } from '../backends/dropbox.js';
import { SyncthingBackend } from '../backends/syncthing.js';
import { RsyncBackend } from '../backends/rsync.js';
import { CustomBackend } from '../backends/custom.js';

/**
 * Load the sync configuration, or print an error and return null
 */
export async function loadConfig(): Promise<SyncConfig | null> {
  const configFile = path.join(os.homedir(), CONFIG_DIR, CONFIG_FILE);

  try {
    const content = await fs.readFile(configFile, 'utf-8');
    return JSON.parse(content) as SyncConfig;
  } catch {
    console.log(chalk.red("  claude-sync is not configured on this device."));
    console.log(chalk.dim("  Run 'claude-sync init' to set up."));
    console.log('');
    return null;
  }
}

/**
 * Save the sync configuration
 */
export async function saveConfig(config: SyncConfig): Promise<void> {
  await writeFileAtomic(path.join(os.homedir(), CONFIG_DIR, CONFIG_FILE), JSON.stringify(config, null, 2));
}

/**
 * Create the appropriate backend from config
 */
export function getBackend(backendConfig: BackendConfig): SyncBackend {
  switch (backendConfig.type) {
    case 'git':
      return new GitBackend(backendConfig);
    case 'gitea':
      return new GiteaBackend(backendConfig);
    case 'cloud':
      return new CloudBackend(backendConfig);
    case 'syncthing':
      return new SyncthingBackend(backendConfig);
    case 'rsync':
      return new RsyncBackend(backendConfig);
    case 'custom':
      return new CustomBackend(backendConfig);
    default:
      throw new Error(`Unknown backend type: ${backendConfig.type}`);
  }
}

/** Transfer options every sync entry point passes to its backend. */
export function transferOptions(config: SyncConfig, prefer?: 'local' | 'remote'): TransferOptions {
  return { filter: createSyncFilter(config.selective), heldDir: DEFAULT_HELD_DIR, prefer };
}

export const ENCRYPTION_NOT_IMPLEMENTED =
  'Encryption at rest is not implemented yet: files are synced unencrypted. Use a private remote you control.';

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
