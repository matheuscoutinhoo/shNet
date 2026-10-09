import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export interface Mail {
  to: string;
  subject: string;
  text: string;
}
export type Mailer = (mail: Mail) => Promise<void>;
export function createMailer(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): Mailer {
  const production = env.NODE_ENV === 'production';
  const provider = env.MAIL_PROVIDER ?? (env.SMTP_HOST ? 'smtp' : 'local');
  if (!['smtp', 'resend', 'local'].includes(provider)) throw new Error('MAIL_PROVIDER inválido.');
  if (production && !env.MAIL_FROM) throw new Error('MAIL_FROM obrigatório em produção.');
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error('Resend exige RESEND_API_KEY e MAIL_FROM.');
    return async (mail) => {
      const response = await request('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Falha no provedor de e-mail (HTTP ' + response.status + ').');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string')
        throw new Error('Resposta inválida do provedor de e-mail.');
    };
  }
  if (provider === 'smtp') {
    if (!env.SMTP_HOST) throw new Error('SMTP_HOST obrigatório para SMTP.');
    const secure = env.SMTP_SECURE === 'true';
    const port = Number(env.SMTP_PORT ?? (secure ? 465 : production ? 587 : 1025));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT inválida.');
    if (env.SMTP_USER && !env.SMTP_PASSWORD) throw new Error('SMTP_PASSWORD obrigatório com SMTP_USER.');
    const smtp = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure,
      requireTLS: production && !secure,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    });
    return async (mail) => {
      await smtp.sendMail({ from: env.MAIL_FROM ?? 'shLab <noreply@shlab.local>', ...mail });
    };
  }
  if (production) throw new Error('Produção exige um provedor de e-mail SMTP ou Resend.');
  return async (mail) => {
    const dir = env.LOCAL_MAIL_DIR
      ? resolve(env.LOCAL_MAIL_DIR)
      : fileURLToPath(new URL('../../../.data/mail', import.meta.url));
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, randomUUID() + '.eml'),
      'To: ' + mail.to + '\nSubject: ' + mail.subject + '\n\n' + mail.text,
      { mode: 0o600 }
    );
  };
}
