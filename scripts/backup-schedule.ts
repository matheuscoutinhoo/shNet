import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { backupDatabase, backupKey } from './backup';
import { publishBackupStatus } from './backup-status';
const key = backupKey(process.env.BACKUP_KEY),
  address = process.env.DATABASE_URL;
if (!address) throw new Error('DATABASE_URL obrigatória.');
const directory = resolve(process.env.BACKUP_DIRECTORY ?? '/backups'),
  interval = Number(process.env.BACKUP_INTERVAL_HOURS ?? '24'),
  retention = Number(process.env.BACKUP_RETENTION_DAYS ?? '30');
if (
  !Number.isFinite(interval) ||
  interval < 1 ||
  interval > 168 ||
  !Number.isInteger(retention) ||
  retention < 2 ||
  retention > 365
)
  throw new Error('Intervalo 1..168 h; retenção 2..365 dias.');
await mkdir(directory, { recursive: true, mode: 0o700 });
let stopped = false,
  running = false;
process.on('SIGTERM', () => {
  stopped = true;
});
process.on('SIGINT', () => {
  stopped = true;
});
async function run() {
  if (running) return;
  running = true;
  try {
    const destination = join(
      directory,
      'shlab-' + new Date().toISOString().replaceAll(':', '-') + '.shlab-backup'
    );
    const report = await backupDatabase(address!, destination, key),
      status = process.env.BACKUP_STATUS_FILE ?? join(directory, 'status.json');
    await publishBackupStatus(status, report);
    // Only this scheduler's completed archives are eligible for retention.
    for (const filename of await readdir(directory))
      if (
        /^(?:shlab-\d{4}-\d{2}-\d{2}T[\d.-]+Z\.shlab-backup|shnet-\d{4}-\d{2}-\d{2}T[\d.-]+Z\.shnet-backup)$/.test(
          filename
        )
      ) {
        const file = join(directory, filename);
        let metadata;
        try {
          metadata = JSON.parse(await readFile(file + '.json', 'utf8'));
        } catch {
          continue;
        }
        if (metadata.version === 1 && Date.parse(metadata.completedAt) < Date.now() - retention * 86400000) {
          await rm(file);
          await rm(file + '.json');
        }
      }
    process.stdout.write(JSON.stringify({ event: 'backup.success', ...report }) + '\n');
  } catch {
    process.stderr.write(JSON.stringify({ event: 'backup.failed', at: new Date().toISOString() }) + '\n');
  } finally {
    running = false;
  }
}
await run();
const timer = setInterval(() => {
  if (stopped) {
    clearInterval(timer);
    return;
  }
  void run();
}, interval * 3600000);
const shutdown = setInterval(() => {
  if (stopped) {
    clearInterval(timer);
    clearInterval(shutdown);
  }
}, 1000);
