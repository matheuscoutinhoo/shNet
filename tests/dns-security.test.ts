import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  dnssecAnchor,
} from '../packages/simulation-engine/src';
import { buildDnsResponse, verifyDnsResponse } from '../packages/simulation-engine/src/protocols/dnssec';
import { receiveDnsAnswer } from '../packages/simulation-engine/src/protocols/dns-client';
function setup(size = 1232) {
  const engine = new SimulationEngine(makeTemplate('dns'));
  const client = engine.state.devices.find((d) => d.type === 'pc')!,
    server = engine.state.devices.find((d) => d.type === 'server')!;
  const zone = { name: 'lab', seed: '01'.repeat(32), validity: 30 };
  engine.configureDnsSecurity(server.id, { validation: 'off', anchors: [] }, [zone]);
  engine.configureDnsSecurity(client.id, {
    validation: 'require',
    anchors: [dnssecAnchor(zone)],
    edns: { version: 0, udpSize: size, dnssecOk: true },
  });
  engine.configureDnsRecord(server.id, { name: 'signed.lab', type: 'A', value: '203.0.113.2', ttl: 300 });
  return { engine, client, server, zone };
}
describe('DNSSEC e EDNS', () => {
  it('transporta DNSSEC por UDP/IPv6 e TCP/IPv6', () => {
    const { engine, client, server } = setup();
    engine.configureIpv6(client.id, 'p0', { auto: false, addresses: [{ ip: '2001:db8::10', prefix: 64 }] });
    engine.configureIpv6(server.id, 'p0', { auto: false, addresses: [{ ip: '2001:db8::20', prefix: 64 }] });
    engine.advanceTo(3000);
    for (const mode of ['udp', 'tcp'] as const) {
      engine.clearDnsCache(client.id);
      engine.lookupDns(client.id, 'signed.lab', 'A', '2001:db8::20', undefined, mode);
      engine.advanceTo(engine.state.clock + 2000);
      expect(client.dnsQueries!.at(-1)).toMatchObject({
        status: 'success',
        security: 'secure',
        transport: mode,
      });
      validateSnapshot(engine.snapshot());
    }
  });
  it('valida Ed25519, usa EDNS e expira cache na assinatura; restaura provas', () => {
    const { engine, client } = setup();
    engine.lookupDns(client.id, 'signed.lab');
    engine.advanceTo(2000);
    expect(client.dnsQueries![0]).toMatchObject({ status: 'success', security: 'secure', transport: 'udp' });
    expect(client.dnsCache![0].expiresAt).toBeLessThanOrEqual(31000);
    validateSnapshot(engine.snapshot());
    const broken = engine.snapshot();
    broken.devices.find((d) => d.id === client.id)!.dnsCache![0].answers[0].value = '1.2.3.4';
    expect(() => validateSnapshot(broken)).toThrow(/DNSSEC/);
    engine.lookupDns(client.id, 'signed.lab');
    expect(client.dnsQueries!.at(-1)!.fromCache).toBe(true);
    engine.advanceTo(32000);
    engine.lookupDns(client.id, 'signed.lab');
    expect(client.dnsQueries!.at(-1)!.fromCache).toBe(false);
    engine.advanceTo(34000);
    expect(client.dnsQueries!.at(-1)!.security).toBe('secure');
  });
  it('autentica NXDOMAIN, NODATA, ancestral vazio e cadeia CNAME', () => {
    const { engine, client, server } = setup();
    engine.configureDnsRecord(server.id, {
      name: 'child.empty.lab',
      type: 'AAAA',
      value: '2001:db8::1',
      ttl: 60,
    });
    engine.configureDnsRecord(server.id, { name: 'alias.lab', type: 'CNAME', value: 'signed.lab', ttl: 60 });
    for (const [name, type, status] of [
      ['absent.lab', 'A', 'nxdomain'],
      ['deep.absent.lab', 'A', 'nxdomain'],
      ['signed.lab', 'AAAA', 'nodata'],
      ['empty.lab', 'A', 'nodata'],
      ['alias.lab', 'A', 'success'],
    ] as const) {
      engine.lookupDns(client.id, name, type);
      engine.advanceTo(engine.state.clock + 2000);
      expect(client.dnsQueries!.at(-1)).toMatchObject({ status, security: 'secure' });
    }
    validateSnapshot(engine.snapshot());
  });
  it('rejeita alteração, validade, DS diferente e negativa sem NSEC', () => {
    const { engine, client, server } = setup();
    const query = {
      type: 'query' as const,
      transactionId: 7,
      question: { name: 'signed.lab', type: 'A' as const },
      recursionDesired: true,
      edns: client.dnsResolver!.edns,
    };
    const signed = buildDnsResponse(server, query, 0);
    expect(verifyDnsResponse(client, signed, 1000)).toBe('secure');
    signed.answers[0].value = '1.2.3.4';
    expect(verifyDnsResponse(client, signed, 1000)).toBe('bogus');
    const expired = buildDnsResponse(server, query, 0);
    expect(verifyDnsResponse(client, expired, 30000)).toBe('bogus');
    const negative = buildDnsResponse(server, { ...query, question: { name: 'missing.lab', type: 'A' } }, 0);
    negative.dnssec!.denial = [];
    expect(verifyDnsResponse(client, negative, 1000)).toBe('bogus');
    engine.lookupDns(client.id, 'signed.lab');
    const q = client.dnsQueries![0];
    receiveDnsAnswer(
      engine,
      client,
      { ...signed, transactionId: q.transactionId },
      { src: q.server, dst: q.sourceIp, destinationPort: q.sourcePort, transport: 'udp' }
    );
    expect(q).toMatchObject({ status: 'servfail', security: 'bogus' });
    expect(client.dnsCache ?? []).toHaveLength(0);
  });
  it('negocia BADVERS e mantém fallback TCP com assinaturas maiores que UDP', () => {
    const { engine, client, server } = setup(512);
    for (let i = 1; i <= 15; i++)
      engine.configureDnsRecord(server.id, {
        name: 'large.lab',
        type: 'A',
        value: `203.0.113.${i}`,
        ttl: 60,
      });
    engine.lookupDns(client.id, 'large.lab');
    engine.advanceTo(3000);
    expect(client.dnsQueries![0]).toMatchObject({
      status: 'success',
      security: 'secure',
      transport: 'tcp',
      tcpFallback: true,
    });
    engine.configureDnsSecurity(client.id, {
      validation: 'off',
      anchors: [],
      edns: { version: 1, udpSize: 1232, dnssecOk: false },
    });
    engine.lookupDns(client.id, 'signed.lab');
    engine.advanceTo(5000);
    expect(client.dnsQueries!.at(-1)).toMatchObject({ status: 'servfail', code: 'BADVERS' });
    validateSnapshot(engine.snapshot());
  });
});
