/**
 * Tests for SnapshotManager retention, orphan cleanup, scope and no-change skipping.
 *
 * Regression coverage for the 2026-10-04 claude01 incident, where ~/.claude-sync/snapshots grew
 * to 10GB: `sync` never pruned, orphan directories were never deleted, and every snapshot was a
 * full copy of ~/.claude.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SnapshotManager, isSnapshotExcluded } from '../src/core/snapshot.js';

describe('SnapshotManager', () => {
  let root: string;
  let source: string;
  let configDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sync-snap-test-'));
    source = path.join(root, 'claude');
    configDir = path.join(root, 'config');
    await fs.mkdir(path.join(source, 'skills'), { recursive: true });
    await fs.writeFile(path.join(source, 'CLAUDE.md'), 'v1');
    await fs.writeFile(path.join(source, 'skills', 'a.md'), 'skill');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function change(content: string): Promise<void> {
    await fs.writeFile(path.join(source, 'CLAUDE.md'), content);
  }

  async function snapshotDirs(): Promise<string[]> {
    const names = await fs.readdir(path.join(configDir, 'snapshots'));
    return names.filter((n) => n !== 'manifest.json');
  }

  it('excludes caches, plugins and transcripts but keeps synced files', async () => {
    await fs.mkdir(path.join(source, 'plugins'), { recursive: true });
    await fs.writeFile(path.join(source, 'plugins', 'big.bin'), 'x'.repeat(1000));
    await fs.mkdir(path.join(source, 'projects', 'p', 'memory'), { recursive: true });
    await fs.writeFile(path.join(source, 'projects', 'p', 'session.jsonl'), 'transcript');
    await fs.writeFile(path.join(source, 'projects', 'p', 'memory', 'm.md'), 'memory');

    const mgr = new SnapshotManager(configDir);
    const snap = await mgr.create(source, 'dev', 'host', 'test');

    const dir = path.join(configDir, 'snapshots', snap.id);
    await expect(fs.access(path.join(dir, 'CLAUDE.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, 'projects', 'p', 'memory', 'm.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, 'plugins'))).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'projects', 'p', 'session.jsonl'))).rejects.toThrow();
    expect(snap.fileCount).toBe(3);
  });

  it('classifies excluded paths', () => {
    expect(isSnapshotExcluded('plugins')).toBe(true);
    expect(isSnapshotExcluded('plugins/x/y.js')).toBe(true);
    expect(isSnapshotExcluded('projects/p/s.jsonl')).toBe(true);
    expect(isSnapshotExcluded('projects/p/memory/m.md')).toBe(false);
    expect(isSnapshotExcluded('projects/p/uuid/tool-results/x.txt')).toBe(true);
    expect(isSnapshotExcluded('projects/p')).toBe(false);
    expect(isSnapshotExcluded('skills/a.md')).toBe(false);
    expect(isSnapshotExcluded('history.jsonl')).toBe(false);
  });

  it('reuses the newest snapshot when nothing changed', async () => {
    const mgr = new SnapshotManager(configDir);
    const first = await mgr.create(source, 'dev', 'host', 'one');
    // Rewriting a file with identical bytes (as a pull does) bumps its mtime but is not a change.
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(source, 'CLAUDE.md'), later, later);
    const second = await mgr.create(source, 'dev', 'host', 'two');
    expect(second.id).toBe(first.id);
    expect(await snapshotDirs()).toHaveLength(1);

    await change('v2 changed');
    const third = await mgr.create(source, 'dev', 'host', 'three');
    expect(third.id).not.toBe(first.id);
  });

  it('prunes automatically on create, keeping the newest keepCount', async () => {
    const mgr = new SnapshotManager(configDir, { keepCount: 3 });
    for (let i = 0; i < 6; i++) {
      await change(`version ${i}`);
      await mgr.create(source, 'dev', 'host', `s${i}`);
    }
    expect(await mgr.list()).toHaveLength(3);
    expect(await snapshotDirs()).toHaveLength(3);
    expect((await mgr.list())[0].description).toBe('s5');
  });

  it('drops snapshots older than maxAgeDays but always keeps the newest few', async () => {
    const mgr = new SnapshotManager(configDir, { keepCount: 100 });
    for (let i = 0; i < 5; i++) {
      await change(`version ${i}`);
      await mgr.create(source, 'dev', 'host', `s${i}`);
    }
    const manifestFile = path.join(configDir, 'snapshots', 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf-8'));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    for (const entry of manifest) entry.timestamp = old.replace(/\d{2}Z$/, `0${manifest.indexOf(entry)}Z`);
    await fs.writeFile(manifestFile, JSON.stringify(manifest));

    const deleted = await mgr.prune(100, 7);
    expect(deleted).toBe(2);
    expect(await mgr.list()).toHaveLength(3);
    expect(await snapshotDirs()).toHaveLength(3);
  });

  it('removes orphan directories and manifest entries with no directory', async () => {
    const mgr = new SnapshotManager(configDir);
    const keep = await mgr.create(source, 'dev', 'host', 'keep');
    await change('v2');
    const lost = await mgr.create(source, 'dev', 'host', 'lost');

    const snapshots = path.join(configDir, 'snapshots');
    const orphan = path.join(snapshots, 'deadbeef0000');
    await fs.mkdir(orphan);
    await fs.writeFile(path.join(orphan, 'f'), 'x');
    const freshOrphan = path.join(snapshots, 'cafecafe0000');
    await fs.mkdir(freshOrphan);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(orphan, longAgo, longAgo);
    await fs.rm(path.join(snapshots, lost.id), { recursive: true });

    await mgr.prune(50);

    const dirs = await snapshotDirs();
    expect(dirs).toContain(keep.id);
    expect(dirs).not.toContain('deadbeef0000');
    // A directory this young may belong to an in-flight create(), so it is left alone.
    expect(dirs).toContain('cafecafe0000');
    expect((await mgr.list()).map((s) => s.id)).toEqual([keep.id]);
  });

  it('keeps every entry when snapshots are created concurrently', async () => {
    const mgrs = [new SnapshotManager(configDir, { keepCount: 50 }), new SnapshotManager(configDir, { keepCount: 50 })];
    const dirs = ['a', 'b', 'c', 'd'];
    const sources = await Promise.all(
      dirs.map(async (d) => {
        const dir = path.join(root, d);
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, 'CLAUDE.md'), d);
        return dir;
      })
    );
    await Promise.all(sources.map((s, i) => mgrs[i % 2].create(s, 'dev', 'host', s)));
    expect(await mgrs[0].list()).toHaveLength(4);
    expect(await snapshotDirs()).toHaveLength(4);
  });

  it('restore leaves excluded directories alone and replaces synced files', async () => {
    const mgr = new SnapshotManager(configDir);
    const snap = await mgr.create(source, 'dev', 'host', 'before');

    await fs.mkdir(path.join(source, 'plugins'), { recursive: true });
    await fs.writeFile(path.join(source, 'plugins', 'keep.bin'), 'keep');
    await change('changed after snapshot');
    await fs.writeFile(path.join(source, 'extra.md'), 'added later');

    expect(await mgr.restore(snap.id, source)).toBe(true);

    expect(await fs.readFile(path.join(source, 'CLAUDE.md'), 'utf-8')).toBe('v1');
    await expect(fs.access(path.join(source, 'extra.md'))).rejects.toThrow();
    expect(await fs.readFile(path.join(source, 'plugins', 'keep.bin'), 'utf-8')).toBe('keep');
  });

  it('returns false when restoring an unknown snapshot', async () => {
    expect(await new SnapshotManager(configDir).restore('nope', source)).toBe(false);
  });
});
