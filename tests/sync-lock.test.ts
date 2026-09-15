/**
 * Tests for the sync lock - shared by `claude-sync sync` and the hook:start/hook:end commands.
 *
 * Before this fix, only onSessionStart/onSessionEnd checked a lock file; the plain `sync` command
 * (and therefore anything that calls it directly, like a periodic timer) did not. Two syncs
 * racing against the same git working directory left a staged-but-uncommitted change that broke
 * the next clone/pull - confirmed 2026-09-13 on a claude-agent host running both a systemd timer
 * and an Ansible-triggered sync.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { withSyncLock, ALREADY_SYNCING } from '../src/core/sync-lock.js';

/** A pid guaranteed not to belong to any running process: spawn a process and wait for its exit. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  if (result.pid === undefined) {
    throw new Error('failed to spawn helper process for deadPid()');
  }
  return result.pid;
}

describe('withSyncLock', () => {
  let lockFile: string;

  afterEach(async () => {
    await fs.rm(lockFile, { force: true });
  });

  async function newLockFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sync-lock-test-'));
    return path.join(dir, '.claude-sync.lock');
  }

  it('runs fn and returns its result when the lock is free', async () => {
    lockFile = await newLockFile();

    const result = await withSyncLock(async () => 'done', lockFile);

    expect(result).toBe('done');
  });

  it('releases the lock after fn completes, so a later call can acquire it', async () => {
    lockFile = await newLockFile();

    await withSyncLock(async () => 'first', lockFile);
    const second = await withSyncLock(async () => 'second', lockFile);

    expect(second).toBe('second');
  });

  it('releases the lock even if fn throws', async () => {
    lockFile = await newLockFile();

    await expect(
      withSyncLock(async () => {
        throw new Error('boom');
      }, lockFile)
    ).rejects.toThrow('boom');

    // The lock must not still be held after the throw.
    const after = await withSyncLock(async () => 'recovered', lockFile);
    expect(after).toBe('recovered');
  });

  it('returns ALREADY_SYNCING and does not call fn when the lock is already held', async () => {
    lockFile = await newLockFile();
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    // Our own pid, right now: alive and fresh, so this must be honored as a real, in-progress lock.
    await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), 'utf-8');

    let called = false;
    const result = await withSyncLock(async () => {
      called = true;
      return 'should not run';
    }, lockFile);

    expect(result).toBe(ALREADY_SYNCING);
    expect(called).toBe(false);
  });

  it('reclaims a lock left by a dead pid and runs fn', async () => {
    lockFile = await newLockFile();
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify({ pid: deadPid(), timestamp: Date.now() }), 'utf-8');

    const result = await withSyncLock(async () => 'reclaimed', lockFile);

    expect(result).toBe('reclaimed');
  });

  it('reclaims a lock older than the staleness threshold even if the pid is alive', async () => {
    lockFile = await newLockFile();
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    // Our own pid is alive, but the timestamp is far older than the 10-minute threshold.
    const staleTimestamp = Date.now() - 60 * 60 * 1000;
    await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, timestamp: staleTimestamp }), 'utf-8');

    const result = await withSyncLock(async () => 'reclaimed', lockFile);

    expect(result).toBe('reclaimed');
  });

  it('reclaims an unparseable lock file', async () => {
    lockFile = await newLockFile();
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, 'not json', 'utf-8');

    const result = await withSyncLock(async () => 'reclaimed', lockFile);

    expect(result).toBe('reclaimed');
  });

  it('does not reclaim a fresh lock held by a live pid, and leaves it in place', async () => {
    lockFile = await newLockFile();
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    const contents = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
    await fs.writeFile(lockFile, contents, 'utf-8');

    const result = await withSyncLock(async () => 'should not run', lockFile);

    expect(result).toBe(ALREADY_SYNCING);
    expect(await fs.readFile(lockFile, 'utf-8')).toBe(contents);
  });

  it('two overlapping syncs: only one actually runs, the other is told to back off', async () => {
    lockFile = await newLockFile();
    let concurrentRuns = 0;
    let maxConcurrentRuns = 0;

    const run = () =>
      withSyncLock(async () => {
        concurrentRuns++;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
        // Simulate the real git work (fetch/add/commit/push) taking a moment - this is exactly
        // the window a periodic timer and a manually-triggered sync could otherwise both enter.
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrentRuns--;
        return 'ran';
      }, lockFile);

    const [a, b] = await Promise.all([run(), run()]);
    const results = [a, b];

    expect(maxConcurrentRuns).toBe(1);
    expect(results.filter((r) => r === 'ran')).toHaveLength(1);
    expect(results.filter((r) => r === ALREADY_SYNCING)).toHaveLength(1);
  });
});
