import { describe, expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot } from '../packages/simulation-engine/src';
function setup(alg = true) {
  const e = new SimulationEngine(),
    phone = e.addDevice('pc'),
    router = e.addDevice('router'),
    remote = e.addDevice('server');
  Object.assign(phone.interfaces[0], { ip: '10.0.0.10', prefix: 24, gateway: '10.0.0.1' });
  Object.assign(router.interfaces[0], { ip: '10.0.0.1', prefix: 24, natRole: 'inside' });
  Object.assign(router.interfaces[1], { ip: '203.0.113.1', prefix: 24, natRole: 'outside' });
  Object.assign(remote.interfaces[0], { ip: '203.0.113.20', prefix: 24 });
  e.connect({ device: phone.id, port: 'p0' }, { device: router.id, port: 'p0' });
  e.connect({ device: remote.id, port: 'p0' }, { device: router.id, port: 'p1' });
  for (const [i, d] of [phone, remote].entries())
    e.configurePhone(d.id, {
      enabled: true,
      number: String(100 + i),
      sipPort: 5060,
      rtpPort: 20000,
      autoAnswer: true,
    });
  e.configureNat(router.id, {
    enabled: true,
    algSip: alg,
    statics: [],
    pools: [
      {
        name: 'PAT',
        source: { network: '10.0.0.0', prefix: 24 },
        start: '203.0.113.1',
        end: '203.0.113.1',
        outside: 'p1',
        overload: true,
      },
    ],
  });
  e.configureFirewall(router.id, {
    enabled: true,
    trustedPorts: [],
    zonePolicy: {
      zones: [
        { name: 'LAN', ports: ['p0'] },
        { name: 'WAN', ports: ['p1'] },
      ],
      rules: [
        { sequence: 10, from: 'LAN', to: 'WAN', protocol: 'UDP', destinationPort: 5060, action: 'inspect' },
      ],
    },
  });
  return { e, phone, router, remote };
}
describe('SIP, RTP e ALG', () => {
  it('negocia SDP através de PAT, permite apenas RTP relacionado e restaura diálogo', () => {
    const { e, phone, router, remote } = setup();
    const id = e.callPhone(phone.id, '203.0.113.20');
    e.advanceTo(400);
    expect(phone.phone!.calls[0]).toMatchObject({ id, state: 'ESTABLISHED' });
    expect(phone.phone!.calls[0].received).toBeGreaterThan(5);
    expect(remote.phone!.calls[0].received).toBeGreaterThan(5);
    expect(router.nat!.sipBindings).toHaveLength(1);
    expect(e.state.events.some((v) => v.reason.includes('RTP RELATED'))).toBe(true);
    validateSnapshot(e.snapshot());
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(1000);
    restored.advanceTo(1000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    e.hangupPhone(phone.id, id);
    e.advanceTo(1100);
    expect(remote.phone!.calls[0].state).toBe('CLOSED');
    expect(router.nat!.sipBindings).toHaveLength(0);
    validateSnapshot(e.snapshot());
  });
  it('rejeita SDP privado sem ALG e não autoriza mídia de origem diversa', () => {
    const { e, phone, router, remote } = setup(false);
    e.callPhone(phone.id, '203.0.113.20');
    e.advanceTo(16000);
    expect(phone.phone!.calls[0].state).toBe('FAILED');
    expect(remote.phone!.calls).toHaveLength(0);
    expect(router.nat!.sipBindings ?? []).toHaveLength(0);
    const active = setup();
    active.e.callPhone(active.phone.id, '203.0.113.20');
    active.e.advanceTo(100);
    const b = active.router.nat!.sipBindings![0];
    active.e.sendIp(active.remote.id, {
      protocol: 'UDP',
      src: '203.0.113.20',
      dst: b.global,
      ttl: 64,
      sourcePort: 20001,
      destinationPort: b.globalPort,
      bytes: 200,
      payload: {
        protocol: 'RTP',
        message: { callId: b.call, ssrc: 2, sequence: 400, timestamp: 0, data: 'forged' },
      },
    });
    active.e.advanceTo(105);
    expect(active.phone.phone!.calls[0].lastSequence).not.toBe(400);
    const bad = active.e.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'sip-alg-expire');
    expect(() => validateSnapshot(bad)).toThrow(/SIP ALG/);
  });
});
