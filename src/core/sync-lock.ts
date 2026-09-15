/**
 * Prevents concurrent syncs from corrupting the shared git working directory.
 *
 * Confirmed 2026-09-13: a device's own periodic timer (running `claude-sync sync` every 15
 * minutes) raced with a separately-triggered `claude-sync sync`, leaving a staged-but-uncommitted
 * change in ~/.claude-sync/repo that broke the next clone/pull. Only onSessionStart/onSessionEnd
 * (src/hooks/) ever checked this lock file - the plain `sync` command didn't, which is exactly
 * the gap that let two automated triggers collide. All three now share this one implementation.
 *
 * Confirmed 2026-09-15 on claude01: a lock left behind by a process killed mid-sync (host
 * restart, SIGKILL) is otherwise never cleaned up - existence alone used to mean "locked", so a
 * dead process's lock blocked every sync indefinitely, silently. Reclaiming a lock whose PID is
 * no longer alive, or that's older than STALE_LOCK_MS, fixes that without reintroducing the
 * TOCTOU race the exclusive-create fix below was for.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { CONFIG_DIR, SYNC_LOCK_FILE } from '../types.js';

/** Sentinel returned by withSyncLock() when another sync already holds the lock. */
export const ALREADY_SYNCING = Symbol('claude-sync: another sync is in progress');

/** A lock older than this is reclaimed even if its owning PID is still alive. */
const STALE_LOCK_MS = 10 * 60 * 1000;

interface LockContents {
  pid: number;
  timestamp: number;
}

/** True if `pid` names a live process. kill(pid, 0) sends no signal, just checks existence. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Reads and parses a lock file's contents. Returns null if the file is missing, unreadable, or
 * not in the expected {pid, timestamp} shape - any of which should be treated as reclaimable
 * rather than as a reason to throw, since a corrupt lock is no more meaningful than no lock.
 */
async function readLock(lockFile: string): Promise<LockContents | null> {
  try {
    const raw = await fs.readFile(lockFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as LockContents).pid === 'number' &&
      typeof (parsed as LockContents).timestamp === 'number'
    ) {
      return parsed as LockContents;
    }
    return null;
  } catch {
    return null;
  }
}

function isStale(lock: LockContents | null): boolean {
  if (lock === null) {
    return true;
  }
  return !isPidAlive(lock.pid) || Date.now() - lock.timestamp > STALE_LOCK_MS;
}

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
 * When the create loses to an existing lock, that lock is only honored if it's live and fresh
 * (see isStale). A stale lock is unlinked and creation is retried - if two callers both judge it
 * stale at once, they both unlink and race the retry, but only one of *those* creates can win,
 * so exactly one caller still proceeds. The loop bounds this to a handful of iterations rather
 * than assuming the retry succeeds, since a third caller could win in between.
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

  const contents: LockContents = { pid: process.pid, timestamp: Date.now() };
  const MAX_ATTEMPTS = 5;
  let acquired = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !acquired; attempt++) {
    try {
      await fs.writeFile(lockFile, JSON.stringify(contents), { encoding: 'utf-8', flag: 'wx' });
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      const existing = await readLock(lockFile);
      if (!isStale(existing)) {
        return ALREADY_SYNCING;
      }
      console.warn(
        `[claude-sync] Reclaiming stale sync lock` +
          (existing ? ` (pid ${existing.pid}, held since ${new Date(existing.timestamp).toISOString()})` : ' (unreadable lock file)')
      );
      await fs.unlink(lockFile).catch(() => {});
    }
  }
  if (!acquired) {
    return ALREADY_SYNCING;
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockFile).catch(() => {});
  }
}
