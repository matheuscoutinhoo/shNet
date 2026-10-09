import { describe, it, expect } from 'vitest';
import { SimulationEngine, validateSnapshot } from '../packages/simulation-engine/src';
import { issueCertificate, publicKey } from '../packages/simulation-engine/src/protocols/security-crypto';
import {
  tlsClientHello,
  tlsServerHello,
  tlsClientFinish,
  tlsServerFinish,
  tlsClientResult,
  tlsServerAcknowledgment,
  tlsExport,
} from '../packages/simulation-engine/src/protocols/tls-session';
import { decodeRadius, decodeEap } from '../packages/simulation-engine/src/protocols/radius-codec';
const ca = '11'.repeat(32),
  serverSeed = '22'.repeat(32),
  clientSeed = '33'.repeat(32),
  trust = [{ name: 'Campus CA', publicKey: publicKey(ca) }];
const identity = (seed: string, usage: 'server' | 'client', subject: string, name: string) => ({
  seed,
  certificate: issueCertificate(ca, {
    subject,
    serial: subject,
    issuer: 'Campus CA',
    names: [name],
    publicKey: publicKey(seed),
    usage,
    notBefore: 0,
    notAfter: 3600,
  }),
});
const serverIdentity = identity(serverSeed, 'server', 'RADIUS Campus', 'radius.campus'),
  clientIdentity = identity(clientSeed, 'client', 'Alice certificate', 'alice');
