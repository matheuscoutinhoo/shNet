import type { Action, Snapshot } from '../model';
import { sameSubnet, subnet } from './ipv4';
import { sdwanConfig } from './sdwan';
import type { z } from 'zod';
import type { sdwanPolicySchema } from './tunnel-model';
type Policy = z.infer<typeof sdwanPolicySchema>;
function policiesValid(policies: Policy[]) {
  return (
    new Set(policies.map((p) => p.name)).size === policies.length &&
    policies.every(
      (p) =>
        subnet(p.match.destination.network, p.match.destination.prefix).network ===
        p.match.destination.network
    )
  );
}
export function validateTunnels(s: Snapshot) {
  const used = new Set<Action>();
  for (const d of s.devices) {
    const keys = new Set<string>();
    for (const p of d.interfaces) {
      const t = p.tunnel;
      if (!t) continue;
      const underlay = d.interfaces.find((p) => p.id === t.underlay),
        key = t.remote + '/' + t.channel;
      if (
        d.type !== 'router' ||
        !underlay ||
        underlay.tunnel ||
        underlay.channel ||
        underlay.vrf ||
        underlay.mode !== 'routed' ||
        p.logical ||
        p.aggregate ||
        p.channel ||
        p.mode !== 'routed' ||
        p.ip !== t.ip ||
        p.prefix !== t.prefix ||
        p.mtu !== t.mtu ||
        t.ip === t.peerIp ||
        !sameSubnet(t.ip, t.peerIp, t.prefix) ||
        keys.has(key) ||
        d.interfaces.some((other) => other !== p && other.tunnel?.number === t.number) ||
        s.links.some((l) => [l.a, l.b].some((end) => end.device === d.id && end.port === p.id))
      )
        throw new Error('Interface/underlay de túnel inválidos.');
      keys.add(key);
      if (
        [...t.advertise, ...t.remotePrefixes].some(
          (r) => subnet(r.network, r.prefix).network !== r.network
        ) ||
        (t.lastRx !== undefined && t.lastRx > s.clock) ||
        (t.pending && t.pending.at > s.clock) ||
        t.samples.some((r) => r.at > s.clock || r.success !== (r.rtt !== undefined)) ||
        t.receivedSequences.some((n, i, a) => i > 0 && n <= a[i - 1]) ||
        (t.status === 'up' &&
          (!t.peerNonce ||
            !t.peerEndpoint ||
            t.lastRx === undefined ||
            t.ike?.phase !== 'ESTABLISHED' ||
            !t.ike.master ||
            !t.ike.peerChildSpi ||
            t.ike.expiresAt === undefined))
      )
        throw new Error('Estado de túnel inválido.');
      const ticks = s.queue.filter(
        (q) => q.action.kind === 'tunnel-tick' && q.action.device === d.id && q.action.port === p.id
      );
      if (
        ticks.length !== 1 ||
        ticks[0].at !== t.tickAt ||
        t.tickAt < s.clock ||
        (ticks[0].action as Extract<Action, { kind: 'tunnel-tick' }>).token !== t.token
      )
        throw new Error('Timer de túnel inconsistente.');
      used.add(ticks[0].action);
    }
    const edge = d.sdwan;
    if (edge) {
      sdwanConfig(d);
      const underlay = d.interfaces.find((p) => p.id === edge.underlay);
      if (
        d.type !== 'router' ||
        !policiesValid(edge.policies) ||
        !policiesValid(edge.receivedPolicies) ||
        (edge.controller &&
          (!underlay || underlay.tunnel || underlay.channel || underlay.vrf || underlay.mode !== 'routed')) ||
        (edge.pendingAt === undefined) !== (edge.pendingNonce === undefined) ||
        (edge.pendingAt !== undefined && edge.pendingAt > s.clock) ||
        (edge.lastController !== undefined && edge.lastController > s.clock) ||
        new Set(edge.selected.map((p) => p.policy)).size !== edge.selected.length ||
        edge.selected.some(
          (p) => p.at > s.clock || !d.interfaces.some((i) => i.id === p.port && i.tunnel?.mode === 'sdwan')
        )
      )
        throw new Error('Estado SD-WAN inválido.');
      const ticks = s.queue.filter((q) => q.action.kind === 'sdwan-tick' && q.action.device === d.id);
      if (
        ticks.length !== 1 ||
        ticks[0].at !== edge.tickAt ||
        edge.tickAt < s.clock ||
        (ticks[0].action as Extract<Action, { kind: 'sdwan-tick' }>).token !== edge.token
      )
        throw new Error('Timer SD-WAN inconsistente.');
      used.add(ticks[0].action);
    }
    const c = d.sdwanController;
    if (
      c &&
      (d.type === 'pc' ||
        new Set(c.sites.map((site) => site.site)).size !== c.sites.length ||
        c.sites.some((site) => !policiesValid(site.policies)))
    )
      throw new Error('Controller SD-WAN inválido.');
  }
  for (const q of s.queue)
    if ((q.action.kind === 'tunnel-tick' || q.action.kind === 'sdwan-tick') && !used.has(q.action))
      throw new Error('Timer de túnel/SD-WAN órfão.');
}
