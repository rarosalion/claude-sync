/**
 * Tests for the selective-sync path filter - shared by the (unused) file
 * watcher and, as of this fix, GitBackend's actual push/pull path.
 */

import { describe, it, expect } from 'vitest';
import { shouldSyncPath, matchGlob } from '../src/core/selective.js';
import type { SelectiveSyncConfig } from '../src/types.js';

describe('matchGlob', () => {
  it('matches a literal path exactly', () => {
    expect(matchGlob('settings.json', 'settings.json')).toBe(true);
    expect(matchGlob('settings.json.bak', 'settings.json')).toBe(false);
  });

  it('does not match a bare substring - the match is anchored to the full path', () => {
    // Regression: the original watcher.ts implementation this was extracted from used an
    // unanchored regex, so a pattern like "cache" would match "mycache/file.txt" or
    // "notcache.txt" as a substring anywhere in the path, not just a real path segment.
    expect(matchGlob('mycache/file.txt', 'cache')).toBe(false);
    expect(matchGlob('notcache.txt', 'cache')).toBe(false);
  });

  it('matches a single star within one path segment only', () => {
    expect(matchGlob('skills/foo.md', 'skills/*')).toBe(true);
    expect(matchGlob('skills/nested/foo.md', 'skills/*')).toBe(false);
  });

  it('matches a double star across multiple path segments', () => {
    expect(matchGlob('skills/nested/deep/foo.md', 'skills/**')).toBe(true);
    expect(matchGlob('skills/foo.md', 'skills/**')).toBe(true);
  });

  it('matches a wildcard segment in the middle of a multi-segment pattern', () => {
    const pattern = 'projects/' + '*/memory/**';
    expect(matchGlob('projects/home-terraform/memory/MEMORY.md', pattern)).toBe(true);
    expect(matchGlob('projects/home-terraform/sessions/abc.jsonl', pattern)).toBe(false);
    // The middle wildcard is single-segment only - it should not itself cross a "/".
    expect(matchGlob('projects/a/b/memory/MEMORY.md', pattern)).toBe(false);
  });
});

describe('shouldSyncPath', () => {
  it('in "all" mode, syncs everything except explicit excludes', () => {
    const config: SelectiveSyncConfig = { mode: 'all', include: [], exclude: ['telemetry/**'] };
    expect(shouldSyncPath('skills/foo.md', config)).toBe(true);
    expect(shouldSyncPath('telemetry/events.json', config)).toBe(false);
  });

  it('in "selective" mode, requires an include match and no exclude match', () => {
    const config: SelectiveSyncConfig = {
      mode: 'selective',
      include: ['skills/**', 'projects/' + '*/memory/**'],
      exclude: [],
    };
    expect(shouldSyncPath('skills/obsidian-notes/SKILL.md', config)).toBe(true);
    expect(shouldSyncPath('projects/home-terraform/memory/MEMORY.md', config)).toBe(true);
    expect(shouldSyncPath('projects/home-terraform/sessions/abc.jsonl', config)).toBe(false);
    expect(shouldSyncPath('settings.json', config)).toBe(false);
  });

  it('in "selective" mode, an exclude still wins over a matching include', () => {
    const config: SelectiveSyncConfig = {
      mode: 'selective',
      include: ['skills/**'],
      exclude: ['skills/secret-skill/**'],
    };
    expect(shouldSyncPath('skills/obsidian-notes/SKILL.md', config)).toBe(true);
    expect(shouldSyncPath('skills/secret-skill/SKILL.md', config)).toBe(false);
  });
});
