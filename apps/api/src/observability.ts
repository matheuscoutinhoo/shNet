import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Database } from './db';
export function registerObservability(
  app: FastifyInstance,
  db: Database,
  options: { metricsToken?: string; backupFile?: string; notificationReady: () => boolean }
) {
  const started = Date.now(),
    requests = new Map<string, { count: number; seconds: number; buckets: number[] }>(),
    began = new WeakMap<object, number>();
  const limits = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  app.addHook('onRequest', async (req) => {
    began.set(req, performance.now());
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? '/unmatched';
    if (['/api/metrics', '/api/live', '/api/ready', '/api/health'].includes(route)) return;
    const labels = `method="${req.method}",route="${route.replaceAll('"', '')}",status="${reply.statusCode}"`;
    const value = requests.get(labels) ?? { count: 0, seconds: 0, buckets: limits.map(() => 0) },
      elapsed = (performance.now() - (began.get(req) ?? performance.now())) / 1000;
    value.count++;
    value.seconds += elapsed;
    limits.forEach((limit, i) => {
      if (elapsed <= limit) value.buckets[i]++;
    });
    requests.set(labels, value);
  });
  const ready = async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        db.query('SELECT 1'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Readiness timeout')), 2000);
          timer.unref();
        }),
      ]);
      return options.notificationReady();
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  app.get('/api/live', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  for (const path of ['/api/ready', '/api/health'])
    app.get(path, { config: { rateLimit: false } }, async (_, reply) => {
      const ok = await ready();
      return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable' });
    });
  app.get('/api/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    if (!options.metricsToken) return reply.code(404).send({ message: 'Rota não encontrada' });
    const expected = Buffer.from('Bearer ' + options.metricsToken),
      provided = Buffer.from(req.headers.authorization ?? '');
    if (provided.length !== expected.length || !timingSafeEqual(expected, provided))
      return reply.code(401).send({ message: 'Acesso inválido' });
    const lines = [
      '# TYPE shlab_ready gauge',
      `shlab_ready ${Number(await ready())}`,
      '# TYPE shlab_notification_connected gauge',
      `shlab_notification_connected ${Number(options.notificationReady())}`,
      '# TYPE shlab_uptime_seconds gauge',
      `shlab_uptime_seconds ${(Date.now() - started) / 1000}`,
      '# TYPE shlab_process_resident_memory_bytes gauge',
      `shlab_process_resident_memory_bytes ${process.memoryUsage().rss}`,
      '# TYPE shlab_http_requests_total counter',
      '# TYPE shlab_http_duration_seconds histogram',
    ];
    for (const [labels, value] of requests) {
      lines.push(
        `shlab_http_requests_total{${labels}} ${value.count}`,
        `shlab_http_duration_seconds_sum{${labels}} ${value.seconds}`,
        `shlab_http_duration_seconds_count{${labels}} ${value.count}`
      );
      limits.forEach((limit, i) =>
        lines.push(`shlab_http_duration_seconds_bucket{${labels},le="${limit}"} ${value.buckets[i]}`)
      );
      lines.push(`shlab_http_duration_seconds_bucket{${labels},le="+Inf"} ${value.count}`);
    }
    if (options.backupFile) {
      let at = 0;
      try {
        const info = JSON.parse(await readFile(options.backupFile, 'utf8')),
          date = Date.parse(info.completedAt);
        if (
          info.version === 1 &&
          Number.isFinite(date) &&
          date <= Date.now() &&
          info.bytes > 36 &&
          /^[a-f0-9]{64}$/.test(info.sha256)
        )
          at = date / 1000;
      } catch {
        /* No successful backup is represented by zero. */
      }
      lines.push(
        '# TYPE shlab_backup_last_success_timestamp_seconds gauge',
        `shlab_backup_last_success_timestamp_seconds ${at}`
      );
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
  });
}
