import {
  BROADCAST,
  LIMITS,
  DHCP,
  type Action,
  type Device,
  type DhcpClient,
  type DhcpLease,
  type Frame,
  type DhcpMessage,
  type NetworkInterface,
  type UdpPacket,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import { isUnicast } from './dhcp-config';
import { sameSubnet, subnet } from './ipv4';
import { sendDhcp } from './dhcp-wire';
import { retainArpResolutions } from './arp';

type ClientTimer = Extract<Action, { kind: 'dhcp-client-timer' }>;

function cancelTimers(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  timers?: ClientTimer['timer'][]
) {
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'dhcp-client-timer' ||
      action.device !== device.id ||
      action.port !== port.id ||
      (timers !== undefined && !timers.includes(action.timer))
  );
}

function clearAddress(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  delete port.ip;
  delete port.prefix;
  delete port.gateway;
  delete port.dns;
  device.arpTable = device.arpTable.filter((entry) => entry.port !== port.id);
  device.pending = device.pending.filter(
    (entry) =>
      entry.port !== port.id ||
      (entry.packet.protocol === 'UDP' &&
        entry.packet.payload.protocol === 'DHCP' &&
        entry.packet.payload.message.type === 'release')
  );
  retainArpResolutions(engine, device);
}

function schedule(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  timer: ClientTimer['timer'],
  at: number,
  token: string
) {
  engine.schedule(Math.max(0, at - engine.state.clock), {
    kind: 'dhcp-client-timer',
    device: device.id,
    port: port.id,
    timer,
    token,
  });
}

function transmit(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  const client = port.dhcp!;
  const identity = {
    transactionId: client.transactionId,
    clientMac: port.mac,
    clientIp: DHCP.unspecifiedIp as string,
  };
  let message: DhcpMessage;
  let destination: string = DHCP.broadcastIp;
  if (client.status === 'selecting') message = { ...identity, type: 'discover' };
  else if (client.status === 'requesting' && client.offer) {
    message = {
      ...identity,
      type: 'request',
      requestedIp: client.offer.address,
      server: client.offer.server,
    };
    client.requestedAt ??= engine.state.clock;
  } else if ((client.status === 'renewing' || client.status === 'rebinding') && client.lease) {
    message = {
      ...identity,
      clientIp: client.lease.address,
      type: 'request',
      requestedIp: client.lease.address,
    };
    if (client.status === 'renewing') destination = client.lease.server;
    client.requestedAt ??= engine.state.clock;
  } else return;
  client.attempts++;
  sendDhcp(
    engine,
    device,
    port,
    message,
    destination,
    'DHCP ' +
      message.type.toUpperCase() +
      ': ' +
      client.status +
      ', tentativa ' +
      client.attempts +
      (destination === DHCP.broadcastIp
        ? '; broadcast local UDP 68 -> 67.'
        : '; renovação unicast para ' + destination + '.')
  );
  schedule(
    engine,
    device,
    port,
    'retry',
    engine.state.clock + DHCP.retryMs * 2 ** (client.attempts - 1),
    client.transactionId
  );
}

export function startDhcp(engine: SimulationEngine, device: Device, port: NetworkInterface, restarts = 0) {
  if (device.type === 'switch' || port.mode !== 'routed')
    throw new Error('DHCP requer uma interface routed de endpoint.');
  if (device.dhcpServer?.pools.some((pool) => pool.port === port.id))
    throw new Error('A interface de um pool DHCP deve manter IPv4 estático.');
  if (port.dhcpRelay?.length) throw new Error('A interface DHCP relay deve manter IPv4 estático.');
  cancelTimers(engine, device, port);
  clearAddress(engine, device, port);
  port.ipv4Mode = 'dhcp';
  port.dhcp = { status: 'selecting', transactionId: engine.id('dhcp'), attempts: 0, restarts };
  if (restarts)
    schedule(engine, device, port, 'retry', engine.state.clock + DHCP.retryMs, port.dhcp.transactionId);
  else transmit(engine, device, port);
}

export function renewDhcp(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  if (!port.dhcp?.lease) {
    startDhcp(engine, device, port);
    return;
  }
  cancelTimers(engine, device, port, ['retry', 'renew']);
  port.dhcp.status = 'renewing';
  port.dhcp.transactionId = engine.id('dhcp');
  port.dhcp.attempts = 0;
  delete port.dhcp.requestedAt;
  engine.emit(
    'DHCP_RENEWING',
    device.id,
    'T1: renovando ' + port.ip + ' com o servidor ' + port.dhcp.lease.server + '.',
    { port: port.id }
  );
  transmit(engine, device, port);
}

