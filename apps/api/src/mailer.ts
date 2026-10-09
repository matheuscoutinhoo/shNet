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
export function createMailer(env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  const production = env.NODE_ENV === 'production';
  const provider = env.MAIL_PROVIDER ?? (env.SMTP_HOST ? 'smtp' : production ? 'none' : 'local');
  if (!['smtp', 'local', 'none'].includes(provider)) throw new Error('MAIL_PROVIDER inválido.');
  if (provider === 'none') return undefined;
  if (provider === 'smtp') {
    if (!env.SMTP_HOST) throw new Error('SMTP_HOST obrigatório para SMTP.');
    if (production && !env.MAIL_FROM) throw new Error('MAIL_FROM obrigatório para SMTP em produção.');
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
  if (production) throw new Error('E-mail local não é permitido em produção.');
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
