import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  encodeEthernet,
  decodeEthernet,
} from '../packages/simulation-engine/src';
import { phoneVoiceVlan } from '../packages/simulation-engine/src/protocols/voice-vlan';
import { cloneTopology } from '../apps/web/src/workspace/cloneTopology';
const run = (t: TerminalSession, commands: string[]) => {
  for (const c of commands) expect(t.execute(c), c).not.toMatch(/^%/);
};
function network() {
  const e = new SimulationEngine(),
    switches = [e.addProfile('switch-l3'), e.addProfile('switch-l3')],
    phones = [e.addProfile('phone'), e.addProfile('phone')];
  e.state.capture = { frames: [], dropped: 0, includeControl: true, startedAt: 0 };
  switches.forEach((d, i) => {
    run(new TerminalSession(e, d.id), [
      'en',
      'conf t',
      'vlan 10',
      'name DATA',
      'exit',
      'vlan 30',
      'name VOICE',
      'exit',
      'vlan 40',
      'name NEW-VOICE',
      'exit',
      'spanning-tree mode rapid-pvst',
      'cdp run',
      'cdp timer 5',
      'cdp holdtime 10',
      'interface Gi0/1',
      'switchport mode access',
      'switchport access vlan 10',
      'switchport voice vlan 30',
      'spanning-tree portfast',
      'exit',
      'interface Gi0/2',
      'switchport mode trunk',
      'switchport trunk allowed vlan 10,30,40',
      'end',
    ]);
    Object.assign(phones[i].interfaces[0], { ip: '10.30.0.' + (10 + i), prefix: 24 });
    e.connect({ device: d.id, port: 'p0' }, { device: phones[i].id, port: 'p0' });
  });
  e.connect({ device: switches[0].id, port: 'p1' }, { device: switches[1].id, port: 'p1' });
  e.advanceTo(5000);
  return { e, switches, phones };
}
describe('CDP voice VLAN provisioning and tagged calls', () => {
  it('rejects untagged data-VLAN frames at a phone with an active learned voice policy', () => {
    const { e, switches, phones } = network(),
      host = e.addDevice('pc');
    Object.assign(host.interfaces[0], { ip: '10.30.0.66', prefix: 24 });
    run(new TerminalSession(e, switches[0].id), [
      'en',
      'conf t',
      'interface Gi0/3',
      'switchport access vlan 10',
      'spanning-tree portfast',
      'end',
    ]);
    e.connect({ device: switches[0].id, port: 'p2' }, { device: host.id, port: 'p0' });
    const probe = e.ping(host.id, '10.30.0.10');
    e.advanceTo(8500);
    expect(e.state.probes.find((p) => p.id === probe)?.status).not.toBe('success');
    expect(
      e.state.events.some(
        (v) => v.device === phones[0].id && v.type === 'PACKET_DROPPED' && v.reason.startsWith('Voice VLAN:')
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('learns the port-local Cisco voice policy and exchanges SIP/RTP across a trunk', () => {
    const { e, switches, phones } = network();
    for (const phone of phones) expect(phoneVoiceVlan(e.state, phone, phone.interfaces[0])).toBe(30);
    const id = e.callPhone(phones[0].id, '10.30.0.11');
    e.advanceTo(6500);
    expect(phones[0].phone!.calls.find((c) => c.id === id)?.state).toBe('ESTABLISHED');
    expect(phones[1].phone!.calls[0].received).toBeGreaterThan(20);
    const frames = e.state.events
        .filter((v) => v.device === phones[0].id && v.type === 'FRAME_SENT')
        .flatMap((v) => (v.frame ? [v.frame] : [])),
      media = frames.filter((f) => f.packet?.protocol === 'UDP' && f.packet.payload.protocol === 'RTP');
    expect(media.length).toBeGreaterThan(20);
    expect(media.every((f) => f.vlan === 30 && f.pcp === 5 && f.packet?.dscp === 46)).toBe(true);
    const cdp =
      e.state.capture!.frames.find((v) => v.frame.discovery?.voiceVlan === 30)?.frame ??
      e.state.events.find((v) => v.frame?.discovery?.voiceVlan === 30)?.frame;
    expect(cdp).toBeDefined();
    if (cdp) {
      const b = encodeEthernet(cdp);
      expect(Buffer.from(b).includes(Buffer.from('000e000701001e', 'hex'))).toBe(true);
      expect(decodeEthernet(b).discovery?.voiceVlan).toBe(30);
    }
    expect(switches[0].macTable.some((m) => m.mac === phones[0].interfaces[0].mac && m.vlan === 30)).toBe(
      true
    );
    validateSnapshot(e.snapshot());
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(7000);
    restored.advanceTo(7000);
    expect(restored.snapshot()).toEqual(e.snapshot());
  });
  it('withdraws stale policy on carrier loss, refreshes a changed VLAN, and clears old LAN state', () => {
    const { e, switches, phones } = network(),
      phone = phones[0],
      sw = switches[0];
    const id = e.callPhone(phone.id, '10.30.0.11');
    e.advanceTo(6000);
    expect(phone.arpTable.length).toBeGreaterThan(0);
    run(new TerminalSession(e, sw.id), [
      'en',
      'conf t',
      'interface Gi0/1',
      'switchport voice vlan 40',
      'end',
    ]);
    e.advanceTo(6100);
    expect(phoneVoiceVlan(e.state, phone, phone.interfaces[0])).toBe(40);
    expect(phone.arpTable).toEqual([]);
    expect(phone.phone?.calls.find((c) => c.id === id)?.state).toBe('FAILED');
    e.setPort(phone.id, 'p0', false);
    expect(phoneVoiceVlan(e.state, phone, phone.interfaces[0])).toBeUndefined();
    e.setPort(phone.id, 'p0', true);
    e.advanceTo(6200);
    expect(phoneVoiceVlan(e.state, phone, phone.interfaces[0])).toBe(40);
    run(new TerminalSession(e, sw.id), ['en', 'conf t', 'no cdp run', 'end']);
    e.advanceTo(17000);
    expect(phoneVoiceVlan(e.state, phone, phone.interfaces[0])).toBeUndefined();
    validateSnapshot(e.snapshot());
  });
  it('keeps voice policy configuration through switch reload and re-learns it on independent clones', () => {
    const { e, switches, phones } = network(),
      t = new TerminalSession(e, switches[0].id);
    run(t, ['en', 'write memory', 'reload', '']);
    e.advanceTo(6000);
    const reloadedPhone = e.device(phones[0].id);
    expect(phoneVoiceVlan(e.state, reloadedPhone, reloadedPhone.interfaces[0])).toBe(30);
    const source = e.snapshot(),
      cloned = cloneTopology(
        source,
        [...switches, ...phones].map((d) => d.id)
      ),
      s = new SimulationEngine(cloned.snapshot),
      phone = s.state.devices.find(
        (d) => d.id !== phones[0].id && d.id !== phones[1].id && d.profile === 'phone'
      )!;
    expect(phone.discovery?.neighbors).toEqual([]);
    s.advanceTo(12000);
    const neighbor = phone.discovery!.neighbors.find((n) => n.voiceVlan !== undefined)!;
    expect(neighbor).toBeDefined();
    expect(neighbor.voiceVlan).not.toBe(30);
    expect(phoneVoiceVlan(s.state, phone, phone.interfaces[0])).toBe(neighbor.voiceVlan);
    validateSnapshot(s.snapshot());
    expect(e.snapshot()).toEqual(source);
  });
  it('renews DHCP in the learned voice VLAN instead of retaining a data-VLAN lease', () => {
    const e = new SimulationEngine(),
      sw = e.addProfile('switch-l3'),
      phone = e.addProfile('phone'),
      server = e.addProfile('dhcp'),
      t = new TerminalSession(e, sw.id);
    run(t, [
      'en',
      'conf t',
      'cdp run',
      'vlan 10',
      'exit',
      'vlan 30',
      'exit',
      'interface Gi0/1',
      'switchport mode access',
      'switchport access vlan 10',
      'switchport voice vlan 30',
      'spanning-tree portfast',
      'exit',
      'interface Gi0/2',
      'switchport access vlan 30',
      'spanning-tree portfast',
      'end',
    ]);
    Object.assign(server.interfaces[0], { ip: '10.30.0.1', prefix: 24 });
    e.configureDhcpPool(server.id, {
      name: 'VOICE',
      port: 'p0',
      network: '10.30.0.0',
      prefix: 24,
      start: '10.30.0.100',
      end: '10.30.0.110',
      gateway: '10.30.0.1',
      leaseMs: 3600000,
      excluded: [],
      dns: [],
    });
    e.connect({ device: sw.id, port: 'p0' }, { device: phone.id, port: 'p0' });
    e.connect({ device: sw.id, port: 'p1' }, { device: server.id, port: 'p0' });
    e.requestDhcp(phone.id, 'p0');
    e.advanceTo(5000);
    expect(phoneVoiceVlan(e.state, phone, phone.interfaces[0])).toBe(30);
    expect(phone.interfaces[0].dhcp?.status).toBe('bound');
    expect(phone.interfaces[0].ip).toMatch(/^10\.30\.0\.10/);
    validateSnapshot(e.snapshot());
  });
});
