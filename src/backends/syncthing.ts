/**
 * Syncthing backend — P2P sync with maximum privacy
 *
 * Uses Syncthing's REST API to manage a shared folder
 * containing .claude/ contents. No cloud, no third party.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SyncBackend, BackendConfig, SyncResult, SyncStatus, TransferOptions } from '../types.js';
import { applyPulledTree, copyFiltered, createSyncFilter, ignoringNames, purgeNeverSync } from '../core/sync-filter.js';
import { DEFAULT_HELD_DIR } from './git-sync.js';

const DEFAULT_API = 'http://127.0.0.1:8384';

export class SyncthingBackend implements SyncBackend {
  readonly type = 'syncthing' as const;
  private apiUrl: string;
  private folderId: string;
  private syncDir: string;

  constructor(config?: BackendConfig) {
    this.apiUrl = config?.syncthingApi ?? DEFAULT_API;
    this.folderId = config?.syncthingFolder ?? 'claude-sync';
    this.syncDir = path.join(os.homedir(), '.claude-sync', 'syncthing-data');
  }

  async init(config: BackendConfig): Promise<void> {
    this.apiUrl = config.syncthingApi ?? DEFAULT_API;
    this.folderId = config.syncthingFolder ?? 'claude-sync';

    await fs.mkdir(this.syncDir, { recursive: true });

    // Check if Syncthing is running
    const running = await this.isSyncthingRunning();
    if (!running) {
      throw new Error(
        'Syncthing is not running. Please start Syncthing first:\n' +
        '  macOS:     brew services start syncthing\n' +
        '  Linux:     systemctl --user start syncthing\n' +
        '  Windows:   Start Syncthing from the Start Menu'
      );
    }

    // Try to add the folder via REST API
    try {
      await this.addFolder();
    } catch (err) {
      // Folder might already exist
      console.warn(`Note: ${(err as Error).message}`);
    }
  }

  async push(sourcePath: string, options: TransferOptions = {}): Promise<SyncResult> {
    const start = Date.now();

    try {
      // Copy .claude/ contents to the Syncthing-watched directory
      const filter = ignoringNames(options.filter ?? createSyncFilter(), ['.stfolder', '.stignore']);
      const filesChanged = await copyFiltered(sourcePath, this.syncDir, { filter });
      await purgeNeverSync(this.syncDir);

      // Syncthing will detect and sync the changes automatically
      // Optionally trigger a rescan via the API
      await this.triggerRescan();

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
      // Copy from Syncthing-watched directory to .claude/
      const filter = ignoringNames(options.filter ?? createSyncFilter(), ['.stfolder', '.stignore']);
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
      const running = await this.isSyncthingRunning();
      if (!running) {
        return {
          connected: false,
          lastSync: null,
          pendingChanges: 0,
          availableUpdates: 0,
          backend: 'syncthing',
          error: 'Syncthing is not running',
        };
      }

      // Query folder status via API
      const folderStatus = await this.getFolderStatus();

      return {
        connected: true,
        lastSync: folderStatus.lastSync,
        pendingChanges: folderStatus.needFiles,
        availableUpdates: folderStatus.receiveOnlyTotalItems,
        backend: 'syncthing',
      };
    } catch (err) {
      return {
        connected: false,
        lastSync: null,
        pendingChanges: 0,
        availableUpdates: 0,
        backend: 'syncthing',
        error: (err as Error).message,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.isSyncthingRunning();
  }

  // ── Private helpers ────────────────────────────────────────────

  private async isSyncthingRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/rest/system/ping`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async getApiKey(): Promise<string | null> {
    // Try to read API key from Syncthing config
    const configPaths = [
      path.join(os.homedir(), '.config', 'syncthing', 'config.xml'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Syncthing', 'config.xml'),
      path.join(os.homedir(), 'AppData', 'Local', 'Syncthing', 'config.xml'),
    ];

    for (const configPath of configPaths) {
      try {
        const content = await fs.readFile(configPath, 'utf-8');
        const match = /<apikey>([^<]+)<\/apikey>/.exec(content);
        if (match) return match[1];
      } catch {
        continue;
      }
    }

    return null;
  }

  private async addFolder(): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Could not find Syncthing API key. Add the folder manually in the Syncthing UI.'
      );
    }

    const response = await fetch(`${this.apiUrl}/rest/config/folders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        id: this.folderId,
        label: 'Claude Sync',
        path: this.syncDir,
        type: 'sendreceive',
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add Syncthing folder: ${response.statusText}`);
    }
  }

  private async triggerRescan(): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return;

    try {
      await fetch(`${this.apiUrl}/rest/db/scan?folder=${this.folderId}`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
      });
    } catch {
      // Non-fatal
    }
  }

  private async getFolderStatus(): Promise<{
    lastSync: string | null;
    needFiles: number;
    receiveOnlyTotalItems: number;
  }> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return { lastSync: null, needFiles: 0, receiveOnlyTotalItems: 0 };
    }

    try {
      const response = await fetch(
        `${this.apiUrl}/rest/db/status?folder=${this.folderId}`,
        { headers: { 'X-API-Key': apiKey } }
      );

      if (!response.ok) {
        return { lastSync: null, needFiles: 0, receiveOnlyTotalItems: 0 };
      }

      const data = await response.json() as Record<string, unknown>;
      return {
        lastSync: (data.stateChanged as string) ?? null,
        needFiles: (data.needFiles as number) ?? 0,
        receiveOnlyTotalItems: (data.receiveOnlyTotalItems as number) ?? 0,
      };
    } catch {
      return { lastSync: null, needFiles: 0, receiveOnlyTotalItems: 0 };
    }
  }
}
