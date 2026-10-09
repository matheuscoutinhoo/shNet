import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import type { Database } from './db';
import type { Mailer } from './mailer';
import {
  COOKIE,
  checkCsrf,
  csrf,
  currentUser,
  digest,
  error,
  sessionCookie,
  token,
  type User,
} from './security';
const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());
const password = z.string().min(12, 'A senha deve ter pelo menos 12 caracteres').max(128);
const hash = (s: string) =>
  argon2.hash(s, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
interface AuthOptions {
  db: Database;
  mailer?: Mailer;
  origin: string;
  production: boolean;
}
export async function registerAuth(app: FastifyInstance, { db, mailer, origin, production }: AuthOptions) {
  const dummy = await hash(token());
  const sensitive = { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } };
  app.get('/api/auth/capabilities', async () => ({ emailEnabled: Boolean(mailer) }));
  const send = async (user: User, purpose: 'verify' | 'reset') => {
    if (!mailer) throw error(503, 'Envio de e-mail desativado nesta instalação.');
    const value = token();
    await db.query('DELETE FROM auth_tokens WHERE user_id=$1 AND purpose=$2', [user.id, purpose]);
    await db.query(
      'INSERT INTO auth_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,now()+$4::interval)',
      [digest(value), user.id, purpose, purpose === 'verify' ? '24 hours' : '30 minutes']
    );
    const link = origin + '/?action=' + purpose + '#token=' + value;
    await mailer({
      to: user.email,
      subject: purpose === 'verify' ? 'Verifique seu e-mail · shLab' : 'Redefina sua senha · shLab',
      text:
        'Olá ' +
        user.name +
        '.\n\n' +
        (purpose === 'verify' ? 'Confirme seu endereço de e-mail' : 'Redefina sua senha') +
        ':\n' +
        link +
        '\n\nSe não solicitou esta ação, ignore esta mensagem.',
    });
  };
  app.post('/api/auth/register', sensitive, async (req, reply) => {
    const body = z
      .object({ name: z.string().trim().min(2).max(80), email, password })
      .strict()
      .parse(req.body);
    const passwordHash = await hash(body.password);
    const users = await db.query<User>(
      'INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING RETURNING id,email,name,verified',
      [randomUUID(), body.email, body.name, passwordHash]
    );
    if (mailer && users[0]) await send(users[0], 'verify');
    return reply.code(202).send({
      message: mailer
        ? 'Se o endereço puder ser cadastrado, enviaremos um e-mail de verificação.'
        : 'Se o endereço estiver disponível, sua conta foi criada. Entre com seu e-mail e senha.',
    });
  });
  app.post('/api/auth/login', sensitive, async (req, reply) => {
    const body = z
      .object({ email, password: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    const user = (
      await db.query<User & { password_hash: string; locked_until: Date | null }>(
        'SELECT * FROM users WHERE email=$1',
        [body.email]
      )
    )[0];
    const valid = await argon2.verify(user?.password_hash ?? dummy, body.password);
    if (!user || !valid || (user.locked_until && new Date(user.locked_until).getTime() > Date.now())) {
      if (user)
        await db.query(
          "UPDATE users SET failed_login=failed_login+1,locked_until=CASE WHEN failed_login>=7 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1",
          [user.id]
        );
      req.log.info({ event: 'auth.login_failed' }, 'Login recusado');
      throw error(401, 'E-mail ou senha inválidos. Aguarde se excedeu as tentativas.');
    }
    if (mailer && !user.verified) throw error(403, 'Verifique seu e-mail antes de entrar.');
    const value = token();
    await db.transaction(async (tx) => {
      const latest = (
        await tx.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [
          user.id,
        ])
      )[0];
      if (latest.password_hash !== user.password_hash)
        throw error(401, 'Credenciais alteradas. Entre novamente.');
      await tx.query('UPDATE users SET failed_login=0,locked_until=NULL WHERE id=$1', [user.id]);
      if (req.cookies[COOKIE])
        await tx.query('DELETE FROM sessions WHERE token_hash=$1', [digest(req.cookies[COOKIE]!)]);
      await tx.query(
        "INSERT INTO sessions(token_hash,user_id,expires_at,user_agent) VALUES($1,$2,now()+interval '7 days',$3)",
        [digest(value), user.id, String(req.headers['user-agent'] ?? '').slice(0, 300)]
      );
      await tx.query('DELETE FROM sessions WHERE expires_at<=now()');
    });
    sessionCookie(reply, value, production);
    req.log.info({ event: 'auth.login', userId: user.id }, 'Sessão criada');
    return {
      user: { id: user.id, email: user.email, name: user.name, verified: user.verified },
      csrfToken: csrf(value),
    };
  });
  app.get('/api/auth/me', async (req) => {
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Entre para continuar');
    return { user, csrfToken: csrf(req.cookies[COOKIE]!) };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    checkCsrf(req);
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [digest(req.cookies[COOKIE]!)]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.patch('/api/auth/profile', async (req) => {
    checkCsrf(req);
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Sessão expirada');
    const body = z
      .object({ name: z.string().trim().min(2).max(80) })
      .strict()
      .parse(req.body);
    return (
      await db.query<User>('UPDATE users SET name=$1 WHERE id=$2 RETURNING id,email,name,verified', [
        body.name,
        user.id,
      ])
    )[0];
  });
  app.get('/api/auth/sessions', async (req) => {
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Sessão expirada');
    return db.query(
      'SELECT id,user_agent,created_at,expires_at,(token_hash=$2) AS is_current FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC',
      [user.id, digest(req.cookies[COOKIE]!)]
    );
  });
  app.delete('/api/auth/sessions/:id', async (req, reply) => {
    checkCsrf(req);
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Sessão expirada');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const removed = (
      await db.query<{ is_current: boolean }>(
        'DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING token_hash=$3 AS is_current',
        [id, user.id, digest(req.cookies[COOKIE]!)]
      )
    )[0];
    if (!removed) throw error(404, 'Sessão não encontrada');
    if (removed.is_current) reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true, current: removed.is_current };
  });
  app.post('/api/auth/sessions/revoke-others', async (req) => {
    checkCsrf(req);
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Sessão expirada');
    await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [
      user.id,
      digest(req.cookies[COOKIE]!),
    ]);
    return { ok: true };
  });
  app.delete('/api/auth/account', sensitive, async (req, reply) => {
    checkCsrf(req);
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Sessão expirada');
    const body = z
      .object({ password: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    await db.transaction(async (tx) => {
      const row = (
        await tx.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [
          user.id,
        ])
      )[0];
      if (!row || !(await argon2.verify(row.password_hash, body.password)))
        throw error(400, 'Senha incorreta');
      await tx.query('DELETE FROM users WHERE id=$1', [user.id]);
    });
    reply.clearCookie(COOKIE, { path: '/' });
    req.log.info({ event: 'auth.account_deleted', userId: user.id }, 'Conta excluída');
    return { ok: true };
  });
  app.post('/api/auth/forgot-password', sensitive, async (req) => {
    if (!mailer) throw error(503, 'Envio de e-mail desativado nesta instalação.');
    const body = z.object({ email }).strict().parse(req.body);
    const user = (
      await db.query<User>('SELECT id,email,name,verified FROM users WHERE email=$1', [body.email])
    )[0];
    if (user) await send(user, 'reset');
    return { message: 'Se o endereço estiver cadastrado, enviaremos as instruções.' };
  });
  app.post('/api/auth/request-verification', sensitive, async (req) => {
    if (!mailer) throw error(503, 'Envio de e-mail desativado nesta instalação.');
    const body = z.object({ email }).strict().parse(req.body);
    const user = (
      await db.query<User>('SELECT id,email,name,verified FROM users WHERE email=$1', [body.email])
    )[0];
    if (user && !user.verified) await send(user, 'verify');
    return { message: 'Se necessário, enviaremos um novo link de verificação.' };
  });
  app.post('/api/auth/verify-email', sensitive, async (req) => {
    const body = z
      .object({ token: z.string().min(40).max(100) })
      .strict()
      .parse(req.body);
    await db.transaction(async (tx) => {
      const row = (
        await tx.query<{ user_id: string }>(
          "DELETE FROM auth_tokens WHERE token_hash=$1 AND purpose='verify' AND expires_at>now() RETURNING user_id",
          [digest(body.token)]
        )
      )[0];
      if (!row) throw error(400, 'Link inválido ou expirado');
      await tx.query('UPDATE users SET verified=true WHERE id=$1', [row.user_id]);
    });
    return { message: 'E-mail verificado. Você já pode entrar.' };
  });
  app.post('/api/auth/reset-password', sensitive, async (req, reply) => {
    const body = z
      .object({ token: z.string().min(40).max(100), password })
      .strict()
      .parse(req.body);
    const passwordHash = await hash(body.password);
    await db.transaction(async (tx) => {
      const row = (
        await tx.query<{ user_id: string }>(
          "DELETE FROM auth_tokens WHERE token_hash=$1 AND purpose='reset' AND expires_at>now() RETURNING user_id",
          [digest(body.token)]
        )
      )[0];
      if (!row) throw error(400, 'Link inválido ou expirado');
      await tx.query('UPDATE users SET password_hash=$1,failed_login=0,locked_until=NULL WHERE id=$2', [
        passwordHash,
        row.user_id,
      ]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [row.user_id]);
    });
    reply.clearCookie(COOKIE, { path: '/' });
    return { message: 'Senha atualizada. Entre novamente.' };
  });
  app.post('/api/auth/change-password', sensitive, async (req, reply) => {
    checkCsrf(req);
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Sessão expirada');
    const body = z
      .object({ currentPassword: z.string().max(128), password })
      .strict()
      .parse(req.body);
    await db.transaction(async (tx) => {
      const row = (
        await tx.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [
          user.id,
        ])
      )[0];
      if (!(await argon2.verify(row.password_hash, body.currentPassword)))
        throw error(400, 'Senha atual incorreta');
      await tx.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await hash(body.password), user.id]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    });
    reply.clearCookie(COOKIE, { path: '/' });
    return { message: 'Senha alterada. Todas as sessões foram encerradas.' };
  });
}
