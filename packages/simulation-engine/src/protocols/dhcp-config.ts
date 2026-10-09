import { dhcpPoolSchema, ipv4Schema, type Device, type DhcpPool, type NetworkInterface } from '../model';
import { ipNumber, ipString, sameSubnet, subnet } from './ipv4';

export function isUnicast(ip: string) {
  const first = ipNumber(ip) >>> 24;
  return first > 0 && first !== 127 && first < 224;
}

export function poolContains(pool: DhcpPool, address: string) {
  const number = ipNumber(address);
  return number >= ipNumber(pool.start) && number <= ipNumber(pool.end);
}

export function sameDhcpScope(a: DhcpPool, b: DhcpPool) {
  return a.network === b.network && a.prefix === b.prefix;
}

export function availablePoolAddress(device: Device, pool: DhcpPool, address: string, clientMac?: string) {
  const reserved = pool.reservations?.find((entry) => entry.address === address);
  const own = pool.reservations?.find((entry) => entry.clientMac === clientMac?.toLowerCase());
  return (
    poolContains(pool, address) &&
    address !== pool.gateway &&
    address !== pool.relayAddress &&
    !pool.excluded.includes(address) &&
    !device.interfaces.some((port) => port.ip === address) &&
    (!reserved || reserved.clientMac === clientMac?.toLowerCase()) &&
    (!own || own.address === address)
  );
}

export function validateDhcpPool(device: Device, pool: DhcpPool) {
  if (device.type !== 'server' && device.type !== 'router')
    throw new Error('O serviço DHCP requer um servidor ou roteador.');
  const port = device.interfaces.find((entry) => entry.id === pool.port);
  if (!port?.ip || port.prefix === undefined || port.ipv4Mode === 'dhcp' || port.mode !== 'routed')
    throw new Error('O pool requer uma interface routed com IPv4 estático.');
  const serverNetwork = subnet(port.ip, port.prefix);
  if (
    !isUnicast(port.ip) ||
    (port.prefix < 31 && [serverNetwork.network, serverNetwork.broadcast].includes(port.ip))
  )
    throw new Error('A interface do servidor DHCP deve usar um endereço IPv4 de host unicast.');
  const network = subnet(pool.network, pool.prefix);
  if (pool.network !== network.network) throw new Error('A rede DHCP deve estar alinhada ao prefixo.');
  const usable = (address: string) =>
    isUnicast(address) &&
    sameSubnet(address, pool.network, pool.prefix) &&
    address !== network.network &&
    address !== network.broadcast;
  if (!pool.relayAddress && (!usable(port.ip) || port.dhcpRelay?.length))
    throw new Error('O pool local requer IPv4 de host e não pode compartilhar a interface com relay.');
  if (pool.relayAddress) {
    if (!usable(pool.relayAddress) || sameSubnet(port.ip, pool.network, pool.prefix))
      throw new Error('O relay deve ser um host da rede remota, diferente da rede da interface do servidor.');
  } else if (port.prefix !== pool.prefix || subnet(port.ip, pool.prefix).network !== pool.network) {
    throw new Error('O pool local requer o mesmo prefixo e rede da interface do servidor.');
  }
  if (![pool.start, pool.end, ...pool.excluded, ...(pool.gateway ? [pool.gateway] : [])].every(usable))
    throw new Error('Use endereços unicast de host pertencentes à subnet do pool.');
  const size = ipNumber(pool.end) - ipNumber(pool.start) + 1;
  if (size < 1 || size > 2048) throw new Error('O intervalo deve conter entre 1 e 2048 endereços.');
  if (!pool.dns.every(isUnicast)) throw new Error('DNS deve usar endereços IPv4 unicast.');
  if (new Set(pool.excluded).size !== pool.excluded.length) throw new Error('Exclusão DHCP duplicada.');
  const macs = new Set<string>(),
    addresses = new Set<string>();
  for (const reservation of pool.reservations ?? []) {
    if (macs.has(reservation.clientMac) || addresses.has(reservation.address))
      throw new Error('Reserva DHCP duplicada: cada MAC e endereço deve ser único no pool.');
    if (!availablePoolAddress(device, pool, reservation.address, reservation.clientMac))
      throw new Error('Reserva DHCP deve estar no intervalo, sem exclusão ou endereço de infraestrutura.');
    macs.add(reservation.clientMac);
    addresses.add(reservation.address);
  }
}

