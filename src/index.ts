/**
 * claude-sync — One Claude brain across all your devices
 *
 * Syncs your Claude Code .claude/ directory across multiple machines
 * so your memory, skills, settings, and context follow you everywhere.
 */

export type {
  BackendType,
  CloudProvider,
  BackendConfig,
  SyncBackend,
  SyncResult,
  SyncStatus,
  ConflictStrategy,
  ConflictInfo,
  MergeRule,
  DeviceInfo,
  SyncConfig,
  EncryptionConfig,
  AutoSyncConfig,
  SelectiveSyncConfig,
  HookConfig,
  Snapshot,
  EnvironmentInfo,
  CloudStoragePath,
} from './types.js';

export { DEFAULT_MERGE_RULES, CONFIG_DIR, CONFIG_FILE } from './types.js';

export { detectEnvironment } from './core/detector.js';
export { DeviceRegistry } from './core/device-registry.js';
export { Merger } from './core/merger.js';
export { Encryption } from './core/encryption.js';
export { SnapshotManager } from './core/snapshot.js';
export { FileWatcher } from './core/watcher.js';

export { GitBackend } from './backends/git.js';
export { GiteaBackend } from './backends/gitea.js';
export { CloudBackend } from './backends/dropbox.js';
export { SyncthingBackend } from './backends/syncthing.js';
export { RsyncBackend } from './backends/rsync.js';
export { CustomBackend } from './backends/custom.js';

// Keep in sync with package.json's "version" - this is a separate literal, not derived from it
// (found drifted from package.json's 0.1.0 while fixing selective sync/hooks, 2026-09-12).
export const VERSION = '0.3.1';
