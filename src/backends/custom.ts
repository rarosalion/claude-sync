/**
 * Custom backend — bring your own sync command
 *
 * For users with unusual setups or who want to integrate
 * with their existing sync infrastructure.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { SyncBackend, BackendConfig, SyncResult, SyncStatus, TransferOptions } from '../types.js';
import { applyPulledTree, createSyncFilter, stageFiltered } from '../core/sync-filter.js';
import { DEFAULT_HELD_DIR } from './git-sync.js';

const STAGE_OUT = path.join(os.homedir(), '.claude-sync', 'custom-out');
const STAGE_IN = path.join(os.homedir(), '.claude-sync', 'custom-in');

const execAsync = promisify(exec);

export class CustomBackend implements SyncBackend {
  readonly type = 'custom' as const;
  private pushCommand: string;
  private pullCommand: string;
  private statusCommand: string;

  constructor(config?: BackendConfig) {
    this.pushCommand = config?.pushCommand ?? '';
    this.pullCommand = config?.pullCommand ?? '';
    this.statusCommand = config?.statusCommand ?? '';
  }

  async init(config: BackendConfig): Promise<void> {
    this.pushCommand = config.pushCommand ?? '';
    this.pullCommand = config.pullCommand ?? '';
    this.statusCommand = config.statusCommand ?? '';

    if (!this.pushCommand || !this.pullCommand) {
      throw new Error(
        'Custom backend requires at least a push and pull command.\n' +
        'Example:\n' +
        '  claude-sync init --backend custom \\\n' +
        '    --push-cmd "rclone sync ~/.claude remote:claude-backup" \\\n' +
        '    --pull-cmd "rclone sync remote:claude-backup ~/.claude"'
      );
    }
  }

  async push(sourcePath: string, options: TransferOptions = {}): Promise<SyncResult> {
    const start = Date.now();

    try {
      // The user's command only ever sees a filtered copy of ~/.claude.
      await stageFiltered(sourcePath, STAGE_OUT, options.filter ?? createSyncFilter());
      const command = this.interpolateCommand(this.pushCommand, STAGE_OUT);
      const { stdout } = await execAsync(command, {
        timeout: 120000,
        env: { ...process.env, CLAUDE_SYNC_SOURCE: STAGE_OUT },
      });

      return {
        success: true,
        filesChanged: stdout.trim() ? stdout.trim().split('\n') : [],
        conflicts: [],
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        filesChanged: [],
        conflicts: [],
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  async pull(targetPath: string, options: TransferOptions = {}): Promise<SyncResult> {
    const start = Date.now();

    try {
      // The command fills a private stage; the result is applied with the
      // same filter and protected-file handling as every other backend.
      await fs.rm(STAGE_IN, { recursive: true, force: true });
      await fs.mkdir(STAGE_IN, { recursive: true });
      const command = this.interpolateCommand(this.pullCommand, STAGE_IN);
      await execAsync(command, {
        timeout: 120000,
        env: { ...process.env, CLAUDE_SYNC_TARGET: STAGE_IN },
      });
      const { applied, held } = await applyPulledTree(
        STAGE_IN,
        targetPath,
        options.heldDir ?? DEFAULT_HELD_DIR,
        options.filter ?? createSyncFilter()
      );

      return {
        success: true,
        filesChanged: applied,
        conflicts: [],
        held,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        filesChanged: [],
        conflicts: [],
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  async status(): Promise<SyncStatus> {
    if (!this.statusCommand) {
      return {
        connected: true,
        lastSync: null,
        pendingChanges: 0,
        availableUpdates: 0,
        backend: 'custom',
      };
    }

    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      const command = this.interpolateCommand(this.statusCommand, claudeDir);
      await execAsync(command, { timeout: 15000 });

      return {
        connected: true,
        lastSync: null,
        pendingChanges: 0,
        availableUpdates: 0,
        backend: 'custom',
      };
    } catch (err) {
      return {
        connected: false,
        lastSync: null,
        pendingChanges: 0,
        availableUpdates: 0,
        backend: 'custom',
        error: (err as Error).message,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    return true; // Custom is always "available"
  }

  // ── Private helpers ────────────────────────────────────────────

  /**
   * Replace placeholders in the command string:
   *   {path}     → the source/target path
   *   {home}     → user's home directory
   *   {hostname} → machine hostname
   */
  private interpolateCommand(command: string, pathValue: string): string {
    // Values are quoted so spaces or shell characters in paths and host
    // names cannot change the user's command.
    const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    return command
      .replace(/\{path\}/g, quote(pathValue))
      .replace(/\{home\}/g, quote(os.homedir()))
      .replace(/\{hostname\}/g, quote(os.hostname()));
  }
}
