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
import { syncNat } from './state-sync';
import { staticNatOutside, natPools } from './nat-selection';
import { matchingAclRule } from './acl';

export function validateNat(device: Device) {
  if (!device.nat) return;
  if (device.type !== 'router') throw new Error('NAT exige um roteador.');
  const nat = device.nat;
  for (const rule of nat.interfaceRules ?? []) {
    if (!device.interfaces.some((p) => p.id === rule.outside && p.mode === 'routed'))
      throw new Error('PAT requires a routed outside interface.');
  }
  if (
    new Set([...(nat.interfaceRules ?? []).map((r) => r.name), ...nat.pools.map((p) => p.name)]).size !==
    (nat.interfaceRules?.length ?? 0) + nat.pools.length
  )
    throw new Error('Duplicate NAT rule name.');
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
    if (!isUnicast(mapping.global)) throw new Error('Endereço global inválido.');
    if (mapping.outside !== '*') validGlobal(mapping.outside, mapping.global);
  }
  if (new Set(nat.pools.map((pool) => pool.name)).size !== nat.pools.length)
    throw new Error('Pool NAT duplicado.');
  for (const pool of nat.iosPools ?? []) {
    const range = subnet(pool.start, pool.prefix);
    if (ipNumber(pool.end) < ipNumber(pool.start)) throw new Error('End address less than start address');
    if (!sameSubnet(pool.end, pool.start, pool.prefix))
      throw new Error(`Start and end addresses on different subnets (pool ${pool.name})`);
    if (pool.prefix < 31 && [range.network, range.broadcast].some((a) => a === pool.start || a === pool.end))
      throw new Error(`Pool ${pool.name} includes a network or broadcast address`);
    if (ipNumber(pool.end) - ipNumber(pool.start) > 1023)
      throw new Error('NAT pools are limited to 1024 addresses in this simulator.');
  }
  if (new Set((nat.iosPools ?? []).map((pool) => pool.name)).size !== (nat.iosPools?.length ?? 0))
    throw new Error('Pool NAT duplicado.');
  for (const rule of nat.poolRules ?? []) {
    if (!nat.iosPools?.some((pool) => pool.name === rule.pool))
      throw new Error(`Pool ${rule.pool} not found`);
    if (nat.poolRules!.some((other) => other.pool === rule.pool && other.overload !== rule.overload))
      throw new Error(`Pool ${rule.pool} is used both with and without overload.`);
  }
  if (new Set((nat.poolRules ?? []).map((rule) => rule.acl)).size !== (nat.poolRules?.length ?? 0))
    throw new Error('Each access list maps to one NAT pool.');
  // Static PAT: one global address and port per protocol; one inside mapping unless "extendable".
  const portStatics = nat.portStatics ?? [];
  for (const entry of portStatics) {
    if (!isUnicast(entry.inside) || !isUnicast(entry.global)) throw new Error('Endereço NAT inválido.');
    const sameGlobal = portStatics.filter(
      (other) =>
        other.protocol === entry.protocol &&
        other.global === entry.global &&
        other.globalPort === entry.globalPort
    );
    const sameInside = portStatics.filter(
      (other) =>
        other.protocol === entry.protocol &&
        other.inside === entry.inside &&
        other.insidePort === entry.insidePort
    );
    if (sameGlobal.length > 1)
      throw new Error(`similar static entry (${entry.global}:${entry.globalPort}) already exists`);
    if (sameInside.length > 1 && sameInside.some((other) => !other.extendable))
      throw new Error(
        `similar static entry (${entry.inside}:${entry.insidePort}) already exists; use extendable`
      );
  }
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
  for (const binding of device.nat?.bindings ?? []) syncNat(engine, device, binding, true);
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
  engine.scheduleAt(binding.expiresAt, {
    kind: 'nat-expire',
    device: device.id,
    binding: binding.id,
    expiresAt: binding.expiresAt,
  });
  syncNat(engine, device, binding);
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

/** Interface PAT owns the current outside address; changing it invalidates old translations. */
export function refreshInterfacePat(engine: SimulationEngine, device: Device) {
  const n = device.nat;
  if (!n?.interfaceRules?.length) return;
  const names = new Set(n.interfaceRules.map((r) => r.name)),
    pools = natPools(device);
  for (const b of [...n.bindings])
    if (names.has(b.pool) && !pools.some((p) => p.name === b.pool && b.global === p.start)) {
      syncNat(engine, device, b, true);
      n.bindings = n.bindings.filter((x) => x.id !== b.id);
      engine.state.queue = engine.state.queue.filter(
        (q) => q.action.kind !== 'nat-expire' || q.action.device !== device.id || q.action.binding !== b.id
      );
    }
}

