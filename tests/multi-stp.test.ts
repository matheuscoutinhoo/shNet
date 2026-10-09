import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  spanningPortState,
  type Device,
} from '../packages/simulation-engine/src';

function topology(mode: 'pvst' | 'mstp') {
  const e = new SimulationEngine();
  const switches = Array.from({ length: 3 }, () => e.addDevice('switch'));
  const pcs = Array.from({ length: 4 }, () => e.addDevice('pc'));
  const connect = (a: Device, pa: number, b: Device, pb: number) =>
    e.connect({ device: a.id, port: a.interfaces[pa].id }, { device: b.id, port: b.interfaces[pb].id });
  for (const d of switches) {
    d.vlans.push({ id: 10, name: 'TEN' }, { id: 20, name: 'TWENTY' });
    for (const p of d.interfaces.slice(1, 3))
      Object.assign(p, { mode: 'trunk', nativeVlan: 1, allowedVlans: [1, 10, 20] });
    Object.assign(d.interfaces[0], { accessVlan: 10, stpEdge: true });
    Object.assign(d.interfaces[3], { accessVlan: 20, stpEdge: true });
  }
  pcs.forEach((d, i) => {
    Object.assign(d.interfaces[0], { ip: `10.${i < 2 ? 10 : 20}.0.${(i % 2) + 10}`, prefix: 24 });
    connect(d, 0, switches[i % 2 === 0 ? 0 : 2], i < 2 ? 0 : 3);
  });
  connect(switches[0], 1, switches[1], 1);
  const direct = connect(switches[0], 2, switches[2], 1);
  connect(switches[1], 2, switches[2], 2);
  switches.forEach((d, index) =>
    e.configureMultiSpanningTree(d.id, {
      mode,
      region: 'CAMPUS',
      revision: 7,
      mappings:
        mode === 'mstp'
          ? [
              { vlan: 10, instance: 1 },
              { vlan: 20, instance: 2 },
            ]
          : [],
      priorities: [
        { instance: mode === 'mstp' ? 1 : 10, priority: index === 0 ? 4096 : 32768 },
        { instance: mode === 'mstp' ? 2 : 20, priority: index === 1 ? 4096 : 32768 },
      ],
    })
  );
  e.advanceTo(200);
  return { e, switches, pcs, direct };
}
describe('PVST e MSTP por instância', () => {
  it.each(['pvst', 'mstp'] as const)(
    '%s elege raízes por BPDUs e encaminha VLANs por caminhos distintos',
    (mode) => {
      const { e, switches, pcs, direct } = topology(mode);
      const s = switches[2];
      expect(spanningPortState(s, s.interfaces[1], 10)).toMatchObject({ role: 'root', state: 'forwarding' });
      expect(spanningPortState(s, s.interfaces[2], 10)).toMatchObject({
        role: 'alternate',
        state: 'discarding',
      });
      expect(spanningPortState(s, s.interfaces[2], 20)).toMatchObject({ role: 'root', state: 'forwarding' });
      for (const i of [0, 2]) {
        const id = e.ping(pcs[i].id, pcs[i + 1].interfaces[0].ip!);
        e.advanceTo(e.state.clock + 100);
        expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
      }
      expect(e.state.events.some((v) => v.frame?.bpdu?.instance === (mode === 'pvst' ? 10 : 1))).toBe(true);
      const restored = new SimulationEngine(e.snapshot());
      e.advanceTo(5000);
      restored.advanceTo(5000);
      expect(restored.snapshot()).toEqual(e.snapshot());
      direct.up = false;
      e.advanceTo(6000);
      expect(spanningPortState(s, s.interfaces[2], 10)).toMatchObject({ role: 'root', state: 'forwarding' });
      const id = e.ping(pcs[0].id, pcs[1].interfaces[0].ip!);
      e.advanceTo(6100);
      expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
      expect(() => validateSnapshot(e.snapshot())).not.toThrow();
    }
  );
  it('MSTP identifica fronteira por região/revisão/mapa e usa CIST externamente', () => {
    const { e, switches } = topology('mstp');
    const c = switches[2].multiSpanningTree!;
    e.configureMultiSpanningTree(switches[2].id, {
      mode: c.mode,
      region: c.region,
      revision: 8,
      mappings: c.mappings,
      priorities: c.priorities,
    });
    e.advanceTo(5000);
    expect(switches[2].interfaces.slice(1, 3).every((p) => p.mstBoundary)).toBe(true);
    const p = switches[2].interfaces[1];
    expect(spanningPortState(switches[2], p, 20)).toEqual(p.spanningTree);
    expect(p.spanningInstances!.every((i) => !i.state.operational && i.state.state === 'discarding')).toBe(
      true
    );
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
  it('CLI, prioridades, timers e estados importados são validados por instância', () => {
    const { e, switches } = topology('pvst');
    const cli = new TerminalSession(e, switches[0].id);
    cli.execute('enable');
    cli.execute('configure terminal');
    expect(cli.execute('show spanning-tree instance 10')).toContain('PVST / RSTP / instância 10');
    expect(cli.execute('show spanning-tree instance 10')).toContain('forwarding');
    const snapshot = e.snapshot();
    expect(
      cli.execute('spanning-tree configure {"mode":"mstp","mappings":[{"vlan":999,"instance":1}]}')
    ).toMatch(/^%/);
    expect(e.snapshot()).toEqual(snapshot);
    const bad = e.snapshot();
    bad.queue = bad.queue.filter(({ action }) => action.kind !== 'stp-hello' || action.instance !== 10);
    expect(() => validateSnapshot(bad)).toThrow('Hello');
    const malformed = e.snapshot();
    malformed.devices[0].interfaces[0].spanningInstances!.push(
      malformed.devices[0].interfaces[0].spanningInstances![0]
    );
    expect(() => validateSnapshot(malformed)).toThrow('instâncias');
  });
});
