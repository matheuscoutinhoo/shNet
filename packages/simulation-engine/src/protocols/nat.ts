import { sipMediaOutbound, sipOutbound, sipInbound, validateSipAlg } from './nat-sip';
import { hairpinInbound, hairpinOutbound, validateHairpins } from './nat-hairpin';
import {
  natSchema,
  type Device,
  type NatBinding,
  type NetworkInterface,
  type Packet,
  type Snapshot,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import { ipNumber, ipString, sameSubnet, subnet } from './ipv4';
import { isUnicast } from './dhcp-config';
import { isIcmpError } from './icmp';
import { natIcmpInbound, natIcmpOutbound } from './nat-icmp';

export function validateNat(device: Device) {
  if (!device.nat) return;
  if (device.type !== 'router') throw new Error('NAT exige um roteador.');
  const nat = device.nat;
  if (
    device.vrrp?.groups.some(
      (group) =>
        nat.statics.some((entry) => entry.global === group.vip) ||
        nat.pools.some(
          (pool) => ipNumber(group.vip) >= ipNumber(pool.start) && ipNumber(group.vip) <= ipNumber(pool.end)
        )
    )
  )
    throw new Error('Endereço global NAT conflita com VIP VRRP.');
  const validGlobal = (outside: string, address: string) => {
    const port = device.interfaces.find((entry) => entry.id === outside);
    if (
      !port?.ip ||
      port.prefix === undefined ||
      port.natRole !== 'outside' ||
      !isUnicast(address) ||
      !sameSubnet(address, port.ip, port.prefix)
    )
      throw new Error('Endereço NAT deve pertencer à interface outside.');
    const range = subnet(port.ip, port.prefix);
    if (port.prefix < 31 && [range.network, range.broadcast].includes(address))
      throw new Error('NAT exige endereço global de host.');
  };
  if (
    new Set(nat.statics.map((entry) => entry.inside)).size !== nat.statics.length ||
    new Set(nat.statics.map((entry) => entry.global)).size !== nat.statics.length
  )
    throw new Error('Mapeamento NAT estático duplicado.');
  for (const mapping of nat.statics) {
    if (!isUnicast(mapping.inside)) throw new Error('Endereço inside inválido.');
    validGlobal(mapping.outside, mapping.global);
  }
  if (new Set(nat.pools.map((pool) => pool.name)).size !== nat.pools.length)
    throw new Error('Pool NAT duplicado.');
  for (const pool of nat.pools) {
    validGlobal(pool.outside, pool.start);
    validGlobal(pool.outside, pool.end);
    if (
      subnet(pool.source.network, pool.source.prefix).network !== pool.source.network ||
      ipNumber(pool.end) < ipNumber(pool.start) ||
      ipNumber(pool.end) - ipNumber(pool.start) > 255
    )
      throw new Error('Rede ou intervalo NAT inválido; máximo de 256 endereços.');
    if (
      nat.pools.some(
        (other) =>
          other !== pool &&
          ipNumber(other.start) <= ipNumber(pool.end) &&
          ipNumber(pool.start) <= ipNumber(other.end)
      ) ||
      nat.statics.some(
        (entry) =>
          ipNumber(entry.global) >= ipNumber(pool.start) && ipNumber(entry.global) <= ipNumber(pool.end)
      )
    )
      throw new Error('Endereços NAT sobrepostos.');
  }
}

export function configureNat(engine: SimulationEngine, device: Device, input: unknown) {
  const config = natSchema.parse(input);
  config.bindings = [];
  config.hairpins = [];
  config.sipBindings = [];
  validateNat({ ...device, nat: config });
  device.nat = config;
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      (action.kind !== 'nat-expire' &&
        action.kind !== 'nat-hairpin-expire' &&
        action.kind !== 'sip-alg-expire') ||
      action.device !== device.id
  );
  engine.emit('CONFIG_CHANGED', device.id, 'Configuração NAT aplicada; traduções dinâmicas reiniciadas.');
  return config;
}

function touch(engine: SimulationEngine, device: Device, binding: NatBinding) {
  binding.expiresAt =
    engine.state.clock + (binding.protocol === 'TCP' ? 300000 : binding.protocol === 'UDP' ? 120000 : 60000);
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'nat-expire' || action.device !== device.id || action.binding !== binding.id
  );
  engine.schedule(binding.expiresAt - engine.state.clock, {
    kind: 'nat-expire',
    device: device.id,
    binding: binding.id,
    expiresAt: binding.expiresAt,
  });
}
export function expireNat(engine: SimulationEngine, device: Device, id: string, expiresAt: number) {
  const binding = device.nat?.bindings.find((entry) => entry.id === id && entry.expiresAt === expiresAt);
  if (!binding) return;
  device.nat!.bindings = device.nat!.bindings.filter((entry) => entry.id !== id);
  engine.emit(
    'NAT_EXPIRED',
    device.id,
    'Tradução expirada: ' + binding.inside + ' -> ' + binding.global + '.'
  );
}

