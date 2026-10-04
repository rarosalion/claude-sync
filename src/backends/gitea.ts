/**
 * Gitea sync backend — self-hosted Git, full control
 *
 * Uses your local/intranet Gitea instance as the sync hub.
 * Works completely offline (no GitHub, no cloud dependency).
 *
 * Features beyond the plain Git backend:
 *  - Auto-creates the sync repo via Gitea API if it doesn't exist
 *  - Validates token and connectivity before init
 *  - Shows direct Gitea web UI link in status output
 *  - Multi-project mode: one repo per project namespace
 *  - Works on LAN, VPN, or public domain (gitea.yourserver.org)
 *
 * Setup example:
 *   claude-sync init --backend gitea \
 *     --gitea-url https://gitea.example.com \
 *     --gitea-token YOUR_TOKEN \
 *     --gitea-user rene
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import type { SyncBackend, BackendConfig, SyncResult, SyncStatus, TransferOptions } from '../types.js'
import { GitSync } from './git-sync.js'

const execFileAsync = promisify(execFile)

export class GiteaBackend implements SyncBackend {
  readonly type = 'gitea' as const

  private repoDir: string
  private baseUrl: string
  private token: string
  private user: string
  private repoName: string
  private branch: string

  constructor(config?: BackendConfig) {
    this.repoDir   = path.join(os.homedir(), '.claude-sync', 'gitea-repo')
    this.baseUrl   = (config?.giteaUrl  ?? 'http://localhost:3000').replace(/\/$/, '')
    this.token     = config?.giteaToken ?? ''
    this.user      = config?.giteaUser  ?? ''
    this.repoName  = config?.giteaRepo  ?? 'claude-memory'
    this.branch    = config?.branch     ?? 'main'
  }

  // ── Gitea API helpers ───────────────────────────────────────────────────

  private apiUrl(endpoint: string): string {
    return `${this.baseUrl}/api/v1${endpoint}`
  }

  private async apiGet(endpoint: string): Promise<unknown> {
    const res = await fetch(this.apiUrl(endpoint), {
      headers: { Authorization: `token ${this.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`Gitea API ${res.status}: ${await res.text()}`)
    return res.json()
  }

  private async apiPost(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.apiUrl(endpoint), {
      method: 'POST',
      headers: { Authorization: `token ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok && res.status !== 409) throw new Error(`Gitea API ${res.status}: ${await res.text()}`)
    return res.json()
  }

  /** Check if the sync repo exists on Gitea */
  private async repoExists(): Promise<boolean> {
    try {
      await this.apiGet(`/repos/${this.user}/${this.repoName}`)
      return true
    } catch {
      return false
    }
  }

  /** Create private repo on Gitea via API */
  private async createRepo(): Promise<void> {
    await this.apiPost('/user/repos', {
      name: this.repoName,
      description: 'claude-sync: Claude Code memory & settings (auto-managed)',
      private: true,
      auto_init: true,
      default_branch: this.branch,
    })
  }

  /** Validate token and server connectivity */
  async validateConnection(): Promise<{ ok: boolean; user?: string; serverVersion?: string; error?: string }> {
    try {
      const user = await this.apiGet('/user') as { login: string }
      const settings = await this.apiGet('/settings/api').catch(() => ({})) as { version?: string }
      return { ok: true, user: user.login, serverVersion: settings.version }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  // ── SyncBackend interface ───────────────────────────────────────────────

  async init(config: BackendConfig): Promise<void> {
    this.baseUrl  = (config.giteaUrl  ?? this.baseUrl).replace(/\/$/, '')
    this.token    = config.giteaToken ?? this.token
    this.user     = config.giteaUser  ?? this.user
    this.repoName = config.giteaRepo  ?? this.repoName
    this.branch   = config.branch     ?? this.branch

    const check = await this.validateConnection()
    if (!check.ok) throw new Error(`Cannot connect to Gitea: ${check.error}`)
    if (!(await this.repoExists())) {
      await this.createRepo()
    }
    await this.engine().ensureRepo()
  }

  async push(sourcePath: string, options?: TransferOptions): Promise<SyncResult> {
    return this.engine().sync(sourcePath, true, options)
  }

  async pull(targetPath: string, options?: TransferOptions): Promise<SyncResult> {
    return this.engine().sync(targetPath, false, options)
  }

  async status(): Promise<SyncStatus> {
    return this.engine().status()
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('git', ['--version'])
      const check = await this.validateConnection()
      return check.ok
    } catch {
      return false
    }
  }

  /** Direct link to the repo in Gitea web UI */
  webUrl(): string {
    return `${this.baseUrl}/${this.user}/${this.repoName}`
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private engine(): GitSync {
    return new GitSync(this.repoDir, this.cloneUrl(), this.branch, 'gitea')
  }

  private cloneUrl(): string {
    // Embed token in URL for auth (works with Gitea)
    const url = new URL(`${this.baseUrl}/${this.user}/${this.repoName}.git`)
    url.username = this.user
    url.password = this.token
    return url.toString()
  }
}
