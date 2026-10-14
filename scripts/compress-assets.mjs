import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';
import console from 'node:console';
const root = resolve(import.meta.dirname, '../apps/web/dist'),
  br = promisify(brotliCompress),
  gz = promisify(gzip);
const files = await readdir(root + '/assets');
let raw = 0,
  compressed = 0;
for (const file of files.filter((f) => /\.(js|css)$/.test(f))) {
  const path = root + '/assets/' + file,
    bytes = await readFile(path);
  const [b, g] = await Promise.all([
    br(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
    gz(bytes, { level: 9 }),
  ]);
  await Promise.all([writeFile(path + '.br', b), writeFile(path + '.gz', g)]);
  raw += bytes.length;
  compressed += b.length;
}
console.log(
  JSON.stringify({
    precompressedAssets: files.filter((f) => /\.(js|css)$/.test(f)).length,
    rawBytes: raw,
    brotliBytes: compressed,
  })
);
