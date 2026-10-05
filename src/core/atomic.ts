import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Writes via a temp file and rename, so a crash never leaves a half-written file. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, file);
}
