import { it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  configurationDiff,
} from '../packages/simulation-engine/src';
import { cloneTopology } from '../apps/web/src/workspace/cloneTopology';
it('clones enterprise policy and monitoring configuration without original timers, MACs or runtime', () => {
  const e = new SimulationEngine(),
    sw = e.addProfile('switch-l3'),
    pc = e.addDevice('pc'),
    t = new TerminalSession(e, sw.id);
  for (const c of [
    'en',
    'conf t',
    'vlan 30',
    'exit',
    'interface Gi0/1',
    'no switchport',
    'ip address 192.0.2.1 255.255.255.0',
    'bfd interval 50 min_rx 50 multiplier 3',
    'exit',
    'class-map match-any VOICE',
    'match ip dscp ef',
    'exit',
    'policy-map WAN',
    'class VOICE',
    'priority percent 30',
    'exit',
    'class class-default',
    'shape average 1000000',
    'exit',
    'exit',
    'interface Gi0/1',
    'service-policy output WAN',
    'exit',
    'interface Gi0/2',
    'switchport voice vlan 30',
    'switchport port-security',
    'switchport port-security mac-address ' + pc.interfaces[0].mac,
    'udld port aggressive',
    'exit',
    'ip sla 10',
    'icmp-echo 192.0.2.2 source-interface Gi0/1',
    'frequency 1',
    'exit',
    'ip sla schedule 10 life forever start-time now',
    'track 10 ip sla 10 reachability',
    'end',
  ])
    expect(t.execute(c), c).not.toMatch(/^%/);
  const original = e.snapshot();
  e.advanceTo(1000);
  expect(configurationDiff(original, e.snapshot())).toEqual([]);
  const source = e.snapshot(),
    result = cloneTopology(source, [sw.id, pc.id]),
    copy = result.snapshot.devices.find((d) => d.id !== sw.id && d.profile === sw.profile)!,
    host = result.snapshot.devices.find((d) => d.id !== pc.id && d.type === 'pc')!;
  expect(copy.monitoring?.token).not.toBe(sw.monitoring?.token);
  expect(copy.monitoring?.operations[0].target).not.toBe(sw.monitoring?.operations[0].target);
  expect(copy.monitoring?.operations[0].probe).toBeUndefined();
  expect(copy.interfaces[1].portSecurity?.macs).toEqual([host.interfaces[0].mac]);
  expect(copy.interfaces[1].voiceVlan).not.toBe(30);
  expect(copy.vlans.some((v) => v.id === copy.interfaces[1].voiceVlan)).toBe(true);
  expect(copy.interfaces[0].qos?.queues).toEqual([]);
  expect(copy.interfaces[0].bfd?.sessions).toEqual([]);
  expect(copy.interfaces[1].udld?.peers).toEqual([]);
  expect(copy.mqc?.attachments[0].port).toBe(copy.interfaces[0].id);
  validateSnapshot(result.snapshot);
  expect(e.snapshot()).toEqual(source);
});
