import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  stateSyncStatus,
  vrrpConfigGroups,
  preflight,
  TerminalSession,
  configurationDiff,
  type Device,
  type UdpPacket,
} from '../packages/simulation-engine/src';
import { permitFirewall } from '../packages/simulation-engine/src/protocols/firewall';
import { natOutbound, natInbound } from '../packages/simulation-engine/src/protocols/nat';
import { permitFirewall6 } from '../packages/simulation-engine/src/protocols/firewall6';

function network(sync = true, pat = false) {
  const e = new SimulationEngine(makeTemplate('vrrp'));
  const [client, , a, b, , server] = e.state.devices;
  for (const d of [a, b]) {
    e.configureFirewall(d.id, { enabled: true, trustedPorts: ['p0'], protocols: ['TCP', 'UDP', 'ICMP'] });
    if (pat) {
      d.interfaces[0].natRole = 'inside';
      d.interfaces[1].natRole = 'outside';
      e.configureNat(d.id, {
        enabled: true,
        statics: [],
        pools: [
          {
            name: 'shared',
            source: { network: '192.168.10.0', prefix: 24 },
            outside: 'p1',
            start: '192.168.20.100',
            end: '192.168.20.100',
            overload: true,
          },
        ],
      });
    }
  }
  e.configureTcpService(server.id, { kind: 'echo', enabled: true, port: 7777 });
  const link = e.connect({ device: a.id, port: 'p2' }, { device: b.id, port: 'p2' });
  if (sync) pair(e, a, b);
  return { e, client, a, b, server, link };
}
function pair(e: SimulationEngine, a: Device, b: Device) {
  e.configureStateSyncPair(a.id, b.id, {
    portA: 'p2',
    portB: 'p2',
    mappings: [
      { a: 'p0', b: 'p0' },
      { a: 'p1', b: 'p1' },
    ],
  });
}
function open(n: ReturnType<typeof network>) {
  const id = n.e.openTcp(n.client.id, n.server.interfaces[0].ip!, 7777, 'before|', false);
  n.e.advanceTo(n.e.state.clock + 1000);
  expect(n.client.tcpConnections!.find((p) => p.id === id)?.received).toBe('before|');
  validateSnapshot(n.e.snapshot());
  return id;
}
function failover(n: ReturnType<typeof network>, id: string) {
  n.e.setDevicePower(n.a.id, false);
  n.e.advanceTo(n.e.state.clock + 5000);
  n.e.writeTcp(n.client.id, id, 'after|');
  n.e.advanceTo(n.e.state.clock + 1500);
  validateSnapshot(n.e.snapshot());
  return n.client.tcpConnections!.find((p) => p.id === id)!;
}
function udp(): UdpPacket {
  return {
    protocol: 'UDP',
    src: '192.168.10.10',
    dst: '192.168.20.10',
    sourcePort: 50001,
    destinationPort: 53,
    ttl: 64,
    bytes: 60,
    payload: {
      protocol: 'DNS',
      message: {
        type: 'query',
        transactionId: 1,
        question: { name: 'ha.test', type: 'A' },
        recursionDesired: false,
      },
    },
  };
}

