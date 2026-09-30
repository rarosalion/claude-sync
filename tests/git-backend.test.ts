/**
 * Tests for the git sync backend's pull() — specifically that it merges a
 * live local edit instead of blindly overwriting it with whatever the repo
 * mirror last had. This is the memory-file-clobbering regression: pull() used
 * to copyTree() the repo mirror straight over the live .claude/ directory
 * with no comparison at all, discarding any local edit made since the last
 * push. Uses local bare repos as the "remote" - no network required.
 *
 * Individual memory files (feedback_*.md, project_*.md, etc.) stay on
 * merge-append specifically so this can never happen to them. MEMORY.md
 * itself is a deliberate exception - it's a low-stakes index of one-line
 * pointers, carved out to latest-wins so a cleanup edit actually sticks - see
 * the last test below for that accepted tradeoff made explicit.
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

    // A real content file, not MEMORY.md itself - that filename is a deliberate latest-wins
    // exception, covered separately below.
    const memoryFile = path.join('memory', 'feedback-something.md');

    // Device A writes an initial memory entry and pushes it.
    await fs.mkdir(path.join(deviceA.liveDir, 'memory'), { recursive: true });
    await fs.writeFile(path.join(deviceA.liveDir, memoryFile), '- entry from device A\n');
    expect((await deviceA.backend.push(deviceA.liveDir)).success).toBe(true);

    // Device B pulls it down.
    expect((await deviceB.backend.pull(deviceB.liveDir)).success).toBe(true);
    const afterFirstPull = await fs.readFile(path.join(deviceB.liveDir, memoryFile), 'utf-8');
    expect(afterFirstPull).toContain('entry from device A');

    // Device B makes a live local edit - not pushed yet, exactly like a
    // Claude session writing a memory file mid-conversation.
    await fs.writeFile(
      path.join(deviceB.liveDir, memoryFile),
      afterFirstPull + '- entry from device B (not yet pushed)\n'
    );

    // Meanwhile, device A adds a second entry and pushes.
    await fs.writeFile(
      path.join(deviceA.liveDir, memoryFile),
      '- entry from device A\n- second entry from device A\n'
    );
    expect((await deviceA.backend.push(deviceA.liveDir)).success).toBe(true);

    // Device B pulls again. Before the fix, this blindly overwrote device
    // B's unpushed edit with whatever device A last pushed, losing it.
    expect((await deviceB.backend.pull(deviceB.liveDir)).success).toBe(true);

    const final = await fs.readFile(path.join(deviceB.liveDir, memoryFile), 'utf-8');
    expect(final).toContain('entry from device A');
    expect(final).toContain('second entry from device A');
    expect(final).toContain('entry from device B (not yet pushed)');
  });

  it('MEMORY.md itself uses latest-wins, not merge-append (accepted tradeoff)', async () => {
    const deviceA = await makeDevice('a');
    const deviceB = await makeDevice('b');
    const indexFile = path.join('memory', 'MEMORY.md');

    await fs.mkdir(path.join(deviceA.liveDir, 'memory'), { recursive: true });
    await fs.writeFile(path.join(deviceA.liveDir, indexFile), '- entry A\n');
    expect((await deviceA.backend.push(deviceA.liveDir)).success).toBe(true);
    expect((await deviceB.backend.pull(deviceB.liveDir)).success).toBe(true);

    // Device B makes an unpushed edit to the index...
    await fs.writeFile(path.join(deviceB.liveDir, indexFile), '- entry A\n- entry B (not yet pushed)\n');

    // ...meanwhile device A pushes a newer version with no knowledge of B's edit.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.writeFile(path.join(deviceA.liveDir, indexFile), '- entry A\n- entry A2\n');
    expect((await deviceA.backend.push(deviceA.liveDir)).success).toBe(true);

    expect((await deviceB.backend.pull(deviceB.liveDir)).success).toBe(true);

    // Unlike the content-file case above, B's unpushed index edit is allowed to be lost here -
    // MEMORY.md only ever holds pointers to the real content, which stays protected.
    const final = await fs.readFile(path.join(deviceB.liveDir, indexFile), 'utf-8');
    expect(final).toContain('entry A2');
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

  // ── Convergence: pull merges against the last-synced version (three-way) ──
  //
  // A plain two-way merge can't tell "the other device added this line" from "this device deleted
  // it", so merge-append used to re-add every deleted or rewritten line, and each device kept its
  // own line order. Push overwrites the repo with the local copy, so two devices holding the same
  // lines in different orders swapped them back and forth on every sync, forever. These tests run
  // full sync cycles (pull, then push, as `claude-sync sync` does) and require byte-identical
  // copies that stop producing commits.

  async function sync(device: Device): Promise<void> {
    expect((await device.backend.pull(device.liveDir)).success).toBe(true);
    expect((await device.backend.push(device.liveDir)).success).toBe(true);
  }

  async function commitCount(device: Device): Promise<number> {
    const { stdout } = await execFileAsync('git', ['-C', device.repoDir, 'rev-list', '--count', 'HEAD']);
    return parseInt(stdout.trim(), 10);
  }

  it('propagates a rewritten or deleted line in a memory file to the other device', async () => {
    const deviceA = await makeDevice('a');
    const deviceB = await makeDevice('b');
    const memoryFile = path.join('memory', 'feedback-something.md');

    await fs.mkdir(path.join(deviceA.liveDir, 'memory'), { recursive: true });
    await fs.writeFile(path.join(deviceA.liveDir, memoryFile), 'keep this\nold wording\nstale line\n');
    await sync(deviceA);
    await sync(deviceB);

    // Device A corrects the memory in place: one line reworded, one removed.
    const corrected = 'keep this\nnew wording\n';
    await fs.writeFile(path.join(deviceA.liveDir, memoryFile), corrected);

    for (let round = 0; round < 3; round++) {
      await sync(deviceA);
      await sync(deviceB);
    }

    expect(await fs.readFile(path.join(deviceA.liveDir, memoryFile), 'utf-8')).toBe(corrected);
    expect(await fs.readFile(path.join(deviceB.liveDir, memoryFile), 'utf-8')).toBe(corrected);
  });

  it('converges after concurrent edits to the same memory file, and then stops committing', async () => {
    const deviceA = await makeDevice('a');
    const deviceB = await makeDevice('b');
    const memoryFile = path.join('memory', 'feedback-something.md');

    await fs.mkdir(path.join(deviceA.liveDir, 'memory'), { recursive: true });
    await fs.writeFile(path.join(deviceA.liveDir, memoryFile), 'shared line\n');
    await sync(deviceA);
    await sync(deviceB);

    // Both devices edit the same file before either syncs, so the configured merge-append
    // strategy has to combine them. Neither side's addition may be lost.
    await fs.writeFile(path.join(deviceA.liveDir, memoryFile), 'shared line\nfrom A\n');
    await fs.writeFile(path.join(deviceB.liveDir, memoryFile), 'shared line\nfrom B\n');

    for (let round = 0; round < 3; round++) {
      await sync(deviceA);
      await sync(deviceB);
    }

    const contentA = await fs.readFile(path.join(deviceA.liveDir, memoryFile), 'utf-8');
    const contentB = await fs.readFile(path.join(deviceB.liveDir, memoryFile), 'utf-8');
    expect(contentA).toContain('from A');
    expect(contentA).toContain('from B');
    expect(contentB).toBe(contentA);

    // Once converged, further syncs must be no-ops rather than swapping line orders.
    const before = await commitCount(deviceA);
    await sync(deviceA);
    await sync(deviceB);
    await sync(deviceA);
    expect(await commitCount(deviceA)).toBe(before);
  });

  it('lets a CLAUDE.md edit from another device through when this device has not changed it', async () => {
    const deviceA = await makeDevice('a');
    const deviceB = await makeDevice('b');

    await fs.writeFile(path.join(deviceA.liveDir, 'CLAUDE.md'), '# Rules\n- one\n');
    await sync(deviceA);
    await sync(deviceB);

    // ask-user can't resolve a real conflict unattended, but an edit made on only one device isn't
    // a conflict. It used to be kept out forever because the two copies simply differed.
    await fs.writeFile(path.join(deviceA.liveDir, 'CLAUDE.md'), '# Rules\n- one\n- two\n');
    await sync(deviceA);
    await sync(deviceB);

    expect(await fs.readFile(path.join(deviceB.liveDir, 'CLAUDE.md'), 'utf-8')).toBe('# Rules\n- one\n- two\n');
  });
});