export function defaultDhcpPool(
  device: Device,
  name: string,
  portId?: string,
  relayAddress?: string,
  remotePrefix = 24
): DhcpPool {
  const port = portId
    ? device.interfaces.find((entry) => entry.id === portId)
    : device.interfaces.find(
        (entry) =>
          entry.ip &&
          entry.ipv4Mode !== 'dhcp' &&
          entry.prefix !== undefined &&
          entry.prefix >= 1 &&
          entry.prefix <= 30 &&
          (relayAddress || !entry.dhcpRelay?.length)
      );
  if (!port?.ip || port.prefix === undefined || port.prefix < 1 || port.prefix > 30)
    throw new Error('Configure primeiro uma interface IPv4 estática com prefixo entre /1 e /30.');
  const prefix = relayAddress ? remotePrefix : port.prefix;
  const network = subnet(relayAddress ?? port.ip, prefix);
  const pool = dhcpPoolSchema.parse({
    name,
    port: port.id,
    network: network.network,
    prefix,
    start: network.first,
    end: ipString(Math.min(ipNumber(network.last), ipNumber(network.first) + 253)),
    gateway: relayAddress ?? (device.type === 'router' ? port.ip : undefined),
    relayAddress,
    dns: [],
    leaseMs: 3600000,
    excluded: [],
  });
  validateDhcpPool(device, pool);
  return pool;
}

function overlapping(a: DhcpPool, b: DhcpPool) {
  return ipNumber(a.start) <= ipNumber(b.end) && ipNumber(b.start) <= ipNumber(a.end);
}

export function configureDhcpPool(device: Device, input: unknown): DhcpPool {
  const pool = dhcpPoolSchema.parse(input);
  validateDhcpPool(device, pool);
  const others = device.dhcpServer?.pools.filter((entry) => entry.name !== pool.name) ?? [];
  if (others.length >= 16) throw new Error('Limite de 16 pools DHCP por equipamento.');
  if (others.some((entry) => overlapping(entry, pool)))
    throw new Error('Pools DHCP não podem ter intervalos sobrepostos.');
  if (
    others.some(
      (entry) =>
        sameDhcpScope(entry, pool) &&
        entry.reservations?.some((reservation) =>
          pool.reservations?.some((other) => other.clientMac === reservation.clientMac)
        )
    )
  )
    throw new Error('MAC reservado em outro pool da mesma rede DHCP.');
  const previous = device.dhcpServer?.pools.find((entry) => entry.name === pool.name);
  const scopeChanged =
    previous &&
    (previous.port !== pool.port ||
      previous.relayAddress !== pool.relayAddress ||
      !sameDhcpScope(previous, pool));
  device.dhcpServer = {
    enabled: device.dhcpServer?.enabled ?? true,
    pools: [...others, pool],
    bindings:
      device.dhcpServer?.bindings.filter(
        (binding) =>
          binding.pool !== pool.name ||
          (!scopeChanged && availablePoolAddress(device, pool, binding.address, binding.clientMac))
      ) ?? [],
  };
  return pool;
}

export function configureDhcpRelay(device: Device, portId: string, input: unknown) {
  const addresses = ipv4Schema.array().max(8).parse(input);
  const port = device.interfaces.find((entry) => entry.id === portId);
  if (
    device.type !== 'router' ||
    !port?.ip ||
    port.prefix === undefined ||
    port.prefix < 1 ||
    port.prefix > 30 ||
    !isUnicast(port.ip) ||
    [subnet(port.ip, port.prefix).network, subnet(port.ip, port.prefix).broadcast].includes(port.ip) ||
    port.mode !== 'routed' ||
    port.ipv4Mode === 'dhcp'
  )
    throw new Error('DHCP relay requer interface routed de roteador com IPv4 estático.');
  if (
    addresses.length &&
    device.dhcpServer?.pools.some((pool) => !pool.relayAddress && pool.port === port.id)
  )
    throw new Error('Use servidor DHCP local ou relay nesta interface.');
  if (
    new Set(addresses).size !== addresses.length ||
    addresses.some(
      (address) => !isUnicast(address) || device.interfaces.some((entry) => entry.ip === address)
    )
  )
    throw new Error('Destinos relay devem ser IPv4 unicast únicos de outros equipamentos.');
  port.dhcpRelay = addresses;
}

export function dhcpPoolStats(device: Device, pool: DhcpPool, clock: number) {
  const excluded = new Set(
    [
      ...pool.excluded,
      ...device.interfaces.flatMap((port) => (port.ip ? [port.ip] : [])),
      ...(pool.gateway ? [pool.gateway] : []),
      ...(pool.relayAddress ? [pool.relayAddress] : []),
    ].filter((address) => poolContains(pool, address))
  );
  const capacity = ipNumber(pool.end) - ipNumber(pool.start) + 1 - excluded.size;
  const active =
    device.dhcpServer?.bindings.filter(
      (binding) => binding.pool === pool.name && binding.expiresAt > clock
    ) ?? [];
  const offered = active.filter((binding) => binding.status === 'offered').length;
  const reserved = pool.reservations?.length ?? 0;
  const usedDynamic = active.filter(
    (binding) => !pool.reservations?.some((entry) => entry.address === binding.address)
  ).length;
  return {
    capacity,
    offered,
    bound: active.length - offered,
    reserved,
    available: Math.max(0, capacity - reserved - usedDynamic),
  };
}

