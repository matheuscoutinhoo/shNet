import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  TerminalSession,
  tcpFinished,
  type DnsMessage,
} from '../packages/simulation-engine/src';
import { decodeDnsTcp, encodeDnsTcp } from '../packages/simulation-engine/src/protocols/dns-tcp-codec';
import { receiveDnsAnswer } from '../packages/simulation-engine/src/protocols/dns-client';
function network(template: 'dns' | 'tcp' = 'dns', count = 32) {
  const engine = new SimulationEngine(makeTemplate(template));
  const client = engine.state.devices.find((device) => device.type === 'pc')!;
  const server = engine.state.devices.find((device) => device.type === 'server')!;
  for (let i = 1; i <= count; i++)
    engine.configureDnsRecord(server.id, { name: 'large.lab', type: 'A', value: `203.0.113.${i}`, ttl: 60 });
  return { engine, client, server, address: server.interfaces[0].ip! };
}
describe('DNS sobre TCP', () => {
  it('recupera a perda de um segmento da resposta antes do timeout DNS', () => {
    const { engine, client, server } = network();
    engine.lookupDns(client.id, 'large.lab', 'A', undefined, undefined, 'tcp');
    let lost = false;
    for (let i = 0; i < 300 && !lost; i++) {
      engine.step();
      const index = engine.state.queue.findIndex(
        ({ action }) =>
          action.kind === 'deliver' &&
          action.from === server.id &&
          action.frame.packet?.protocol === 'TCP' &&
          !!action.frame.packet.data
      );
      if (index >= 0) {
        engine.state.queue.splice(index, 1);
        lost = true;
      }
    }
    expect(lost).toBe(true);
    engine.advanceTo(4500);
    expect(client.dnsQueries![0].status).toBe('success');
    expect(server.tcpConnections![0].retransmissions).toBeGreaterThan(0);
    validateSnapshot(engine.snapshot());
  });
  it('repete TC=1 via TCP segmentado, valida estados intermediários e alimenta cache', () => {
    const { engine, client } = network();
    engine.lookupDns(client.id, 'large.lab');
    for (let i = 0; i < 500 && client.dnsQueries![0].status === 'pending'; i++) {
      engine.step();
      validateSnapshot(engine.snapshot());
    }
    expect(client.dnsQueries![0]).toMatchObject({ status: 'success', transport: 'tcp', tcpFallback: true });
    expect(client.dnsQueries![0].answers).toHaveLength(32);
    expect(client.tcpConnections![0].bytesReceived).toBeGreaterThan(536);
    engine.lookupDns(client.id, 'large.lab');
    expect(client.dnsQueries!.at(-1)?.fromCache).toBe(true);
    engine.advanceTo(engine.state.clock + 1000);
    validateSnapshot(engine.snapshot());
  });
  it('restaura uma resposta parcial sem duplicação', () => {
    const { engine, client } = network();
    engine.lookupDns(client.id, 'large.lab', 'A', undefined, undefined, 'tcp');
    for (let i = 0; i < 200 && !client.tcpConnections?.[0]?.received; i++) engine.step();
    expect(client.dnsQueries![0].status).toBe('pending');
    const resumed = new SimulationEngine(engine.snapshot());
    engine.advanceTo(3000);
    resumed.advanceTo(3000);
    expect(resumed.snapshot()).toEqual(engine.snapshot());
    expect(client.dnsQueries![0].answers).toHaveLength(32);
  });
  it('consulta por TCP/53 através de PAT e firewall de trânsito', () => {
    const { engine, client, address } = network('tcp');
    engine.lookupDns(client.id, 'large.lab', 'A', address);
    engine.advanceTo(3000);
    expect(client.dnsQueries![0]).toMatchObject({ status: 'success', transport: 'tcp' });
    expect(client.dnsQueries![0].answers).toHaveLength(32);
    validateSnapshot(engine.snapshot());
  });
  it('não usa resposta truncada como sucesso quando ACL bloqueia TCP', () => {
    const { engine, client } = network();
    const cli = new TerminalSession(engine, client.id);
    for (const cmd of [
      'enable',
      'conf t',
      'access-list BLOCK 10 deny tcp any any eq 53',
      'access-list BLOCK 20 permit ip any any',
      'interface Eth0',
      'ip access-group BLOCK out',
    ])
      expect(cli.execute(cmd)).toBe('OK');
    engine.lookupDns(client.id, 'large.lab');
    engine.advanceTo(12000);
    expect(client.dnsQueries![0].status).toBe('timeout');
    expect(client.dnsCache ?? []).toEqual([]);
    expect(client.tcpConnections!.every(tcpFinished)).toBe(true);
    validateSnapshot(engine.snapshot());
  });
  it('correlaciona conexão, pergunta e ID; rejeita respostas UDP durante TCP', () => {
    const { engine, client, address } = network();
    engine.lookupDns(client.id, 'large.lab', 'A', address, undefined, 'tcp');
    const query = client.dnsQueries![0];
    const message: Extract<DnsMessage, { type: 'response' }> = {
      type: 'response',
      transactionId: query.transactionId,
      question: query.question,
      recursionDesired: true,
      recursionAvailable: false,
      authoritative: true,
      truncated: false,
      code: 'NOERROR',
      answers: [{ name: 'large.lab', type: 'A', value: '1.2.3.4', ttl: 30 }],
    };
    const endpoint = { src: address, dst: query.sourceIp, destinationPort: query.sourcePort };
    receiveDnsAnswer(engine, client, message, { ...endpoint, transport: 'udp' });
    receiveDnsAnswer(engine, client, message, { ...endpoint, transport: 'tcp', connection: 'tcp-invalid' });
    receiveDnsAnswer(
      engine,
      client,
      { ...message, transactionId: (query.transactionId + 1) % 65536 },
      { ...endpoint, transport: 'tcp', connection: query.tcpConnection }
    );
    expect(query.status).toBe('pending');
    expect(client.dropped).toBe(3);
    engine.advanceTo(3000);
    expect(query.answers).toHaveLength(32);
  });
  it('aceita leitura parcial do framing e recusa comprimentos adulterados', () => {
    const message: DnsMessage = {
      type: 'query',
      transactionId: 3,
      question: { name: 'server.lab', type: 'A' },
      recursionDesired: true,
    };
    const encoded = encodeDnsTcp(message);
    expect(decodeDnsTcp(encoded.slice(0, 2))).toBeUndefined();
    expect(decodeDnsTcp(encoded.slice(0, -1))).toBeUndefined();
    expect(decodeDnsTcp(encoded)).toEqual(message);
    expect(() => decodeDnsTcp('ffff' + encoded.slice(4))).toThrow(/limite/);
    expect(() => decodeDnsTcp(encoded + 'x')).toThrow(/uma mensagem/);
  });
  it('resolve por TCP local via CLI e impede conflito com outros serviços na porta 53', () => {
    const { engine, server, address } = network();
    const cli = new TerminalSession(engine, server.id);
    const result = cli.execute(`nslookup -tcp large.lab ${address}`);
    expect(result).toContain('success');
    expect(result).toContain('Transporte: TCP');
    expect(server.dnsQueries![0].answers).toHaveLength(32);
    expect(() => engine.configureTcpService(server.id, { enabled: true, port: 53, kind: 'echo' })).toThrow(
      /reservado/
    );
    validateSnapshot(engine.snapshot());
  });
  it('rejeita snapshot com consulta sem conexão e retorna SERVFAIL além do limite', () => {
    const { engine, client } = network('dns', 65);
    engine.lookupDns(client.id, 'large.lab', 'A', undefined, undefined, 'tcp');
    const invalid = engine.snapshot();
    invalid.devices.find((device) => device.id === client.id)!.dnsQueries![0].tcpConnection = 'tcp-invalid';
    expect(() => validateSnapshot(invalid)).toThrow(/DNS\/TCP/);
    engine.advanceTo(3000);
    expect(client.dnsQueries![0].status).toBe('servfail');
    validateSnapshot(engine.snapshot());
  });
});
