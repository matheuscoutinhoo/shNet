import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  makeTemplate,
  validateSnapshot,
} from '../packages/simulation-engine/src';

describe('resolução ARP com retransmissão', () => {
  it('limita pacotes acumulados sem iniciar uma resolução por pacote', () => {
    const engine = new SimulationEngine(makeTemplate('lan')),
      client = engine.state.devices[0];
    engine.ping(client.id, '192.168.10.99');
    const packet = structuredClone(client.pending[0].packet);
    for (let index = 0; index < 300; index++) engine.sendIp(client.id, packet);
    expect(client.pending).toHaveLength(256);
    expect(client.arpResolutions).toHaveLength(1);
    expect(engine.state.events.filter((event) => event.type === 'ARP_REQUEST')).toHaveLength(1);
    expect(engine.state.events.some((event) => event.reason === 'Fila ARP cheia.')).toBe(true);
    validateSnapshot(engine.snapshot());
    engine.advanceTo(3001);
    expect(client.pending).toHaveLength(0);
    expect(client.arpResolutions).toHaveLength(0);
  });
  for (const loss of ['request', 'reply'] as const)
    it('recupera a perda do primeiro ARP ' + loss + ' e cancela os timers após resolver', () => {
      const engine = new SimulationEngine(makeTemplate('lan')),
        client = engine.state.devices[0];
      const probe = engine.ping(client.id, '192.168.10.20');
      if (loss === 'reply')
        while (!engine.state.events.some((event) => event.type === 'ARP_REPLY')) {
          expect(engine.step()).toBe(true);
          validateSnapshot(engine.snapshot());
        }
      engine.state.queue = engine.state.queue.filter(
        ({ action }) => !(action.kind === 'deliver' && action.frame.arp?.kind === loss)
      );
      engine.advanceTo(1200);
      expect(engine.state.probes.find((entry) => entry.id === probe)?.status).toBe('success');
      expect(
        engine.state.events.filter((event) => event.type === 'ARP_REQUEST' && event.device === client.id)
      ).toHaveLength(2);
      expect(client.arpResolutions).toHaveLength(0);
      expect(client.pending).toHaveLength(0);
      expect(
        engine.state.queue.some(({ action }) => action.kind === 'arp-timeout' && action.device === client.id)
      ).toBe(false);
      validateSnapshot(engine.snapshot());
    });

  it('compartilha a resolução de vários pacotes e preserva retry exato após save/load', () => {
    const engine = new SimulationEngine(makeTemplate('lan')),
      client = engine.state.devices[0];
    const first = engine.ping(client.id, '192.168.10.20'),
      second = engine.ping(client.id, '192.168.10.20');
    expect(client.arpResolutions).toHaveLength(1);
    expect(client.pending).toHaveLength(2);
    expect(new TerminalSession(engine, client.id).execute('show arp')).toContain('INCOMPLETE');
    engine.state.queue = engine.state.queue.filter(
      ({ action }) => !(action.kind === 'deliver' && action.frame.arp?.kind === 'request')
    );
    engine.advanceTo(1000);
    expect(client.arpResolutions?.[0].attempts).toBe(2);
    const restored = new SimulationEngine(engine.snapshot());
    engine.advanceTo(1500);
    restored.advanceTo(1500);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(
      engine.state.probes
        .filter((entry) => [first, second].includes(entry.id))
        .every((entry) => entry.status === 'success')
    ).toBe(true);
  });

  it('encerra três tentativas em 3 s, limita a fila e não aceita resposta tardia sem resolução', () => {
    const engine = new SimulationEngine(makeTemplate('lan')),
      client = engine.state.devices[0];
    engine.ping(client.id, '192.168.10.99');
    engine.ping(client.id, '192.168.10.99');
    engine.advanceTo(3001);
    expect(
      engine.state.events.filter((event) => event.type === 'ARP_REQUEST' && event.device === client.id)
    ).toHaveLength(3);
    expect(client.pending).toHaveLength(0);
    expect(client.arpResolutions).toHaveLength(0);
    expect(engine.state.events.some((event) => event.reason.includes('2 pacote(s) removido(s)'))).toBe(true);
    const target = engine.state.devices.find((entry) => entry.hostname === 'PC-02')!;
    engine.sendFrame(target.id, 'p0', {
      src: target.interfaces[0].mac,
      dst: client.interfaces[0].mac,
      etherType: 'ARP',
      hops: 32,
      arp: {
        kind: 'reply',
        senderIp: '192.168.10.99',
        senderMac: target.interfaces[0].mac,
        targetIp: '192.168.10.10',
      },
    });
    engine.advanceTo(3100);
    expect(client.arpTable.some((entry) => entry.ip === '192.168.10.99')).toBe(false);
    validateSnapshot(engine.snapshot());
  });

  it('recusa timers adulterados, mantém snapshots legados e limpa resolução de TCP abortado', () => {
    const engine = new SimulationEngine(makeTemplate('lan')),
      client = engine.state.devices[0];
    engine.ping(client.id, '192.168.10.99');
    const missing = engine.snapshot();
    missing.queue = missing.queue.filter(({ action }) => action.kind !== 'arp-timeout');
    expect(() => validateSnapshot(missing)).toThrow('ARP');
    const bad = engine.snapshot();
    bad.devices[0].arpResolutions![0].nextAt++;
    expect(() => validateSnapshot(bad)).toThrow('ARP');
    const badSource = engine.snapshot();
    badSource.devices[0].arpResolutions![0].sourceIp = '192.168.10.77';
    expect(() => validateSnapshot(badSource)).toThrow('ARP');
    const legacy = engine.snapshot();
    delete legacy.devices[0].arpResolutions;
    for (const { action } of legacy.queue) if (action.kind === 'arp-timeout') delete action.token;
    const restored = new SimulationEngine(legacy);
    restored.advanceTo(3001);
    expect(restored.state.devices[0].pending).toHaveLength(0);
    const tcp = new SimulationEngine(makeTemplate('lan'));
    const connection = tcp.openTcp(tcp.state.devices[0].id, '192.168.10.99', 80);
    tcp.closeTcp(tcp.state.devices[0].id, connection, true);
    validateSnapshot(tcp.snapshot());
    expect(
      tcp.state.devices[0].pending.every(
        ({ packet }) => packet.protocol === 'TCP' && packet.flags.includes('RST')
      )
    ).toBe(true);
    tcp.advanceTo(3001);
    validateSnapshot(tcp.snapshot());
    expect(tcp.state.devices[0].arpResolutions).toHaveLength(0);
  });

  it('DHCP RELEASE resolve o gateway após remover IPv4 e é persistido durante a resolução', () => {
    const engine = new SimulationEngine(makeTemplate('dhcp-relay'));
    engine.advanceTo(300);
    const client = engine.state.devices[0],
      server = engine.state.devices.find((device) => device.type === 'server')!;
    expect(client.arpTable).toHaveLength(0);
    engine.releaseDhcp(client.id, 'p0');
    expect(client.interfaces[0].ip).toBeUndefined();
    expect(client.pending).toHaveLength(1);
    const restored = new SimulationEngine(engine.snapshot());
    engine.advanceTo(600);
    restored.advanceTo(600);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(server.dhcpServer!.bindings.some((entry) => entry.clientMac === client.interfaces[0].mac)).toBe(
      false
    );
    expect(client.pending).toHaveLength(0);
  });
});
