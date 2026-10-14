import { SimulationEngine } from './core/engine';
import { validateSnapshot } from './core/validation';
import { configurationDiff } from './configuration-review';
import { configurationPatchSchema, type ConfigurationPatch } from './configuration-patch-model';
export { configurationPatchSchema } from './configuration-patch-model';
export type { ConfigurationPatch } from './configuration-patch-model';
export function applyConfigurationPatch(engine: SimulationEngine, input: unknown) {
  const patch = configurationPatchSchema.parse(input),
    before = engine.snapshot();
  const draft = new SimulationEngine(before),
    rollback: ConfigurationPatch = [],
    seen = new Set<string>();
  for (const change of patch) {
    const d = draft.state.devices.find((d) => d.id === change.device || d.hostname === change.device);
    if (!d || seen.has(d.id))
      throw new Error('Equipamento inexistente ou repetido na proposta: ' + change.device);
    if (!change.ports && !change.routes && change.firewall === undefined)
      throw new Error('Proposta sem alterações.');
    seen.add(d.id);
    const original: ConfigurationPatch[number] = { device: d.id };
    if (change.routes) {
      original.routes = structuredClone(d.routes);
      d.routes = structuredClone(change.routes);
    }
    if (change.firewall !== undefined) {
      if (d.firewall) {
        original.firewall = Object.fromEntries(
          Object.entries(structuredClone(d.firewall)).filter(
            ([key]) => !['sessions', 'dropped'].includes(key)
          )
        ) as typeof original.firewall;
      } else original.firewall = null;
      draft.configureFirewall(d.id, change.firewall ?? { enabled: false, trustedPorts: [] });
      if (change.firewall === null) delete d.firewall;
    }
    if (change.ports) {
      original.ports = [];
      const ports = new Set<string>();
      for (const edit of change.ports) {
        const p = d.interfaces.find((p) => p.id === edit.port || p.name === edit.port);
        if (!p || ports.has(p.id))
          throw new Error('Interface inexistente ou repetida: ' + d.hostname + '/' + edit.port);
        ports.add(p.id);
        if ((p.ipv4Mode === 'dhcp' || p.dhcp) && ['ip', 'prefix', 'dns', 'gateway'].some((k) => k in edit))
          throw new Error('Desabilite DHCP antes de editar o endereço: ' + d.hostname);
        const saved: NonNullable<ConfigurationPatch[number]['ports']>[number] = { port: p.id };
        const keys = Object.keys(edit).filter((k) => k !== 'port');
        if (!keys.length) throw new Error('Interface sem alterações.');
        for (const key of keys) {
          const target = key === 'gateway' && ['pc', 'server'].includes(d.type) ? d : p;
          Object.assign(saved, {
            [key]: structuredClone((target as unknown as Record<string, unknown>)[key] ?? null),
          });
          const value = (edit as Record<string, unknown>)[key];
          if (value === null) delete (target as unknown as Record<string, unknown>)[key];
          else Object.assign(target, { [key]: structuredClone(value) });
        }
        original.ports.push(saved);
      }
      d.arpTable = [];
      d.pending = [];
      delete d.arpResolutions;
      draft.state.queue = draft.state.queue.filter(
        ({ action }) => action.kind !== 'arp-timeout' || action.device !== d.id
      );
    }
    rollback.push(original);
  }
  draft.refreshSpanningTree();
  draft.refreshVrrp();
  draft.refreshBgp();
  const diff = configurationDiff(before, draft.state);
  draft.emit(
    'CONFIG_CHANGED',
    [...seen][0],
    'Proposta de configuração aplicada a ' + seen.size + ' equipamento(s).'
  );
  validateSnapshot(draft.state);
  engine.state = draft.state;
  return { rollback, diff };
}
