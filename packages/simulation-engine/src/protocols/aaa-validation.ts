import type { Snapshot } from '../model';
import { isUnicast } from './dhcp-config';
import { radiusRequest } from './aaa';
export function validateAaa(s: Snapshot) {
  const timers = s.queue.filter((q) => q.action.kind === 'dot1x-tick' || q.action.kind === 'aaa-timeout');
  for (const d of s.devices) {
    const server = d.aaaServer;
    if (
      server &&
      (d.type === 'pc' ||
        new Set(server.users.map((u) => u.username)).size !== server.users.length ||
        new Set(server.clients).size !== server.clients.length ||
        server.clients.some((ip) => !isUnicast(ip)) ||
        server.accounting.some((a) => a.at > s.clock) ||
        (server.enabled && server.tacacs && d.tcpServices?.some((t) => t.enabled && t.port === 49)))
    )
      throw new Error('Servidor AAA inválido.');
    if (d.aaaClient && !isUnicast(d.aaaClient.server)) throw new Error('Servidor AAA cliente inválido.');
    const queries = d.aaaQueries ?? [];
    if (new Set(queries.map((q) => q.id)).size !== queries.length) throw new Error('Consulta AAA duplicada.');
    for (const q of queries) {
      const connection = d.tcpConnections?.find((c) => c.id === q.connection);
      if (
        !isUnicast(q.server) ||
        !isUnicast(q.sourceIp) ||
        q.startedAt > s.clock ||
        q.requestAuthenticator !== radiusRequest(q).authenticator ||
        (q.port && (!q.mac || !q.session || !d.interfaces.some((p) => p.id === q.port && p.dot1x))) ||
        (!q.port && (q.mac || q.session)) ||
        (q.method === 'radius' && (!q.sourcePort || q.connection)) ||
        (q.method === 'tacacs' &&
          (!q.connection ||
            q.sourcePort ||
            (q.status === 'pending' && !connection) ||
            (connection &&
              (connection.service !== 'aaa' ||
                connection.role !== 'client' ||
                connection.remoteIp !== q.server ||
                connection.remotePort !== 49)))) ||
        (q.status === 'accepted' && (q.privilege === undefined || q.expiresAt === undefined))
      )
        throw new Error('Consulta/autorização AAA inválida.');
      const ts = timers.filter(
        (t) => t.action.kind === 'aaa-timeout' && t.action.device === d.id && t.action.query === q.id
      );
      if (
        q.status === 'pending'
          ? ts.length !== 1 ||
            ts[0].at !== q.deadline ||
            ts[0].action.kind !== 'aaa-timeout' ||
            ts[0].action.at !== q.deadline
          : ts.length !== 0
      )
        throw new Error('Timer AAA inválido.');
    }
    if (
      d.networkAuth &&
      !queries.some(
        (q) =>
          !q.port &&
          q.status === 'accepted' &&
          q.id === d.networkAuth!.query &&
          q.username === d.networkAuth!.username &&
          q.privilege === d.networkAuth!.privilege &&
          JSON.stringify(q.commands ?? ['*']) === JSON.stringify(d.networkAuth!.commands) &&
          q.expiresAt === d.networkAuth!.expiresAt
      )
    )
      throw new Error('Login de rede sem autorização AAA.');
    for (const p of d.interfaces) {
      const a = p.dot1x,
        client = p.supplicant,
        state = a ?? client;
      if (!state) continue;
      if (
        (a && client) ||
        p.media === 'wifi' ||
        p.aggregate ||
        p.channel ||
        p.logical ||
        p.tunnel ||
        p.vxlan ||
        state.lastAt > s.clock ||
        (a &&
          (d.type !== 'switch' ||
            p.mode !== 'access' ||
            !isUnicast(a.server) ||
            !d.interfaces.some(
              (w) =>
                w.id === a.underlay &&
                w !== p &&
                w.mode === 'routed' &&
                w.ip &&
                !w.vrf &&
                !w.vxlan &&
                !w.tunnel
            ) ||
            !d.vlans.some((v) => v.id === a.baseVlan) ||
            p.accessVlan !== (a.assignedVlan ?? a.baseVlan) ||
            (a.phase === 'authorized' &&
              (!a.enabled ||
                !a.mac ||
                !a.session ||
                !a.expiresAt ||
                !queries.some(
                  (q) =>
                    q.id === a.query &&
                    q.status === 'accepted' &&
                    q.port === p.id &&
                    q.mac === a.mac &&
                    q.session === a.session &&
                    q.vlan === a.assignedVlan &&
                    q.expiresAt! >= a.expiresAt!
                ))) ||
            (a.phase === 'authenticating' && (!a.mac || !a.session)) ||
            (a.phase === 'unauthorized' &&
              (a.mac || a.session || a.query || a.expiresAt || a.assignedVlan)))) ||
        (client &&
          (d.type === 'switch' ||
            (client.phase === 'authorized' && (!client.enabled || !client.session || !client.authenticator))))
      )
        throw new Error('Porta/supplicant 802.1X inválido.');
      const ts = timers.filter(
        (t) => t.action.kind === 'dot1x-tick' && t.action.device === d.id && t.action.port === p.id
      );
      if (
        state.enabled
          ? ts.length !== 1 ||
            ts[0].at !== state.tickAt ||
            ts[0].action.kind !== 'dot1x-tick' ||
            ts[0].action.token !== state.token ||
            ts[0].action.at !== state.tickAt
          : ts.length !== 0 || state.tickAt !== undefined
      )
        throw new Error('Timer 802.1X inválido.');
    }
  }
  for (const t of timers) {
    const a = t.action,
      d = s.devices.find((d) => d.id === ('device' in a ? a.device : ''));
    if (
      (a.kind === 'aaa-timeout' && !d?.aaaQueries?.some((q) => q.id === a.query)) ||
      (a.kind === 'dot1x-tick' && !d?.interfaces.some((p) => p.id === a.port && (p.dot1x || p.supplicant)))
    )
      throw new Error('Timer AAA/802.1X órfão.');
  }
}
