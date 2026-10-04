/**
 * Git sync backend — the recommended default
 *
 * Commits .claude/ contents to a private Git repo and merges changes from
 * other devices with git's three-way merge (see git-sync.ts).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SyncBackend, BackendConfig, SyncResult, SyncStatus, TransferOptions } from '../types.js';
import { GitSync } from './git-sync.js';

const execFileAsync = promisify(execFile);

export class GitBackend implements SyncBackend {
  readonly type = 'git' as const;
  private engine: GitSync;

  constructor(config?: BackendConfig) {
    this.engine = new GitSync(
      path.join(os.homedir(), '.claude-sync', 'repo'),
      config?.remoteUrl ?? '',
      config?.branch ?? 'main',
      'git'
    );
  }

  async init(config: BackendConfig): Promise<void> {
    this.engine = new GitSync(
      path.join(os.homedir(), '.claude-sync', 'repo'),
      config.remoteUrl ?? '',
      config.branch ?? 'main',
      'git'
    );
    await this.engine.ensureRepo();
  }

  async push(sourcePath: string, options?: TransferOptions): Promise<SyncResult> {
    return this.engine.sync(sourcePath, true, options);
  }

  async pull(targetPath: string, options?: TransferOptions): Promise<SyncResult> {
    return this.engine.sync(targetPath, false, options);
  }

  async status(): Promise<SyncStatus> {
    return this.engine.status();
  }

  async isAvailable(): Promise<boolean> {
    return execFileAsync('git', ['--version']).then(() => true, () => false);
  }
}