function topology(method: 'tls' | 'peap', password = 'campus-password') {
  const e = new SimulationEngine(),
    ap = e.addDevice('switch', { x: 100, y: 100 }),
    pc = e.addDevice('pc', { x: 105, y: 105 }),
    aaa = e.addDevice('server'),
    web = e.addDevice('server');
  const w = {
    ssid: 'Enterprise',
    security: 'wpa2-enterprise',
    band: '2.4',
    channel: 1,
    txPower: 20,
    noise: -110,
    attenuation: 0,
    enabled: true,
  };
  e.configureWireless(ap.id, { ...w, role: 'ap' });
  e.configureWireless(pc.id, { ...w, role: 'client' });
  Object.assign(ap.interfaces[0], { mode: 'routed', ip: '192.0.2.1', prefix: 24 });
  Object.assign(aaa.interfaces[0], { ip: '192.0.2.2', prefix: 24 });
  Object.assign(web.interfaces[0], { ip: '10.0.0.20', prefix: 24 });
  Object.assign(
    pc.interfaces.find((p) => p.id === 'wlan0')!,
    { ip: '10.0.0.10', prefix: 24 }
  );
  e.connect({ device: ap.id, port: 'p0' }, { device: aaa.id, port: 'p0' });
  e.connect({ device: ap.id, port: 'p1' }, { device: web.id, port: 'p0' });
  e.configureEapServer(aaa.id, {
    enabled: true,
    method,
    identity: serverIdentity,
    trust,
    key: 'radius-secret-key',
    clients: ['192.0.2.1'],
    users: [{ username: 'alice', password: 'campus-password', certificateSubject: 'Alice certificate' }],
  });
  e.configureEapAuthenticator(ap.id, {
    enabled: true,
    server: '192.0.2.2',
    key: 'radius-secret-key',
    underlay: 'p0',
    reauthMs: 10000,
  });
  e.configureEapSupplicant(pc.id, {
    enabled: true,
    method,
    username: 'alice',
    password,
    tls: { trust, serverName: 'radius.campus', ...(method === 'tls' ? { identity: clientIdentity } : {}) },
  });
  e.configureTcpService(web.id, { kind: 'http', port: 80, enabled: true, body: 'HTTP empresarial' });
  return { e, ap, pc, aaa, web };
}
describe('EAP empresarial TLS / PEAP', () => {
  it('verifica certificados/Finished, cifra credenciais e exporta a mesma MSK após resultado protegido', () => {
    const client = tlsClientHello('session', '44'.repeat(32), 'client-nonce', 'SSID|AP|token');
    const server = tlsServerHello(
      client.message,
      '55'.repeat(32),
      'server-nonce',
      serverIdentity,
      'SSID|AP|token'
    );
    expect(() =>
      tlsClientFinish(
        structuredClone(client.state),
        server.message,
        { trust, serverName: 'wrong.name' },
        0,
        { username: 'alice', password: 'secret' },
        false
      )
    ).toThrow(/certificado/);
    const finish = tlsClientFinish(
      client.state,
      server.message,
      { trust, serverName: 'radius.campus' },
      0,
      { username: 'alice', password: 'secret' },
      false
    );
    expect(JSON.stringify(finish)).not.toContain('secret');
    expect(() => tlsExport(client.state)).toThrow();
    const result = tlsServerFinish(
      server.state,
      finish,
      trust,
      0,
      false,
      (u, p) => u === 'alice' && p === 'secret'
    );
    const ack = tlsClientResult(client.state, result);
    expect(tlsServerAcknowledgment(server.state, ack)).toBe(true);
    expect(tlsExport(client.state)).toBe(tlsExport(server.state));
    const tampered = structuredClone(result);
    tampered.ciphertext = '00' + tampered.ciphertext.slice(2);
    expect(() => tlsClientResult({ ...client.state, phase: 'FINISHED' }, tampered)).toThrow();
  });
  it.each(['tls', 'peap'] as const)(
    '%s usa EAP fragmentado/RADIUS real e AES-GCM antes de liberar HTTP; snapshot retoma handshake',
    (method) => {
      const { e, ap, pc, aaa } = topology(method);
      e.advanceTo(40);
      validateSnapshot(e.snapshot());
      const resumed = new SimulationEngine(e.snapshot());
      e.advanceTo(5000);
      resumed.advanceTo(5000);
      expect(resumed.snapshot()).toEqual(e.snapshot());
      expect(
        pc.wireless!.phase,
        e.state.events
          .filter((v) => v.type === 'PACKET_DROPPED')
          .map((v) => v.reason)
          .join('\n')
      ).toBe('associated');
      expect(pc.eapSupplicant!.phase).toBe('authorized');
      expect(aaa.eapServer!.accepted).toBe(1);
      expect(pc.wireless!.association!.pmk).toBe(ap.wireless!.peers[0].pmk);
      const exchanges = e.state.events
        .filter((v) => v.frame?.wifi?.eap)
        .map((v) => decodeEap(v.frame!.wifi!.eap!));
      expect(exchanges.some((p) => (p.flags ?? 0) & 64)).toBe(true);
      const radius = e.state.events.find(
        (v) => v.frame?.packet?.protocol === 'UDP' && v.frame.packet.payload.protocol === 'EAP-RADIUS'
      );
      expect(radius).toBeDefined();
      if (radius?.frame?.packet?.protocol === 'UDP' && radius.frame.packet.payload.protocol === 'EAP-RADIUS')
        expect(decodeRadius(radius.frame.packet.payload.wire, 'radius-secret-key').code).toBe(1);
      const id = e.httpGet(pc.id, '10.0.0.20');
      e.advanceTo(6000);
      expect(pc.tcpConnections!.find((c) => c.id === id)!.received).toContain('HTTP empresarial');
      expect(e.state.events.some((v) => v.frame?.secure?.cipher === 'AES-GCM')).toBe(true);
      validateSnapshot(e.snapshot());
      e.advanceTo(13000);
      expect(pc.wireless!.phase).not.toBe('associated');
      expect(ap.wireless!.peers).toHaveLength(0);
      validateSnapshot(e.snapshot());
    }
  );
  it('senha PEAP errada e confiança TLS errada mantêm rádio sem autorização', () => {
    const wrong = topology('peap', 'wrong-password');
    wrong.e.advanceTo(6000);
    expect(wrong.pc.wireless!.phase).not.toBe('associated');
    expect(wrong.aaa.eapServer!.rejected).toBe(1);
    expect(wrong.ap.wireless!.peers).toHaveLength(0);
    const invalid = topology('tls');
    invalid.pc.eapSupplicant!.tls.serverName = 'wrong.name';
    invalid.e.advanceTo(6000);
    expect(invalid.pc.wireless!.phase).not.toBe('associated');
    expect(invalid.aaa.eapServer!.accepted).toBe(0);
  });
});
