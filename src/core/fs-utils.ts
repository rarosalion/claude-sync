import fs from 'node:fs/promises';

/**
 * Copy a file, replacing the destination even when it is read-only.
 * Git writes pack and object files as 0444, so a plain copyFile onto an
 * existing one fails with EACCES. Removing the destination first is allowed
 * because unlinking only needs write access to the parent directory.
 */
export async function copyFileOverwrite(src: string, dest: string): Promise<void> {
  try {
    await fs.copyFile(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
    await fs.rm(dest, { force: true });
    await fs.copyFile(src, dest);
  }
}
