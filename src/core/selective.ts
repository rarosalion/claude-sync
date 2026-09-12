/**
 * Selective sync filtering — shared by the file watcher and every backend's
 * actual push/pull path.
 *
 * Previously this logic only existed inside FileWatcher, which is never
 * instantiated anywhere in the CLI (see watcher.ts's own file for the
 * history) - meaning `selective.mode`/`include`/`exclude` had no effect on
 * a real sync at all, regardless of what a device's config.json said. This
 * module is what both the watcher and GitBackend's copyTree/mergeTree now
 * consult, so the config actually does what it says.
 */

import type { SelectiveSyncConfig } from '../types.js';

/**
 * Whether a vault-relative path should be synced, given a selective config.
 *
 * 'all' mode syncs everything except explicit excludes. 'selective' mode
 * requires a match against `include` and no match against `exclude`.
 */
export function shouldSyncPath(relativePath: string, config: SelectiveSyncConfig): boolean {
  const normalized = relativePath.replace(/\\/g, '/');

  if (config.mode === 'all') {
    return !config.exclude.some((pattern) => matchGlob(normalized, pattern));
  }

  const included = config.include.some((pattern) => matchGlob(normalized, pattern));
  const excluded = config.exclude.some((pattern) => matchGlob(normalized, pattern));

  return included && !excluded;
}

/**
 * Simple glob matcher: a double star matches across path separators, a single star matches
 * within one segment. Matches against a full relative path, not a bare directory name - a
 * pattern such as "projects, wildcard, memory, double-star" (a single-level wildcard between
 * two literal segments, followed by a double-star) is expected to be tested against each
 * individual file's full path (e.g. "projects/foo/memory/MEMORY.md"), not against "projects" or
 * "projects/foo" in isolation. Callers that walk a tree recursively should therefore filter at
 * each file (leaf), not prune whole directories by testing an intermediate directory's own path
 * against the pattern list - an intermediate directory frequently won't match on its own even
 * when something nested inside it should sync (see selective.test.ts).
 */
export function matchGlob(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const regexStr = pattern
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{GLOBSTAR}}/g, '.*');

  return new RegExp(`^${regexStr}$`).test(normalized);
}
