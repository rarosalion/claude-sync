/**
 * Snapshot manager — creates and restores backups of .claude/ state
 *
 * Every sync creates a lightweight snapshot so you can roll back
 * to any previous point in time.
 *
 * Confirmed 2026-10-04 on claude01: ~/.claude-sync/snapshots had grown to 10GB (164 directories
 * at ~78MB each). Causes, all fixed here:
 *  - `claude-sync sync` snapshotted before every pull but never pruned, and only the hooks did.
 *    create() now prunes itself, so no caller can forget.
 *  - Directories not listed in the manifest (a crash between mkdir and the manifest write, or
 *    two processes racing on the manifest's read-modify-write) were never deleted. Snapshots are
 *    now built in a temp directory, renamed into place, and recorded under a lock; prune() also
 *    sweeps orphans.
 *  - Every snapshot was a full copy of ~/.claude, including plugins, caches and session
 *    transcripts that sync never touches. See SNAPSHOT_EXCLUDED_TOP_LEVEL.
 *  - An unchanged ~/.claude was snapshotted again on every sync. create() now reuses the newest
 *    snapshot when the fingerprint matches.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { CONFIG_DIR, SNAPSHOTS_DIR } from '../types.js';
import type { Snapshot } from '../types.js';

/**
 * Top-level entries of ~/.claude that are never snapshotted: caches, logs, plugin installs and
 * per-session scratch that claude-sync does not sync and that Claude Code regenerates.
 */
export const SNAPSHOT_EXCLUDED_TOP_LEVEL: ReadonlySet<string> = new Set([
  'plugins',
  'cache',
  'telemetry',
  'shell-snapshots',
  'session-env',
  'sessions',
  'bridge-spawn',
  'backups',
  'file-history',
  'debug',
  'statsig',
  'todos',
]);

export interface RetentionPolicy {
  /** Keep at most this many snapshots. */
  keepCount: number;
  /** Also delete snapshots older than this many days (the newest MIN_KEEP always survive). */
  maxAgeDays?: number;
}

/** Applied automatically after every create(). */
export const DEFAULT_RETENTION: RetentionPolicy = { keepCount: 30, maxAgeDays: 7 };

/** Age-based pruning never removes the newest few snapshots, however old. */
const MIN_KEEP = 3;

/** A snapshot directory younger than this is assumed to be mid-creation, not an orphan. */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** A manifest lock older than this is assumed to belong to a dead process. */
const STALE_MANIFEST_LOCK_MS = 30 * 1000;

const TMP_PREFIX = '.tmp-';
const MANIFEST_LOCK = '.manifest.lock';

/**
 * True if `rel` (a path relative to the source root, '/'-separated) is skipped by snapshots.
 * Under projects/<project>/ only memory/ is kept: it is the part claude-sync syncs, whereas
 * everything else there (transcripts, tool results, live per-session files like ccr-tip.json)
 * is large and changes constantly, which also stopped unchanged-snapshot detection working.
 */
export function isSnapshotExcluded(rel: string): boolean {
  const parts = rel.split('/');
  if (SNAPSHOT_EXCLUDED_TOP_LEVEL.has(parts[0])) return true;
  return parts[0] === 'projects' && parts.length >= 3 && parts[2] !== 'memory';
}

interface Scan {
  fileCount: number;
  sizeBytes: number;
  fingerprint: string;
}

export class SnapshotManager {
  private snapshotsDir: string;
  private manifestFile: string;
  private retention: RetentionPolicy;

  constructor(configDir?: string, retention: RetentionPolicy = DEFAULT_RETENTION) {
    const base = configDir ?? path.join(os.homedir(), CONFIG_DIR);
    this.snapshotsDir = path.join(base, SNAPSHOTS_DIR);
    this.manifestFile = path.join(this.snapshotsDir, 'manifest.json');
    this.retention = retention;
  }

  /**
   * Create a snapshot of the given directory, then apply the retention policy. If nothing has
   * changed since the newest snapshot, that snapshot is returned and nothing is copied.
   */
  async create(sourceDir: string, deviceId: string, deviceName: string, description?: string): Promise<Snapshot> {
    const scan = await this.scanDirectory(sourceDir);

    const newest = (await this.list())[0];
    if (newest && newest.fingerprint === scan.fingerprint && (await this.exists(path.join(this.snapshotsDir, newest.id)))) {
      return newest;
    }

    const id = crypto.randomBytes(6).toString('hex');
    const timestamp = new Date().toISOString();
    const finalDir = path.join(this.snapshotsDir, id);
    const tmpDir = path.join(this.snapshotsDir, TMP_PREFIX + id);

    await fs.mkdir(tmpDir, { recursive: true });
    try {
      await this.copyDirectory(sourceDir, tmpDir);
      await fs.rename(tmpDir, finalDir);
    } catch (err) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      throw err;
    }

    const snapshot: Snapshot = {
      id,
      timestamp,
      deviceId,
      deviceName,
      fileCount: scan.fileCount,
      sizeBytes: scan.sizeBytes,
      description,
      fingerprint: scan.fingerprint,
    };

    await this.updateManifest((manifest) => [...manifest, snapshot]);

    try {
      await this.prune(this.retention.keepCount, this.retention.maxAgeDays);
    } catch {
      // Non-fatal: the snapshot itself was created.
    }