export function releaseDhcp(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  const lease = port.dhcp?.lease;
  if (!port.dhcp) throw new Error('DHCP não está habilitado nesta interface.');
  if (lease)
    sendDhcp(
      engine,
      device,
      port,
      {
        type: 'release',
        transactionId: engine.id('dhcp'),
        clientMac: port.mac,
        clientIp: lease.address,
        server: lease.server,
      },
      lease.server,
      'Devolvendo a concessão ' + lease.address + ' ao servidor.'
    );
  cancelTimers(engine, device, port);
  clearAddress(engine, device, port);
  port.dhcp = { status: 'released', transactionId: engine.id('dhcp'), attempts: 0 };
}

export function disableDhcp(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  if (port.dhcp) releaseDhcp(engine, device, port);
  delete port.dhcp;
  port.ipv4Mode = 'static';
}

function validOptions(message: Extract<DhcpMessage, { type: 'offer' | 'ack' }>) {
  const network = subnet(message.address, message.prefix);
  return (
    isUnicast(message.address) &&
    message.address !== network.network &&
    message.address !== network.broadcast &&
    isUnicast(message.server) &&
    (!message.gateway ||
      (isUnicast(message.gateway) &&
        sameSubnet(message.address, message.gateway, message.prefix) &&
        message.gateway !== network.network &&
        message.gateway !== network.broadcast)) &&
    message.dns.every(isUnicast)
  );
}

export function receiveDhcpClient(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: UdpPacket,
  sourceMac: string
) {
  const client = port.dhcp;
  if (packet.payload.protocol !== 'DHCP') return;
  const message = packet.payload.message;
  if (
    !client ||
    port.ipv4Mode !== 'dhcp' ||
    message.clientMac !== port.mac ||
    message.transactionId !== client.transactionId
  )
    return;
  if (message.type === 'offer' && client.status === 'selecting') {
    if (!validOptions(message)) {
      engine.drop(device, 'Oferta DHCP contém opções incompatíveis com a subnet.', port.id);
      return;
    }
    cancelTimers(engine, device, port, ['retry']);
    client.offer = { address: message.address, server: message.server };
    client.status = 'requesting';
    client.attempts = 0;
    transmit(engine, device, port);
    return;
  }
  if (!['requesting', 'renewing', 'rebinding'].includes(client.status)) return;
  const expectedServer = client.status === 'requesting' ? client.offer?.server : client.lease?.server;
  if ('server' in message && client.status !== 'rebinding' && message.server !== expectedServer) return;
  if (message.type === 'nak') {
    cancelTimers(engine, device, port);
    clearAddress(engine, device, port);
    const restarts = (client.restarts ?? 0) + 1;
    if (restarts >= DHCP.attempts) {
      port.dhcp = {
        status: 'failed',
        transactionId: client.transactionId,
        attempts: client.attempts,
        restarts,
      };
      engine.emit(
        'DHCP_FAILED',
        device.id,
        'DHCP NAK repetido: limite de reinícios atingido. Revise a configuração do servidor.',
        { port: port.id }
      );
    } else {
      engine.emit(
        'DHCP_NAK',
        device.id,
        'Endereço recusado; configuração removida e nova descoberta em 4 s virtuais.',
        { port: port.id }
      );
      startDhcp(engine, device, port, restarts);
    }
    return;
  }
  if (message.type !== 'ack') return;
  const expectedAddress = client.status === 'requesting' ? client.offer?.address : client.lease?.address;
  if (message.address !== expectedAddress || !validOptions(message)) {
    engine.drop(
      device,
      'DHCP ACK não corresponde ao endereço solicitado ou contém opções inválidas.',
      port.id
    );
    return;
  }
  const acquiredAt = client.requestedAt ?? engine.state.clock;
  if (acquiredAt + message.leaseMs <= engine.state.clock) {
    engine.drop(device, 'DHCP ACK chegou após a validade da concessão.', port.id);
    return;
  }
  cancelTimers(engine, device, port);
  const lease = {
    id: engine.id('dhcp-lease'),
    address: message.address,
    prefix: message.prefix,
    server: message.server,
    serverMac: sourceMac,
    gateway: message.gateway,
    dns: [...message.dns],
    acquiredAt,
    renewAt: acquiredAt + message.leaseMs / 2,
    rebindAt: acquiredAt + message.leaseMs * 0.875,
    expiresAt: acquiredAt + message.leaseMs,
  };
  if (port.dhcpConflictDetection && !client.lease) {
    port.dhcp = {
      status: 'probing',
      transactionId: client.transactionId,
      attempts: 0,
      restarts: client.restarts,
      pendingLease: lease,
    };
    probeAddress(engine, device, port);
  } else bindAddress(engine, device, port, lease, client.transactionId);
}
function bindAddress(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  lease: DhcpLease,
  transactionId: string
) {
  Object.assign(port, {
    ip: lease.address,
    prefix: lease.prefix,
    gateway: lease.gateway,
    dns: [...lease.dns],
  });
  device.arpTable = device.arpTable.filter((entry) => entry.port !== port.id);
  port.dhcp = { status: 'bound', transactionId, attempts: 0, lease };
  engine.emit(
    'DHCP_BOUND',
    device.id,
    'Concessão aplicada: ' +
      lease.address +
      '/' +
      lease.prefix +
      '; gateway ' +
      (lease.gateway ?? 'não informado') +
      '; expira em ' +
      lease.expiresAt.toFixed(3) +
      ' ms virtuais.',
    { port: port.id }
  );
  schedule(engine, device, port, 'renew', lease.renewAt, lease.id);
  schedule(engine, device, port, 'rebind', lease.rebindAt, lease.id);
  schedule(engine, device, port, 'expire', lease.expiresAt, lease.id);
}
export function handleDhcpClientTimer(engine: SimulationEngine, action: ClientTimer) {
  const device = engine.device(action.device);
  const port = device.interfaces.find((entry) => entry.id === action.port);
  const client: DhcpClient | undefined = port?.dhcp;
  if (!port || !client || port.ipv4Mode !== 'dhcp') return;
  if (action.timer === 'probe') {
    if (
      client.status !== 'probing' ||
      client.pendingLease?.id !== action.token ||
      client.probeAt !== engine.state.clock
    )
      return;
    if (client.pendingLease.expiresAt <= engine.state.clock) {
      startDhcp(engine, device, port, 1);
      return;
    }
    if (client.attempts < 3) probeAddress(engine, device, port);
    else bindAddress(engine, device, port, client.pendingLease, client.transactionId);
    return;
  }
  if (action.timer === 'retry') {
    if (
      action.token !== client.transactionId ||
      !['selecting', 'requesting', 'renewing', 'rebinding'].includes(client.status)
    )
      return;
    if (client.attempts < DHCP.attempts) transmit(engine, device, port);
    else if (!client.lease) {
      client.status = 'failed';
      delete client.offer;
      engine.emit(
        'DHCP_FAILED',
        device.id,
        'Sem resposta DHCP após quatro tentativas. Verifique serviço, pool, VLAN e conectividade.',
        { port: port.id }
      );
    }
    return;
  }
  if (action.token !== client.lease?.id) return;
  if (action.timer === 'renew') renewDhcp(engine, device, port);
  else if (action.timer === 'rebind') {
    cancelTimers(engine, device, port, ['retry', 'renew']);
    client.status = 'rebinding';
    client.transactionId = engine.id('dhcp');
    client.attempts = 0;
    delete client.requestedAt;
    engine.emit(
      'DHCP_REBINDING',
      device.id,
      'T2: servidor não confirmou a renovação; DHCP Request em broadcast.',
      { port: port.id }
    );
    transmit(engine, device, port);
  } else {
    const address = client.lease.address;
    cancelTimers(engine, device, port);
    clearAddress(engine, device, port);
    port.dhcp = { status: 'expired', transactionId: client.transactionId, attempts: 0 };
    engine.emit(
      'DHCP_EXPIRED',
      device.id,
      'Lease de ' + address + ' expirou: IPv4, gateway e DNS removidos antes de nova descoberta.',
      { port: port.id }
    );
    startDhcp(engine, device, port);
  }
}

