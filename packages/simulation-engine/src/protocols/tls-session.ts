import type { z } from 'zod';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { z as schema } from 'zod';
import { tlsMessageSchema, type TlsMessage, type TlsSession, tlsClientConfigSchema } from './tls-model';
import {
  certificateSchema,
  identitySchema,
  trustSchema,
  hashHex,
  hmacHex,
  keyShare,
  deriveSecret,
  sealRecord,
  openRecord,
  verifyCertificate,
  publicKey,
  signText,
  verifyText,
} from './security-crypto';
type Identity = z.infer<typeof identitySchema>;
const text = (s: string) => new TextEncoder().encode(s);
const identityMatches = (i: Identity) => publicKey(i.seed) === i.certificate.publicKey;
function traffic(s: TlsSession) {
  if (!s.master) throw new Error('TLS sem segredo de handshake.');
  return s.master.slice(0, 32);
}
function context(s: TlsSession) {
  if (s.hello.type !== 'ClientHello') throw new Error('TLS sem ClientHello.');
  return s.hello.context + '|' + s.session;
}
export function tlsClientHello(
  session: string,
  secret: string,
  nonce: string,
  binding: string
): { state: TlsSession; message: TlsMessage } {
  const message: TlsMessage = {
    type: 'ClientHello',
    version: 'TLS1.3',
    suite: 'TLS_AES_128_GCM_SHA256',
    session,
    nonce,
    keyShare: keyShare(secret),
    context: binding,
  };
  return { state: { role: 'client', phase: 'HELLO', session, secret, nonce, hello: message }, message };
}
export function tlsServerHello(
  input: TlsMessage,
  secret: string,
  nonce: string,
  identity: Identity,
  binding: string
) {
  const hello = tlsMessageSchema.parse(input);
  if (hello.type !== 'ClientHello' || hello.context !== binding || !identityMatches(identity))
    throw new Error('TLS ClientHello, binding ou identidade inválidos.');
  const share = keyShare(secret),
    transcript = hashHex(
      JSON.stringify(hello) + '|' + JSON.stringify({ session: hello.session, nonce, keyShare: share })
    );
  const master = deriveSecret(secret, hello.keyShare, hello.nonce + '|' + nonce, 'TLS1.3|' + transcript);
  const state: TlsSession = {
    role: 'server',
    phase: 'FINISHED',
    session: hello.session,
    secret,
    nonce,
    hello,
    peerShare: hello.keyShare,
    peerNonce: hello.nonce,
    master,
    transcript,
  };
  const flight = {
    certificate: identity.certificate,
    certificateVerify: signText(identity.seed, 'TLS1.3 server CertificateVerify|' + transcript),
    finished: hmacHex(master, 'server Finished|' + transcript),
  };
  const message: TlsMessage = {
    type: 'ServerHello',
    session: hello.session,
    nonce,
    keyShare: share,
    flight: sealRecord(traffic(state), 1, 0, JSON.stringify(flight), context(state)),
  };
  return { state, message };
}
export function tlsClientFinish(
  s: TlsSession,
  input: TlsMessage,
  config: z.infer<typeof tlsClientConfigSchema>,
  clock: number,
  credentials: { username: string; password?: string },
  mutual: boolean
) {
  const m = tlsMessageSchema.parse(input);
  if (
    m.type !== 'ServerHello' ||
    m.session !== s.session ||
    s.phase !== 'HELLO' ||
    s.hello.type !== 'ClientHello'
  )
    throw new Error('TLS ServerHello incompatível.');
  s.transcript = hashHex(
    JSON.stringify(s.hello) +
      '|' +
      JSON.stringify({ session: m.session, nonce: m.nonce, keyShare: m.keyShare })
  );
  s.master = deriveSecret(s.secret, m.keyShare, s.nonce + '|' + m.nonce, 'TLS1.3|' + s.transcript);
  s.peerShare = m.keyShare;
  s.peerNonce = m.nonce;
  const flight = schema
    .object({
      certificate: certificateSchema,
      certificateVerify: schema.string().regex(/^[a-f0-9]{128}$/),
      finished: schema.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(JSON.parse(openRecord(traffic(s), 1, 0, m.flight, context(s))));
  if (
    !verifyCertificate(flight.certificate, config.trust, clock, 'server', config.serverName) ||
    !verifyText(
      flight.certificate.publicKey,
      'TLS1.3 server CertificateVerify|' + s.transcript,
      flight.certificateVerify
    ) ||
    flight.finished !== hmacHex(s.master, 'server Finished|' + s.transcript)
  )
    throw new Error('TLS certificado, nome, validade, CertificateVerify ou Finished inválidos.');
  s.peerCertificate = flight.certificate;
  if (mutual && (!config.identity || !identityMatches(config.identity)))
    throw new Error('EAP-TLS exige certificado/chave do cliente.');
  const identity = config.identity;
  const body = {
    username: credentials.username,
    ...(!mutual ? { password: credentials.password ?? '' } : {}),
    ...(mutual && identity
      ? {
          certificate: identity.certificate,
          certificateVerify: signText(identity.seed, 'TLS1.3 client CertificateVerify|' + s.transcript),
        }
      : {}),
    finished: hmacHex(s.master, 'client Finished|' + s.transcript),
  };
  s.phase = 'FINISHED';
  return {
    type: 'ClientFinished' as const,
    session: s.session,
    ciphertext: sealRecord(traffic(s), 0, 0, JSON.stringify(body), context(s)),
  };
}
export function tlsServerFinish(
  s: TlsSession,
  input: TlsMessage,
  trust: z.infer<typeof trustSchema>,
  clock: number,
  mutual: boolean,
  authorize: (username: string, password?: string, certificateSubject?: string) => boolean
) {
  const m = tlsMessageSchema.parse(input);
  if (m.type !== 'ClientFinished' || m.session !== s.session || s.phase !== 'FINISHED')
    throw new Error('TLS ClientFinished incompatível.');
  const body = schema
    .object({
      username: schema.string().regex(/^[a-zA-Z0-9_.@-]{1,64}$/),
      password: schema.string().max(64).optional(),
      certificate: certificateSchema.optional(),
      certificateVerify: schema
        .string()
        .regex(/^[a-f0-9]{128}$/)
        .optional(),
      finished: schema.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(JSON.parse(openRecord(traffic(s), 0, 0, m.ciphertext, context(s))));
  if (body.finished !== hmacHex(s.master!, 'client Finished|' + s.transcript))
    throw new Error('TLS client Finished inválido.');
  let valid = true;
  if (mutual)
    valid =
      !!body.certificate &&
      !!body.certificateVerify &&
      verifyCertificate(body.certificate, trust, clock, 'client', body.username) &&
      verifyText(
        body.certificate.publicKey,
        'TLS1.3 client CertificateVerify|' + s.transcript,
        body.certificateVerify
      );
  s.username = body.username;
  s.peerCertificate = body.certificate;
  s.accepted = valid && authorize(body.username, body.password, body.certificate?.subject);
  s.phase = 'RESULT';
  return {
    type: 'ProtectedResult' as const,
    session: s.session,
    ciphertext: sealRecord(
      traffic(s),
      1,
      1,
      JSON.stringify({
        accepted: s.accepted,
        finished: hmacHex(s.master!, 'protected result|' + s.transcript + '|' + s.accepted),
      }),
      context(s)
    ),
  };
}
export function tlsClientResult(s: TlsSession, input: TlsMessage) {
  const m = tlsMessageSchema.parse(input);
  if (m.type !== 'ProtectedResult' || m.session !== s.session || s.phase !== 'FINISHED')
    throw new Error('TLS resultado incompatível.');
  const body = schema
    .object({ accepted: schema.boolean(), finished: schema.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(JSON.parse(openRecord(traffic(s), 1, 1, m.ciphertext, context(s))));
  if (body.finished !== hmacHex(s.master!, 'protected result|' + s.transcript + '|' + body.accepted))
    throw new Error('TLS resultado sem prova de transcript.');
  s.accepted = body.accepted;
  s.phase = body.accepted ? 'ESTABLISHED' : 'FAILED';
  return {
    type: 'ResultAcknowledgment' as const,
    session: s.session,
    ciphertext: sealRecord(
      traffic(s),
      0,
      1,
      JSON.stringify({ finished: hmacHex(s.master!, 'ack result|' + s.transcript + '|' + s.accepted) }),
      context(s)
    ),
  };
}
export function tlsServerAcknowledgment(s: TlsSession, input: TlsMessage) {
  const m = tlsMessageSchema.parse(input);
  if (m.type !== 'ResultAcknowledgment' || m.session !== s.session || s.phase !== 'RESULT')
    throw new Error('TLS confirmação incompatível.');
  const body = schema
    .object({ finished: schema.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(JSON.parse(openRecord(traffic(s), 0, 1, m.ciphertext, context(s))));
  if (body.finished !== hmacHex(s.master!, 'ack result|' + s.transcript + '|' + s.accepted))
    throw new Error('TLS confirmação de resultado inválida.');
  s.phase = s.accepted ? 'ESTABLISHED' : 'FAILED';
  return s.accepted ?? false;
}
export function tlsExport(s: TlsSession) {
  if (s.phase !== 'ESTABLISHED' || !s.accepted || !s.master || !s.transcript)
    throw new Error('TLS não autorizado para exportar MSK.');
  return bytesToHex(
    hkdf(
      sha256,
      hexToBytes(s.master),
      text(s.transcript),
      text('EXPORTER_EAP_TLS_Key_Material|' + context(s)),
      64
    )
  );
}
