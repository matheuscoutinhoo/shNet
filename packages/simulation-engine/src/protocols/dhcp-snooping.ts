import { dhcpSnoopingConfigSchema } from './dhcp-snooping-model';
import type { Device, Frame, NetworkInterface, Snapshot } from '../model';
import type { SimulationEngine } from '../core/engine';
import { portCarriesVlan } from './stp-scope';
import { isUnicast } from './dhcp-config';

export function configureDhcpSnooping(e: SimulationEngine, d: Device, input: unknown) {
  if (d.type !== 'switch') throw new Error('DHCP snooping exige switch.');
  const c = dhcpSnoopingConfigSchema.parse(input);
  validateConfig(d, c);
  d.dhcpSnooping = { ...c, bindings: [], requests: [], dropped: 0 };
  e.emit('CONFIG_CHANGED', d.id, 'DHCP snooping configurado; tabelas reaprendidas por REQUEST/ACK.');
}
function validateConfig(d: Device, c: ReturnType<typeof dhcpSnoopingConfigSchema.parse>) {
  if (
    new Set(c.vlans).size !== c.vlans.length ||
    new Set(c.trustedPorts).size !== c.trustedPorts.length ||
    c.vlans.some((v) => !d.vlans.some((i) => i.id === v)) ||
    c.trustedPorts.some(
      (id) => !d.interfaces.some((p) => p.id === id && !p.logical && !p.channel && p.mode !== 'routed')
    ) ||
    c.staticBindings.some(
      (b) =>
        !c.vlans.includes(b.vlan) ||
        !isUnicast(b.ip) ||
        !d.interfaces.some((p) => p.id === b.port && portCarriesVlan(p, b.vlan))
    ) ||
    new Set(c.staticBindings.map((b) => b.vlan + ':' + b.ip)).size !== c.staticBindings.length
  )
    throw new Error('Configuração DHCP snooping, VLAN, porta ou binding inválido.');
}
export function permitDhcpSnooping(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  f: Frame,
  vlan: number
) {
  const c = d.dhcpSnooping;
  if (!c?.enabled || !c.vlans.includes(vlan)) return true;
  c.bindings = c.bindings.filter((b) => b.expiresAt > e.state.clock);
  c.requests = c.requests.filter((r) => r.expiresAt > e.state.clock);
  const trusted = c.trustedPorts.includes(p.id);
  const deny = (why: string) => {
    c.dropped++;
    e.drop(d, 'DHCP snooping: ' + why, p.id, f);
    return false;
  };
  const packet = f.packet;
  if (packet?.protocol === 'UDP' && packet.payload.protocol === 'DHCP') {
    const m = packet.payload.message,
      server = ['offer', 'ack', 'nak'].includes(m.type);
    if (server) {
      const toRelay =
        packet.destinationPort === 67 &&
        !!m.giaddr &&
        m.giaddr !== '0.0.0.0' &&
        packet.dst === m.giaddr &&
        m.hops === 1;
      if (!trusted || packet.sourcePort !== 67 || (packet.destinationPort !== 68 && !toRelay))
        return deny('resposta de servidor em porta não confiável ou portas UDP inválidas.');
      const request = c.requests.find(
        (r) => r.vlan === vlan && r.mac === m.clientMac && r.transaction === m.transactionId
      );
      if (
        !request ||
        (toRelay && request.relay !== m.giaddr) ||
        ('server' in m && request.server && request.server !== m.server)
      )
        return deny('resposta sem transação observada ou de outro servidor.');
      if (m.type === 'ack') {
        if (!isUnicast(m.address) || (request.ip && request.ip !== m.address))
          return deny('ACK não confirma o endereço solicitado.');
        if (!request.relay && !c.trustedPorts.includes(request.port)) {
          c.bindings = c.bindings.filter(
            (b) => !(b.vlan === vlan && (b.mac === m.clientMac || b.ip === m.address))
          );
          if (c.bindings.length === 1024) c.bindings.shift();
          c.bindings.push({
            vlan,
            port: request.port,
            mac: m.clientMac,
            ip: m.address,
            expiresAt: e.state.clock + m.leaseMs,
            server: m.server,
          });
        }
      } else if (m.type === 'nak')
        c.bindings = c.bindings.filter((b) => b.vlan !== vlan || b.mac !== m.clientMac);
    } else {
      const relayed =
        trusted &&
        packet.sourcePort === 67 &&
        packet.destinationPort === 67 &&
        !!m.giaddr &&
        isUnicast(m.giaddr) &&
        m.hops === 1 &&
        packet.src === m.giaddr;
      if (
        (!relayed && packet.sourcePort !== 68) ||
        packet.destinationPort !== 67 ||
        (!relayed && !trusted && m.clientMac.toLowerCase() !== f.src.toLowerCase()) ||
        (!relayed && m.giaddr && m.giaddr !== '0.0.0.0')
      )
        return deny('cliente, MAC, giaddr ou portas UDP incompatíveis.');
      if (m.type === 'release' || m.type === 'decline')
        c.bindings = c.bindings.filter((b) => b.vlan !== vlan || b.mac !== m.clientMac || b.port !== p.id);
      else if (m.type === 'discover' || m.type === 'request') {
        c.requests = c.requests.filter((r) => r.vlan !== vlan || r.mac !== m.clientMac);
        if (c.requests.length === 256) c.requests.shift();
        c.requests.push({
          vlan,
          port: p.id,
          mac: m.clientMac,
          transaction: m.transactionId,
          server: 'server' in m ? m.server : undefined,
          ip: m.type === 'request' ? m.requestedIp : undefined,
          ...(relayed ? { relay: m.giaddr } : {}),
          expiresAt: e.state.clock + 60000,
        });
      }
    }
    return true;
  }
  if (trusted) return true;
  const bindings = [...c.staticBindings, ...c.bindings];
  const bound = (ip: string, mac: string) =>
    bindings.some((b) => b.vlan === vlan && b.port === p.id && b.mac === mac.toLowerCase() && b.ip === ip);
  if (c.sourceGuard && (packet || f.fragment) && !bound((packet ?? f.fragment)!.src, f.src))
    return deny('IP Source Guard: IP/MAC/porta sem binding.');
  if (c.arpInspection && f.arp) {
    const a = f.arp;
    if (a.senderMac !== f.src || (a.senderIp !== '0.0.0.0' && !bound(a.senderIp, a.senderMac)))
      return deny('DAI: anúncio ARP diverge do binding.');
    if (
      a.senderIp === '0.0.0.0' &&
      !bindings.some((b) => b.vlan === vlan && b.port === p.id && b.mac === f.src && b.ip === a.targetIp)
    )
      return deny('ARP probe sem concessão observada.');
  }
  return true;
}
export function validateDhcpSnooping(s: Snapshot) {
  for (const d of s.devices) {
    const c = d.dhcpSnooping;
    if (!c) continue;
    if (d.type !== 'switch') throw new Error('DHCP snooping pertence a switches.');
    validateConfig(d, c);
    if (
      new Set(c.bindings.map((b) => b.vlan + ':' + b.ip)).size !== c.bindings.length ||
      new Set(c.bindings.map((b) => b.vlan + ':' + b.mac)).size !== c.bindings.length ||
      c.bindings.some(
        (b) =>
          !isUnicast(b.ip) ||
          !isUnicast(b.server) ||
          c.trustedPorts.includes(b.port) ||
          !c.vlans.includes(b.vlan) ||
          !d.interfaces.some((p) => p.id === b.port && portCarriesVlan(p, b.vlan))
      ) ||
      c.requests.some(
        (r) =>
          (r.relay && (!isUnicast(r.relay) || !c.trustedPorts.includes(r.port))) ||
          !c.vlans.includes(r.vlan) ||
          !d.interfaces.some((p) => p.id === r.port && portCarriesVlan(p, r.vlan))
      )
    )
      throw new Error('Tabela DHCP snooping inválida.');
  }
}
