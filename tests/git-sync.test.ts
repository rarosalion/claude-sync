import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitSync, redactCredentials } from '../src/backends/git-sync.js';
import { applyHeld } from '../src/core/sync-filter.js';

interface Device {
  claude: string;
  held: string;
  engine: GitSync;
}

let tmp: string;
let remote: string;

function device(name: string): Device {
  const root = path.join(tmp, name);
  return {
    claude: path.join(root, 'claude'),
    held: path.join(root, 'held'),
    engine: new GitSync(path.join(root, 'repo'), remote, 'main', 'git'),
  };
}

async function write(d: Device, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(d.claude, rel)), { recursive: true });
  await fs.writeFile(path.join(d.claude, rel), content);
}

async function read(d: Device, rel: string): Promise<string | null> {
  return fs.readFile(path.join(d.claude, rel), 'utf-8').catch(() => null);
}

function remoteFiles(): string[] {
  try {
    return execFileSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf-8' })
      .split('\n')
      .filter((f) => f && !f.startsWith('.git'));
  } catch {
    return [];
  }
}

async function sync(d: Device, publish = true, prefer?: 'local' | 'remote') {
  const result = await d.engine.sync(d.claude, publish, { heldDir: d.held, prefer });
  return result;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sync-git-'));
  remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GitSync', () => {
  it('a new device adopts the group state and contributes its own files', async () => {
    const a = device('a');
    await write(a, 'CLAUDE.md', 'from A');
    expect((await sync(a)).success).toBe(true);

    const b = device('b');
    await write(b, 'skills/b/SKILL.md', 'from B');
    const result = await sync(b);
    expect(result.success).toBe(true);
    expect(await read(b, 'CLAUDE.md')).toBe('from A');
    expect(remoteFiles()).toEqual(expect.arrayContaining(['CLAUDE.md', 'skills/b/SKILL.md']));
  });

  it('a new device with an empty ~/.claude does not wipe the remote', async () => {
    const a = device('a');
    await write(a, 'CLAUDE.md', 'keep me');
    await sync(a);

    const b = device('b');
    await fs.mkdir(b.claude, { recursive: true });
    await sync(b);
    expect(remoteFiles()).toContain('CLAUDE.md');
    expect(await read(b, 'CLAUDE.md')).toBe('keep me');
  });

  it('keeps an unpushed local edit when another device changed a different file', async () => {
    const a = device('a');
    const b = device('b');
    await write(a, 'CLAUDE.md', 'v1');
    await write(a, 'notes.md', 'n1');
    await sync(a);
    await sync(b);

    await write(a, 'CLAUDE.md', 'v2 from A');
    await sync(a);
    await write(b, 'notes.md', 'n2 unsaved on B');

    const pulled = await sync(b, false);
    expect(pulled.success).toBe(true);
    expect(await read(b, 'notes.md')).toBe('n2 unsaved on B');
    expect(await read(b, 'CLAUDE.md')).toBe('v2 from A');
  });

  it('keeps both sides when two devices append to the same memory file', async () => {
    const a = device('a');
    const b = device('b');
    await write(a, 'projects/p/memory/MEMORY.md', '- fact 1\n');
    await sync(a);
    await sync(b);

    await write(a, 'projects/p/memory/MEMORY.md', '- fact 1\n- from A\n');
    await sync(a);
    await write(b, 'projects/p/memory/MEMORY.md', '- fact 1\n- from B\n');

    const result = await sync(b);
    expect(result.success).toBe(true);
    const merged = await read(b, 'projects/p/memory/MEMORY.md');
    expect(merged).toContain('- from A');
    expect(merged).toContain('- from B');
  });

  it('propagates deletions', async () => {
    const a = device('a');
    const b = device('b');
    await write(a, 'CLAUDE.md', 'x');
    await write(a, 'old.md', 'delete me');
    await sync(a);
    await sync(b);

    await fs.rm(path.join(a.claude, 'old.md'));
    await sync(a);
    expect(remoteFiles()).not.toContain('old.md');

    await sync(b);
    expect(await read(b, 'old.md')).toBeNull();
  });

  it('stops on a real conflict without touching ~/.claude, then resolves with prefer', async () => {
    const a = device('a');
    const b = device('b');
    await write(a, 'CLAUDE.md', 'base');
    await sync(a);
    await sync(b);

    await write(a, 'CLAUDE.md', 'edit A');
    await sync(a);
    await write(b, 'CLAUDE.md', 'edit B');

    const conflicted = await sync(b);
    expect(conflicted.success).toBe(false);
    expect(conflicted.conflicts.map((c) => c.filePath)).toEqual(['CLAUDE.md']);
    expect(await read(b, 'CLAUDE.md')).toBe('edit B');

    const resolved = await sync(b, true, 'local');
    expect(resolved.success).toBe(true);
    expect(await read(b, 'CLAUDE.md')).toBe('edit B');
    await sync(a);
    expect(await read(a, 'CLAUDE.md')).toBe('edit B');
  });

  it('never pushes credentials and purges ones that older versions committed', async () => {
    const a = device('a');
    await write(a, 'CLAUDE.md', 'x');
    await write(a, '.credentials.json', '{"token":"secret"}');
    await write(a, 'shell-snapshots/s.sh', 'export TOKEN=1');
    await sync(a);
    expect(remoteFiles()).toEqual(['CLAUDE.md']);
  });

  it('removes credentials that an older version already pushed', async () => {
    const a = device('a');
    await write(a, 'CLAUDE.md', 'x');
    await sync(a);
    const repo = path.join(tmp, 'a', 'repo');
    await fs.writeFile(path.join(repo, '.credentials.json'), '{"token":"old-leak"}');
    execFileSync('git', ['-C', repo, 'add', '-f', '.credentials.json']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'old version leak']);
    // Simulates an old release; local pre-push secret scanners would rightly block this.
    execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main']);
    expect(remoteFiles()).toContain('.credentials.json');

    await write(a, 'CLAUDE.md', 'y');
    await sync(a);
    expect(remoteFiles()).toEqual(['CLAUDE.md']);
  });

  it('keeps unpushed edits on a device upgrading from a version without a last-sync marker', async () => {
    const a = device('a');
    await write(a, 'CLAUDE.md', 'synced by 1.0');
    await write(a, 'notes.md', 'n1');
    await sync(a);
    const repo = path.join(tmp, 'a', 'repo');
    // Repos created by versions before 1.1 have neither marker.
    execFileSync('git', ['-C', repo, 'update-ref', '-d', 'refs/claude-sync/last-sync']);

    const b = device('b');
    await sync(b);
    await write(b, 'notes.md', 'n2 from B');
    await sync(b);

    await write(a, 'CLAUDE.md', 'edited after the last 1.0 sync');
    const result = await sync(a);
    expect(result.success).toBe(true);
    expect(await read(a, 'CLAUDE.md')).toBe('edited after the last 1.0 sync');
    expect(await read(a, 'notes.md')).toBe('n2 from B');
  });

  it('never reports credentials from the remote URL in errors', async () => {
    expect(redactCredentials('fatal: unable to access https://rene:s3cret@gitea.example/x.git')).toBe(
      'fatal: unable to access https://***@gitea.example/x.git'
    );
    const root = path.join(tmp, 'leaky');
    await fs.mkdir(path.join(root, 'claude'), { recursive: true });
    const engine = new GitSync(path.join(root, 'repo'), 'http://rene:s3cret@127.0.0.1:9/x.git', 'main', 'gitea');
    await engine.sync(path.join(root, 'claude'), true, { heldDir: path.join(root, 'held') });
    await fs.writeFile(path.join(root, 'claude', 'CLAUDE.md'), 'x');
    const result = await engine.sync(path.join(root, 'claude'), true, { heldDir: path.join(root, 'held') });
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('s3cret');
  });

  it('holds a remotely changed settings.json instead of applying it', async () => {
    const a = device('a');
    const b = device('b');
    await write(a, 'settings.json', '{}');
    await sync(a);

    // Even a new device only receives settings.json after accepting it.
    const first = await sync(b);
    expect(first.held).toEqual(['settings.json']);
    expect(await read(b, 'settings.json')).toBeNull();
    await applyHeld(b.held, b.claude);
    expect(await read(b, 'settings.json')).toBe('{}');

    await write(a, 'settings.json', '{"hooks":{"SessionStart":[{"command":"evil"}]}}');
    await sync(a);

    const pulled = await sync(b, false);
    expect(pulled.held).toEqual(['settings.json']);
    expect(await read(b, 'settings.json')).toBe('{}');
    expect(await fs.readFile(path.join(b.held, 'settings.json'), 'utf-8')).toContain('evil');

    // The held file is not pushed back as a revert by the next sync.
    await sync(b);
    await sync(a);
    expect(await read(a, 'settings.json')).toContain('evil');
  });
});
