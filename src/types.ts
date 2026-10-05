/**
 * claude-sync type definitions
 */

// ── Sync Backend Types ──────────────────────────────────────────────

export type BackendType = 'git' | 'gitea' | 'cloud' | 'syncthing' | 'rsync' | 'custom';

export type CloudProvider = 'dropbox' | 'icloud' | 'onedrive';

export interface BackendConfig {
  type: BackendType;
  /** Git-specific: remote URL */
  remoteUrl?: string;
  /** Git-specific: branch to use */
  branch?: string;
  /** Cloud-specific: provider name */
  cloudProvider?: CloudProvider;
  /** Cloud-specific: path to cloud storage root */
  cloudPath?: string;
  /** Syncthing-specific: folder ID */
  syncthingFolder?: string;
  /** Syncthing-specific: API endpoint */
  syncthingApi?: string;
  /** rsync-specific: remote host:path */
  rsyncTarget?: string;
  /** rsync-specific: SSH key path */
  sshKeyPath?: string;
  /** Custom-specific: push command */
  pushCommand?: string;
  /** Custom-specific: pull command */
  pullCommand?: string;
  /** Custom-specific: status command */
  statusCommand?: string;
  /** Gitea-specific: base URL (e.g. https://gitea.example.org) */
  giteaUrl?: string;
  /** Gitea-specific: personal access token */
  giteaToken?: string;
  /** Gitea-specific: username */
  giteaUser?: string;
  /** Gitea-specific: repository name (default: claude-memory) */
  giteaRepo?: string;
}

// ── Sync Backend Interface ──────────────────────────────────────────

/** Options every backend honours when moving files in either direction. */
export interface TransferOptions {
  /** Which relative paths may be synced (NEVER_SYNC plus selective sync). */
  filter?: (relPath: string) => boolean;
  /** Where pull-protected files (settings.json, plugins/) are held for review. */
  heldDir?: string;
  /** Resolve merge conflicts in favour of this side (git-based backends). */
  prefer?: 'local' | 'remote';
}

export interface SyncBackend {
  readonly type: BackendType;
  /** Initialize the backend (first-time setup) */
  init(config: BackendConfig): Promise<void>;
  /** Push local changes to the sync target */
  push(sourcePath: string, options?: TransferOptions): Promise<SyncResult>;
  /** Pull remote changes to local */
  pull(targetPath: string, options?: TransferOptions): Promise<SyncResult>;
  /** Get current sync status */
  status(): Promise<SyncStatus>;
  /** Check if backend is available/configured */
  isAvailable(): Promise<boolean>;
}

// ── Sync Results ────────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  filesChanged: string[];
  conflicts: ConflictInfo[];
  /** Pull-protected files that changed remotely and wait for review. */
  held?: string[];
  timestamp: string;
  duration: number;
  error?: string;
}

export interface SyncStatus {
  connected: boolean;
  lastSync: string | null;
  pendingChanges: number;
  availableUpdates: number;
  backend: BackendType;
  error?: string;
}

// ── Conflict Resolution ─────────────────────────────────────────────

export type ConflictStrategy =
  | 'merge-append'    // Memory files: append new entries, dedup
  | 'latest-wins'     // Settings/skills: most recent timestamp
  | 'merge-chrono'    // Activity logs: chronological merge
  | 'ask-user'        // CLAUDE.md: show diff, ask
  | 'skip';           // Don't resolve, leave both versions

export interface ConflictInfo {
  filePath: string;
  strategy: ConflictStrategy;
  localModified: string;
  remoteModified: string;
  resolved: boolean;
  resolution?: string;
}

export interface MergeRule {
  /** Glob pattern matching file paths */
  pattern: string;
  /** Strategy to use for conflicts */
  strategy: ConflictStrategy;
}

// ── Device Registry ─────────────────────────────────────────────────

export interface DeviceInfo {
  id: string;
  name: string;
  os: 'darwin' | 'linux' | 'win32';
  hostname: string;
  lastSync: string | null;
  lastSeen: string;
  claudePath: string;
  version: string;
}

// ── Configuration ───────────────────────────────────────────────────

