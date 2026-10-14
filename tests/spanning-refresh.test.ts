import { expect, it } from 'vitest';
import { SimulationEngine, makeTemplate } from '@shlab/engine';
it('refresh incremental conserva o snapshot de execução com refresh por evento, inclusive falhas', () => {
  const source = makeTemplate('enterprise-datacenter'),
    baseline = new SimulationEngine(source),
    optimized = new SimulationEngine(source);
  const advanceBaseline = (time: number) => {
    while ((baseline.state.queue[0]?.at ?? Infinity) <= time) baseline.step();
    baseline.advanceTo(time);
  };
  for (const time of [1000, 4000, 10000]) {
    advanceBaseline(time);
    optimized.advanceTo(time, 100000);
    expect(optimized.snapshot()).toEqual(baseline.snapshot());
  }
  for (const e of [baseline, optimized])
    e.setDevicePower(e.state.devices.find((d) => d.hostname === 'CORE-A')!.id, false);
  advanceBaseline(15000);
  optimized.advanceTo(15000, 100000);
  expect(optimized.snapshot()).toEqual(baseline.snapshot());
}, 30000);
