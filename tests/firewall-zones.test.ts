import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  TerminalSession,
  validateSnapshot,
  type FirewallZonePolicy,
  type IcmpPacket,
  type UdpPacket,
} from '../packages/simulation-engine/src';
import { permitFirewall } from '../packages/simulation-engine/src/protocols/firewall';

function network() {
  const engine = new SimulationEngine(makeTemplate('firewall-zones'));
  const [client, edge, upstream, wan, dmz] = engine.state.devices;
  return { engine, client, edge, upstream, wan, dmz };
}
function packet(): UdpPacket {
  return {
    protocol: 'UDP',
    src: '192.168.10.10',
    dst: '192.168.20.10',
    sourcePort: 50123,
    destinationPort: 53,
    ttl: 64,
    bytes: 60,
    payload: {
      protocol: 'DNS',
      message: {
        type: 'query',
        transactionId: 1,
        question: { name: 'zones.lab', type: 'A' },
        recursionDesired: false,
      },
    },
  };
}
function until(engine: SimulationEngine, ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) {
    expect(engine.step()).toBe(true);
    validateSnapshot(engine.snapshot());
  }
  expect(ready()).toBe(true);
}

describe('firewall por zonas', () => {
  it('template entrega HTTP LAN→WAN com PAT e LAN/WAN→DMZ com retorno inspecionado', () => {
    const { engine, client, edge, wan, dmz } = network();
    for (const [origin, target] of [
      [client, wan],
      [client, dmz],
      [wan, dmz],
    ]) {
      const id = engine.httpGet(origin.id, target.interfaces[0].ip!);
      until(engine, () => origin.tcpConnections?.find((entry) => entry.id === id)?.state === 'TIME-WAIT');
      expect(origin.tcpConnections?.find((entry) => entry.id === id)?.received).toContain('HTTP/1.1 200 OK');
    }
    expect(edge.firewall!.sessions).toHaveLength(3);
    expect(
      edge.firewall!.sessions.some((session) => session.inside === 'p1' && session.outside === 'p2')
    ).toBe(true);
    expect(edge.firewall!.dropped).toBe(0);
    expect(edge.nat!.bindings).toHaveLength(1);
    validateSnapshot(engine.snapshot());
  });
  it('bloqueia conexões WAN→LAN, echo/7 na DMZ e HTTP DMZ→WAN', () => {
    const { engine, client, edge, wan, dmz } = network();
    for (const [origin, target, port] of [
      [wan, client, 80],
      [wan, dmz, 7],
      [dmz, wan, 80],
    ] as const) {
      const id = engine.openTcp(origin.id, target.interfaces[0].ip!, port);
      engine.advanceTo(engine.state.clock + 64000);
      expect(origin.tcpConnections?.find((entry) => entry.id === id)?.state).toBe('TIMED-OUT');
    }
    expect(edge.firewall!.sessions).toHaveLength(0);
    expect(edge.firewall!.dropped).toBeGreaterThanOrEqual(3);
  });
  it('aplica a primeira sequência correspondente, protocolo e porta de destino', () => {
    const { engine, edge } = network();
    const zones = edge.firewall!.zonePolicy!.zones;
    const rules: FirewallZonePolicy['rules'] = [
      { sequence: 30, from: 'LAN', to: 'WAN', action: 'inspect', protocol: 'ip' },
      { sequence: 10, from: 'LAN', to: 'WAN', action: 'deny', protocol: 'UDP', destinationPort: 53 },
      { sequence: 20, from: 'LAN', to: 'WAN', action: 'permit', protocol: 'UDP', destinationPort: 54 },
    ];
    engine.configureFirewall(edge.id, { enabled: true, zonePolicy: { zones, rules } });
    expect(permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[1], packet())).toBe(false);
    expect(
      permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[1], {
        ...packet(),
        destinationPort: 54,
      })
    ).toBe(true);
    expect(edge.firewall!.sessions).toHaveLength(0);
    expect(
      permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[1], {
        ...packet(),
        destinationPort: 55,
      })
    ).toBe(true);
    expect(edge.firewall!.sessions).toHaveLength(1);
    validateSnapshot(engine.snapshot());
  });
  it('permit não abre retorno; inspect abre retorno e valida o tuple', () => {
    const { engine, edge } = network();
    const zones = edge.firewall!.zonePolicy!.zones;
    const reply = {
      ...packet(),
      src: packet().dst,
      dst: packet().src,
      sourcePort: 53,
      destinationPort: 50123,
    };
    engine.configureFirewall(edge.id, {
      enabled: true,
      zonePolicy: {
        zones,
        rules: [{ sequence: 10, from: 'LAN', to: 'WAN', action: 'permit', protocol: 'UDP' }],
      },
    });
    expect(permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[1], packet())).toBe(true);
    expect(permitFirewall(engine, edge, edge.interfaces[1], edge.interfaces[0], reply)).toBe(false);
    engine.configureFirewall(edge.id, {
      enabled: true,
      zonePolicy: {
        zones,
        rules: [{ sequence: 10, from: 'LAN', to: 'WAN', action: 'inspect', protocol: 'UDP' }],
      },
    });
    expect(permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[1], packet())).toBe(true);
    const pending = structuredClone(edge.firewall!.sessions[0]);
    expect(
      permitFirewall(engine, edge, edge.interfaces[1], edge.interfaces[0], { ...reply, sourcePort: 54 })
    ).toBe(false);
    expect(edge.firewall!.sessions).toEqual([pending]);
    expect(permitFirewall(engine, edge, edge.interfaces[1], edge.interfaces[0], reply)).toBe(true);
    expect(edge.firewall!.sessions[0].state).toBe('REPLIED');
    engine.advanceTo(120000);
    expect(permitFirewall(engine, edge, edge.interfaces[1], edge.interfaces[0], reply)).toBe(false);
  });
  it('permite a mesma zona e bloqueia interfaces não atribuídas; regra deny tem precedência', () => {
    const { engine, edge } = network();
    engine.configureFirewall(edge.id, {
      enabled: true,
      zonePolicy: {
        zones: [
          { name: 'LAN', ports: ['p0', 'p2'] },
          { name: 'WAN', ports: ['p1'] },
        ],
        rules: [],
      },
    });
    expect(permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[2], packet())).toBe(true);
    expect(permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[3], packet())).toBe(false);
    engine.configureFirewall(edge.id, {
      ...edge.firewall!,
      zonePolicy: {
        ...edge.firewall!.zonePolicy!,
        rules: [{ sequence: 1, from: 'LAN', to: 'LAN', protocol: 'ip', action: 'deny' }],
      },
    });
    expect(permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[2], packet())).toBe(false);
  });
  it('correlaciona ICMP RELATED por zonas sem alterar timers; deny explícito bloqueia o erro', () => {
    const { engine, client, edge } = network();
    const probe = engine.ping(client.id, '192.168.20.10', 2);
    until(engine, () => engine.state.probes.find((entry) => entry.id === probe)?.status === 'time-exceeded');
    expect(edge.firewall!.sessions[0].state).toBe('UNREPLIED');
    engine.configureFirewall(edge.id, {
      ...edge.firewall!,
      zonePolicy: {
        ...edge.firewall!.zonePolicy!,
        rules: [
          ...edge.firewall!.zonePolicy!.rules,
          { sequence: 1, from: 'WAN', to: 'LAN', protocol: 'ICMP', action: 'deny' },
        ],
      },
    });
    const blocked = engine.ping(client.id, '192.168.20.10', 2);
    engine.advanceTo(1000);
    expect(engine.state.probes.find((entry) => entry.id === blocked)?.status).toBe('pending');
    expect(edge.firewall!.dropped).toBe(1);
    validateSnapshot(engine.snapshot());
  });
  it('rejeita erro sem citação, identificação ou portas alteradas e preserva a sessão', () => {
    const { engine, edge } = network();
    permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[1], packet());
    const session = structuredClone(edge.firewall!.sessions[0]);
    const error: IcmpPacket = {
      protocol: 'ICMP',
      src: '10.0.0.2',
      dst: packet().src,
      ttl: 64,
      bytes: 56,
      kind: 'time-exceeded',
      probeId: 'test',
      error: {
        code: 0,
        quote: {
          protocol: 'UDP',
          src: packet().src,
          dst: packet().dst,
          sourcePort: 50123,
          destinationPort: 53,
          ttl: 1,
        },
      },
    };
    expect(permitFirewall(engine, edge, edge.interfaces[1], edge.interfaces[0], error)).toBe(true);
    const forged = structuredClone(error);
    if (forged.error!.quote.protocol === 'UDP') forged.error!.quote.destinationPort++;
    const missing = structuredClone(error);
    delete missing.error;
    for (const invalid of [forged, missing, { ...error, dst: '192.168.10.99' }])
      expect(permitFirewall(engine, edge, edge.interfaces[1], edge.interfaces[0], invalid)).toBe(false);
    expect(edge.firewall!.sessions).toEqual([session]);
  });
  it('valida sequências TCP citadas, inclusive wraparound e ACK sem dados', () => {
    const { engine, edge } = network();
    const syn = {
      protocol: 'TCP' as const,
      src: packet().src,
      dst: packet().dst,
      sourcePort: 50123,
      destinationPort: 80,
      ttl: 64,
      bytes: 40,
      flags: ['SYN' as const],
      sequence: 0xffffffff,
      acknowledgment: 0,
      window: 4096,
      data: '',
    };
    expect(permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[1], syn)).toBe(true);
    const session = structuredClone(edge.firewall!.sessions[0]);
    const error: IcmpPacket = {
      protocol: 'ICMP',
      src: '10.0.0.2',
      dst: syn.src,
      ttl: 64,
      bytes: 56,
      kind: 'time-exceeded',
      probeId: 'test',
      error: {
        code: 0,
        quote: {
          protocol: 'TCP',
          src: syn.src,
          dst: syn.dst,
          sourcePort: 50123,
          destinationPort: 80,
          sequence: 0xffffffff,
          ttl: 1,
        },
      },
    };
    expect(permitFirewall(engine, edge, edge.interfaces[1], edge.interfaces[0], error)).toBe(true);
    if (error.error!.quote.protocol === 'TCP') error.error!.quote.sequence = 0;
    expect(permitFirewall(engine, edge, edge.interfaces[1], edge.interfaces[0], error)).toBe(true);
    if (error.error!.quote.protocol === 'TCP') error.error!.quote.sequence = 1;
    expect(permitFirewall(engine, edge, edge.interfaces[1], edge.interfaces[0], error)).toBe(false);
    expect(edge.firewall!.sessions).toEqual([session]);
  });
  it('persiste política e sessões e rejeita zonas, regras e sessões incoerentes', () => {
    const { engine, edge } = network();
    permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[1], packet());
    const restored = new SimulationEngine(engine.snapshot());
    expect(restored.snapshot()).toEqual(engine.snapshot());
    for (const mutate of [
      (policy: FirewallZonePolicy) => policy.zones[1].ports.push('p0'),
      (policy: FirewallZonePolicy) => policy.zones.push({ name: 'LAN', ports: [] }),
      (policy: FirewallZonePolicy) => (policy.rules[0].from = 'MISSING'),
      (policy: FirewallZonePolicy) => (policy.rules[1].sequence = 10),
      (policy: FirewallZonePolicy) => (policy.rules[0].destinationPort = 80),
      (policy: FirewallZonePolicy) => (policy.rules[0].action = 'permit'),
    ]) {
      const invalid = engine.snapshot();
      mutate(invalid.devices[1].firewall!.zonePolicy!);
      expect(() => validateSnapshot(invalid)).toThrow();
    }
  });
  it('CLI configura zonas/regras, mantém modo ao habilitar e reconstitui running-config', () => {
    const { engine, edge } = network();
    const expected = structuredClone(edge.firewall!.zonePolicy);
    const cli = new TerminalSession(engine, edge.id);
    const config = cli
      .execute('show running-config')
      .split('\n')
      .filter((line) => line.startsWith('firewall ') || line.endsWith('service firewall'));
    engine.configureFirewall(edge.id, { enabled: false, trustedPorts: [] });
    for (const command of ['enable', 'configure terminal', ...config])
      expect(cli.execute(command)).toBe('OK');
    expect(engine.device(edge.id).firewall!.zonePolicy).toEqual(expected);
    expect(cli.execute('firewall protocols tcp')).toBe('OK');
    expect(cli.execute('no service firewall')).toBe('OK');
    expect(cli.execute('service firewall')).toBe('OK');
    expect(engine.device(edge.id).firewall!.zonePolicy).toEqual(expected);
    expect(cli.execute('firewall zone DMZ Gi0/1')).toMatch(/^%/);
    expect(engine.device(edge.id).firewall!.zonePolicy).toEqual(expected);
    expect(cli.execute('firewall rule 5 WAN LAN deny ip')).toBe('OK');
    expect(cli.execute('show firewall zones')).toContain('firewall rule 5 WAN LAN deny ip');
    expect(cli.execute('no firewall rule 5')).toBe('OK');
    expect(cli.execute('no firewall zone DMZ')).toBe('OK');
    expect(engine.device(edge.id).firewall!.zonePolicy!.rules).toHaveLength(1);
    expect(cli.execute('firewall trust Gi0/1')).toBe('OK');
    expect(cli.execute('firewall mode trusted')).toBe('OK');
    expect(engine.device(edge.id).firewall!.zonePolicy).toBeUndefined();
    validateSnapshot(engine.snapshot());
  });
});
