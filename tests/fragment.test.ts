import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  validateSnapshot,
  type Device,
  type Frame,
} from '../packages/simulation-engine/src';
function network() {
  const e = new SimulationEngine(),
    a = e.addDevice('pc'),
    r = e.addDevice('router'),
    s = e.addDevice('router'),
    b = e.addDevice('pc');
  const ip = (d: Device, p: number, ip: string, prefix: number, mtu: number, gateway?: string) =>
    Object.assign(d.interfaces[p], { ip, prefix, mtu, gateway });
  ip(a, 0, '10.0.0.10', 24, 1500, '10.0.0.1');
  ip(r, 0, '10.0.0.1', 24, 1500);
  ip(r, 1, '10.1.0.1', 30, 1000);
  ip(s, 0, '10.1.0.2', 30, 1000);
  ip(s, 1, '10.2.0.1', 24, 576);
  ip(b, 0, '10.2.0.10', 24, 576, '10.2.0.1');
  r.routes.push({ network: '10.2.0.0', prefix: 24, nextHop: '10.1.0.2', metric: 1 });
  s.routes.push({ network: '10.0.0.0', prefix: 24, nextHop: '10.1.0.1', metric: 1 });
  const link = (d: Device, p: number, v: Device, q: number) =>
    e.connect({ device: d.id, port: d.interfaces[p].id }, { device: v.id, port: v.interfaces[q].id });
  link(a, 0, r, 0);
  link(r, 1, s, 0);
  link(s, 1, b, 0);
  return { e, a, b, r, s };
}
describe('Fragmentação e reassembly IPv4', () => {
  it('envia bytes distintos, refragmenta em roteadores e entrega somente o datagrama completo', () => {
    const { e, a, b, r, s } = network();
    const id = e.ping(a.id, b.interfaces[0].ip!, 64, undefined, 4000);
    e.advanceTo(200);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    const sent = e.state.events.filter((v) => v.type === 'FRAME_SENT' && v.frame?.fragment);
    // Ordinary transit routers forward fragments rather than delivering payloads.
    expect(e.state.events.filter((v) => v.type === 'IP_REASSEMBLED').map((v) => v.device)).not.toContain(
      r.id
    );
    expect(e.state.events.filter((v) => v.type === 'IP_REASSEMBLED').map((v) => v.device)).not.toContain(
      s.id
    );
    expect(e.state.events.filter((v) => v.type === 'IP_REASSEMBLED').length).toBe(2);
    expect(e.state.events.some((v) => v.frame?.fragment?.offset && v.frame.fragment.more)).toBe(true);
    expect(
      sent.every(
        (v) => v.frame!.fragment!.bytes <= e.device(v.device).interfaces.find((p) => p.id === v.port)!.mtu
      )
    ).toBe(true);
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
  it('DF produz ICMP code 4 com MTU e impede fragmentação', () => {
    const { e, a, b } = network();
    const id = e.ping(a.id, b.interfaces[0].ip!, 64, undefined, 1400, true);
    e.advanceTo(200);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('unreachable');
    expect(
      e.state.events.some(
        (v) =>
          v.frame?.packet?.protocol === 'ICMP' &&
          v.frame.packet.error?.code === 4 &&
          v.frame.packet.error.mtu === 1000
      )
    ).toBe(true);
    expect(e.state.events.some((v) => v.frame?.fragment)).toBe(false);
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
  it('reordena e restaura bytes/timers pendentes, incluindo ARP de fragmentos', () => {
    const { e, a, b } = network();
    e.ping(a.id, b.interfaces[0].ip!, 64, undefined, 4000);
    for (let i = 0; i < 1000 && !e.state.devices.some((d) => d.fragmentPending?.length); i++) e.step();
    expect(e.state.devices.some((d) => d.fragmentPending?.length)).toBe(true);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(200);
    restored.advanceTo(200);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const broken = e.snapshot();
    broken.queue.push({
      at: broken.clock + 10,
      order: ++broken.sequence,
      action: { kind: 'fragment-expire', device: a.id, id: 'orphan', expiresAt: broken.clock + 10 },
    });
    broken.queue.sort((a, b) => a.at - b.at || a.order - b.order);
    expect(() => validateSnapshot(broken)).toThrow('fragmentos');
  });
  it('perda de um fragmento impede entrega e expira reassembly', () => {
    const { e, a, b } = network();
    const id = e.ping(a.id, b.interfaces[0].ip!, 64, undefined, 4000);
    for (
      let i = 0;
      i < 1000 &&
      !e.state.queue.some(
        (v) => v.action.kind === 'deliver' && v.action.device === b.id && v.action.frame.fragment?.more
      );
      i++
    )
      e.step();
    const lost = e.state.queue.findIndex(
      (v) => v.action.kind === 'deliver' && v.action.device === b.id && v.action.frame.fragment?.more
    );
    expect(lost).toBeGreaterThanOrEqual(0);
    e.state.queue.splice(lost, 1);
    e.advanceTo(31000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('timeout');
    expect(e.state.events.some((v) => v.type === 'IP_REASSEMBLY_TIMEOUT')).toBe(true);
    expect(b.reassemblies).toEqual([]);
  });
  it('fragmentos sobrepostos são rejeitados e não podem completar o datagrama', () => {
    const { e, a, b, s } = network();
    e.ping(a.id, b.interfaces[0].ip!, 64, undefined, 4000);
    for (let i = 0; i < 1000 && !b.reassemblies?.length; i++) e.step();
    const first = b.reassemblies![0].fragments[0];
    expect(first).toBeDefined();
    const attack: Frame = {
      src: s.interfaces[1].mac,
      dst: b.interfaces[0].mac,
      etherType: 'IPv4',
      hops: 16,
      fragment: { ...first, data: [...first.data], offset: first.offset + 8, first: undefined },
    };
    // Deliver the overlapping range before the remaining wire fragments.
    for (const q of e.state.queue)
      if (q.action.kind === 'deliver' && q.action.device === b.id && q.action.frame.fragment) q.at += 10;
    e.state.queue.sort((a, b) => a.at - b.at || a.order - b.order);
    e.sendFrame(s.id, s.interfaces[1].id, attack);
    e.advanceTo(200);
    expect(b.reassemblies?.some((r) => r.failed)).toBe(true);
    expect(e.state.events.filter((v) => v.type === 'IP_REASSEMBLED' && v.device === b.id)).toHaveLength(0);
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
});
