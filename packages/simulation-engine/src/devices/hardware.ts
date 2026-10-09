import { refreshInfrastructure } from './infrastructure';
import type { SimulationEngine } from '../core/engine';
import type { Device, Frame, NetworkInterface, Snapshot } from '../model';
import { consoleSchema, poeDeviceSchema, poeSupplySchema, serialSchema } from './hardware-model';
import { redactNetworkSecrets } from '../cli/aaa';
import { TerminalSession } from '../cli/terminal';
import { linkOperational } from '../links/physical';
const pse = [15.4, 4, 7, 15.4, 30, 45, 60, 75, 90],
  pd = [12.95, 3.84, 6.49, 12.95, 25.5, 40, 51, 62, 71];
function allocatePower(s: Snapshot) {
  for (const d of s.devices) {
    if (d.poeSupply) d.poeSupply.allocations = [];
    if (d.poeDevice?.required) {
      d.poeDevice.powered = false;
      delete d.poeDevice.source;
      d.power = false;
    }
  }
  for (let pass = 0; pass < s.devices.length; pass++) {
    let changed = false;
    for (const supply of s.devices.filter((d) => d.power && d.poeSupply?.enabled)) {
      const p = supply.poeSupply!;
      let used = p.allocations.reduce((n, a) => n + a.watts, 0);
      for (const config of [...p.ports]
        .filter((p) => p.enabled)
        .sort((a, b) => a.priority - b.priority || a.port.localeCompare(b.port))) {
        if (p.allocations.some((a) => a.port === config.port)) continue;
        const port = supply.interfaces.find((p) => p.id === config.port);
        if (!port?.adminUp || port.media !== 'rj45') continue;
        const link = s.links.find(
          (l) =>
            l.up &&
            ['copper', 'crossover'].includes(l.cable) &&
            [l.a, l.b].some((end) => end.device === supply.id && end.port === port.id)
        );
        if (!link) continue;
        const remote = link.a.device === supply.id ? link.b : link.a,
          target = s.devices.find((d) => d.id === remote.device),
          input = target?.interfaces.find((p) => p.id === remote.port),
          load = target?.poeDevice;
        if (!target || !input?.adminUp || !load?.required || !load.requested || load.powered) continue;
        const max = config.standard === 'af' ? 3 : config.standard === 'at' ? 4 : 8,
          reserved = pse[load.class];
        if (load.class > max || used + reserved > p.budget) continue;
        used += reserved;
        p.allocations.push({ port: port.id, device: target.id, watts: reserved });
        load.powered = true;
        load.source = supply.id;
        target.power = true;
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const d of s.devices)
    if (d.poeDevice && !d.poeDevice.required) {
      d.poeDevice.powered = d.power;
      delete d.poeDevice.source;
    }
}
export function refreshPower(e: SimulationEngine) {
  refreshInfrastructure(e);
  if (!e.state.devices.some((d) => d.poeSupply || d.poeDevice)) return;
  const before = new Map(e.state.devices.map((d) => [d.id, d.power]));
  allocatePower(e.state);
  for (const d of e.state.devices)
    if (before.get(d.id) !== d.power) {
      e.emit(
        d.power ? 'LINK_UP' : 'LINK_DOWN',
        d.id,
        d.power ? 'PoE: alimentação concedida.' : 'PoE: alimentação removida ou orçamento insuficiente.'
      );
      if (!d.power) {
        d.macTable = [];
        d.arpTable = [];
      }
    }
}
export function configurePoe(e: SimulationEngine, d: Device, supply: unknown, load?: unknown) {
  const c = supply === undefined ? undefined : poeSupplySchema.omit({ allocations: true }).parse(supply),
    p =
      load === undefined
        ? undefined
        : poeDeviceSchema.omit({ powered: true, source: true, requested: true }).parse(load);
  if (
    c &&
    (new Set(c.ports.map((p) => p.port)).size !== c.ports.length ||
      c.ports.some((v) => d.interfaces.find((p) => p.id === v.port)?.media !== 'rj45'))
  )
    throw new Error('PSE exige portas RJ45 distintas.');
  if (p && p.watts > pd[p.class]) throw new Error('Consumo excede a classe PoE do PD.');
  if (c) d.poeSupply = { ...c, allocations: [] };
  if (p) {
    const requested = d.poeDevice?.requested ?? d.power;
    d.poeDevice = { ...p, requested, powered: !p.required && requested };
    if (!p.required) d.power = requested;
  }
  refreshPower(e);
  e.emit('CONFIG_CHANGED', d.id, 'PoE: PSE/PD e orçamento aplicados.');
}
export function setDevicePower(e: SimulationEngine, d: Device, power: boolean) {
  if (d.poeDevice) d.poeDevice.requested = power;
  d.power = power;
  refreshPower(e);
}
export function addHardwarePort(
  e: SimulationEngine,
  d: Device,
  media: 'serial' | 'console',
  input?: unknown
) {
  if (d.interfaces.length >= 48) throw new Error('Limite de interfaces.');
  const serial =
      media === 'serial'
        ? serialSchema.parse(input ?? { role: 'DTE', clockRate: 64000, encapsulation: 'hdlc' })
        : undefined,
    console = media === 'console' ? consoleSchema.parse(input ?? { baud: '9600' }) : undefined;
  const id = e.id('port');
  const port: NetworkInterface = {
    id,
    name: (media === 'serial' ? 'Serial' : 'Console') + d.interfaces.filter((p) => p.media === media).length,
    mac: d.interfaces[0].mac.slice(0, -2) + (d.interfaces.length % 256).toString(16).padStart(2, '0'),
    media,
    adminUp: true,
    speed: 100,
    duplex: 'full',
    mtu: 1500,
    mode: 'routed',
    accessVlan: 1,
    nativeVlan: 1,
    allowedVlans: [1],
    description: '',
    errors: 0,
    tx: 0,
    rx: 0,
    ...(serial ? { serial } : {}),
    ...(console ? { console } : {}),
  };
  d.interfaces.push(port);
  e.emit('CONFIG_CHANGED', d.id, 'Porta ' + port.name + ' adicionada.');
  return port;
}
export function serialFrame(frame: Frame) {
  const clean = { ...frame };
  delete clean.wan;
  let fcs = 65535;
  for (const byte of new TextEncoder().encode(JSON.stringify({ ...clean, hops: 0 }))) {
    fcs ^= byte;
    for (let i = 0; i < 8; i++) fcs = fcs & 1 ? (fcs >>> 1) ^ 0x8408 : fcs >>> 1;
  }
  return {
    ...clean,
    wan: {
      encapsulation: 'hdlc' as const,
      protocol: frame.ipv6 ? ('IPv6' as const) : frame.arp ? ('ARP' as const) : ('IPv4' as const),
      fcs: fcs ^ 65535,
    },
  };
}
export function consoleCommand(e: SimulationEngine, source: string, linkId: string, line: string) {
  const link = e.state.links.find(
    (l) => l.id === linkId && l.cable === 'console' && [l.a, l.b].some((p) => p.device === source)
  );
  if (!link || !linkOperational(e.state, link))
    throw new Error('Console sem cabo/alimentação ou baud incompatível.');
  const end = link.a.device === source ? link.b : link.a,
    target = e.device(end.device);
  const session = new TerminalSession(e, target.id),
    stored = target.consoleSessions?.find((c) => c.link === link.id);
  if (stored) {
    session.context = { ...stored.context };
    session.history = [...stored.history];
  }
  const output = session.execute(line),
    current = e.device(target.id),
    sessions = (current.consoleSessions ??= []);
  const old = sessions.findIndex((s) => s.link === link.id);
  if (old >= 0) sessions.splice(old, 1);
  sessions.push({ link: link.id, context: session.context, history: session.history });
  e.emit(
    'APPLICATION_DATA',
    current.id,
    'Console UART: ' + session.prompt + ' ' + redactNetworkSecrets(line).slice(0, 100)
  );
  return output;
}
export function validateHardware(s: Snapshot) {
  const copy = structuredClone(s);
  allocatePower(copy);
  for (const d of s.devices) {
    const expected = copy.devices.find((v) => v.id === d.id)!;
    if (
      d.poeDevice &&
      (d.poeDevice.watts > pd[d.poeDevice.class] ||
        d.power !== expected.power ||
        JSON.stringify(d.poeDevice) !== JSON.stringify(expected.poeDevice))
    )
      throw new Error('Estado de alimentação PoE inconsistente.');
    if (
      d.poeSupply &&
      (JSON.stringify(d.poeSupply.allocations) !== JSON.stringify(expected.poeSupply!.allocations) ||
        new Set(d.poeSupply.ports.map((p) => p.port)).size !== d.poeSupply.ports.length ||
        d.poeSupply.ports.some((v) => d.interfaces.find((p) => p.id === v.port)?.media !== 'rj45'))
    )
      throw new Error('Orçamento/portas PoE inválidos.');
    for (const p of d.interfaces)
      if (
        (p.media === 'serial') !== !!p.serial ||
        (p.media === 'console') !== !!p.console ||
        (p.media === 'console' && (p.ip || p.ipv6 || p.mode !== 'routed')) ||
        (p.media === 'serial' && (p.mode !== 'routed' || p.logical))
      )
        throw new Error('Porta serial/console inválida.');
    const ids = new Set<string>();
    for (const c of d.consoleSessions ?? []) {
      if (
        ids.has(c.link) ||
        !s.links.some(
          (l) => l.id === c.link && l.cable === 'console' && [l.a, l.b].some((p) => p.device === d.id)
        ) ||
        (c.context.port && !d.interfaces.some((p) => p.id === c.context.port))
      )
        throw new Error('Sessão console inválida.');
      ids.add(c.link);
    }
  }
}
