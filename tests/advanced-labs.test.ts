import { describe, it, expect } from 'vitest';
import {
  advancedLabs,
  makeLab,
  makeTemplate,
  evaluateLab,
  validateSnapshot,
  SimulationEngine,
} from '@shlab/engine';
describe('laboratórios avançados com tráfego novo', () => {
  for (const lab of advancedLabs)
    it(lab.name, () => {
      const broken = makeLab(lab.id);
      validateSnapshot(broken);
      const fail = evaluateLab(lab.id, broken);
      expect(fail.total).toBeGreaterThan(1);
      expect(fail.complete, JSON.stringify(fail)).toBe(false);
      const solved = makeTemplate(lab.template),
        before = structuredClone(solved),
        result = evaluateLab(lab.id, solved);
      expect(result.complete, JSON.stringify(result)).toBe(true);
      expect(solved).toEqual(before);
    });
  it('estado anterior e contadores não substituem tráfego novo', () => {
    const e = new SimulationEngine(makeTemplate('evpn'));
    e.advanceTo(2000);
    e.httpGet(e.state.devices.find((d) => d.type === 'pc')!.id, '10.50.0.20');
    e.advanceTo(3000);
    for (const l of e.state.links) l.loss = 1;
    expect(evaluateLab('evpn-repair', e.snapshot()).complete).toBe(false);
    expect(evaluateLab('aaa-repair', new SimulationEngine().snapshot()).complete).toBe(false);
  });
});
