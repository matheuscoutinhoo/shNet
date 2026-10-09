import type { Action, Device, NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

type StpAction = Extract<Action, { kind: 'stp-hello' | 'stp-transition' | 'stp-info-expire' }>;
const scopes = new WeakMap<Device, number>();
export const stpScope = (device: Device) => scopes.get(device) ?? 0;
export const isStpAction = (action: Action): action is StpAction =>
  ['stp-hello', 'stp-transition', 'stp-info-expire'].includes(action.kind);
export function stpSchedule(e: SimulationEngine, delay: number, action: StpAction) {
  const instance = stpScope(e.device(action.device));
  e.schedule(delay, instance ? { ...action, instance } : action);
}

// The election code runs synchronously against one persisted instance. No timers
// or packet delivery run inside this scope; finally always restores the CST.
export function withStpInstance<T>(d: Device, instance: number, run: () => T): T {
  const previousScope = scopes.get(d);
  if (previousScope !== undefined && previousScope !== instance)
    throw new Error('Instância STP aninhada incompatível.');
  const entry = instance ? d.multiSpanningTree?.instances.find((i) => i.id === instance) : undefined;
  const common = d.spanningTree;
  const ports = d.interfaces.map((p) => ({ p, state: p.spanningTree }));
  if (instance && !entry) throw new Error('Instância STP inexistente.');
  scopes.set(d, instance);
  if (entry) {
    d.spanningTree = entry.tree;
    for (const { p } of ports) p.spanningTree = p.spanningInstances?.find((i) => i.id === instance)?.state;
  }
  try {
    return run();
  } finally {
    if (entry) {
      if (d.spanningTree) entry.tree = d.spanningTree;
      d.spanningTree = common;
      for (const { p, state } of ports) {
        const current = p.spanningTree;
        p.spanningInstances = p.spanningInstances?.filter((i) => i.id !== instance) ?? [];
        if (current) p.spanningInstances.push({ id: instance, state: current });
        p.spanningTree = state;
      }
    }
    if (previousScope === undefined) scopes.delete(d);
    else scopes.set(d, previousScope);
  }
}
export function stpInstances(d: Device) {
  return [0, ...(d.multiSpanningTree?.instances.map((i) => i.id) ?? [])];
}
export function mstRegion(d: Device) {
  const c = d.multiSpanningTree;
  if (c?.mode !== 'mstp') return;
  const map = [...c.mappings].filter((m) => m.instance !== 0).sort((a, b) => a.vlan - b.vlan);
  const digest = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(map))));
  return JSON.stringify([c.region, c.revision, digest]);
}
export function stpVlanInstance(d: Device, vlan: number) {
  const c = d.multiSpanningTree;
  return c?.mode === 'pvst' ? vlan : (c?.mappings.find((m) => m.vlan === vlan)?.instance ?? 0);
}
export function portCarriesVlan(p: NetworkInterface, vlan: number) {
  return p.mode === 'trunk' ? p.allowedVlans.includes(vlan) : p.accessVlan === vlan;
}
export function instancePort(d: Device, p: NetworkInterface) {
  const instance = stpScope(d);
  if (!instance) return true;
  return d.multiSpanningTree?.mode === 'pvst'
    ? portCarriesVlan(p, instance)
    : !p.mstBoundary &&
        d.multiSpanningTree!.mappings.some((m) => m.instance === instance && portCarriesVlan(p, m.vlan));
}
export function spanningPortState(d: Device, p: NetworkInterface, vlan?: number) {
  const instance = vlan === undefined || p.mstBoundary ? 0 : stpVlanInstance(d, vlan);
  return instance ? p.spanningInstances?.find((i) => i.id === instance)?.state : p.spanningTree;
}
export const frameVlan = (p: NetworkInterface, vlan?: number) =>
  p.mode === 'trunk' ? (vlan ?? p.nativeVlan) : p.accessVlan;