export function natOwnsAddress(device: Device, port: NetworkInterface, address: string) {
  if (!device.nat?.enabled || port.natRole !== 'outside') return false;
  const groups = device.vrrp?.enabled ? device.vrrp.groups.filter((g) => g.port === port.id) : [];
  if (groups.length && !groups.some((g) => g.state === 'ACTIVE')) return false;
  return (
    device.nat.statics.some((entry) => staticNatOutside(entry.outside, port) && entry.global === address) ||
    (device.nat.portStatics ?? []).some((entry) => entry.global === address) ||
    device.nat.bindings.some(
      (entry) =>
        entry.global === address &&
        natPools(device).some((pool) => pool.name === entry.pool && staticNatOutside(pool.outside, port))
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
  const fixed = nat.statics.find(
    (entry) => entry.inside === packet.src && staticNatOutside(entry.outside, output)
  );
  if (fixed) {
    engine.emit(
      'NAT_TRANSLATED',
      device.id,
      'Static NAT source ' + packet.src + ' -> ' + fixed.global + '.',
      { port: output.id }
    );
    return { ...packet, src: fixed.global };
  }
  // A server answering from a forwarded port leaves with its static PAT address and port.
  const forwarded =
    packet.protocol === 'TCP' || packet.protocol === 'UDP'
      ? (nat.portStatics ?? []).find(
          (entry) =>
            entry.protocol === packet.protocol.toLowerCase() &&
            entry.inside === packet.src &&
            entry.insidePort === packet.sourcePort
        )
      : undefined;
  if (forwarded && (packet.protocol === 'TCP' || packet.protocol === 'UDP')) {
    engine.emit(
      'NAT_TRANSLATED',
      device.id,
      `Static PAT source ${packet.src}:${packet.sourcePort} -> ${forwarded.global}:${forwarded.globalPort}.`,
      { port: output.id }
    );
    return { ...packet, src: forwarded.global, sourcePort: forwarded.globalPort };
  }
  const pool = natPools(device).find(
    (entry) =>
      staticNatOutside(entry.outside, output) &&
      sameSubnet(entry.source.network, packet.src, entry.source.prefix) &&
      (!entry.sourceAcl || matchingAclRule(device, entry.sourceAcl, packet)?.action === 'permit')
  );
  if (!pool) return packet;
  if ((packet.protocol === 'GRE' || packet.protocol === 'ESP') && pool.overload) {
    engine.drop(
      device,
      `PAT cannot translate ${packet.protocol}: it has no ports (use static NAT or NAT-T).`,
      output.id
    );
    return;
  }
  const ported = packet.protocol === 'TCP' || packet.protocol === 'UDP';
  const token = ported
    ? String(packet.sourcePort)
    : packet.protocol === 'ICMP'
      ? packet.probeId
      : packet.protocol;
  const remotePort = ported ? packet.destinationPort : 0;
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
      protocol: pool.overload ? (packet.protocol as 'ICMP' | 'UDP' | 'TCP') : 'ip',
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
  return packet.protocol === 'TCP' || packet.protocol === 'UDP'
    ? { ...packet, src: binding.global, sourcePort: Number(binding.globalToken) }
    : packet.protocol === 'ICMP'
      ? { ...packet, src: binding.global, probeId: binding.globalToken! }
      : packet;
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
  const fixed = nat.statics.find(
    (entry) => staticNatOutside(entry.outside, port) && entry.global === packet.dst
  );
  if (fixed) {
    engine.emit(
      'NAT_TRANSLATED',
      device.id,
      'Static NAT destination ' + packet.dst + ' -> ' + fixed.inside + '.',
      { port: port.id }
    );
    return { ...packet, dst: fixed.inside };
  }
  // Port forwarding: only the mapped protocol and port reach the inside server.
  const forwarded =
    packet.protocol === 'TCP' || packet.protocol === 'UDP'
      ? (nat.portStatics ?? []).find(
          (entry) =>
            entry.protocol === packet.protocol.toLowerCase() &&
            entry.global === packet.dst &&
            entry.globalPort === packet.destinationPort
        )
      : undefined;
  if (forwarded && (packet.protocol === 'TCP' || packet.protocol === 'UDP')) {
    engine.emit(
      'NAT_TRANSLATED',
      device.id,
      `Static PAT destination ${packet.dst}:${packet.destinationPort} -> ${forwarded.inside}:${forwarded.insidePort}.`,
      { port: port.id }
    );
    return { ...packet, dst: forwarded.inside, destinationPort: forwarded.insidePort };
  }
  const ported = packet.protocol === 'TCP' || packet.protocol === 'UDP';
  const token = ported
    ? String(packet.destinationPort)
    : packet.protocol === 'ICMP'
      ? packet.probeId
      : packet.protocol;
  const binding = nat.bindings.find(
    (entry) =>
      entry.global === packet.dst &&
      entry.expiresAt > engine.state.clock &&
      natPools(device).some((pool) => pool.name === entry.pool && staticNatOutside(pool.outside, port)) &&
      (entry.protocol === 'ip' ||
        (entry.protocol === packet.protocol &&
          entry.globalToken === token &&
          entry.remote === packet.src &&
          (packet.protocol === 'ICMP' || (ported && entry.remotePort === packet.sourcePort))))
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
  return packet.protocol === 'TCP' || packet.protocol === 'UDP'
    ? { ...packet, dst: binding.inside, destinationPort: Number(binding.insideToken) }
    : packet.protocol === 'ICMP'
      ? { ...packet, dst: binding.inside, probeId: binding.insideToken! }
      : packet;
}

export function validateNatSnapshot(snapshot: Snapshot) {
  validateHairpins(snapshot);
  validateSipAlg(snapshot);
  for (const device of snapshot.devices) {
    validateNat(device);
    const ids = new Set<string>();
    for (const binding of device.nat?.bindings ?? []) {
      const pool = natPools(device).find((entry) => entry.name === binding.pool);
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
