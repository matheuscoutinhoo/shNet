import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  configurationDiff,
} from '../packages/simulation-engine/src';
import { releaseDhcp } from '../packages/simulation-engine/src/protocols/dhcp-client';

function commands(t: TerminalSession, lines: string[]) {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/);
}
describe('Cisco enterprise audit regressions', () => {
  it('preserves Rapid PVST and MST when a physical interface becomes routed', () => {
    for (const mode of ['rapid-pvst', 'mst']) {
      const e = new SimulationEngine(),
        d = e.addProfile('switch-l3'),
        t = new TerminalSession(e, d.id);
      commands(t, ['en', 'conf t', 'vlan 10', 'exit', 'spanning-tree mode ' + mode]);
      const config = structuredClone(d.multiSpanningTree);
      commands(t, ['interface Gi0/1', 'no switchport']);
      expect(d.multiSpanningTree?.mode).toBe(config?.mode);
      expect(d.multiSpanningTree?.priorities).toEqual(config?.priorities);
      expect(d.interfaces[0].spanningInstances?.length ?? 0).toBe(0);
      validateSnapshot(e.snapshot());
    }
  });
  it('enters and leaves VRF and address-family modes, and replays startup', () => {
    const e = new SimulationEngine(),
      d = e.addProfile('router'),
      t = new TerminalSession(e, d.id);
    commands(t, ['en', 'conf t', 'vrf definition CORP']);
    expect(t.context.mode).toBe('vrf');
    commands(t, ['address-family ipv4']);
    expect(t.context.mode).toBe('address-family');
    commands(t, ['exit-address-family']);
    expect(t.context.mode).toBe('vrf');
    commands(t, ['address-family ipv6', 'exit', 'exit']);
    expect(t.context.mode).toBe('config');
    commands(t, ['end', 'write memory', 'reload', '', 'en']);
    expect(e.device(d.id).vrfs).toEqual(['CORP']);
  });
  it('reports device uptime from boot and reload rather than the lab clock', () => {
    const e = new SimulationEngine();
    e.advanceTo(60000);
    const d = e.addFactoryProfile('router');
    e.setDevicePower(d.id, true);
    const t = new TerminalSession(e, d.id);
    commands(t, ['en']);
    expect(t.execute('show version')).toContain('uptime: 0.000');
    const before = e.snapshot();
    e.advanceTo(62000);
    expect(t.execute('show version')).toContain('uptime: 2.000');
    expect(configurationDiff(before, e.snapshot())).toEqual([]);
    commands(t, ['reload', 'no', '', 'en']);
    expect(t.execute('show version')).toContain('uptime: 0.000');
    expect(e.state.clock).toBe(62000);
  });
  it('relays DHCP on multilayer SVIs only through active HSRP and recovers after primary failure', () => {
    const e = new SimulationEngine(),
      cores = [e.addProfile('switch-l3'), e.addProfile('switch-l3')],
      sw = e.addDevice('switch'),
      client = e.addDevice('pc'),
      server = e.addDevice('server');
    e.configureSpanningTree(sw.id, 'off');
    for (const [i, d] of cores.entries()) {
      const t = new TerminalSession(e, d.id);
      commands(t, [
        'en',
        'conf t',
        'vlan 10',
        'exit',
        'vlan 99',
        'exit',
        'interface Gi0/1',
        'switchport mode trunk',
        'switchport trunk allowed vlan 10,99',
        'exit',
        'interface Vlan10',
        `ip address 10.0.10.${i + 2} 255.255.255.0`,
        'ip helper-address 10.0.99.67',
        'standby version 2',
        'standby 10 ip 10.0.10.1',
        `standby 10 priority ${i ? 100 : 120}`,
        'exit',
        'interface Vlan99',
        `ip address 10.0.99.${i + 2} 255.255.255.0`,
        'standby version 2',
        'standby 99 ip 10.0.99.1',
        `standby 99 priority ${i ? 100 : 120}`,
        'end',
      ]);
      Object.assign(sw.interfaces[i], { mode: 'trunk', allowedVlans: [10, 99] });
      e.connect({ device: d.id, port: 'p0' }, { device: sw.id, port: 'p' + i });
    }
    sw.vlans = [
      { id: 10, name: 'CLIENTS' },
      { id: 99, name: 'SERVICES' },
    ];
    sw.interfaces[2].accessVlan = 10;
    sw.interfaces[3].accessVlan = 99;
    e.connect({ device: client.id, port: 'p0' }, { device: sw.id, port: 'p2' });
    e.connect({ device: server.id, port: 'p0' }, { device: sw.id, port: 'p3' });
    Object.assign(server.interfaces[0], { ip: '10.0.99.67', prefix: 24 });
    server.gateway = '10.0.99.1';
    e.configureDhcpPool(server.id, {
      name: 'CORP',
      port: 'p0',
      network: '10.0.10.0',
      prefix: 24,
      start: '10.0.10.100',
      end: '10.0.10.120',
      gateway: '10.0.10.1',
      relayAddress: '10.0.10.2',
      relayAddresses: ['10.0.10.3'],
      dns: [],
      leaseMs: 3600000,
      excluded: [],
    });
    e.advanceTo(35000);
    expect(cores.map((d) => d.hsrp?.groups.find((g) => g.group === 10)?.state)).toEqual([
      'ACTIVE',
      'STANDBY',
    ]);
    e.requestDhcp(client.id, 'p0');
    e.advanceTo(37000);
    expect(client.interfaces[0].dhcp?.status).toBe('bound');
    const relays = e.state.events.filter((ev) => ev.type === 'DHCP_RELAY_REQUEST');
    expect(
      new Set(relays.map((ev) => ev.device)),
      JSON.stringify({
        relays: relays.map((ev) => ({ device: ev.device, port: ev.port, reason: ev.reason })),
        hsrp: cores.map((d) => d.hsrp),
      })
    ).toEqual(new Set([cores[0].id]));
    const saved = new SimulationEngine(e.snapshot());
    saved.setDevicePower(cores[0].id, false);
    saved.advanceTo(49000);
    releaseDhcp(saved, saved.device(client.id), saved.device(client.id).interfaces[0]);
    saved.advanceTo(49500);
    saved.requestDhcp(client.id, 'p0');
    saved.advanceTo(51500);
    expect(
      saved.device(client.id).interfaces[0].dhcp?.status,
      JSON.stringify({
        hsrp: saved.device(cores[1].id).hsrp,
        events: saved.state.events
          .filter((ev) => /DHCP|DROPPED/.test(ev.type))
          .slice(-20)
          .map((ev) => ({ type: ev.type, device: ev.device, reason: ev.reason })),
      })
    ).toBe('bound');
    expect(
      saved.state.events.some((ev) => ev.type === 'DHCP_RELAY_REQUEST' && ev.device === cores[1].id)
    ).toBe(true);
    validateSnapshot(saved.snapshot());
  });
});
