import type { Snapshot } from './model';
import { plcProcessConfigSchema, hmiScanConfigSchema } from './protocols/industrial-process-model';
import { databaseConfigSchema } from './protocols/database-model';
function pick(value: unknown, keys: string[]) {
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)))
    : value;
}
function processBanks(value: unknown, process: unknown) {
  if (!value || typeof value !== 'object' || !process || typeof process !== 'object') return value;
  const result = { ...value } as Record<string, unknown>,
    p = process as Record<string, unknown>;
  for (const [bank, mapping] of [
    ['inputRegisters', 'levelInputRegister'],
    ['coils', 'pumpCoil'],
    ['discreteInputs', 'alarmDiscreteInput'],
  ]) {
    const values = result[bank],
      index = p[mapping];
    if (Array.isArray(values) && typeof index === 'number')
      result[bank] = values.map((v, i) => (i === index ? '[processo]' : v));
  }
  return result;
}
export interface ConfigurationChange {
  kind: 'device' | 'link' | 'canvas' | 'project';
  id: string;
  name: string;
  action: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}
function configuration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(configuration);
  if (!value || typeof value !== 'object') return value;
  const volatile = new Set([
    'logs',
    'rx',
    'tx',
    'errors',
    'dropped',
    'macTable',
    'arpTable',
    'pending',
    'arpResolutions',
    'tcpConnections',
    'dnsQueries',
    'dnsCache',
    'snmpQueries',
    'queries',
    'entries',
    'sessions',
    'clients',
    'peers',
    'bindings',
    'declined',
    'iot',
    'received',
    'token',
    'nextAt',
    'tickAt',
    'helloAt',
    'lastAt',
    'startedAt',
    'updatedAt',
    'expiresAt',
    'state',
    'root',
    'rootPort',
    'cost',
    'changes',
    'changeId',
    'changeUntil',
    'seenChanges',
    'spanningInstances',
    'spanningTree',
    'system',
  ]);
  volatile.delete('spanningTree');
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !volatile.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [
        key,
        key === 'plcProcess'
          ? configuration(pick(val, Object.keys(plcProcessConfigSchema.shape)))
          : key === 'databaseHa'
            ? true
            : key === 'database' && 'databaseHa' in value
              ? configuration(pick(val, Object.keys(databaseConfigSchema.shape)))
              : key === 'quorum'
                ? configuration(pick(val, ['ports']))
                : key === 'dhcpHa'
                  ? configuration(pick(val, ['peer', 'port', 'role']))
                  : key === 'hmiScan'
                    ? configuration(pick(val, Object.keys(hmiScanConfigSchema.shape)))
                    : key === 'bond'
                      ? configuration(pick(val, ['number', 'members', 'primary', 'monitor']))
                      : key === 'modbus' && 'plcProcess' in value
                        ? configuration(processBanks(val, value.plcProcess))
                        : key === 'stateSync' && val && typeof val === 'object'
                          ? Object.fromEntries(
                              Object.entries(val).filter(([k]) => ['peer', 'port', 'portMap'].includes(k))
                            )
                          : key === 'spanningTree' && val && typeof val === 'object'
                            ? Object.fromEntries(
                                Object.entries(val).filter(([k]) =>
                                  ['enabled', 'mode', 'priority', 'stpEdge', 'stpCost'].includes(k)
                                )
                              )
                            : configuration(val),
      ])
  );
}
export function configurationDiff(before: Snapshot, after: Snapshot): ConfigurationChange[] {
  const changes: ConfigurationChange[] = [];
  const compare = (kind: ConfigurationChange['kind'], previous: { id: string }[], next: { id: string }[]) => {
    const a = new Map(previous.map((d) => [d.id, d])),
      b = new Map(next.map((d) => [d.id, d]));
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const old = configuration(a.get(id)),
        current = configuration(b.get(id));
      if (JSON.stringify(old) !== JSON.stringify(current)) {
        const named = (b.get(id) ?? a.get(id)) as { hostname?: string; text?: string };
        changes.push({
          kind,
          id,
          name: named.hostname ?? named.text ?? id,
          action: !a.has(id) ? 'added' : !b.has(id) ? 'removed' : 'changed',
          before: old,
          after: current,
        });
      }
    }
  };
  compare('device', before.devices, after.devices);
  compare('link', before.links, after.links);
  compare('canvas', before.canvasItems ?? [], after.canvasItems ?? []);
  for (const key of ['notes', 'rfObstacles', 'scenarios', 'background', 'pattern', 'snapToGrid'] as const) {
    const old = configuration(before[key]),
      current = configuration(after[key]);
    if (JSON.stringify(old) !== JSON.stringify(current))
      changes.push({ kind: 'project', id: key, name: key, action: 'changed', before: old, after: current });
  }
  return changes;
}
