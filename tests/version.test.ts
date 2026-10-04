/**
 * VERSION in src/index.ts is a separate literal from package.json's "version" (it drifted once
 * already). Releases rewrite both via .releaserc.json, and this test catches any hand edit that
 * lets them diverge.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf-8');
    const match = /^export const VERSION = '([^']+)';$/m.exec(source);
    expect(match?.[1]).toBe(pkg.version);
  });
});