export function natOwnsAddress(device: Device, port: NetworkInterface, address: string) {
  if (!device.nat?.enabled || port.natRole !== 'outside') return false;
  return (
    device.nat.statics.some((entry) => entry.outside === port.id && entry.global === address) ||
    device.nat.bindings.some(
      (entry) =>
        entry.global === address &&
        device.nat!.pools.some((pool) => pool.name === entry.pool && pool.outside === port.id)
    )
  );
}

export function natOutbound(
  engine: SimulationEngine,
  device: Device,
  input: NetworkInterface | undefined,
  output: NetworkInterface,
  packet: Packet
): Packet | undefined {
  return (
    sipMediaOutbound(engine, device, input, output, packet) ??
    sipOutbound(
      engine,
      device,
      input,
      output,
      packet,
      translateOutbound(engine, device, input, output, packet)
    )
  );
}
function translateOutbound(
  engine: SimulationEngine,
  device: Device,
  input: NetworkInterface | undefined,
  output: NetworkInterface,
  packet: Packet
): Packet | undefined {
  if (packet.protocol === 'OSPF' || packet.protocol === 'VRRP') return packet;
  const hp = hairpinOutbound(engine, device, input, output, packet);
  if (hp) return hp;
  const nat = device.nat;
  if (nat?.enabled && output.natRole === 'outside' && isIcmpError(packet))
    return natIcmpOutbound(engine, device, output, packet);
  if (!nat?.enabled || input?.natRole !== 'inside' || output.natRole !== 'outside') return packet;
  const fixed = nat.statics.find((entry) => entry.inside === packet.src && entry.outside === output.id);
  if (fixed) {
    engine.emit(
      'NAT_TRANSLATED',
      device.id,
      'Static NAT source ' + packet.src + ' -> ' + fixed.global + '.',
      { port: output.id }
    );
    return { ...packet, src: fixed.global };
  }
  const pool = nat.pools.find(
    (entry) =>
      entry.outside === output.id && sameSubnet(entry.source.network, packet.src, entry.source.prefix)
  );
  if (!pool) return packet;
  const token = packet.protocol !== 'ICMP' ? String(packet.sourcePort) : packet.probeId;
  const remotePort = packet.protocol !== 'ICMP' ? packet.destinationPort : 0;
  let binding = nat.bindings.find(
    (entry) =>
      entry.pool === pool.name &&
      entry.inside === packet.src &&
      entry.expiresAt > engine.state.clock &&
      (!pool.overload ||
        (entry.protocol === packet.protocol &&
          entry.insideToken === token &&
          entry.remote === packet.dst &&
          entry.remotePort === remotePort))
  );
  if (!binding) {
    if (nat.bindings.length >= 1024) {
      engine.drop(device, 'Limite de traduções NAT atingido.', output.id);
      return;
    }
    let global: string | undefined;
    for (let address = ipNumber(pool.start); address <= ipNumber(pool.end); address++) {
      const candidate = ipString(address);
      if (
        pool.overload ||
        !nat.bindings.some((entry) => entry.global === candidate && entry.expiresAt > engine.state.clock)
      ) {
        global = candidate;
        break;
      }
    }
    if (!global) {
      engine.emit('NAT_EXHAUSTED', device.id, 'Pool NAT ' + pool.name + ' sem endereços disponíveis.');
      engine.drop(device, 'Pool NAT esgotado.', output.id);
      return;
    }
    const id = engine.id('nat');
    let mapped = 49152 + (engine.state.sequence % 16384);
    while (
      nat.bindings.some(
        (entry) =>
          entry.global === global &&
          entry.globalToken === (packet.protocol !== 'ICMP' ? String(mapped) : 'nat-icmp-' + mapped)
      )
    )
      mapped = mapped >= 65535 ? 49152 : mapped + 1;
    binding = {
      id,
      pool: pool.name,
      inside: packet.src,
      global,
      protocol: pool.overload ? packet.protocol : 'ip',
      expiresAt: 0,
      ...(pool.overload
        ? {
            insideToken: token,
            globalToken: packet.protocol !== 'ICMP' ? String(mapped) : 'nat-icmp-' + mapped,
            remote: packet.dst,
            remotePort,
          }
        : {}),
    };
    nat.bindings.push(binding);
  }
  touch(engine, device, binding);
  engine.emit(
    'NAT_TRANSLATED',
    device.id,
    (pool.overload ? 'PAT' : 'Dynamic NAT') +
      ' source ' +
      packet.src +
      ':' +
      token +
      ' -> ' +
      binding.global +
      ':' +
      (binding.globalToken ?? token) +
      '.',
    { port: output.id }
  );
  if (!pool.overload) return { ...packet, src: binding.global };
  return packet.protocol !== 'ICMP'
    ? { ...packet, src: binding.global, sourcePort: Number(binding.globalToken) }
    : { ...packet, src: binding.global, probeId: binding.globalToken! };
}