describe('Sincronização HA por canal dedicado', () => {
  it('diff de configuração omite revisões e contadores HA mas inclui mudanças do par', () => {
    const n = network(),
      before = n.e.snapshot(),
      after = structuredClone(before);
    const config = after.devices.find((d) => d.id === n.a.id)!.stateSync!;
    config.sent = 10;
    config.received = 5;
    config.rejected = 2;
    config.lastReceivedAt = 4000;
    config.records = [
      { table: 'firewall', id: 'runtime-only', revision: 1, expiresAt: 200000, deleted: true },
    ];
    expect(configurationDiff(before, after)).toEqual([]);
    n.e.disableStateSync(n.a.id);
    expect(
      configurationDiff(before, n.e.snapshot())
        .filter((c) => c.kind === 'device')
        .map((c) => c.id)
    ).toEqual([n.a.id, n.b.id]);
  });
  it('CLI configura e remove o par com running-config concreto e status verificável', () => {
    const n = network(false),
      cli = new TerminalSession(n.e, n.a.id);
    for (const command of [
      'enable',
      'conf t',
      'ha state-sync configure ' +
        n.b.hostname +
        ' ' +
        JSON.stringify({
          portA: 'p2',
          portB: 'p2',
          mappings: [
            { a: 'p0', b: 'p0' },
            { a: 'p1', b: 'p1' },
          ],
        }),
      'end',
    ])
      expect(cli.execute(command)).not.toMatch(/Erro|%/);
    expect(cli.execute('show ha state-sync')).toContain('HA: ready');
    expect(cli.execute('show running-config')).toContain('"portB":"p2"');
    expect(cli.execute('show running-config')).toContain('ha state-sync configure ' + n.b.id);
    for (const command of ['conf t', 'no ha state-sync', 'end'])
      expect(cli.execute(command)).not.toMatch(/Erro|%/);
    expect(n.b.stateSync).toBeUndefined();
    validateSnapshot(n.e.snapshot());
  });
  it('modelos nativos da fábrica e enterprise possuem canal HA e mapeamento de subinterfaces distintos', () => {
    for (const template of ['factory', 'enterprise-datacenter'] as const) {
      const e = new SimulationEngine(makeTemplate(template)),
        a = e.state.devices.find((d) => d.hostname === 'FW-A')!,
        b = e.state.devices.find((d) => d.hostname === 'FW-B')!;
      expect(a.stateSync?.peer).toBe(b.id);
      expect(stateSyncStatus(e.state, a)).toBe('ready');
      expect(a.stateSync!.portMap.some((p) => p.local !== p.remote)).toBe(true);
      validateSnapshot(e.snapshot());
    }
  });
  it('mantém a mesma conexão TCP, sequências e retorno depois da perda do primário', () => {
    const n = network(),
      id = open(n);
    expect(n.b.firewall!.sessions).toEqual(n.a.firewall!.sessions);
    expect(stateSyncStatus(n.e.state, n.a)).toBe('ready');
    const c = failover(n, id);
    expect(c.received).toBe('before|after|');
    expect(c.state).toBe('ESTABLISHED');
    expect(n.b.firewall!.dropped).toBe(0);
  });
  it('sem sincronização, nova conexão recupera mas a conexão preexistente é recusada', () => {
    const n = network(false),
      id = open(n);
    expect(failover(n, id).received).toBe('before|');
    expect(n.b.firewall!.dropped).toBeGreaterThan(0);
    const fresh = n.e.openTcp(n.client.id, n.server.interfaces[0].ip!, 7777, 'new|', false);
    n.e.advanceTo(n.e.state.clock + 1000);
    expect(n.client.tcpConnections!.find((p) => p.id === fresh)?.received).toBe('new|');
  });
  it('PAT conserva o IP global e a porta traduzida e usa MAC virtual no retorno', () => {
    const n = network(true, true),
      id = open(n);
    const original = structuredClone(n.a.nat!.bindings[0]);
    expect(n.b.nat!.bindings).toEqual(n.a.nat!.bindings);
    expect(n.server.arpTable.find((p) => p.ip === original.global)?.mac).toBe('00:00:5e:00:01:14');
    expect(failover(n, id).received).toBe('before|after|');
    expect(n.b.nat!.bindings[0]).toMatchObject({
      id: original.id,
      global: original.global,
      globalToken: original.globalToken,
    });
    expect(
      n.e.state.events
        .filter((p) => p.type === 'ARP_REPLY' && p.frame?.arp?.senderIp === original.global)
        .map((p) => p.device)
    ).toEqual([n.a.id]);
  });
  it('retorno assimétrico por B preserva handshake e TCP iniciado através de A', () => {
    const n = network();
    n.server.gateway = n.b.interfaces[1].ip;
    const id = open(n);
    n.e.writeTcp(n.client.id, id, 'asymmetric|');
    n.e.advanceTo(n.e.state.clock + 1000);
    expect(n.client.tcpConnections!.find((p) => p.id === id)?.received).toBe('before|asymmetric|');
    expect(n.a.firewall!.dropped + n.b.firewall!.dropped).toBe(0);
    expect(n.b.stateSync!.received).toBeGreaterThan(0);
    validateSnapshot(n.e.snapshot());
  });
  it('PAT assimétrico usa A na saída e B no retorno sem trocar a tradução', () => {
    const n = network(true, true);
    n.e.configureVrrp(n.b.id, {
      enabled: true,
      groups: vrrpConfigGroups(n.b).map((g) => ({ ...g, priority: g.port === 'p1' ? 200 : 100 })),
    });
    n.e.advanceTo(n.e.state.clock + 5000);
    expect(n.a.vrrp!.groups.map((g) => g.state)).toEqual(['ACTIVE', 'BACKUP']);
    expect(n.b.vrrp!.groups.map((g) => g.state)).toEqual(['BACKUP', 'ACTIVE']);
    const id = open(n);
    n.e.writeTcp(n.client.id, id, 'asymmetric-pat|');
    n.e.advanceTo(n.e.state.clock + 1000);
    expect(n.client.tcpConnections!.find((p) => p.id === id)?.received).toBe('before|asymmetric-pat|');
    expect(n.a.firewall!.dropped + n.b.firewall!.dropped).toBe(0);
    expect(n.server.arpTable.find((p) => p.ip === n.a.nat!.bindings[0].global)?.mac).toBe(
      '00:00:5e:00:01:14'
    );
    validateSnapshot(n.e.snapshot());
  });
  it('retorno do primário recebe o estado atual antes da preempção e mantém TCP/PAT', () => {
    const n = network(true, true),
      id = open(n);
    expect(failover(n, id).received).toBe('before|after|');
    n.e.setDevicePower(n.a.id, true);
    n.e.advanceTo(n.e.state.clock + 5000);
    n.e.writeTcp(n.client.id, id, 'failback|');
    n.e.advanceTo(n.e.state.clock + 1000);
    expect(n.client.tcpConnections!.find((p) => p.id === id)?.received).toBe('before|after|failback|');
    validateSnapshot(n.e.snapshot());
  });
  it('partição antes da abertura não cria réplicas e não concede continuidade falsa', () => {
    const n = network();
    n.link.up = false;
    expect(stateSyncStatus(n.e.state, n.a)).toBe('unavailable');
    const id = open(n);
    expect(n.b.firewall!.sessions).toHaveLength(0);
    expect(failover(n, id).received).toBe('before|');
  });
  it('reconcilia após perda de 100% dos updates e recuperação do canal', () => {
    const n = network();
    n.link.loss = 1;
    const id = open(n);
    expect(n.b.firewall!.sessions).toHaveLength(0);
    n.link.loss = 0;
    n.e.advanceTo(n.e.state.clock + 1100);
    expect(n.b.firewall!.sessions).toEqual(n.a.firewall!.sessions);
    expect(failover(n, id).received).toBe('before|after|');
  });
  it('falha antes da entrega pendente não obtém continuidade por cópia instantânea', () => {
    const n = network();
    n.link.latency = 3000;
    const id = open(n);
    expect(n.b.firewall!.sessions).toHaveLength(0);
    expect(failover(n, id).received).toBe('before|');
  });
  it('checkpoint com entrega pendente conserva estado, fila, timers e resultados', () => {
    const n = network(true, true);
    expect(permitFirewall(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], udp())).toBe(true);
    natOutbound(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], udp());
    const saved = n.e.snapshot();
    expect(saved.queue.some((p) => p.action.kind === 'state-sync-deliver')).toBe(true);
    const restored = new SimulationEngine(saved);
    const target = n.e.state.clock + 1500;
    n.e.advanceTo(target);
    restored.advanceTo(target);
    expect(restored.snapshot()).toEqual(n.e.snapshot());
    validateSnapshot(n.e.snapshot());
  });
  it('UDP/PAT aceita retorno no backup, recusa tuple não solicitado e expira nos dois peers', () => {
    const n = network(true, true),
      p = udp();
    expect(permitFirewall(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], p)).toBe(true);
    const translated = natOutbound(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], p)!;
    n.e.advanceTo(n.e.state.clock + 100);
    if (translated.protocol !== 'UDP') throw new Error('UDP esperado');
    const incoming = {
      ...translated,
      src: p.dst,
      dst: translated.src,
      sourcePort: p.destinationPort,
      destinationPort: translated.sourcePort,
    };
    const decoded = natInbound(n.e, n.b, n.b.interfaces[1], incoming)!;
    expect(decoded.dst).toBe(p.src);
    expect(permitFirewall(n.e, n.b, n.b.interfaces[1], n.b.interfaces[0], decoded)).toBe(true);
    expect(
      permitFirewall(n.e, n.b, n.b.interfaces[1], n.b.interfaces[0], {
        ...p,
        src: p.dst,
        dst: p.src,
        sourcePort: 53,
        destinationPort: 50002,
      })
    ).toBe(false);
    n.e.advanceTo(n.e.state.clock + 125000);
    for (const d of [n.a, n.b]) {
      expect(d.firewall!.sessions).toHaveLength(0);
      expect(d.nat!.bindings).toHaveLength(0);
    }
    validateSnapshot(n.e.snapshot());
  });
  it('reset de política propaga remoção, não ressuscita a sessão em reconciliação', () => {
    const n = network();
    open(n);
    n.link.up = false;
    n.e.configureFirewall(n.a.id, { ...n.a.firewall!, sessions: [] });
    expect(n.b.firewall!.sessions).toHaveLength(1);
    n.link.up = true;
    n.e.advanceTo(n.e.state.clock + 2100);
    expect(n.b.firewall!.sessions).toHaveLength(0);
    validateSnapshot(n.e.snapshot());
  });
  it('reconfigurar ambos os pools enquanto há update pendente não instala binding obsoleto', () => {
    const n = network(true, true);
    n.link.latency = 100;
    natOutbound(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], udp());
    expect(n.e.state.queue.some((q) => q.action.kind === 'state-sync-deliver' && q.action.binding)).toBe(
      true
    );
    for (const d of [n.a, n.b])
      n.e.configureNat(d.id, {
        ...d.nat!,
        pools: d.nat!.pools.map((p) => ({ ...p, start: '192.168.20.101', end: '192.168.20.101' })),
      });
    n.e.advanceTo(n.e.state.clock + 1500);
    expect(n.a.nat!.bindings).toHaveLength(0);
    expect(n.b.nat!.bindings).toHaveLength(0);
    validateSnapshot(n.e.snapshot());
  });
  it('RST válido remove a sessão no backup e seus timers sem ressuscitar pela reconciliação', () => {
    const n = network();
    open(n);
    const s = n.a.firewall!.sessions[0];
    if (s.protocol !== 'TCP') throw new Error('TCP esperado');
    expect(
      permitFirewall(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], {
        protocol: 'TCP',
        src: s.clientIp,
        dst: s.serverIp,
        sourcePort: s.clientPort,
        destinationPort: s.serverPort,
        flags: ['RST', 'ACK'],
        sequence: s.clientNext,
        acknowledgment: s.serverNext!,
        window: 16000,
        data: '',
        ttl: 64,
        bytes: 40,
      })
    ).toBe(true);
    n.e.advanceTo(n.e.state.clock + 1500);
    expect(n.a.firewall!.sessions).toHaveLength(0);
    expect(n.b.firewall!.sessions).toHaveLength(0);
    expect(n.e.state.queue.some((q) => q.action.kind === 'firewall-expire')).toBe(false);
    validateSnapshot(n.e.snapshot());
  });
  it('expiração de réplica desatualizada não apaga estado renovado no outro peer', () => {
    const n = network(),
      p = udp();
    permitFirewall(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], p);
    n.e.advanceTo(n.e.state.clock + 100);
    n.link.up = false;
    const expires = n.a.firewall!.sessions[0].expiresAt;
    n.e.advanceTo(expires - 1000);
    permitFirewall(n.e, n.b, n.b.interfaces[0], n.b.interfaces[1], p);
    n.e.advanceTo(expires + 1);
    expect(n.a.firewall!.sessions).toHaveLength(0);
    expect(n.b.firewall!.sessions).toHaveLength(1);
    n.link.up = true;
    n.e.advanceTo(n.e.state.clock + 1100);
    expect(n.a.firewall!.sessions).toEqual(n.b.firewall!.sessions);
    validateSnapshot(n.e.snapshot());
  });
  it('políticas divergentes bloqueiam novos updates e preflight pode distinguir o estado', () => {
    const n = network();
    n.e.configureFirewall(n.b.id, { enabled: true, trustedPorts: ['p1'], protocols: ['TCP', 'UDP', 'ICMP'] });
    expect(stateSyncStatus(n.e.state, n.a)).toBe('policy-mismatch');
    expect(preflight(n.e.snapshot()).some((p) => p.code === 'HA_SYNC_UNAVAILABLE')).toBe(true);
    open(n);
    expect(n.b.firewall!.sessions).toHaveLength(0);
    validateSnapshot(n.e.snapshot());
  });
  it('ICMP e sessões IPv6 replicam retorno correlacionado sem liberar tuple forjado', () => {
    const n = network();
    const packet = {
      protocol: 'ICMPv6' as const,
      kind: 'echo-request' as const,
      src: '2001:db8:1::10',
      dst: '2001:db8:2::10',
      hopLimit: 64,
      bytes: 64,
      probeId: 'ha-icmp6',
    };
    expect(permitFirewall6(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], packet)).toBe(true);
    n.e.advanceTo(n.e.state.clock + 100);
    const reply = { ...packet, kind: 'echo-reply' as const, src: packet.dst, dst: packet.src };
    expect(permitFirewall6(n.e, n.b, n.b.interfaces[1], n.b.interfaces[0], reply)).toBe(true);
    expect(
      permitFirewall6(n.e, n.b, n.b.interfaces[1], n.b.interfaces[0], { ...reply, probeId: 'unsolicited' })
    ).toBe(false);
    validateSnapshot(n.e.snapshot());
  });
  it('colisão de PAT criada durante partição é recusada ao reconciliar', () => {
    const n = network(true, true);
    n.link.up = false;
    natOutbound(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], udp());
    natOutbound(n.e, n.b, n.b.interfaces[0], n.b.interfaces[1], { ...udp(), sourcePort: 50002 });
    n.b.nat!.bindings[0].globalToken = n.a.nat!.bindings[0].globalToken;
    n.link.up = true;
    n.e.advanceTo(n.e.state.clock + 1100);
    expect(n.a.nat!.bindings).toHaveLength(1);
    expect(n.b.nat!.bindings).toHaveLength(1);
    expect(n.a.stateSync!.rejected + n.b.stateSync!.rejected).toBeGreaterThan(0);
    validateSnapshot(n.e.snapshot());
  });
  it('recusa configuração inválida atomicamente e limpa ações quando o peer é removido', () => {
    const n = network();
    open(n);
    const before = n.e.snapshot();
    expect(() =>
      n.e.configureStateSyncPair(n.a.id, n.b.id, {
        portA: 'p0',
        portB: 'p0',
        mappings: [{ a: 'missing', b: 'p1' }],
      })
    ).toThrow(/HA/);
    expect(n.e.snapshot()).toEqual(before);
    n.e.removeDevice(n.b.id);
    expect(n.a.stateSync).toBeUndefined();
    expect(n.e.state.queue.some((p) => p.action.kind.startsWith('state-sync'))).toBe(false);
    validateSnapshot(n.e.snapshot());
  });
  it('snapshot rejeita timers duplicados, revision forjada e mapeamento não recíproco', () => {
    const n = network();
    open(n);
    for (const mutate of [
      (s: ReturnType<typeof n.e.snapshot>) =>
        s.queue.push(structuredClone(s.queue.find((p) => p.action.kind === 'state-sync-tick')!)),
      (s: ReturnType<typeof n.e.snapshot>) => {
        s.devices.find((p) => p.id === n.a.id)!.stateSync!.records[0].revision = s.sequence + 1;
      },
      (s: ReturnType<typeof n.e.snapshot>) => {
        s.devices.find((p) => p.id === n.b.id)!.stateSync!.portMap[0].remote = 'p1';
      },
    ]) {
      const bad = n.e.snapshot();
      mutate(bad);
      expect(() => validateSnapshot(bad)).toThrow(/HA/);
    }
  });
  it('snapshot rejeita payloads HA com IP não unicast e portas PAT fora de faixa', () => {
    const n = network(true, true);
    permitFirewall(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], udp());
    natOutbound(n.e, n.a, n.a.interfaces[0], n.a.interfaces[1], udp());
    const sessionSnapshot = n.e.snapshot(),
      bindingSnapshot = n.e.snapshot();
    const session = sessionSnapshot.queue.find(
      (q) => q.action.kind === 'state-sync-deliver' && q.action.session
    )!.action;
    if (session.kind !== 'state-sync-deliver') throw new Error('Update esperado');
    session.session!.clientIp = '0.0.0.0';
    const binding = bindingSnapshot.queue.find(
      (q) => q.action.kind === 'state-sync-deliver' && q.action.binding
    )!.action;
    if (binding.kind !== 'state-sync-deliver') throw new Error('Update esperado');
    binding.binding!.globalToken = '999999';
    expect(() => validateSnapshot(sessionSnapshot)).toThrow(/HA/);
    expect(() => validateSnapshot(bindingSnapshot)).toThrow(/HA/);
  });
});