function validateClient(port: NetworkInterface) {
  const client = port.dhcp;
  if (!client) {
    if (port.ipv4Mode === 'dhcp') throw new Error('Interface DHCP sem estado de cliente.');
    return;
  }
  if (port.ipv4Mode !== 'dhcp' || port.mode !== 'routed')
    throw new Error('Cliente DHCP fora de interface routed dinâmica.');
  const bound = ['bound', 'renewing', 'rebinding'].includes(client.status);
  if (bound !== !!client.lease) throw new Error('Estado e lease DHCP incompatíveis.');
  if (client.status === 'requesting' && !client.offer)
    throw new Error('DHCP Request sem oferta selecionada.');
  if (!client.lease) {
    if (port.ip || port.gateway || port.dns?.length)
      throw new Error('Cliente DHCP sem lease não pode manter configuração IPv4.');
    if (!client.pendingLease) return;
  }
  const lease = (client.lease ?? client.pendingLease)!,
    range = subnet(lease.address, lease.prefix);
  if (
    !isUnicast(lease.address) ||
    lease.address === range.network ||
    lease.address === range.broadcast ||
    !isUnicast(lease.server) ||
    !lease.dns.every(isUnicast) ||
    (lease.gateway &&
      (!isUnicast(lease.gateway) ||
        !sameSubnet(lease.address, lease.gateway, lease.prefix) ||
        [range.network, range.broadcast].includes(lease.gateway)))
  )
    throw new Error('Endereço, servidor ou gateway do lease DHCP inválido.');
  if (
    client.lease &&
    (port.ip !== lease.address ||
      port.prefix !== lease.prefix ||
      port.gateway !== lease.gateway ||
      JSON.stringify(port.dns) !== JSON.stringify(lease.dns))
  )
    throw new Error('A configuração da interface diverge do lease DHCP.');
}

export function validateDhcpDevice(device: Device, clock?: number) {
  for (const port of device.interfaces) {
    validateClient(port);
    if (port.dhcpRelay?.length)
      configureDhcpRelay(
        { ...device, interfaces: device.interfaces.map((entry) => ({ ...entry })) },
        port.id,
        port.dhcpRelay
      );
  }
  const server = device.dhcpServer;
  if (!server) return;
  if (device.type !== 'server' && device.type !== 'router')
    throw new Error('Serviço DHCP requer servidor ou roteador.');
  const names = new Set<string>(),
    addresses = new Set<string>(),
    clients = new Set<string>(),
    ids = new Set<string>();
  for (const pool of server.pools) {
    validateDhcpPool(device, pool);
    if (!pool.relayAddress && device.interfaces.find((port) => port.id === pool.port)?.dhcpRelay?.length)
      throw new Error('Servidor DHCP local e relay na mesma interface.');
    if (names.has(pool.name)) throw new Error('Nome de pool DHCP duplicado.');
    names.add(pool.name);
    if (server.pools.some((other) => other !== pool && overlapping(other, pool)))
      throw new Error('Pools DHCP sobrepostos.');
    if (
      server.pools.some(
        (other) =>
          other !== pool &&
          sameDhcpScope(other, pool) &&
          other.reservations?.some((reservation) =>
            pool.reservations?.some((entry) => entry.clientMac === reservation.clientMac)
          )
      )
    )
      throw new Error('MAC reservado em outro pool da mesma rede DHCP.');
  }
  for (const binding of server.bindings) {
    const pool = server.pools.find((entry) => entry.name === binding.pool);
    if (!pool || !availablePoolAddress(device, pool, binding.address, binding.clientMac))
      throw new Error('Binding fora do pool DHCP.');
    const addressKey = binding.address,
      clientKey = pool.network + '/' + pool.prefix + ':' + binding.clientMac.toLowerCase();
    if (addresses.has(addressKey) || clients.has(clientKey) || ids.has(binding.id))
      throw new Error('Binding DHCP duplicado.');
    addresses.add(addressKey);
    clients.add(clientKey);
    ids.add(binding.id);
  }
  const quarantined = new Set<string>();
  for (const entry of server.declined ?? []) {
    if (
      !isUnicast(entry.address) ||
      quarantined.has(entry.address) ||
      addresses.has(entry.address) ||
      !server.pools.some(
        (pool) =>
          poolContains(pool, entry.address) &&
          !pool.excluded.includes(entry.address) &&
          pool.gateway !== entry.address &&
          pool.relayAddress !== entry.address
      ) ||
      device.interfaces.some((port) => port.ip === entry.address) ||
      (clock !== undefined && entry.expiresAt > clock + 600000)
    )
      throw new Error('Quarentena DHCP inválida.');
    quarantined.add(entry.address);
  }
}
