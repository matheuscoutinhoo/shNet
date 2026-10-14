import { describe, expect, it } from 'vitest';
import { acquireTopologyValidator } from '../apps/api/src/topology-validation';
import { capacityTopology } from '../scripts/capacity-topology';
describe('Validação de saves grandes', () => {
  it('recusa saturação com erro recuperável e conclui os saves já admitidos', async () => {
    const validator = acquireTopologyValidator(),
      snapshot = capacityTopology(250).snapshot;
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 40 }, () => validator.validate(snapshot))
      );
      const failures = results.filter((r) => r.status === 'rejected');
      expect(failures).toHaveLength(8);
      for (const failure of failures)
        if (failure.status === 'rejected') expect(failure.reason).toMatchObject({ statusCode: 503 });
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(32);
    } finally {
      await validator.close();
    }
    await expect(validator.validate({ devices: [] })).rejects.toMatchObject({ statusCode: 503 });
  }, 30000);
  it('valida o grafo no Worker, recusa cabo órfão e conserva o serviço ao fechar outra instância', async () => {
    const first = acquireTopologyValidator(),
      second = acquireTopologyValidator();
    const snapshot = capacityTopology(250).snapshot;
    try {
      const restored = await first.validate(snapshot);
      expect(restored.devices.map((d) => d.id)).toEqual(snapshot.devices.map((d) => d.id));
      expect(restored.links).toEqual(snapshot.links);
      const invalid = structuredClone(snapshot);
      invalid.links[0].a.device = 'missing-device';
      await expect(first.validate(invalid)).rejects.toMatchObject({ statusCode: 400 });
      await first.close();
      expect((await second.validate(snapshot)).devices).toHaveLength(250);
    } finally {
      await first.close();
      await second.close();
    }
  }, 20000);
});
