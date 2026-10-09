import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

export const runtimePaths = {
  web: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
  embedded: fileURLToPath(new URL('../../../.data/postgres', import.meta.url)),
};

export function runtimeConfig(env: NodeJS.ProcessEnv) {
  const production = env.NODE_ENV === 'production';
  if (env.METRICS_TOKEN && env.METRICS_TOKEN.length < 32)
    throw new Error('METRICS_TOKEN exige pelo menos 32 caracteres.');
  const embedded = env.DATABASE_MODE === 'embedded';
  if (production && (embedded || !env.DATABASE_URL))
    throw new Error('Produção exige DATABASE_URL PostgreSQL e DATABASE_MODE=server.');
  if (!embedded && !env.DATABASE_URL) throw new Error('Defina DATABASE_URL ou DATABASE_MODE=embedded.');
  const configuredOrigin =
    env.APP_ORIGIN ?? (env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + env.RAILWAY_PUBLIC_DOMAIN : undefined);
  let origin: URL;
  try {
    origin = new URL(configuredOrigin ?? 'http://127.0.0.1:5173');
  } catch {
    throw new Error('APP_ORIGIN deve ser uma origem HTTP/HTTPS válida.');
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (production && origin.protocol !== 'https:')
  )
    throw new Error('APP_ORIGIN deve conter apenas a origem; HTTPS é obrigatório em produção.');
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
  const trustedProxies =
    env.TRUSTED_PROXY_CIDRS?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];
  for (const value of trustedProxies) {
    const parts = value.split('/');
    const family = isIP(parts[0]);
    const prefix = parts[1] === undefined ? undefined : Number(parts[1]);
    if (
      !family ||
      parts.length > 2 ||
      (prefix !== undefined &&
        (!Number.isInteger(prefix) || prefix < 1 || prefix > (family === 4 ? 32 : 128)))
    )
      throw new Error('TRUSTED_PROXY_CIDRS exige IPs/CIDRs explícitos, sem redes /0.');
  }
  return {
    production,
    embedded,
    origin: origin.origin,
    port,
    trustedProxies,
    host: env.HOST ?? (production ? '::' : '127.0.0.1'),
  };
}
