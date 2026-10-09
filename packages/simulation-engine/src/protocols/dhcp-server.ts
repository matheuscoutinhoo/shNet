import {
  DHCP,
  type Device,
  type DhcpBinding,
  type DhcpMessage,
  type DhcpPool,
  type NetworkInterface,
  type UdpPacket,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import { availablePoolAddress, poolContains, sameDhcpScope } from './dhcp-config';
import { ipNumber, ipString, sameSubnet } from './ipv4';
import { sendDhcp } from './dhcp-wire';

function removeBinding(engine: SimulationEngine, device: Device, binding: DhcpBinding) {
  if (device.dhcpServer)
    device.dhcpServer.bindings = device.dhcpServer.bindings.filter((entry) => entry.id !== binding.id);
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'dhcp-binding-expire' || action.device !== device.id || action.binding !== binding.id
  );
}

export function expireDhcpBinding(
  engine: SimulationEngine,
  device: Device,
  bindingId: string,
  expiresAt: number
) {
  const binding = device.dhcpServer?.bindings.find((entry) => entry.id === bindingId);
  if (!binding || binding.expiresAt !== expiresAt || expiresAt > engine.state.clock) return;
  removeBinding(engine, device, binding);
  engine.emit(
    'DHCP_LEASE_EXPIRED',
    device.id,
    (binding.status === 'offered' ? 'Reserva de oferta' : 'Concessão') +
      ' expirada: ' +
      binding.address +
      ' voltou ao pool ' +
      binding.pool +
      '.'
  );
}

function expireOldBindings(engine: SimulationEngine, device: Device) {
  if (device.dhcpServer?.declined)
    device.dhcpServer.declined = device.dhcpServer.declined.filter((v) => v.expiresAt > engine.state.clock);
  for (const binding of [...(device.dhcpServer?.bindings ?? [])])
    if (binding.expiresAt <= engine.state.clock)
      expireDhcpBinding(engine, device, binding.id, binding.expiresAt);
}

function saveBinding(
  engine: SimulationEngine,
  device: Device,
  pool: DhcpPool,
  clientMac: string,
  address: string,
  status: DhcpBinding['status']
) {
  const server = device.dhcpServer!;
  clientMac = clientMac.toLowerCase();
  let binding = server.bindings.find(
    (entry) =>
      entry.clientMac === clientMac &&
      sameDhcpScope(
        server.pools.find((item) => item.name === entry.pool)!,
        pool
      )
  );
  if (!binding) {
    if (server.bindings.length >= 2048) return;
    binding = { id: engine.id('dhcp-binding'), pool: pool.name, clientMac, address, status, expiresAt: 0 };
    server.bindings.push(binding);
  }
  if (status === 'offered' && binding.status === 'bound' && binding.expiresAt > engine.state.clock)
    return binding;
  Object.assign(binding, {
    pool: pool.name,
    address,
    status,
    expiresAt: engine.state.clock + (status === 'offered' ? DHCP.offerMs : pool.leaseMs),
  });
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'dhcp-binding-expire' || action.device !== device.id || action.binding !== binding!.id
  );
  engine.schedule(binding.expiresAt - engine.state.clock, {
    kind: 'dhcp-binding-expire',
    device: device.id,
    binding: binding.id,
    expiresAt: binding.expiresAt,
  });
  return binding;
}

function response(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  request: DhcpMessage,
  type: 'offer' | 'ack',
  pool: DhcpPool,
  address: string
) {
  const message: DhcpMessage = {
    type,
    transactionId: request.transactionId,
    clientMac: request.clientMac,
    clientIp: request.clientIp,
    giaddr: request.giaddr,
    hops: request.hops,
    address,
    prefix: pool.prefix,
    server: port.ip!,
    gateway: pool.gateway,
    dns: [...pool.dns],
    leaseMs: pool.leaseMs,
  };
  const relayed = !!request.giaddr && request.giaddr !== DHCP.unspecifiedIp;
  const destination = relayed
    ? request.giaddr!
    : request.clientIp === DHCP.unspecifiedIp
      ? DHCP.broadcastIp
      : request.clientIp;
  sendDhcp(
    engine,
    device,
    port,
    message,
    destination,
    'DHCP ' +
      type.toUpperCase() +
      ': ' +
      address +
      '/' +
      pool.prefix +
      ' do pool ' +
      pool.name +
      '; lease de ' +
      pool.leaseMs / 1000 +
      ' s.',
    undefined,
    relayed
  );
}

function nack(engine: SimulationEngine, device: Device, port: NetworkInterface, request: DhcpMessage) {
  sendDhcp(
    engine,
    device,
    port,
    {
      type: 'nak',
      transactionId: request.transactionId,
      clientMac: request.clientMac,
      clientIp: request.clientIp,
      giaddr: request.giaddr,
      hops: request.hops,
      server: port.ip!,
    },
    request.giaddr && request.giaddr !== DHCP.unspecifiedIp ? request.giaddr : DHCP.broadcastIp,
    'DHCP NAK: endereço solicitado não possui concessão válida neste pool.',
    undefined,
    !!request.giaddr && request.giaddr !== DHCP.unspecifiedIp
  );
}

