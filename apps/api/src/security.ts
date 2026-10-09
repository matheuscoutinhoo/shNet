import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './db';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const csrf = (session: string) => createHmac('sha256', session).update('shlab-csrf-v1').digest('hex');
export const COOKIE = 'shlab_session';
export interface User {
  id: string;
  email: string;
  name: string;
  verified: boolean;
}
export function error(status: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: status });
}
export function sessionCookie(reply: FastifyReply, value: string, production: boolean) {
  reply.setCookie(COOKIE, value, {
    httpOnly: true,
    secure: production,
    sameSite: 'strict',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
}
export async function currentUser(db: Database, request: FastifyRequest): Promise<User | undefined> {
  const raw = request.cookies[COOKIE];
  if (!raw) return;
  return (
    await db.query<User>(
      'SELECT u.id,u.email,u.name,u.verified FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()',
      [digest(raw)]
    )
  )[0];
}
export function checkOrigin(request: FastifyRequest, origin: string) {
  if (request.headers.origin !== origin) throw error(403, 'Origem não autorizada');
}
export function checkCsrf(request: FastifyRequest) {
  const raw = request.cookies[COOKIE],
    provided = request.headers['x-csrf-token'];
  if (!raw || typeof provided !== 'string') throw error(403, 'Token CSRF ausente');
  const expected = csrf(raw),
    a = Buffer.from(expected),
    b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw error(403, 'Token CSRF inválido');
}
