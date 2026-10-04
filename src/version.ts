import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageVersion(): string {
  // dist/src/version.js and src/version.ts both sit two levels below the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string; version?: string };
      if (pkg.name === 'claude-sync' && pkg.version) return pkg.version;
    } catch {
      continue;
    }
  }
  return '0.0.0';
}

/** Package version from package.json. */
export const VERSION = readPackageVersion();
