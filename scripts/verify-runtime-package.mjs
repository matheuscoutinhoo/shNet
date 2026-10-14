import { readFile, mkdir, cp, symlink, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import process from 'node:process';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/application-stability-2026-10-13';
const base = resolve('.data'),
  target = resolve(base, 'runtime-smoke-' + Date.now());
if (!target.startsWith(base + sep) || !/^runtime-smoke-\d+$/.test(target.slice(base.length + 1)))
  throw new Error('Destino de smoke inválido.');
const dockerfile = await readFile('Dockerfile', 'utf8'),
  runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:24-bookworm-slim AS runtime'));
const files = [
  'package.json',
  'package-lock.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'packages/simulation-engine/package.json',
];
const directories = [
  'apps/api/src',
  'apps/api/migrations',
  'packages/simulation-engine/src',
  'apps/web/dist',
];
// Copy the declared runtime sources, without the repository or development scripts.
for (const line of runtime.split('\n').filter((line) => line.startsWith('COPY --from=build'))) {
  const matches = line.match(/\/app\/[\w./-]+/g) ?? [];
  for (const match of matches) {
    const path = match.slice(5);
    if (!directories.includes(path) && !files.includes(path)) files.push(path);
  }
}
await mkdir(target, { recursive: true });
let db, app;
const result = {
  passed: false,
  dockerEngine: 'not executed; isolated filesystem package using Dockerfile runtime COPY declarations',
  files,
  directories,
};
try {
  for (const file of files) {
    const dest = resolve(target, file);
    await mkdir(resolve(dest, '..'), { recursive: true });
    await cp(resolve(file), dest);
  }
  for (const directory of directories)
    await cp(resolve(directory), resolve(target, directory), { recursive: true });
  await symlink(resolve('node_modules'), resolve(target, 'node_modules'), 'junction');
  const database = await tsImport(pathToFileURL(resolve(target, 'apps/api/src/db.ts')).href, import.meta.url),
    server = await tsImport(pathToFileURL(resolve(target, 'apps/api/src/app.ts')).href, import.meta.url);
  db = await database.createEmbedded();
  await database.migrate(db);
  app = await server.buildApp({ db, origin: 'http://127.0.0.1:5209', mailer: async () => {} });
  const response = await app.inject('/api/build');
  if (response.statusCode !== 200) throw new Error(response.body);
  const build = response.json(),
    expected = JSON.parse(await readFile(out + '/built-application-ui.json', 'utf8'));
  if (
    build.engineBuild !== expected.build.engineBuild ||
    build.workerArtifact !== expected.build.workerArtifactHash ||
    build.schemaVersion !== 11
  )
    throw new Error('Origem/artefato divergente no runtime empacotado.');
  const migrations = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  if (migrations.length !== 11) throw new Error('Migrações incompletas no pacote.');
  result.build = build;
  result.migrations = migrations.map((m) => m.version);
  result.passed = true;
} finally {
  await app?.close();
  await db?.close();
  await rm(target, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(out + '/runtime-package.json', JSON.stringify(result, null, 2));
}
process.stdout.write(JSON.stringify(result) + '\n');
