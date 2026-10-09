import { hashHex, publicKey, issueCertificate } from './security-crypto';
// Local lab authority: deterministic fixtures for exercises, editable before use.
export function enterpriseDefaults() {
  const ca = hashHex('shLab local lab CA'),
    trust = [{ name: 'shLab Lab CA', publicKey: publicKey(ca) }];
  function identity(subject: string, name: string, usage: 'client' | 'server') {
    const seed = hashHex('shLab lab identity ' + subject);
    return {
      seed,
      certificate: issueCertificate(ca, {
        serial: subject,
        subject,
        issuer: 'shLab Lab CA',
        names: [name],
        publicKey: publicKey(seed),
        usage,
        notBefore: 0,
        notAfter: 86400,
      }),
    };
  }
  return {
    server: {
      enabled: true,
      method: 'tls',
      identity: identity('Campus RADIUS', 'radius.campus', 'server'),
      trust,
      key: 'radius-network-key',
      clients: [],
      users: [{ username: 'student', certificateSubject: 'Campus student', enabled: true }],
    },
    supplicant: {
      enabled: true,
      method: 'tls',
      username: 'student',
      outerIdentity: 'anonymous',
      tls: { trust, serverName: 'radius.campus', identity: identity('Campus student', 'student', 'client') },
    },
  };
}
