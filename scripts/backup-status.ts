import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { backupDatabase } from './backup';

export async function publishBackupStatus(path: string, report: Awaited<ReturnType<typeof backupDatabase>>) {
  // Only non-secret success metadata is shared with the application user.
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const partial = path + '.' + randomBytes(8).toString('hex') + '.partial';
  try {
    await writeFile(partial, JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o644 });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}
