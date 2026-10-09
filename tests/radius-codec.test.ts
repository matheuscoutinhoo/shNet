import { describe, expect, it } from 'vitest';
import {
  decodeEap,
  encodeEap,
  decodeRadius,
  encodeRadius,
} from '../packages/simulation-engine/src/protocols/radius-codec';
describe('Octetos EAP/RADIUS', () => {
  it('codifica cabeçalho EAP conhecido e reagrupa EAP-Message maior que 253 bytes', () => {
    expect(encodeEap({ code: 2, identifier: 1, method: 1, data: 'u' })).toBe('020100060175');
    expect(decodeEap('03010004')).toEqual({ code: 3, identifier: 1, data: '' });
    const m = {
      code: 1 as const,
      identifier: 7,
      authenticator: '12'.repeat(16),
      username: 'anonymous',
      nas: 'AP-1',
      callingStation: '02:00:00:00:00:01',
      eap: {
        code: 2 as const,
        identifier: 8,
        method: 13 as const,
        flags: 128,
        length: 800,
        data: 'ab'.repeat(800),
      },
    };
    expect(decodeRadius(encodeRadius(m, 'radius-network-key'), 'radius-network-key')).toEqual(m);
  });
  it('protege Response/Message Authenticator e entrega MPPE somente ao NAS que conhece a chave', () => {
    const request = 'ab'.repeat(16),
      m = {
        code: 2 as const,
        identifier: 9,
        authenticator: request,
        state: 'session-1',
        eap: { code: 3 as const, identifier: 4, data: '' },
        recvKey: '11'.repeat(32),
        sendKey: '22'.repeat(32),
      };
    const wire = encodeRadius(m, 'radius-network-key', request),
      decoded = decodeRadius(wire, 'radius-network-key', request);
    expect(decoded.recvKey).toBe(m.recvKey);
    expect(decoded.sendKey).toBe(m.sendKey);
    expect(wire).not.toContain(m.recvKey);
    expect(() => decodeRadius(wire, 'wrong-key', request)).toThrow(/Authenticator/);
    expect(() => decodeRadius(wire, 'radius-network-key', '00'.repeat(16))).toThrow(/Authenticator/);
    expect(() => decodeRadius(wire.slice(0, -2) + '00', 'radius-network-key', request)).toThrow(
      /Authenticator/
    );
    expect(() => decodeEap('01010005')).toThrow();
    expect(() => decodeRadius('01010014' + '00'.repeat(16), 'key')).toThrow(/Message-Authenticator/);
  });
});
