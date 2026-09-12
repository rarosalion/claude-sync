/**
 * Tests that GitBackend's actual push()/pull() respect a device's selective-sync config.
 *
 * Before this fix, `selective.mode`/`include`/`exclude` had no effect on a real sync at all -
 * copyTree() and mergeTree() copied everything (bar a literal ".git"/".gitignore" exclusion)
 * regardless of what config.json said, since the only code that ever consulted selectiveConfig
 * was FileWatcher.shouldSync(), which is never instantiated anywhere in the CLI. Same local
 * bare-repo setup as git-backend.test.ts - no network required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { GitBackend } from '../src/backends/git.js';
import type { SelectiveSyncConfig } from '../src/types.js';

const execFileAsync = promisify(execFile);

describe('GitBackend selective sync', () => {
  let workDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sync-selective-test-'));
    remoteDir = path.join(workDir, 'remote.git');

    await execFileAsync('git', ['init', '--bare', '-b', 'main', remoteDir]);
    const seedDir = path.join(workDir, 'seed');
    await execFileAsync('git', ['clone', remoteDir, seedDir]);
    await fs.writeFile(path.join(seedDir, '.gitkeep'), '');
    await execFileAsync('git', ['-C', seedDir, 'config', 'user.email', 'test@test.com']);
    await execFileAsync('git', ['-C', seedDir, 'config', 'user.name', 'test']);
    await execFileAsync('git', ['-C', seedDir, 'add', '-A']);
    await execFileAsync('git', ['-C', seedDir, 'commit', '-m', 'seed']);
    await execFileAsync('git', ['-C', seedDir, 'push', 'origin', 'main']);
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  async function makeDevice(name: string, selective?: SelectiveSyncConfig) {
    const liveDir = path.join(workDir, `${name}-live`);
    const repoDir = path.join(workDir, `${name}-repo`);
    await fs.mkdir(liveDir, { recursive: true });

    const backend = new GitBackend(undefined, repoDir, selective);
    await backend.init({ type: 'git', remoteUrl: remoteDir, branch: 'main' });
    await execFileAsync('git', ['-C', repoDir, 'config', 'user.email', 'test@test.com']);
    await execFileAsync('git', ['-C', repoDir, 'config', 'user.name', 'test']);
    await fs.rm(path.join(repoDir, '.gitignore'), { force: true });

    return { backend, liveDir, repoDir };
  }

  it('push() only stages files matching the include patterns in selective mode', async () => {
    const device = await makeDevice('a', {
      mode: 'selective',
      include: ['skills/**'],
      exclude: [],
    });

    await fs.mkdir(path.join(device.liveDir, 'skills', 'obsidian-notes'), { recursive: true });
    await fs.writeFile(path.join(device.liveDir, 'skills', 'obsidian-notes', 'SKILL.md'), '# obsidian');
    await fs.mkdir(path.join(device.liveDir, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(device.liveDir, 'sessions', 'abc.jsonl'), '{"transcript":true}');

    const result = await device.backend.push(device.liveDir);
    expect(result.success).toBe(true);

    const trackedFiles = (
      await execFileAsync('git', ['-C', device.repoDir, 'ls-files'])
    ).stdout.trim().split('\n');

    expect(trackedFiles).toContain('skills/obsidian-notes/SKILL.md');
    expect(trackedFiles).not.toContain('sessions/abc.jsonl');
  });

  it('push() only excludes files matching exclude patterns in "all" mode', async () => {
    const device = await makeDevice('a', {
      mode: 'all',
      include: [],
      exclude: ['telemetry/**'],
    });

    await fs.mkdir(path.join(device.liveDir, 'skills'), { recursive: true });
    await fs.writeFile(path.join(device.liveDir, 'skills', 'foo.md'), '# foo');
    await fs.mkdir(path.join(device.liveDir, 'telemetry'), { recursive: true });
    await fs.writeFile(path.join(device.liveDir, 'telemetry', 'events.json'), '{}');

    await device.backend.push(device.liveDir);

    const trackedFiles = (
      await execFileAsync('git', ['-C', device.repoDir, 'ls-files'])
    ).stdout.trim().split('\n');

    expect(trackedFiles).toContain('skills/foo.md');
    expect(trackedFiles).not.toContain('telemetry/events.json');
  });

  it('pull() only merges files matching the receiving device\'s own selective config', async () => {
    // Device A syncs everything.
    const deviceA = await makeDevice('a');
    await fs.mkdir(path.join(deviceA.liveDir, 'skills'), { recursive: true });
    await fs.writeFile(path.join(deviceA.liveDir, 'skills', 'foo.md'), '# foo');
    await fs.mkdir(path.join(deviceA.liveDir, 'projects', 'home-terraform', 'memory'), { recursive: true });
    await fs.writeFile(
      path.join(deviceA.liveDir, 'projects', 'home-terraform', 'memory', 'MEMORY.md'),
      '- an entry'
    );
    await fs.mkdir(path.join(deviceA.liveDir, 'projects', 'home-terraform'), { recursive: true });
    await fs.writeFile(
      path.join(deviceA.liveDir, 'projects', 'home-terraform', 'session.jsonl'),
      '{"transcript":true}'
    );
    expect((await deviceA.backend.push(deviceA.liveDir)).success).toBe(true);

    // Device B (a claude-agent-style host) only wants skills/ and memory/.
    const deviceB = await makeDevice('b', {
      mode: 'selective',
      include: ['skills/**', 'projects/*/memory/**'],
      exclude: [],
    });
    expect((await deviceB.backend.pull(deviceB.liveDir)).success).toBe(true);

    await expect(fs.access(path.join(deviceB.liveDir, 'skills', 'foo.md'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(deviceB.liveDir, 'projects', 'home-terraform', 'memory', 'MEMORY.md'))
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(deviceB.liveDir, 'projects', 'home-terraform', 'session.jsonl'))
    ).rejects.toThrow();
  });
});
