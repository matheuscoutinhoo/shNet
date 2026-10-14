import { createHash } from 'node:crypto';
import { connect } from 'node:tls';
import { mkdir, writeFile } from 'node:fs/promises';
const origin = new URL(process.env.SHLAB_REMOTE_ORIGIN ?? 'https://shnet.up.railway.app');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/')
  throw new Error('Use uma origem HTTPS sem credenciais ou caminho.');
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/application-completion-2026-10-13';
const certificate = await new Promise((resolve, reject) => {
  const socket = connect(
    {
      host: origin.hostname,
      port: Number(origin.port || 443),
      servername: origin.hostname,
      rejectUnauthorized: true,
    },
    () => {
      const c = socket.getPeerCertificate();
      resolve({
        authorized: socket.authorized,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher().name,
        validFrom: c.valid_from,
        validTo: c.valid_to,
      });
      socket.end();
    }
  );
  socket.setTimeout(15000, () => socket.destroy(new Error('Timeout TLS.')));
  socket.on('error', reject);
});
const responses = [];
for (const path of ['/', '/api/health', '/api/build', '/api/projects', '/api/metrics']) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(20000) }),
    body = await response.text();
  if (!response.headers.get('strict-transport-security')) throw new Error('HSTS ausente.');
  if (response.headers.get('x-content-type-options') !== 'nosniff') throw new Error('nosniff ausente.');
  if (['/', '/api/health', '/api/build'].includes(path) && response.status !== 200)
    throw new Error(path + ' indisponível.');
  if (['/api/projects', '/api/metrics'].includes(path) && ![401, 403, 404].includes(response.status))
    throw new Error(path + ' exposto sem autorização.');
  responses.push({
    path,
    status: response.status,
    headers: {
      hsts: response.headers.get('strict-transport-security'),
      csp: response.headers.get('content-security-policy'),
    },
    body: path === '/api/build' ? JSON.parse(body) : undefined,
    html: path === '/' ? body : undefined,
  });
}
const build = responses.find((r) => r.path === '/api/build')!.body;
if (process.env.SHLAB_EXPECT_ENGINE_BUILD && build.engineBuild !== process.env.SHLAB_EXPECT_ENGINE_BUILD)
  throw new Error('O ambiente ainda não executa a fonte esperada.');
const assets = new Map<string, { sha256: string; bytes: number }>(),
  pending = [...responses[0].html!.matchAll(/(?:src|href)="(\/assets\/[^" ]+\.(?:js|css))"/g)].map(
    (m) => m[1]
  );
let artifact: string | undefined;
while (pending.length) {
  const path = pending.shift()!;
  if (assets.has(path)) continue;
  if (assets.size >= 100) throw new Error('Grafo de assets excedeu 100 arquivos.');
  const r = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('Asset indisponível: ' + path);
  const bytes = Buffer.from(await r.arrayBuffer()),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  assets.set(path, { sha256, bytes: bytes.length });
  if (/scenario\.worker-/.test(path)) artifact = sha256;
  if (path.endsWith('.js'))
    for (const m of bytes
      .toString()
      .matchAll(/(?:["'`])(?:\.\/|\/assets\/|assets\/)?([\w.-]+-[\w-]+\.js)(?:["'`])/g))
      pending.push('/assets/' + m[1]);
}
if (!artifact || artifact !== build.workerArtifact) {
  console.error(JSON.stringify({ assets: [...assets.keys()], artifact, expected: build.workerArtifact }));
  throw new Error('O Worker remoto não corresponde à identidade anunciada.');
}
await mkdir(out, { recursive: true });
const result = {
  generatedAt: new Date().toISOString(),
  origin: origin.origin,
  certificate,
  responses: responses.map(({ html, ...r }) => {
    void html;
    return r;
  }),
  assets: Object.fromEntries(assets),
  workerMatched: true,
  scope:
    'Somente leitura: TLS público, headers, readiness do banco, controle de acesso e bytes publicados. Não valida backup nem rollback do Railway.',
};
await writeFile(out + '/remote-release.json', JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({ origin: origin.origin, build, assets: assets.size, workerMatched: true, tls: true })
);