export function natInbound(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: Packet
): Packet | undefined {
  return sipInbound(engine, device, port, packet) ?? translateInbound(engine, device, port, packet);
}
function translateInbound(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: Packet
): Packet | undefined {
  if (packet.protocol === 'OSPF' || packet.protocol === 'VRRP') return packet;
  if (port.natRole === 'inside') return hairpinInbound(engine, device, port, packet);
  const nat = device.nat;
  if (!nat?.enabled || port.natRole !== 'outside') return packet;
  if (isIcmpError(packet)) return natIcmpInbound(engine, device, port, packet);
  const fixed = nat.statics.find((entry) => entry.outside === port.id && entry.global === packet.dst);
  if (fixed) {
    engine.emit(
      'NAT_TRANSLATED',
      device.id,
      'Static NAT destination ' + packet.dst + ' -> ' + fixed.inside + '.',
      { port: port.id }
    );
    return { ...packet, dst: fixed.inside };
  }
  const token = packet.protocol !== 'ICMP' ? String(packet.destinationPort) : packet.probeId;
  const binding = nat.bindings.find(
    (entry) =>
      entry.global === packet.dst &&
      entry.expiresAt > engine.state.clock &&
      nat.pools.some((pool) => pool.name === entry.pool && pool.outside === port.id) &&
      (entry.protocol === 'ip' ||
        (entry.protocol === packet.protocol &&
          entry.globalToken === token &&
          entry.remote === packet.src &&
          (packet.protocol === 'ICMP' || entry.remotePort === packet.sourcePort)))
  );
  if (!binding) return packet;
  touch(engine, device, binding);
  engine.emit(
    'NAT_TRANSLATED',
    device.id,
    'Reverse NAT ' +
      packet.dst +
      ':' +
      token +
      ' -> ' +
      binding.inside +
      ':' +
      (binding.insideToken ?? token) +
      '.',
    { port: port.id }
  );
  if (binding.protocol === 'ip') return { ...packet, dst: binding.inside };
  return packet.protocol !== 'ICMP'
    ? { ...packet, dst: binding.inside, destinationPort: Number(binding.insideToken) }
    : { ...packet, dst: binding.inside, probeId: binding.insideToken! };
}

export function validateNatSnapshot(snapshot: Snapshot) {
  validateHairpins(snapshot);
  validateSipAlg(snapshot);
  for (const device of snapshot.devices) {
    validateNat(device);
    const ids = new Set<string>();
    for (const binding of device.nat?.bindings ?? []) {
      const pool = device.nat!.pools.find((entry) => entry.name === binding.pool);
      if (
        !pool ||
        ids.has(binding.id) ||
        !sameSubnet(pool.source.network, binding.inside, pool.source.prefix) ||
        ipNumber(binding.global) < ipNumber(pool.start) ||
        ipNumber(binding.global) > ipNumber(pool.end) ||
        binding.expiresAt < snapshot.clock
      )
        throw new Error('Tradução NAT inválida.');
      ids.add(binding.id);
      if (
        pool.overload &&
        (!binding.insideToken || !binding.globalToken || !binding.remote || binding.protocol === 'ip')
      )
        throw new Error('Tradução PAT incompleta.');
      if (!pool.overload && binding.protocol !== 'ip')
        throw new Error('NAT dinâmico não deve alterar portas.');
      if (
        (binding.protocol === 'UDP' || binding.protocol === 'TCP') &&
        [binding.insideToken, binding.globalToken].some(
          (token) => !token || !/^\d+$/.test(token) || Number(token) < 1 || Number(token) > 65535
        )
      )
        throw new Error('Portas PAT inválidas.');
      if (binding.protocol === 'ICMP' && !/^nat-icmp-\d+$/.test(binding.globalToken ?? ''))
        throw new Error('Identificador PAT inválido.');
      if (
        !snapshot.queue.some(
          ({ at, action }) =>
            action.kind === 'nat-expire' &&
            action.device === device.id &&
            action.binding === binding.id &&
            at === binding.expiresAt &&
            action.expiresAt === binding.expiresAt
        )
      )
        throw new Error('Tradução NAT sem timer.');
    }
  }
}
