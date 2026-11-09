import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  makeTemplate,
  validateSnapshot,
} from '../packages/simulation-engine/src';

/** PC-01 (192.168.10.10) — R-01 — R-02 — PC-02 (192.168.20.10); PC-01 has a /16 mask and no gateway. */
function lab() {
  const e = new SimulationEngine(makeTemplate('static'));
  const pc = e.state.devices.find((d) => d.hostname === 'PC-01')!,
    r1 = e.state.devices.find((d) => d.hostname === 'R-01')!;
  pc.interfaces[0].prefix = 16;
  delete pc.gateway;
  const t = new TerminalSession(e, r1.id);
  t.execute('enable');
  const ping = () => {
    const id = e.ping(pc.id, '192.168.20.10');
    e.advanceTo(e.state.clock + 4000);
    return e.state.probes.find((p) => p.id === id)?.status;
  };
  return { e, pc, r1, t, ping };
}

describe('IOS proxy ARP', () => {
  it('is on by default: the router answers for a remote host with its own MAC', () => {
    const { e, pc, r1, t, ping } = lab();
    expect(ping()).toBe('success');
    const entry = pc.arpTable.find((a) => a.ip === '192.168.20.10');
    expect(entry?.mac).toBe(r1.interfaces[0].mac);
    expect(e.state.events.some((v) => v.type === 'ARP_REPLY' && v.reason.startsWith('Proxy ARP'))).toBe(true);
    expect(t.execute('show ip interface ' + r1.interfaces[0].name)).toContain('Proxy ARP is enabled');
    expect(t.execute('show running-config')).not.toContain('proxy-arp');
    validateSnapshot(e.snapshot());
  });

  it('"no ip proxy-arp" stops the answers and is saved in running-config', () => {
    const { pc, r1, t, ping } = lab();
    for (const line of ['configure terminal', 'interface ' + r1.interfaces[0].name, 'no ip proxy-arp', 'end'])
      expect(t.execute(line), line).toBe('');
    pc.arpTable = [];
    expect(ping()).not.toBe('success');
    expect(t.execute('show ip interface ' + r1.interfaces[0].name)).toContain('Proxy ARP is disabled');
    expect(t.execute('show running-config')).toMatch(
      /interface GigabitEthernet0\/1\n(?: .*\n)* no ip proxy-arp\n/
    );
    for (const line of ['configure terminal', 'interface ' + r1.interfaces[0].name, 'ip proxy-arp', 'end'])
      t.execute(line);
    expect(ping()).toBe('success');
  });

  it('does not answer through the default route or for the arrival interface', () => {
    const { e, r1, ping } = lab();
    r1.routes = [{ network: '0.0.0.0', prefix: 0, nextHop: '10.0.0.2', metric: 1 }];
    expect(ping()).not.toBe('success');
    expect(e.state.events.some((v) => v.type === 'ARP_REPLY' && v.reason.startsWith('Proxy ARP'))).toBe(
      false
    );
  });
});