export interface SyncConfig {
  version: number;
  deviceId: string;
  deviceName: string;
  backend: BackendConfig;
  encryption: EncryptionConfig;
  autoSync: AutoSyncConfig;
  selective: SelectiveSyncConfig;
  hooks: HookConfig;
}

export interface EncryptionConfig {
  enabled: boolean;
  /** Path to the age identity (private key) file */
  identityFile?: string;
  /** Public key for encryption */
  recipientKey?: string;
}

export interface AutoSyncConfig {
  /** Pull on Claude Code session start */
  onSessionStart: boolean;
  /** Push on Claude Code session end */
  onSessionEnd: boolean;
  /** Watch for file changes and sync in real-time */
  watchEnabled: boolean;
  /** Debounce interval in milliseconds for file watcher */
  watchDebounceMs: number;
}

export interface SelectiveSyncConfig {
  /** Sync mode: 'all' or 'selective' */
  mode: 'all' | 'selective';
  /** Directories/patterns to include (when mode is 'selective') */
  include: string[];
  /** Directories/patterns to exclude */
  exclude: string[];
}

export interface HookConfig {
  /** Run a command before push */
  prePush?: string;
  /** Run a command after push */
  postPush?: string;
  /** Run a command before pull */
  prePull?: string;
  /** Run a command after pull */
  postPull?: string;
}

// ── Snapshots & History ─────────────────────────────────────────────

export interface Snapshot {
  id: string;
  timestamp: string;
  deviceId: string;
  deviceName: string;
  fileCount: number;
  sizeBytes: number;
  description?: string;
  /** Hash of the snapshotted files' paths, sizes and mtimes, used to skip no-change snapshots. */
  fingerprint?: string;
}

// ── OS Detection ────────────────────────────────────────────────────

export interface EnvironmentInfo {
  os: 'darwin' | 'linux' | 'win32';
  arch: string;
  homeDir: string;
  claudeDir: string;
  hasGit: boolean;
  hasRsync: boolean;
  hasSyncthing: boolean;
  hasAge: boolean;
  cloudStoragePaths: CloudStoragePath[];
  shell: string;
  nodeVersion: string;
}

export interface CloudStoragePath {
  provider: CloudProvider;
  path: string;
  exists: boolean;
}

// ── Default Configuration ───────────────────────────────────────────

export const DEFAULT_MERGE_RULES: MergeRule[] = [
  // MEMORY.md is a flat index of one-line pointers, not the actual content - latest-wins lets an
  // edit that removes a stale/duplicate line actually stick, and the failure mode if it ever
  // clobbers a concurrent addition is low-severity (a missing index line, not lost content - the
  // real memory below it is untouched and can be re-indexed). This rule must come before
  // **/memory/** below since MEMORY.md's own path also matches that broader pattern.
  { pattern: '**/MEMORY.md', strategy: 'latest-wins' },
  // Individual memory files hold the actual content and get corrected/rewritten in place, not just
  // appended to. Keep merge-append here specifically so an unpushed local edit (e.g. mid-session)
  // can never be silently discarded by a concurrent push from another device - see commit ad143e6
  // and tests/git-backend.test.ts, which fixed exactly that data-loss bug once already.
  // merge-append can't represent a deletion on its own. The git backend handles that by passing
  // each file's last-synced version as a base: if only one device changed the file, that version
  // wins as-is, so rewrites and deletions propagate, and merge-append only runs when both devices
  // changed it. Backends that can't supply a base still re-append deleted lines, and two devices
  // can then keep swapping line orders instead of converging.
  { pattern: '**/memory/**', strategy: 'merge-append' },
  { pattern: '**/activity-log*', strategy: 'merge-chrono' },
  { pattern: '**/settings*', strategy: 'latest-wins' },
  { pattern: '**/skills/**', strategy: 'latest-wins' },
  { pattern: '**/CLAUDE.md', strategy: 'ask-user' },
  { pattern: '**/.clauderc', strategy: 'latest-wins' },
  { pattern: '**/projects/**', strategy: 'merge-append' },
];

export const CONFIG_DIR = '.claude-sync';
export const CONFIG_FILE = 'config.json';
export const DEVICES_FILE = 'devices.json';
export const SNAPSHOTS_DIR = 'snapshots';
export const SYNC_LOCK_FILE = '.claude-sync.lock';
