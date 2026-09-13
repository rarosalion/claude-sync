/**
 * Session start hook — pull latest changes when Claude Code starts
 *
 * This runs automatically (if enabled) when a new Claude Code session begins.
 * It pulls the latest .claude/ state from other devices so Claude has
 * the most up-to-date memory and context.
 *
 * Usage:
 *   Add to your shell profile or Claude Code hooks:
 *   claude-sync hook:start
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, getBackend } from '../cli/helpers.js';
import { DeviceRegistry } from '../core/device-registry.js';
import { SnapshotManager } from '../core/snapshot.js';
import { withSyncLock, ALREADY_SYNCING } from '../core/sync-lock.js';

/**
 * Run the session-start sync (pull)
 * Returns a summary string for display
 */
export async function onSessionStart(): Promise<string> {
  const config = await loadConfig();
  if (!config) return '';
  if (!config.autoSync.onSessionStart) return '';

  const result = await withSyncLock(async () => {
    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      const backend = getBackend(config.backend, config.selective);

      // Create a snapshot before pulling (safety net)
      const snapshots = new SnapshotManager();
      try {
        await snapshots.create(claudeDir, config.deviceId, config.deviceName, 'session-start backup');
      } catch {
        // Non-fatal
      }

      // Pull latest changes
      const pullResult = await backend.pull(claudeDir);

      // Update device registry
      const registry = new DeviceRegistry();
      await registry.updateLastSync(config.deviceId);

      if (!pullResult.success) {
        return `[claude-sync] Pull failed: ${pullResult.error}`;
      }

      if (pullResult.filesChanged.length === 0) {
        return '[claude-sync] Up to date';
      }

      return `[claude-sync] Pulled ${pullResult.filesChanged.length} update(s) from other devices`;
    } catch (err) {
      return `[claude-sync] Error: ${(err as Error).message}`;
    }
  });

  if (result === ALREADY_SYNCING) {
    return '[claude-sync] Another sync is in progress';
  }

  return result;
}
