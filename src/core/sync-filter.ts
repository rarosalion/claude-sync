import fs from 'node:fs/promises';
import path from 'node:path';
import type { SelectiveSyncConfig } from '../types.js';

/**
 * Never leaves the device, whatever the user's selective-sync config says.
 * Matched against every path segment (file or directory name).
 */
export const NEVER_SYNC: readonly string[] = [
  '.credentials.json', // Claude Code OAuth credentials
  'settings.local.json', // per-machine by Claude Code convention
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ecdsa*',
  'id_ed25519*',
  'shell-snapshots', // captured shell environments, may hold exported tokens
  'session-env',
  'ide', // IDE lock files carry auth tokens
  'statsig', // device-specific telemetry cache
];

const NEVER_SYNC_ALLOWED: readonly string[] = ['.env.example', '.env.sample', '.env.template'];

/**
 * Top-level entries that can make Claude Code run commands (settings hooks,
 * plugin hooks and MCP servers). A pull never applies them automatically:
 * whoever can write to the remote would otherwise get code execution.
 */
export const PULL_PROTECTED: readonly string[] = ['settings.json', 'plugins'];

/** Bookkeeping files that belong to the sync backend, not to ~/.claude. */
const BACKEND_FILES: readonly string[] = ['.git', '.gitignore', '.gitattributes'];

export type PathFilter = (relPath: string) => boolean;

function globToRegExp(pattern: string, flags = ''): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`, flags);
}

// Case-insensitive: macOS and Windows treat ".Credentials.JSON" as the same file.
const NEVER_SYNC_RE = NEVER_SYNC.map((p) => globToRegExp(p, 'i'));

function segments(relPath: string): string[] {
  return relPath.split(/[\\/]+/).filter(Boolean);
}

export function isNeverSync(relPath: string): boolean {
  return segments(relPath).some(
    (seg) => !NEVER_SYNC_ALLOWED.includes(seg.toLowerCase()) && NEVER_SYNC_RE.some((re) => re.test(seg))
  );
}

export function isPullProtected(relPath: string): boolean {
  const [first] = segments(relPath);
  return first !== undefined && PULL_PROTECTED.includes(first);
}

function matchesUserPattern(relPath: string, pattern: string): boolean {
  const clean = pattern.replace(/^\/+|\/+$/g, '');
  if (!clean) return false;
  const normalized = segments(relPath).join('/');
  if (normalized === clean || normalized.startsWith(`${clean}/`)) return true;
  const re = globToRegExp(clean);
  return segments(relPath).some((seg) => re.test(seg));
}

/**
 * The filter every backend applies in both directions: NEVER_SYNC first,
 * then the user's selective-sync include/exclude lists.
 */
export function createSyncFilter(selective?: SelectiveSyncConfig): PathFilter {
  return (relPath) => {
    if (isNeverSync(relPath)) return false;
    if (!selective) return true;
    if (selective.exclude.some((p) => matchesUserPattern(relPath, p))) return false;
    if (selective.mode === 'selective' && selective.include.length > 0) {
      const [first] = segments(relPath);
      // Directories above an included path must be walked to reach it.
      return selective.include.some(
        (p) => matchesUserPattern(relPath, p) || p.replace(/^\/+/, '').startsWith(`${first}/`)
      );
    }
    return true;
  };
}

interface CopyOptions {
  filter: PathFilter;
  /** Relative paths to leave out entirely (e.g. pull-protected entries). */
  skip?: (relPath: string) => boolean;
}

/**
 * Recursively copies files that pass the filter and returns their relative
 * paths. Symlinks are skipped so a synced tree cannot point outside itself.
 */
export async function copyFiltered(
  source: string,
  target: string,
  options: CopyOptions,
  relDir = ''
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(source, { withFileTypes: true });
  } catch {
    return [];
  }
  await fs.mkdir(target, { recursive: true });

  const copied: string[] = [];
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (BACKEND_FILES.includes(entry.name) && relDir === '') continue;
    if (!options.filter(rel) || options.skip?.(rel)) continue;

    const srcPath = path.join(source, entry.name);
    const destPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copied.push(...(await copyFiltered(srcPath, destPath, options, rel)));
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
      copied.push(rel);
    }
  }
  return copied;
}

/**
 * Deletes NEVER_SYNC entries from a backend's staging copy (for example a
 * git working tree that older versions filled with credentials), so the
 * next commit or upload no longer contains them. Never touches ~/.claude.
 */
export async function purgeNeverSync(stagingDir: string, relDir = ''): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(stagingDir, relDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (relDir === '' && BACKEND_FILES.includes(entry.name)) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (isNeverSync(rel)) {
      await fs.rm(path.join(stagingDir, rel), { recursive: true, force: true });
      removed.push(rel);
    } else if (entry.isDirectory()) {
      removed.push(...(await purgeNeverSync(stagingDir, rel)));
    }
  }
  return removed;
}

async function sameContent(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return x.equals(y);
  } catch {
    return false;
  }
}

/**
 * Applies a pulled tree to ~/.claude, except PULL_PROTECTED entries: changed
 * ones are copied to heldDir for review instead. Returns applied and held paths.
 */
export async function applyPulledTree(
  pulledDir: string,
  claudeDir: string,
  heldDir: string,
  filter: PathFilter
): Promise<{ applied: string[]; held: string[] }> {
  const applied = await copyFiltered(pulledDir, claudeDir, { filter, skip: isPullProtected });

  const heldCandidates = await copyFiltered(pulledDir, heldDir, {
    filter: (rel) => filter(rel) && isPullProtected(rel),
  });
  const held: string[] = [];
  for (const rel of heldCandidates) {
    if (await sameContent(path.join(heldDir, rel), path.join(claudeDir, rel))) {
      await fs.rm(path.join(heldDir, rel), { force: true });
    } else {
      held.push(rel);
    }
  }
  return { applied, held };
}

/** Applies previously held files after the user reviewed them. */
export async function applyHeld(heldDir: string, claudeDir: string): Promise<string[]> {
  const applied = await copyFiltered(heldDir, claudeDir, {
    filter: (rel) => !isNeverSync(rel) && isPullProtected(rel),
  });
  await fs.rm(heldDir, { recursive: true, force: true });
  return applied;
}

/** Excludes backend bookkeeping entries (marker files, Syncthing metadata). */
export function ignoringNames(filter: PathFilter, prefixes: readonly string[]): PathFilter {
  return (rel) => !prefixes.some((p) => segments(rel)[0]?.startsWith(p)) && filter(rel);
}

/**
 * Replaces stageDir with a filtered copy of source. Backends that hand a
 * directory to an external tool (rsync, custom commands) upload the stage,
 * never ~/.claude itself.
 */
export async function stageFiltered(source: string, stageDir: string, filter: PathFilter): Promise<string[]> {
  await fs.rm(stageDir, { recursive: true, force: true });
  return copyFiltered(source, stageDir, { filter });
}