function probeAddress(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const c = p.dhcp!,
    lease = c.pendingLease!;
  c.attempts++;
  const frame: Frame = {
    src: p.mac,
    dst: BROADCAST,
    etherType: 'ARP',
    hops: LIMITS.l2Hops,
    arp: { kind: 'request', senderIp: '0.0.0.0', senderMac: p.mac, targetIp: lease.address },
  };
  e.emit('DHCP_PROBE', d.id, 'ARP probe ' + c.attempts + '/3 para ' + lease.address + '.', {
    port: p.id,
    frame,
  });
  e.sendFrame(d.id, p.id, frame);
  c.probeAt = e.state.clock + 1000;
  schedule(e, d, p, 'probe', c.probeAt, lease.id);
}
export function observeDhcpArp(e: SimulationEngine, d: Device, p: NetworkInterface, f: Frame) {
  const c = p.dhcp,
    a = f.arp,
    lease = c?.pendingLease;
  if (
    !a ||
    !lease ||
    c?.status !== 'probing' ||
    a.senderMac === p.mac ||
    a.senderMac !== f.src ||
    (a.senderIp !== lease.address && !(a.senderIp === '0.0.0.0' && a.targetIp === lease.address))
  )
    return false;
  cancelTimers(e, d, p);
  sendDhcp(
    e,
    d,
    p,
    {
      type: 'decline',
      transactionId: c.transactionId,
      clientMac: p.mac,
      clientIp: '0.0.0.0',
      server: lease.server,
      requestedIp: lease.address,
    },
    DHCP.broadcastIp,
    'Conflito detectado por ARP; DECLINE para ' + lease.server + '.'
  );
  const restarts = (c.restarts ?? 0) + 1;
  if (restarts >= DHCP.attempts)
    p.dhcp = { status: 'failed', transactionId: c.transactionId, attempts: 0, restarts };
  else startDhcp(e, d, p, restarts);
  return true;
}
