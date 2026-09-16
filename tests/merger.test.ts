/**
 * Tests for the smart conflict resolution merger
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Merger } from '../src/core/merger.js';

describe('Merger', () => {
  let merger: Merger;
  let tmpDir: string;

  beforeEach(async () => {
    merger = new Merger();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sync-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Strategy Detection ────────────────────────────────────

  describe('getStrategy', () => {
    it('returns latest-wins for MEMORY.md specifically', () => {
      // MEMORY.md is a flat index of one-line pointers, not the actual content - latest-wins lets
      // a cleanup edit (e.g. removing a stale/duplicate line) actually stick.
      expect(merger.getStrategy('memory/MEMORY.md')).toBe('latest-wins');
      expect(merger.getStrategy('projects/myapp/memory/MEMORY.md')).toBe('latest-wins');
    });

    it('returns merge-append for individual memory files (not MEMORY.md itself)', () => {
      // These hold the actual content and get corrected/rewritten in place - merge-append is kept
      // here (rather than latest-wins) specifically so an unpushed local edit can never be
      // silently discarded by a concurrent push from another device (regression: commit ad143e6 /
      // tests/git-backend.test.ts).
      expect(merger.getStrategy('memory/feedback-something.md')).toBe('merge-append');
      expect(merger.getStrategy('projects/myapp/memory/notes.md')).toBe('merge-append');
    });

    it('returns merge-append for non-memory project files', () => {
      expect(merger.getStrategy('projects/myapp/notes.md')).toBe('merge-append');
    });

    it('returns merge-chrono for activity logs', () => {
      expect(merger.getStrategy('activity-log.md')).toBe('merge-chrono');
      expect(merger.getStrategy('projects/myapp/activity-log-2025.md')).toBe('merge-chrono');
    });

    it('returns latest-wins for settings', () => {
      expect(merger.getStrategy('settings.json')).toBe('latest-wins');
      expect(merger.getStrategy('settings/preferences.json')).toBe('latest-wins');
    });

    it('returns latest-wins for skills', () => {
      expect(merger.getStrategy('skills/my-skill.md')).toBe('latest-wins');
    });

    it('returns ask-user for CLAUDE.md', () => {
      expect(merger.getStrategy('CLAUDE.md')).toBe('ask-user');
      expect(merger.getStrategy('projects/myapp/CLAUDE.md')).toBe('ask-user');
    });

    it('returns latest-wins as default for unknown files', () => {
      expect(merger.getStrategy('random-file.txt')).toBe('latest-wins');
    });
  });

  // ── Merge: Identical Content ──────────────────────────────

  describe('merge — identical content', () => {
    it('detects identical files as no-conflict', async () => {
      const localFile = path.join(tmpDir, 'local.md');
      const remoteFile = path.join(tmpDir, 'remote.md');
      const content = '# Memory\n\nSome notes here.\n';

      await fs.writeFile(localFile, content);
      await fs.writeFile(remoteFile, content);

      const result = await merger.merge(localFile, remoteFile, 'memory/test.md');

      expect(result.conflict.resolved).toBe(true);
      expect(result.conflict.resolution).toBe('identical');
      expect(result.content).toBe(content);
    });
  });

  // ── Merge: Append Strategy ────────────────────────────────

  describe('merge — merge-append', () => {
    // Uses a projects/ path (not memory/) so the strategy resolved is actually merge-append -
    // memory/** now resolves to latest-wins (see getStrategy tests above). These tests exercise
    // the merge-append algorithm itself, which other file categories (e.g. projects/**) still use.
    it('appends unique lines from both files', async () => {
      const localFile = path.join(tmpDir, 'local.md');
      const remoteFile = path.join(tmpDir, 'remote.md');

      await fs.writeFile(localFile, '# Notes\nLine A\nLine B\n');
      await fs.writeFile(remoteFile, '# Notes\nLine B\nLine C\n');

      const result = await merger.merge(localFile, remoteFile, 'projects/myapp/notes.md');

      expect(result.conflict.resolved).toBe(true);
      expect(result.conflict.resolution).toBe('merged-append');
      expect(result.content).toContain('Line A');
      expect(result.content).toContain('Line B');
      expect(result.content).toContain('Line C');
      expect(result.content).toContain('# Notes');
    });

    it('deduplicates identical lines', async () => {
      const localFile = path.join(tmpDir, 'local.md');
      const remoteFile = path.join(tmpDir, 'remote.md');

      await fs.writeFile(localFile, 'Line A\nLine B\n');
      await fs.writeFile(remoteFile, 'Line A\nLine B\n');

      // Files differ only in that they're "the same" — but our test is about
      // ensuring dedup when content is different. Let's make them actually differ:
      await fs.writeFile(remoteFile, 'Line A\nLine C\n');

      const result = await merger.merge(localFile, remoteFile, 'projects/myapp/notes.md');

      const lines = result.content.split('\n').filter(l => l.trim() !== '');
      const lineACount = lines.filter(l => l.trim() === 'Line A').length;
      expect(lineACount).toBe(1); // Deduplicated
    });

    it('preserves a legitimately repeated line within one side, like YAML frontmatter delimiters', async () => {
      const localFile = path.join(tmpDir, 'local.md');
      const remoteFile = path.join(tmpDir, 'remote.md');

      // Both sides are valid frontmatter-delimited files - `---` appears
      // twice in each, on its own, which is structurally required, not a
      // duplicate to collapse. Content between the delimiters differs.
      await fs.writeFile(
        localFile,
        '---\nname: test\nmodified: 2025-01-01\n---\n\nbody text\n'
      );
      await fs.writeFile(
        remoteFile,
        '---\nname: test\nmodified: 2025-01-02\n---\n\nbody text\n'
      );

      const result = await merger.merge(localFile, remoteFile, 'projects/myapp/notes.md');

      const dashCount = result.content.split('\n').filter(l => l.trim() === '---').length;
      expect(dashCount).toBe(2); // Both delimiters survive - the file is still valid frontmatter.
      expect(result.content).toContain('modified: 2025-01-01');
      expect(result.content).toContain('modified: 2025-01-02'); // Remote's differing value still comes through.
    });

    it('does not duplicate a line that legitimately appears the same number of times on both sides', async () => {
      const localFile = path.join(tmpDir, 'local.md');
      const remoteFile = path.join(tmpDir, 'remote.md');

      await fs.writeFile(localFile, '---\nLine A\n---\n');
      await fs.writeFile(remoteFile, '---\nLine A\n---\n');

      const result = await merger.merge(localFile, remoteFile, 'projects/myapp/notes.md');

      // Identical content end to end - the "identical content" fast path
      // should apply, not even reach mergeAppend, but assert the outcome
      // either way: no tripling/quadrupling of the shared lines.
      const dashCount = result.content.split('\n').filter(l => l.trim() === '---').length;
      expect(dashCount).toBe(2);
    });

    it('does not let blank lines accumulate across repeated merges (regression, was Math.random hash)', async () => {
      const localFile = path.join(tmpDir, 'local.md');
      const remoteFile = path.join(tmpDir, 'remote.md');

      await fs.writeFile(localFile, 'Line A\n\nLine B\n');
      await fs.writeFile(remoteFile, 'Line A\n\n\nLine C\n');

      let result = await merger.merge(localFile, remoteFile, 'projects/myapp/notes.md');
      // Re-merge the result against the same remote a few more times, simulating repeated
      // syncs - a fixed line count means blank lines are being deduplicated by occurrence
      // count like any other line, not treated as always-new.
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(localFile, result.content);
        result = await merger.merge(localFile, remoteFile, 'projects/myapp/notes.md');
      }

      const blankLineCount = result.content.split('\n').filter(l => l.trim() === '').length;
      expect(blankLineCount).toBeLessThanOrEqual(3);
    });
  });

  // ── Merge: Chronological Strategy ─────────────────────────

  describe('merge — merge-chrono', () => {
    it('sorts lines with dates chronologically', async () => {
      const localFile = path.join(tmpDir, 'local.md');
      const remoteFile = path.join(tmpDir, 'remote.md');

      await fs.writeFile(localFile, '2025-03-15 Did thing A\n2025-03-17 Did thing C\n');
      await fs.writeFile(remoteFile, '2025-03-16 Did thing B\n2025-03-18 Did thing D\n');

      const result = await merger.merge(localFile, remoteFile, 'activity-log.md');

      expect(result.conflict.resolved).toBe(true);
      const lines = result.content.split('\n').filter(l => l.trim() !== '');
      const dates = lines.map(l => l.substring(0, 10));
      expect(dates).toEqual([...dates].sort());
    });
  });

  // ── Merge: Latest Wins Strategy ───────────────────────────

  describe('merge — latest-wins', () => {
    it('picks the file with the later modification time', async () => {
      const localFile = path.join(tmpDir, 'local.json');
      const remoteFile = path.join(tmpDir, 'remote.json');

      await fs.writeFile(localFile, '{"theme": "dark"}');
      // Wait a tiny bit to ensure different mtime
      await new Promise(resolve => setTimeout(resolve, 50));
      await fs.writeFile(remoteFile, '{"theme": "light"}');

      const result = await merger.merge(localFile, remoteFile, 'settings.json');

      expect(result.conflict.resolved).toBe(true);
      expect(result.content).toBe('{"theme": "light"}');
    });
  });

  // ── Merge: Ask User Strategy ──────────────────────────────

  describe('merge — ask-user', () => {
    it('marks conflicts as unresolved for CLAUDE.md', async () => {
      const localFile = path.join(tmpDir, 'local.md');
      const remoteFile = path.join(tmpDir, 'remote.md');

      await fs.writeFile(localFile, '# Local Claude Config');
      await fs.writeFile(remoteFile, '# Remote Claude Config');

      const result = await merger.merge(localFile, remoteFile, 'CLAUDE.md');

      expect(result.conflict.resolved).toBe(false);
      expect(result.conflict.resolution).toBe('needs-user-input');
    });
  });

  // ── Diff Generation ───────────────────────────────────────

  describe('generateDiff', () => {
    it('produces a readable diff', () => {
      const local = 'Line 1\nLine 2\nLine 3';
      const remote = 'Line 1\nModified Line 2\nLine 3';

      const diff = merger.generateDiff(local, remote, 'test.md');

      expect(diff).toContain('--- local/test.md');
      expect(diff).toContain('+++ remote/test.md');
      expect(diff).toContain('- Line 2');
      expect(diff).toContain('+ Modified Line 2');
    });

    it('handles completely different files', () => {
      const diff = merger.generateDiff('AAA', 'BBB', 'test.md');
      expect(diff).toContain('- AAA');
      expect(diff).toContain('+ BBB');
    });
  });
});
