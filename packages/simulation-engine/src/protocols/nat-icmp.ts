import type { SimulationEngine } from '../core/engine';
import type { Device, IcmpPacket, IcmpQuote, NatBinding, NetworkInterface } from '../model';
import { ipNumber, sameSubnet } from './ipv4';

function token(quote: IcmpQuote, side: 'src' | 'dst') {
  return quote.protocol === 'ICMP'
    ? quote.probeId
    : String(side === 'src' ? quote.sourcePort : quote.destinationPort);
}
function remap(quote: IcmpQuote, side: 'src' | 'dst', address: string, mapped?: string): IcmpQuote {
  const header = { ...quote, [side]: address };
  if (!mapped) return header;
  if (header.protocol === 'ICMP') return { ...header, probeId: mapped };
  return { ...header, [side === 'src' ? 'sourcePort' : 'destinationPort']: Number(mapped) };
}
function matches(binding: NatBinding, quote: IcmpQuote, side: 'src' | 'dst') {
  return (
    binding.protocol === 'ip' ||
    (binding.protocol === quote.protocol &&
      (side === 'src' ? binding.globalToken : binding.insideToken) === token(quote, side) &&
      binding.remote === (side === 'src' ? quote.dst : quote.src) &&
      (quote.protocol === 'ICMP' ||
        binding.remotePort === (side === 'src' ? quote.destinationPort : quote.sourcePort)))
  );
}
export function natIcmpInbound(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: IcmpPacket
): IcmpPacket | undefined {
  const nat = device.nat!;
  const fixed = nat.statics.find((entry) => entry.outside === port.id && entry.global === packet.dst);
  const poolContains = nat.pools.some(
    (pool) =>
      pool.outside === port.id &&
      ipNumber(packet.dst) >= ipNumber(pool.start) &&
      ipNumber(packet.dst) <= ipNumber(pool.end)
  );
  if (!fixed && !poolContains) return packet;
  const quote = packet.error?.quote;
  const binding =
    quote &&
    nat.bindings.find(
      (entry) =>
        entry.global === packet.dst &&
        entry.expiresAt > engine.state.clock &&
        nat.pools.some((pool) => pool.name === entry.pool && pool.outside === port.id) &&
        matches(entry, quote, 'src')
    );
  const local =
    quote &&
    device.interfaces.some((entry) => entry.ip === packet.dst) &&
    quote.src === packet.dst &&
    (quote.protocol === 'ICMP'
      ? engine.state.probes.some(
          (probe) =>
            probe.device === device.id &&
            probe.id === quote.probeId &&
            probe.target === quote.dst &&
            probe.status === 'pending'
        )
      : quote.protocol === 'TCP'
        ? device.tcpConnections?.some(
            (connection) =>
              connection.localIp === quote.src &&
              connection.remoteIp === quote.dst &&
              connection.localPort === quote.sourcePort &&
              connection.remotePort === quote.destinationPort &&
              !['CLOSED', 'RESET', 'TIMED-OUT'].includes(connection.state)
          )
        : device.dnsQueries?.some(
            (query) =>
              query.status === 'pending' &&
              query.transport === 'udp' &&
              query.sourceIp === quote.src &&
              query.sourcePort === quote.sourcePort &&
              query.server === quote.dst &&
              quote.destinationPort === 53
          ) ||
          device.snmpQueries?.some(
            (query) =>
              query.status === 'pending' &&
              query.sourceIp === quote.src &&
              query.sourcePort === quote.sourcePort &&
              query.server === quote.dst &&
              quote.destinationPort === 161
          ));
  if (!fixed && !binding && local) return packet;
  if (!quote || quote.src !== packet.dst || (!fixed && !binding)) {
    engine.drop(device, 'Erro ICMP sem citação e tradução NAT correspondentes.', port.id);
    return;
  }
  const translated = remap(quote, 'src', fixed?.inside ?? binding!.inside, binding?.insideToken);
  engine.emit(
    'NAT_TRANSLATED',
    device.id,
    'ICMP relacionado: destino e origem citada ' + packet.dst + ' → ' + translated.src + '.',
    { port: port.id }
  );
  // Errors neither create a mapping nor refresh its lifetime.
  return {
    ...packet,
    dst: translated.src,
    ...(translated.protocol === 'ICMP' ? { probeId: translated.probeId } : {}),
    error: { ...packet.error!, quote: translated },
  };
}
export function natIcmpOutbound(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: IcmpPacket
): IcmpPacket | undefined {
  const nat = device.nat!;
  const quote = packet.error?.quote;
  const sourceRequiresNat =
    nat.statics.some((entry) => entry.outside === port.id && entry.inside === packet.src) ||
    nat.pools.some(
      (pool) => pool.outside === port.id && sameSubnet(pool.source.network, packet.src, pool.source.prefix)
    );
  if (!quote && sourceRequiresNat) {
    engine.drop(device, 'NAT recusou erro ICMP sem cabeçalho citado.', port.id);
    return;
  }
  const fixed = quote && nat.statics.find((entry) => entry.outside === port.id && entry.inside === quote.dst);
  const pools = nat.pools.filter(
    (pool) =>
      pool.outside === port.id && quote && sameSubnet(pool.source.network, quote.dst, pool.source.prefix)
  );
  if (!fixed && !pools.length) {
    if (sourceRequiresNat) {
      engine.drop(device, 'NAT recusou erro ICMP com destino citado sem mapeamento.', port.id);
      return;
    }
    return packet;
  }
  const binding =
    quote &&
    nat.bindings.find(
      (entry) =>
        entry.inside === quote.dst &&
        entry.expiresAt > engine.state.clock &&
        pools.some((pool) => pool.name === entry.pool) &&
        matches(entry, quote, 'dst')
    );
  if (!quote || packet.dst !== quote.src || (!fixed && !binding)) {
    engine.drop(device, 'Erro ICMP sem citação e tradução NAT correspondentes.', port.id);
    return;
  }
  const translated = remap(quote, 'dst', fixed?.global ?? binding!.global, binding?.globalToken);
  const sourceMapping =
    nat.statics.find((entry) => entry.outside === port.id && entry.inside === packet.src) ??
    nat.bindings.find(
      (entry) =>
        entry.inside === packet.src &&
        entry.expiresAt > engine.state.clock &&
        nat.pools.some((pool) => pool.name === entry.pool && pool.outside === port.id)
    );
  const source = sourceMapping?.global ?? port.ip;
  if (!source) return;
  engine.emit(
    'NAT_TRANSLATED',
    device.id,
    'ICMP relacionado: destino citado ' + quote.dst + ' → ' + translated.dst + '.',
    { port: port.id }
  );
  return {
    ...packet,
    src: source,
    ...(translated.protocol === 'ICMP' ? { probeId: translated.probeId } : {}),
    error: { ...packet.error!, quote: translated },
  };
}
