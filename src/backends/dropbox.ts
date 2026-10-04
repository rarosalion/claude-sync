/**
 * Cloud storage backend — Dropbox, iCloud, OneDrive
 *
 * Uses symlinks to redirect .claude/ into a cloud-synced folder.
 * The cloud provider handles the actual sync.
 *
 * This is the easiest setup — just symlink and forget.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SyncBackend, BackendConfig, SyncResult, SyncStatus, CloudProvider, TransferOptions } from '../types.js';
import { applyPulledTree, copyFiltered, createSyncFilter, ignoringNames, purgeNeverSync } from '../core/sync-filter.js';
import { DEFAULT_HELD_DIR } from './git-sync.js';

const CLOUD_SUBDIR = 'claude-sync';

export class CloudBackend implements SyncBackend {
  readonly type = 'cloud' as const;
  private provider: CloudProvider;
  private cloudPath: string;
  private syncDir: string;

  constructor(config?: BackendConfig) {
    this.provider = config?.cloudProvider ?? 'dropbox';
    this.cloudPath = config?.cloudPath ?? '';
    this.syncDir = this.cloudPath ? path.join(this.cloudPath, CLOUD_SUBDIR) : '';
  }

  async init(config: BackendConfig): Promise<void> {
    this.provider = config.cloudProvider ?? 'dropbox';
    this.cloudPath = config.cloudPath ?? this.detectCloudPath();
    this.syncDir = path.join(this.cloudPath, CLOUD_SUBDIR);

    if (!this.cloudPath) {
      throw new Error(
        `Could not detect ${this.provider} folder. Please specify the path with --cloud-path.`
      );
    }

    // Create the sync subdirectory in the cloud folder
    await fs.mkdir(this.syncDir, { recursive: true });

    // Create a marker file so other devices know this is a claude-sync folder
    const markerFile = path.join(this.syncDir, '.claude-sync-marker');
    const marker = {
      provider: this.provider,
      createdAt: new Date().toISOString(),
      hostname: os.hostname(),
    };
    await fs.writeFile(markerFile, JSON.stringify(marker, null, 2), 'utf-8');
  }

  async push(sourcePath: string, options: TransferOptions = {}): Promise<SyncResult> {
    const start = Date.now();

    try {
      if (!this.syncDir) {
        throw new Error('Cloud backend not initialized. Run claude-sync init first.');
      }

      const filter = ignoringNames(options.filter ?? createSyncFilter(), ['.claude-sync']);
      const filesChanged = await copyFiltered(sourcePath, this.syncDir, { filter });
      await purgeNeverSync(this.syncDir);

      return {
        success: true,
        filesChanged,
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
      if (!this.syncDir) {
        throw new Error('Cloud backend not initialized. Run claude-sync init first.');
      }

      const filter = ignoringNames(options.filter ?? createSyncFilter(), ['.claude-sync']);
      const { applied, held } = await applyPulledTree(this.syncDir, targetPath, options.heldDir ?? DEFAULT_HELD_DIR, filter);

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
    try {
      if (!this.syncDir) {
        return {
          connected: false,
          lastSync: null,
          pendingChanges: 0,
          availableUpdates: 0,
          backend: 'cloud',
          error: 'Cloud backend not initialized',
        };
      }

      // Check if the cloud folder exists
      await fs.access(this.syncDir);

      // Check marker file for last sync time
      const markerPath = path.join(this.syncDir, '.claude-sync-marker');
      let lastSync: string | null = null;

      try {
        const stat = await fs.stat(markerPath);
        lastSync = stat.mtime.toISOString();
      } catch {
        // No marker
      }

      return {
        connected: true,
        lastSync,
        pendingChanges: 0,
        availableUpdates: 0,
        backend: 'cloud',
      };
    } catch (err) {
      return {
        connected: false,
        lastSync: null,
        pendingChanges: 0,
        availableUpdates: 0,
        backend: 'cloud',
        error: (err as Error).message,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    const cloudPath = this.cloudPath || this.detectCloudPath();
    if (!cloudPath) return false;

    try {
      await fs.access(cloudPath);
      return true;
    } catch {
      return false;
    }
  }

  // ── Private helpers ────────────────────────────────────────────

  private detectCloudPath(): string {
    const homeDir = os.homedir();

    const paths: Record<CloudProvider, string[]> = {
      dropbox: [path.join(homeDir, 'Dropbox')],
      icloud: [
        path.join(homeDir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
        path.join(homeDir, 'iCloudDrive'),
      ],
      onedrive: [path.join(homeDir, 'OneDrive')],
    };

    const candidates = paths[this.provider] ?? [];
    // We can't use async here, so do a best-effort sync check
    for (const p of candidates) {
      try {
        if (fsSync.existsSync(p)) {
          return p;
        }
      } catch {
        continue;
      }
    }

    return '';
  }
}
