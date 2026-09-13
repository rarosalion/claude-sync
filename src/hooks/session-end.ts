/**
 * Session end hook — push local changes when Claude Code session ends
 *
 * This runs automatically (if enabled) when a Claude Code session ends.
 * It pushes local .claude/ changes so other devices can pick them up.
 *
 * Usage:
 *   Add to your shell profile or Claude Code hooks:
 *   claude-sync hook:end
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, getBackend } from '../cli/helpers.js';
import { DeviceRegistry } from '../core/device-registry.js';
import { SnapshotManager } from '../core/snapshot.js';
import { withSyncLock, ALREADY_SYNCING } from '../core/sync-lock.js';

/**
 * Run the session-end sync (push)
 * Returns a summary string for display
 */
export async function onSessionEnd(): Promise<string> {
  const config = await loadConfig();
  if (!config) return '';
  if (!config.autoSync.onSessionEnd) return '';

  const result = await withSyncLock(async () => {
    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      const backend = getBackend(config.backend, config.selective);

      // Create a snapshot before pushing (for history)
      const snapshots = new SnapshotManager();
      try {
        await snapshots.create(claudeDir, config.deviceId, config.deviceName, 'session-end snapshot');
      } catch {
        // Non-fatal
      }

      // Push local changes
      const pushResult = await backend.push(claudeDir);

      // Update device registry
      const registry = new DeviceRegistry();
      await registry.updateLastSync(config.deviceId);

      // Auto-prune old snapshots (keep last 50)
      try {
        await snapshots.prune(50);
      } catch {
        // Non-fatal
      }

      if (!pushResult.success) {
        return `[claude-sync] Push failed: ${pushResult.error}`;
      }

      if (pushResult.filesChanged.length === 0) {
        return '[claude-sync] No changes to push';
      }

      return `[claude-sync] Pushed ${pushResult.filesChanged.length} change(s)`;
    } catch (err) {
      return `[claude-sync] Error: ${(err as Error).message}`;
    }
  });

  if (result === ALREADY_SYNCING) {
    return '[claude-sync] Another sync is in progress';
  }

  return result;
}
