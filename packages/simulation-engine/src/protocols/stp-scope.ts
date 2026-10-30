import type { Action, Device, NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import {md5} from '@noble/hashes/legacy.js';
import {hmac} from '@noble/hashes/hmac.js';
import { bytesToHex } from '@noble/hashes/utils.js';

type StpAction = Extract<
  Action,
  { kind: 'stp-hello' | 'stp-transition' | 'stp-info-expire' | 'stp-transmit' }
>;
const scopes = new WeakMap<Device, number>();
const commonTrees=new WeakMap<Device,Device['spanningTree']>();
const commonPorts=new WeakMap<Device,Map<string,NetworkInterface['spanningTree']>>();
export const stpCommonTree=(d:Device)=>commonTrees.get(d)??d.spanningTree;
export const stpCommonPort=(d:Device,p:NetworkInterface)=>commonPorts.get(d)?.get(p.id)??p.spanningTree;
export const stpScope = (device: Device) => scopes.get(device) ?? 0;
export const isStpAction = (action: Action): action is StpAction =>
  ['stp-hello', 'stp-transition', 'stp-info-expire', 'stp-transmit'].includes(action.kind);
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
    commonTrees.set(d,common);commonPorts.set(d,new Map(ports.map(({p,state})=>[p.id,state])));
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
      commonTrees.delete(d);commonPorts.delete(d);
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
  const table=new Uint8Array(8192),view=new DataView(table.buffer);for(const m of c.mappings)view.setUint16(m.vlan*2,m.instance);
  const digest=bytesToHex(hmac(md5,new Uint8Array([0x13,0xac,0x06,0xa6,0x2e,0x47,0xfd,0x51,0xf9,0x5d,0x2b,0xa2,0x43,0xcd,0x03,0x46]),table));
  return JSON.stringify([c.region, c.revision, digest]);
}
export function stpVlanInstance(d: Device, vlan: number) {
  const c = d.multiSpanningTree;
  return c?.mode === 'pvst' ? vlan : (c?.mappings.find((m) => m.vlan === vlan)?.instance ?? 0);
}
export function portCarriesVlan(p: NetworkInterface, vlan: number) {
  return p.mode === 'trunk' ? p.allowedVlans.includes(vlan) : p.accessVlan === vlan||p.voiceVlan===vlan;
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
  p.mode === 'trunk' ? (vlan ?? p.nativeVlan) : p.voiceVlan!==undefined&&vlan===p.voiceVlan?p.voiceVlan:p.accessVlan;
