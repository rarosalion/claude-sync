/**
 * Prevents concurrent syncs from corrupting the shared git working directory.
 *
 * Confirmed 2026-09-13: a device's own periodic timer (running `claude-sync sync` every 15
 * minutes) raced with a separately-triggered `claude-sync sync`, leaving a staged-but-uncommitted
 * change in ~/.claude-sync/repo that broke the next clone/pull. Only onSessionStart/onSessionEnd
 * (src/hooks/) ever checked this lock file - the plain `sync` command didn't, which is exactly
 * the gap that let two automated triggers collide. All three now share this one implementation.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { CONFIG_DIR, SYNC_LOCK_FILE } from '../types.js';

/** Sentinel returned by withSyncLock() when another sync already holds the lock. */
export const ALREADY_SYNCING = Symbol('claude-sync: another sync is in progress');

/**
 * Runs `fn` while holding the sync lock. If another sync already holds it, `fn` is not called
 * and ALREADY_SYNCING is returned instead. The lock is always released afterward, even if `fn`
 * throws.
 *
 * Acquires the lock with an exclusive create (flag "wx"), not a check-then-write - a separate
 * fs.access()-then-fs.writeFile() has a TOCTOU race where two concurrent callers can both see
 * "no lock file yet" before either writes one, defeating the whole point of the lock. Caught by
 * this module's own test (tests/sync-lock.test.ts) before this fix shipped: two overlapping
 * withSyncLock() calls both ran their `fn` simultaneously. "wx" makes the filesystem itself the
 * single point of truth - exactly one of two racing creates succeeds, atomically.
 *
 * lockFileOverride is test-only (mirrors GitBackend's repoDirOverride) - real callers never pass
 * it, so they always use the actual ~/.claude-sync/ lock file.
 */
export async function withSyncLock<T>(
  fn: () => Promise<T>,
  lockFileOverride?: string
): Promise<T | typeof ALREADY_SYNCING> {
  const lockFile = lockFileOverride ?? path.join(os.homedir(), CONFIG_DIR, SYNC_LOCK_FILE);

  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  try {
    await fs.writeFile(lockFile, `${process.pid}`, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return ALREADY_SYNCING;
    }
    throw err;
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockFile).catch(() => {});
  }
}
