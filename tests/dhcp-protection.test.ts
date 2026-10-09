import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  defaultDhcpPool,
  validateSnapshot,
  type Device,
  type Frame,
} from '../packages/simulation-engine/src';

function lan() {
  const e = new SimulationEngine(),
    s = e.addDevice('switch'),
    server = e.addDevice('server'),
    pc = e.addDevice('pc'),
    rogue = e.addDevice('server');
  Object.assign(server.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
  Object.assign(rogue.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
  const connect = (d: Device, p: number) =>
    e.connect({ device: d.id, port: d.interfaces[0].id }, { device: s.id, port: s.interfaces[p].id });
  connect(pc, 0);
  connect(server, 1);
  connect(rogue, 2);
  for (const d of [server, rogue])
    e.configureDhcpPool(d.id, {
      ...defaultDhcpPool(d, 'LAN'),
      start: d === server ? '10.0.0.100' : '10.0.0.200',
      end: d === server ? '10.0.0.105' : '10.0.0.205',
      leaseMs: 60000,
    });
  return { e, s, server, pc, rogue };
}
describe('Proteção DHCPv4 e conflitos ARP', () => {
  it('snooping bloqueia servidor indevido, aprende ACK e filtra IP/ARP falsos', () => {
    const { e, s, pc, server, rogue } = lan();
    e.configureDhcpSnooping(s.id, {
      enabled: true,
      vlans: [1],
      trustedPorts: [s.interfaces[1].id],
      sourceGuard: true,
      arpInspection: true,
    });
    e.setDhcpConflictDetection(pc.id, pc.interfaces[0].id, true);
    e.requestDhcp(pc.id, pc.interfaces[0].id);
    e.advanceTo(3500);
    expect(pc.interfaces[0].ip).toBe('10.0.0.100');
    expect(s.dhcpSnooping?.bindings[0].server).toBe(server.interfaces[0].ip);
    expect(s.dhcpSnooping!.dropped).toBeGreaterThan(0);
    const id = e.ping(pc.id, server.interfaces[0].ip!);
    e.advanceTo(3600);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    const count = s.dhcpSnooping!.dropped;
    const frame: Frame = {
      src: rogue.interfaces[0].mac,
      dst: 'ff:ff:ff:ff:ff:ff',
      etherType: 'ARP',
      hops: 16,
      arp: {
        kind: 'reply',
        senderIp: pc.interfaces[0].ip!,
        senderMac: rogue.interfaces[0].mac,
        targetIp: server.interfaces[0].ip!,
      },
    };
    e.sendFrame(rogue.id, rogue.interfaces[0].id, frame);
    e.advanceTo(3700);
    expect(s.dhcpSnooping!.dropped).toBeGreaterThan(count);
    Object.assign(rogue.interfaces[0], { ip: '10.0.0.100', prefix: 24 });
    e.ping(rogue.id, '10.0.0.1');
    e.advanceTo(3800);
    expect(e.state.events.some((v) => v.reason.includes('IP Source Guard') || v.reason.includes('DAI'))).toBe(
      true
    );
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(10000);
    restored.advanceTo(10000);
    expect(restored.snapshot()).toEqual(e.snapshot());
  });
  it('cliente faz probes antes de usar IP, envia DECLINE e obtém endereço livre', () => {
    const { e, s, pc, server, rogue } = lan();
    e.setDhcpEnabled(rogue.id, false);
    rogue.interfaces[0].ip = '10.0.0.100';
    e.setDhcpConflictDetection(pc.id, pc.interfaces[0].id, true);
    e.requestDhcp(pc.id, pc.interfaces[0].id);
    e.advanceTo(100);
    expect(pc.interfaces[0].ip).toBeUndefined();
    expect(server.dhcpServer?.declined?.[0].address).toBe('10.0.0.100');
    e.advanceTo(8000);
    expect(pc.interfaces[0].dhcp?.status).toBe('bound');
    expect(pc.interfaces[0].ip).toBe('10.0.0.101');
    expect(
      e.state.events.some(
        (v) =>
          v.frame?.packet?.protocol === 'UDP' &&
          v.frame.packet.payload.protocol === 'DHCP' &&
          v.frame.packet.payload.message.type === 'decline'
      )
    ).toBe(true);
    expect(s.macTable.length).toBeGreaterThan(0);
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
  it('preserva probing/restauração, valida timer e recusa ACK sem REQUEST', () => {
    const { e, s, pc, server, rogue } = lan();
    e.setDhcpEnabled(rogue.id, false);
    e.setDhcpConflictDetection(pc.id, pc.interfaces[0].id, true);
    e.requestDhcp(pc.id, pc.interfaces[0].id);
    e.advanceTo(100);
    expect(pc.interfaces[0].dhcp?.status).toBe('probing');
    const malformed = e.snapshot();
    malformed.queue = malformed.queue.filter(
      ({ action }) => action.kind !== 'dhcp-client-timer' || action.timer !== 'probe'
    );
    expect(() => validateSnapshot(malformed)).toThrow('probing');
    const missing = e.snapshot();
    missing.devices.find((d) => d.id === pc.id)!.interfaces[0].dhcp!.pendingLease = undefined;
    expect(() => validateSnapshot(missing)).toThrow('probing');
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(3500);
    restored.advanceTo(3500);
    expect(restored.snapshot()).toEqual(e.snapshot());
    e.configureDhcpSnooping(s.id, { enabled: true, vlans: [1], trustedPorts: [s.interfaces[1].id] });
    const ack: Frame = {
      src: server.interfaces[0].mac,
      dst: 'ff:ff:ff:ff:ff:ff',
      etherType: 'IPv4',
      hops: 16,
      packet: {
        protocol: 'UDP',
        src: '10.0.0.1',
        dst: '255.255.255.255',
        ttl: 64,
        sourcePort: 67,
        destinationPort: 68,
        bytes: 328,
        payload: {
          protocol: 'DHCP',
          message: {
            type: 'ack',
            transactionId: 'forged',
            clientMac: pc.interfaces[0].mac,
            clientIp: '0.0.0.0',
            server: '10.0.0.1',
            address: '10.0.0.110',
            prefix: 24,
            dns: [],
            leaseMs: 60000,
          },
        },
      },
    };
    e.sendFrame(server.id, server.interfaces[0].id, ack);
    e.advanceTo(3700);
    expect(s.dhcpSnooping?.bindings).toEqual([]);
    expect(s.dhcpSnooping!.dropped).toBeGreaterThan(0);
  });
});