export function receiveDhcpServer(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: UdpPacket
) {
  const server = device.dhcpServer;
  if (!server?.enabled || !port.ip || (device.type !== 'server' && device.type !== 'router')) return;
  if (packet.payload.protocol !== 'DHCP') return;
  const message = packet.payload.message;
  const relayed = !!message.giaddr && message.giaddr !== DHCP.unspecifiedIp;
  const renewal = !relayed && packet.dst !== DHCP.broadcastIp && message.clientIp !== DHCP.unspecifiedIp;
  let pools = server.pools.filter((pool) => {
    const listener = device.interfaces.find((entry) => entry.id === pool.port);
    if (!listener?.adminUp || !listener.ip || (packet.dst !== DHCP.broadcastIp && packet.dst !== listener.ip))
      return false;
    if (relayed) return pool.relayAddress === message.giaddr;
    if (renewal) return sameSubnet(message.clientIp, pool.network, pool.prefix);
    return !pool.relayAddress && pool.port === port.id;
  });
  const reservedPool = pools.find((pool) =>
    pool.reservations?.some((entry) => entry.clientMac === message.clientMac.toLowerCase())
  );
  if (reservedPool) pools = [reservedPool];
  if (!pools.length) {
    engine.drop(device, 'DHCP: nenhum pool corresponde ao giaddr, ciaddr ou interface de destino.', port.id);
    return;
  }
  const sourcePort = device.interfaces.find((entry) => entry.id === pools[0].port)!;
  expireOldBindings(engine, device);
  const bindings = () => server.bindings.filter((entry) => pools.some((pool) => pool.name === entry.pool));
  const existing = bindings().find(
    (entry) => entry.clientMac.toLowerCase() === message.clientMac.toLowerCase()
  );
  if (message.type === 'decline') {
    if (message.server === sourcePort.ip && existing?.address === message.requestedIp) {
      removeBinding(engine, device, existing);
      server.declined = (server.declined ?? []).filter((v) => v.address !== message.requestedIp);
      if (server.declined.length === 256) server.declined.shift();
      server.declined.push({ address: message.requestedIp, expiresAt: engine.state.clock + 600000 });
      engine.emit(
        'DHCP_DECLINE',
        device.id,
        'Conflito ARP: ' + message.requestedIp + ' em quarentena por 600 s.',
        { port: port.id }
      );
    }
    return;
  }
  if (message.type === 'release') {
    if (message.server === sourcePort.ip && existing?.address === message.clientIp) {
      removeBinding(engine, device, existing);
      engine.emit('DHCP_RELEASE', device.id, 'Concessão ' + existing.address + ' devolvida pelo cliente.', {
        port: port.id,
      });
    }
    return;
  }
  if (message.type === 'discover') {
    if (existing) {
      const pool = pools.find((entry) => entry.name === existing.pool)!;
      response(engine, device, sourcePort, message, 'offer', pool, existing.address);
      return;
    }
    for (const pool of pools) {
      const reservation = pool.reservations?.find(
        (entry) => entry.clientMac === message.clientMac.toLowerCase()
      );
      if (reservation) {
        if (
          !bindings().some((entry) => entry.address === reservation.address) &&
          !server.declined?.some((v) => v.address === reservation.address) &&
          saveBinding(engine, device, pool, message.clientMac, reservation.address, 'offered')
        ) {
          response(engine, device, sourcePort, message, 'offer', pool, reservation.address);
          return;
        }
        continue;
      }
      for (let number = ipNumber(pool.start); number <= ipNumber(pool.end); number++) {
        const address = ipString(number);
        if (
          !availablePoolAddress(device, pool, address, message.clientMac) ||
          server.declined?.some((v) => v.address === address) ||
          bindings().some((entry) => entry.address === address)
        )
          continue;
        if (saveBinding(engine, device, pool, message.clientMac, address, 'offered')) {
          response(engine, device, sourcePort, message, 'offer', pool, address);
          return;
        }
        break;
      }
    }
    engine.emit(
      'DHCP_POOL_EXHAUSTED',
      device.id,
      'Nenhum endereço disponível: verifique exclusões, reservas e concessões do pool.',
      { port: port.id }
    );
    return;
  }
  if (message.type !== 'request' || (message.server && message.server !== sourcePort.ip)) return;
  const pool = pools.find((entry) => poolContains(entry, message.requestedIp));
  const collision = bindings().some(
    (entry) =>
      entry.address === message.requestedIp &&
      entry.clientMac.toLowerCase() !== message.clientMac.toLowerCase()
  );
  const selected = message.server === sourcePort.ip;
  const renewing = message.clientIp !== DHCP.unspecifiedIp && message.clientIp === message.requestedIp;
  const valid =
    pool &&
    availablePoolAddress(device, pool, message.requestedIp, message.clientMac) &&
    !collision &&
    !server.declined?.some((v) => v.address === message.requestedIp) &&
    ((selected && existing?.address === message.requestedIp) || renewing);
  if (!valid || !saveBinding(engine, device, pool, message.clientMac, message.requestedIp, 'bound')) {
    if (selected || packet.dst === sourcePort.ip) nack(engine, device, sourcePort, message);
    return;
  }
  response(engine, device, sourcePort, message, 'ack', pool, message.requestedIp);
}
