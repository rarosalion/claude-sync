/**
 * Tests for the git sync backend's pull() — specifically that it merges a
 * live local edit instead of blindly overwriting it with whatever the repo
 * mirror last had. This is the MEMORY.md-clobbering regression: pull() used
 * to copyTree() the repo mirror straight over the live .claude/ directory
 * with no comparison at all, discarding any local edit made since the last
 * push. Uses local bare repos as the "remote" - no network required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { GitBackend } from '../src/backends/git.js';

const execFileAsync = promisify(execFile);

interface Device {
  backend: GitBackend;
  liveDir: string;
  repoDir: string;
}

describe('GitBackend pull()', () => {
  let workDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sync-git-test-'));
    remoteDir = path.join(workDir, 'remote.git');

    // Bare "remote", seeded with one commit so both devices' first clone
    // lands on a real branch - sidesteps empty-repo/default-branch-name
    // ambiguity that isn't what this test is about.
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

  async function makeDevice(name: string): Promise<Device> {
    const liveDir = path.join(workDir, `${name}-live`);
    const repoDir = path.join(workDir, `${name}-repo`);
    await fs.mkdir(liveDir, { recursive: true });

    const backend = new GitBackend(undefined, repoDir);
    await backend.init({ type: 'git', remoteUrl: remoteDir, branch: 'main' });
    await execFileAsync('git', ['-C', repoDir, 'config', 'user.email', 'test@test.com']);
    await execFileAsync('git', ['-C', repoDir, 'config', 'user.name', 'test']);

    // Known separate issue (not this fix): init() writes an untracked
    // .gitignore into every device's repo dir, which collides with git
    // merge if another device pushes one first. Not what these tests are
    // about, so sidestep it here rather than mask it - see the writeup.
    await fs.rm(path.join(repoDir, '.gitignore'), { force: true });

    return { backend, liveDir, repoDir };
  }

  it('merges an unpushed local memory-file edit with an incoming remote update, instead of losing it', async () => {
    const deviceA = await makeDevice('a');
    const deviceB = await makeDevice('b');

    // Device A writes an initial memory entry and pushes it.
    await fs.mkdir(path.join(deviceA.liveDir, 'memory'), { recursive: true });
    await fs.writeFile(path.join(deviceA.liveDir, 'memory', 'MEMORY.md'), '- entry from device A\n');
    expect((await deviceA.backend.push(deviceA.liveDir)).success).toBe(true);

    // Device B pulls it down.
    expect((await deviceB.backend.pull(deviceB.liveDir)).success).toBe(true);
    const afterFirstPull = await fs.readFile(path.join(deviceB.liveDir, 'memory', 'MEMORY.md'), 'utf-8');
    expect(afterFirstPull).toContain('entry from device A');

    // Device B makes a live local edit - not pushed yet, exactly like a
    // Claude session writing a memory file mid-conversation.
    await fs.writeFile(
      path.join(deviceB.liveDir, 'memory', 'MEMORY.md'),
      afterFirstPull + '- entry from device B (not yet pushed)\n'
    );

    // Meanwhile, device A adds a second entry and pushes.
    await fs.writeFile(
      path.join(deviceA.liveDir, 'memory', 'MEMORY.md'),
      '- entry from device A\n- second entry from device A\n'
    );
    expect((await deviceA.backend.push(deviceA.liveDir)).success).toBe(true);

    // Device B pulls again. Before the fix, this blindly overwrote device
    // B's unpushed edit with whatever device A last pushed, losing it.
    expect((await deviceB.backend.pull(deviceB.liveDir)).success).toBe(true);

    const final = await fs.readFile(path.join(deviceB.liveDir, 'memory', 'MEMORY.md'), 'utf-8');
    expect(final).toContain('entry from device A');
    expect(final).toContain('second entry from device A');
    expect(final).toContain('entry from device B (not yet pushed)');
  });

  it('copies a brand new remote file straight through when nothing exists locally yet', async () => {
    const deviceA = await makeDevice('a');
    const deviceB = await makeDevice('b');

    await fs.writeFile(path.join(deviceA.liveDir, 'settings.json'), '{"theme":"dark"}');
    await deviceA.backend.push(deviceA.liveDir);

    await deviceB.backend.pull(deviceB.liveDir);

    const content = await fs.readFile(path.join(deviceB.liveDir, 'settings.json'), 'utf-8');
    expect(content).toBe('{"theme":"dark"}');
  });

  it('still applies latest-wins for non-memory files through the merge path', async () => {
    const deviceA = await makeDevice('a');
    const deviceB = await makeDevice('b');

    await fs.writeFile(path.join(deviceA.liveDir, 'settings.json'), '{"theme":"dark"}');
    await deviceA.backend.push(deviceA.liveDir);
    await deviceB.backend.pull(deviceB.liveDir);

    // Device B edits settings locally (newer mtime), doesn't push.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.writeFile(path.join(deviceB.liveDir, 'settings.json'), '{"theme":"light"}');

    // Nothing new on the remote, but this still exercises mergeFile's
    // latest-wins branch - local is newer, so it should win.
    await deviceB.backend.pull(deviceB.liveDir);

    const content = await fs.readFile(path.join(deviceB.liveDir, 'settings.json'), 'utf-8');
    expect(content).toBe('{"theme":"light"}');
  });
});
