import { createHash } from 'node:crypto';
import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import type { Database } from './db';
export function sharedRateLimitStore(db: Database): FastifyRateLimitStoreCtor {
  return class PostgresRateLimit implements FastifyRateLimitStore {
    private prefix = 'global';
    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number
    ) {
      const id = createHash('sha256')
        .update(this.prefix + '\0' + key)
        .digest('hex');
      void db
        .query<{ current: number; ttl: string }>(
          `INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,clock_timestamp()+$2::double precision*interval '1 millisecond')
        ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<=clock_timestamp() THEN 1 ELSE CASE WHEN rate_limits.count>=2147483646 THEN 2147483647 ELSE rate_limits.count+1 END END,
        expires_at=CASE WHEN rate_limits.expires_at<=clock_timestamp() THEN clock_timestamp()+$2::double precision*interval '1 millisecond' ELSE rate_limits.expires_at END
        RETURNING count AS current,GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))*1000)::text AS ttl`,
          [id, timeWindow]
        )
        .then(([row]) => callback(null, { current: row.current, ttl: Math.ceil(Number(row.ttl)) }))
        .catch((error: Error) => callback(error));
    }
    child(options: {
      path?: string;
      prefix?: string;
      routeInfo?: { method: string | string[]; url: string };
      max?: number;
      timeWindow?: unknown;
    }) {
      const child = new PostgresRateLimit();
      const route = options.routeInfo;
      child.prefix = route
        ? JSON.stringify([route.method, route.url])
        : JSON.stringify(['manual', options.path, options.prefix, options.max, options.timeWindow]);
      return child;
    }
  };
}
