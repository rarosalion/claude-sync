/**
 * Shared sync engine for the git and gitea backends.
 *
 * A sync first commits this device's state (including deletions since the
 * last sync), then merges the remote with git's three-way merge and applies
 * only what the merge changed. A conflict aborts the merge and leaves
 * ~/.claude untouched, so no edit is silently overwritten.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BackendType, ConflictInfo, SyncResult, SyncStatus, TransferOptions } from '../types.js';
import {
  NEVER_SYNC,
  copyFiltered,
  createSyncFilter,
  isPullProtected,
  purgeNeverSync,
  type PathFilter,
} from '../core/sync-filter.js';

const execFileAsync = promisify(execFile);

const LAST_SYNC_REF = 'refs/claude-sync/last-sync';
// Written when this version creates the local repo; absent in repos from
// versions before 1.1, which already hold this device's last state.
const NEW_DEVICE_MARKER = 'claude-sync-new-device';
export const DEFAULT_HELD_DIR = path.join(os.homedir(), '.claude-sync', 'incoming');

interface MergeChanges {
  changed: string[];
  deleted: string[];
  conflicts: string[];
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

async function listFiles(root: string, relDir = ''): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, rel)));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/** Removes credentials embedded in URLs (user:token@host) from git messages. */
export function redactCredentials(message: string): string {
  return message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

function lines(output: string): string[] {
  return output.split('\n').map((l) => l.trim()).filter(Boolean);
}

export class GitSync {
  constructor(
    private readonly repoDir: string,
    private remoteUrl: string,
    private readonly branch: string,
    private readonly backend: BackendType
  ) {}

  setRemote(url: string): void {
    this.remoteUrl = url;
  }

  // ── Repository setup ───────────────────────────────────────────

  async ensureRepo(): Promise<void> {
    await fs.mkdir(this.repoDir, { recursive: true });
    if (!(await this.isRepo())) {
      let cloned = false;
      if (this.remoteUrl) {
        cloned = await execFileAsync('git', ['clone', this.remoteUrl, this.repoDir]).then(() => true, () => false);
      }
      if (!cloned) {
        await execFileAsync('git', ['init', this.repoDir]);
        await this.git('symbolic-ref', 'HEAD', `refs/heads/${this.branch}`);
        if (this.remoteUrl) await this.git('remote', 'add', 'origin', this.remoteUrl);
      }
      await fs.writeFile(path.join(this.repoDir, '.git', NEW_DEVICE_MARKER), new Date().toISOString());
    } else if (this.remoteUrl) {
      const hasOrigin = await this.gitOut('remote').then((o) => lines(o).includes('origin'));
      await this.git('remote', hasOrigin ? 'set-url' : 'add', 'origin', this.remoteUrl);
    }
    await this.ensureIdentity();
    await this.ensureGitignore();
    await this.ensureGitattributes();
  }

  /**
   * Append-only files (memory, activity logs, session transcripts) use git's
   * built-in union merge: when two devices append at the same spot, both
   * sides are kept instead of raising a conflict.
   */
  private async ensureGitattributes(): Promise<void> {
    const file = path.join(this.repoDir, '.gitattributes');
    const current = await fs.readFile(file, 'utf-8').catch(() => '');
    const wanted = ['**/memory/** merge=union', '**/MEMORY.md merge=union', '**/activity-log* merge=union', '*.jsonl merge=union'];
    const missing = wanted.filter((l) => !current.split('\n').includes(l));
    if (missing.length > 0) {
      await fs.writeFile(file, `${current.replace(/\n?$/, current ? '\n' : '')}${missing.join('\n')}\n`, 'utf-8');
    }
  }

  private async ensureIdentity(): Promise<void> {
    const name = await this.gitOut('config', 'user.name').catch(() => '');
    if (!name.trim()) {
      await this.git('config', 'user.name', `claude-sync/${os.hostname()}`);
      await this.git('config', 'user.email', `claude-sync@${os.hostname()}`);
    }
  }

  private async ensureGitignore(): Promise<void> {
    const file = path.join(this.repoDir, '.gitignore');
    const current = await fs.readFile(file, 'utf-8').catch(() => '');
    const wanted = ['.DS_Store', 'Thumbs.db', '*.lock', '*.swp', ...NEVER_SYNC, '!.env.example'];
    const missing = wanted.filter((p) => !current.split('\n').includes(p));
    if (missing.length > 0) {
      await fs.writeFile(file, `${current.replace(/\n?$/, current ? '\n' : '')}${missing.join('\n')}\n`, 'utf-8');
    }
  }

  // ── Sync ───────────────────────────────────────────────────────

  /**
   * Commits local state, merges the remote, applies the merge result to
   * claudeDir and, when publish is set, pushes.
   */
  async sync(claudeDir: string, publish: boolean, options: TransferOptions = {}): Promise<SyncResult> {
    const start = Date.now();
    const filter = options.filter ?? createSyncFilter();
    const heldDir = options.heldDir ?? DEFAULT_HELD_DIR;

    try {
      await this.ensureRepo();
      const mode = await this.syncMode();
      // A known device commits its edits and deletions first. A repo from an
      // older version commits its edits but deletes nothing yet. A new device
      // takes the shared state first and only then adds its own files.
      if (mode !== 'join') await this.stage(claudeDir, filter, heldDir, mode === 'known');

      const merge = await this.integrate(options.prefer);
      if (merge.conflicts.length > 0) {
        return this.conflictResult(merge.conflicts, start);
      }

      const { applied, held } =
        mode === 'join'
          ? await this.applyFiles(await this.trackedFiles('HEAD'), [], claudeDir, filter, heldDir)
          : await this.applyFiles(merge.changed, merge.deleted, claudeDir, filter, heldDir);
      if (mode === 'join') await this.stage(claudeDir, filter, heldDir, false);

      const pushed = publish ? await this.publish() : [];
      if (await this.head()) {
        await this.git('update-ref', LAST_SYNC_REF, 'HEAD');
        await fs.rm(path.join(this.repoDir, '.git', NEW_DEVICE_MARKER), { force: true });
      }

      return {
        success: true,
        filesChanged: publish ? pushed : applied,
        conflicts: [],
        held,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        filesChanged: [],
        conflicts: [],
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        error: redactCredentials((err as Error).message),
      };
    }
  }

  /**
   * Copies claudeDir into the working tree and commits. Files deleted on
   * this device since the last sync are deleted from the tree too; on the
   * first sync nothing is deleted, so a new device cannot wipe the remote.
   */
  private async stage(claudeDir: string, filter: PathFilter, heldDir: string, withDeletions: boolean): Promise<string[]> {
    const held = new Set(await listFiles(heldDir));
    await copyFiltered(claudeDir, this.repoDir, { filter, skip: (rel) => held.has(rel) });

    if (withDeletions) {
      const base = await this.lastSynced();
      for (const rel of base ? await this.trackedFiles(base) : []) {
        if (!filter(rel) || held.has(rel)) continue;
        if (!(await exists(path.join(claudeDir, rel)))) {
          await fs.rm(path.join(this.repoDir, rel), { force: true });
        }
      }
    }
    await purgeNeverSync(this.repoDir);

    await this.git('add', '-A');
    const changed = lines(await this.gitOut('status', '--porcelain')).map((l) => l.slice(3));
    if (changed.length > 0) {
      await this.git('commit', '-m', `sync: ${os.hostname()} at ${new Date().toISOString()}`);
    }
    return changed;
  }

  private async integrate(prefer?: 'local' | 'remote'): Promise<MergeChanges> {
    const none: MergeChanges = { changed: [], deleted: [], conflicts: [] };
    if (!this.remoteUrl) return none;

    try {
      await this.git('fetch', 'origin', this.branch);
    } catch (err) {
      if (/couldn't find remote ref/i.test((err as Error).message)) return none;
      throw err;
    }

    const before = await this.head();
    if (!before) {
      await this.git('reset', '--hard', `origin/${this.branch}`);
      return { changed: await this.trackedFiles('HEAD'), deleted: [], conflicts: [] };
    }

    const args = ['merge', '--no-edit', '--allow-unrelated-histories'];
    if (prefer) args.push('-X', prefer === 'local' ? 'ours' : 'theirs');
    try {
      await this.git(...args, `origin/${this.branch}`);
    } catch (err) {
      const conflicts = lines(await this.gitOut('diff', '--name-only', '--diff-filter=U').catch(() => ''));
      await this.git('merge', '--abort').catch(() => undefined);
      if (conflicts.length === 0) throw err;
      return { ...none, conflicts };
    }

    const changed: string[] = [];
    const deleted: string[] = [];
    for (const line of lines(await this.gitOut('diff', '--name-status', '--no-renames', before, 'HEAD'))) {
      const [status, file] = line.split('\t');
      if (!file) continue;
      (status === 'D' ? deleted : changed).push(file);
    }
    return { changed, deleted, conflicts: [] };
  }

  /** Applies merged files to claudeDir; pull-protected changes go to heldDir instead. */
  private async applyFiles(
    changed: string[],
    deleted: string[],
    claudeDir: string,
    filter: PathFilter,
    heldDir: string
  ): Promise<{ applied: string[]; held: string[] }> {
    const applied: string[] = [];
    const held: string[] = [];

    for (const rel of changed) {
      if (!filter(rel)) continue;
      const from = path.join(this.repoDir, rel);
      const local = path.join(claudeDir, rel);
      const remoteContent = await fs.readFile(from).catch(() => null);
      if (remoteContent === null) continue;
      const localContent = await fs.readFile(local).catch(() => null);
      if (localContent !== null && localContent.equals(remoteContent)) continue;

      const to = isPullProtected(rel) ? path.join(heldDir, rel) : local;
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.writeFile(to, remoteContent);
      (isPullProtected(rel) ? held : applied).push(rel);
    }

    for (const rel of deleted) {
      if (!filter(rel) || isPullProtected(rel)) continue;
      const local = path.join(claudeDir, rel);
      if (await exists(local)) {
        await fs.rm(local, { force: true });
        applied.push(rel);
      }
    }
    return { applied, held };
  }

  /** Pushes local commits and returns the files they change on the remote. */
  private async publish(): Promise<string[]> {
    if (!this.remoteUrl || !(await this.head())) return [];
    const remoteTip = await this.gitOut('rev-parse', '--verify', '-q', `origin/${this.branch}`).then(
      (o) => o.trim(),
      () => ''
    );
    if (remoteTip && (await this.gitOut('rev-list', '--count', `${remoteTip}..HEAD`)).trim() === '0') return [];
    const pending = remoteTip
      ? lines(await this.gitOut('diff', '--name-only', remoteTip, 'HEAD')).filter((f) => !f.startsWith('.git'))
      : await this.trackedFiles('HEAD');
    await this.git('push', '--set-upstream', 'origin', this.branch).catch((err: Error) => {
      throw new Error(`Push failed (${err.message.split('\n')[0]}). Another device pushed in the meantime; run sync again.`);
    });
    return pending;
  }

  private conflictResult(paths: string[], start: number): SyncResult {
    const conflicts: ConflictInfo[] = paths.map((filePath) => ({
      filePath,
      strategy: 'ask-user',
      localModified: '',
      remoteModified: '',
      resolved: false,
    }));
    return {
      success: false,
      filesChanged: [],
      conflicts,
      timestamp: new Date().toISOString(),
      duration: Date.now() - start,
      error:
        `${paths.length} file(s) changed on this device and on another one. Nothing was overwritten. ` +
        "Run 'claude-sync sync --prefer local' or '--prefer remote' to decide.",
    };
  }

  // ── Status ─────────────────────────────────────────────────────

  async status(): Promise<SyncStatus> {
    const base = { lastSync: null, pendingChanges: 0, availableUpdates: 0, backend: this.backend };
    if (!(await this.isRepo())) return { ...base, connected: false, error: 'Not initialized' };
    try {
      let availableUpdates = 0;
      if (this.remoteUrl) {
        try {
          await this.git('fetch', 'origin', this.branch);
          availableUpdates = parseInt(await this.gitOut('rev-list', '--count', `HEAD..origin/${this.branch}`), 10) || 0;
        } catch {
          // offline or empty remote
        }
      }
      const lastSync = (await this.gitOut('log', '-1', '--format=%aI', LAST_SYNC_REF).catch(() => '')).trim() || null;
      return { ...base, connected: true, lastSync, availableUpdates };
    } catch (err) {
      return { ...base, connected: false, error: (err as Error).message };
    }
  }

  // ── git helpers ────────────────────────────────────────────────

  private async isRepo(): Promise<boolean> {
    return exists(path.join(this.repoDir, '.git'));
  }

  private async head(): Promise<string | null> {
    return this.gitOut('rev-parse', '--verify', '-q', 'HEAD').then((o) => o.trim() || null, () => null);
  }

  private async syncMode(): Promise<'known' | 'legacy' | 'join'> {
    if ((await this.lastSynced()) !== null) return 'known';
    const isNew = await exists(path.join(this.repoDir, '.git', NEW_DEVICE_MARKER));
    return isNew || (await this.head()) === null ? 'join' : 'legacy';
  }

  private async lastSynced(): Promise<string | null> {
    return this.gitOut('rev-parse', '--verify', '-q', LAST_SYNC_REF).then((o) => o.trim() || null, () => null);
  }

  private async trackedFiles(ref: string): Promise<string[]> {
    return lines(await this.gitOut('ls-tree', '-r', '--name-only', ref).catch(() => '')).filter(
      (f) => f !== '.gitignore' && f !== '.gitattributes'
    );
  }

  private async git(...args: string[]): Promise<void> {
    await this.gitOut(...args);
  }

  private async gitOut(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', this.repoDir, ...args]);
      return stdout;
    } catch (err) {
      throw new Error(redactCredentials((err as Error).message));
    }
  }
}