    return snapshot;
  }

  /**
   * Restore a snapshot to the target directory. Entries snapshots never contain (see
   * SNAPSHOT_EXCLUDED_TOP_LEVEL) are left in place rather than wiped.
   */
  async restore(snapshotId: string, targetDir: string): Promise<boolean> {
    const snapshotDir = path.join(this.snapshotsDir, snapshotId);

    if (!(await this.exists(snapshotDir))) return false;

    // Create a safety backup of the current state before restoring. This copies everything,
    // since it is a one-off and cheap compared to losing something the snapshot didn't cover.
    await this.copyDirectory(targetDir, targetDir + '.pre-restore', false);

    await this.clearDirectory(targetDir, '');
    await this.copyDirectory(snapshotDir, targetDir, false);

    return true;
  }

  /**
   * List all snapshots, newest first
   */
  async list(): Promise<Snapshot[]> {
    const manifest = await this.getManifest();
    return manifest.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * Find snapshots by date prefix (e.g., "2025-03-15")
   */
  async findByDate(datePrefix: string): Promise<Snapshot[]> {
    const all = await this.list();
    return all.filter((s) => s.timestamp.startsWith(datePrefix));
  }

  /**
   * Delete old snapshots, keeping the N most recent (and, when maxAgeDays is given, dropping
   * any older than that apart from the newest MIN_KEEP). Also removes snapshot directories the
   * manifest doesn't know about and manifest entries whose directory is gone.
   *
   * @returns the number of snapshots deleted (orphan directories are not counted)
   */
  async prune(keepCount: number, maxAgeDays?: number): Promise<number> {
    let deleted = 0;
    const cutoff = maxAgeDays === undefined ? undefined : Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const doomed = new Set<string>();

    await this.updateManifest((manifest) => {
      const sorted = [...manifest].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const keep: Snapshot[] = [];
      sorted.forEach((snap, index) => {
        const tooMany = index >= keepCount;
        const tooOld = cutoff !== undefined && index >= MIN_KEEP && Date.parse(snap.timestamp) < cutoff;
        if (tooMany || tooOld) doomed.add(snap.id);
        else keep.push(snap);
      });
      return keep;
    });

    for (const id of doomed) {
      try {
        await fs.rm(path.join(this.snapshotsDir, id), { recursive: true, force: true });
        deleted++;
      } catch {
        // Skip if already deleted
      }
    }

    await this.reconcile();

    return deleted;
  }

  // ── Private helpers ────────────────────────────────────────────

  /** Remove orphan directories and manifest entries pointing at missing directories. */
  private async reconcile(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.snapshotsDir);
    } catch {
      return;
    }

    const known = new Set((await this.getManifest()).map((s) => s.id));

    for (const name of entries) {
      if (name === 'manifest.json' || name === MANIFEST_LOCK || known.has(name)) continue;
      const full = path.join(this.snapshotsDir, name);
      try {
        const stat = await fs.stat(full);
        if (Date.now() - stat.mtimeMs < ORPHAN_GRACE_MS) continue;
        await fs.rm(full, { recursive: true, force: true });
      } catch {
        // Raced with another cleanup.
      }
    }

    const present = new Set(entries);
    await this.updateManifest((manifest) => manifest.filter((s) => present.has(s.id)));
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async getManifest(): Promise<Snapshot[]> {
    try {
      const content = await fs.readFile(this.manifestFile, 'utf-8');
      return JSON.parse(content) as Snapshot[];
    } catch {
      return [];
    }
  }

  /** Read-modify-write the manifest under a cross-process lock, replacing it atomically. */
  private async updateManifest(mutate: (manifest: Snapshot[]) => Snapshot[]): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    await this.withManifestLock(async () => {
      const next = mutate(await this.getManifest());
      const tmp = `${this.manifestFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
      await fs.rename(tmp, this.manifestFile);
    });
  }

  /** mkdir is atomic, so a directory serves as the lock. A stale one is reclaimed. */
  private async withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(this.snapshotsDir, MANIFEST_LOCK);
    const deadline = Date.now() + STALE_MANIFEST_LOCK_MS * 2;

    for (;;) {
      try {
        await fs.mkdir(lockDir);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          const stat = await fs.stat(lockDir);
          if (Date.now() - stat.mtimeMs > STALE_MANIFEST_LOCK_MS) {
            await fs.rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error('timed out waiting for the snapshot manifest lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    try {
      return await fn();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  /**
   * Walk the snapshot-eligible files, counting them and hashing path and content. Content, not
   * mtime: a sync rewrites files like CLAUDE.md with identical bytes, which must not count as a change.
   */
  private async scanDirectory(source: string): Promise<Scan> {
    const hash = crypto.createHash('sha256');
    let fileCount = 0;
    let sizeBytes = 0;

    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (isSnapshotExcluded(entryRel)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, entryRel);
        } else if (entry.isFile()) {
          try {
            const content = await fs.readFile(full);
            fileCount++;
            sizeBytes += content.length;
            hash.update(`${entryRel}\0${content.length}\0`);
            hash.update(crypto.createHash('sha256').update(content).digest());
          } catch {
            // File vanished mid-scan.
          }
        }
      }
    };

    await walk(source, '');
    return { fileCount, sizeBytes, fingerprint: hash.digest('hex') };
  }

  /** Delete everything in `dir` that snapshots would have covered. */
  private async clearDirectory(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isSnapshotExcluded(entryRel)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.clearDirectory(full, entryRel);
        // Only remove the directory if clearing left it empty (excluded files may remain).
        if ((await fs.readdir(full)).length === 0) await fs.rmdir(full);
      } else {
        await fs.rm(full, { force: true });
      }
    }
  }

  private async copyDirectory(source: string, target: string, applyExcludes = true, rel = ''): Promise<void> {
    await fs.mkdir(target, { recursive: true });

    let entries;
    try {
      entries = await fs.readdir(source, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (applyExcludes && isSnapshotExcluded(entryRel)) continue;
      const srcPath = path.join(source, entry.name);
      const destPath = path.join(target, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath, applyExcludes, entryRel);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
}
