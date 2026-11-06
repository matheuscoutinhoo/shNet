import { SimulationEngine } from '../core/engine';
import { interfaceSchema, startupConfigurationSchema, type Device, type NetworkInterface } from '../model';
import type { CommandRegistry, Context } from './registry';
import { validateSnapshot } from '../core/validation';
import { ospfConfigSchema } from '../protocols/ospf-model';
import { ripConfigSchema } from '../protocols/rip-model';
import { bgpConfig } from '../protocols/bgp';
import { configureDiscovery } from '../protocols/discovery';
import { archiveRunning } from './ios-operations';
import { applyDefaultSpanningTree } from '../protocols/stp';
import { hardwareSpeed, negotiateLink } from '../links/physical';
import { iosLogLine } from './ios-time';

/** Simulated time an IOS router or switch takes to boot after "reload". */
export const RELOAD_BOOT_MS = 60_000;
const pick = (value: object, keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** IOS routers and switches keep a startup-config in NVRAM; appliances and radios do not. */
export function startupCapable(d: Device) {
  return ['router', 'switch'].includes(d.type) && !['ap', 'mesh', 'wlc'].includes(d.profile ?? '');
}
function assertStartupCapable(d: Device) {
  if (!startupCapable(d)) throw new Error('This device has no startup-config (NVRAM).');
}
export function runningConfigText(e: SimulationEngine, d: Device, registry: CommandRegistry) {
  return String(registry.execute('show running-config', e, d, { mode: 'privileged' }) ?? '');
}
function emptyPort(input: Device['interfaces'][number], live?: NetworkInterface) {
  return interfaceSchema.parse({
    id: input.id,
    name: input.name,
    mac: input.mac,
    media: input.media,
    transceiver: input.transceiver,
    logical: input.logical,
    loopback: input.loopback,
    installedNic: input.installedNic,
    serial: input.serial,
    console: input.console,
    adminUp: true,
    // Hardware keeps its native speed; copper renegotiates once the replay finishes.
    speed: live ? hardwareSpeed(live) : 1000,
    duplex: 'full',
    mtu: input.loopback ? 9216 : 1500,
    mode: input.logical || input.loopback ? 'routed' : 'access',
    accessVlan: 1,
    nativeVlan: 1,
    allowedVlans: [],
    allVlansAllowed: true,
    description: '',
    rx: 0,
    tx: 0,
    errors: 0,
  });
}
/**
 * Boots a device from NVRAM in place, as IOS does: hardware, identity and resource counters
 * survive; the configuration is rebuilt only from startup-config and every runtime table,
 * session and timer starts empty. Lines the parser rejects are reported like boot console
 * errors instead of aborting the boot.
 */
function rebuild(e: SimulationEngine, id: string, registry: CommandRegistry): string[] {
  const old = e.device(id),
    saved = old.startupConfig;
  // Port-channels come back with their members' channel-group commands, tunnels and VXLAN
  // interfaces with the global commands that define them.
  const recreated = (p: { id: string; name: string }) => {
    const live = old.interfaces.find((port) => port.id === p.id);
    return (
      /^Port-channel\d+$/.test(p.name) ||
      (/^tun\d+$/.test(p.id) && /^Tunnel\d+$/.test(p.name)) ||
      // IOS "interface TunnelN" is re-created by its own interface command.
      /^tunnel-if-\d+$/.test(p.id) ||
      (/^vx\d+$/.test(p.id) && /^Vxlan\d+$/.test(p.name)) ||
      !!(live?.aggregate || live?.tunnel || live?.iosTunnel || live?.vxlan)
    );
  };
  const hardware = (saved?.interfaces ?? old.interfaces.filter((p) => !p.logical && !p.loopback)).filter(
    (p) => !recreated(p)
  );
  const physical = old.interfaces.filter(
    (p) => !p.logical && !p.loopback && !recreated(p) && !hardware.some((port) => port.id === p.id)
  );
  const interfaces = [...hardware, ...physical].map((p) =>
    emptyPort(
      p as NetworkInterface,
      old.interfaces.find((port) => port.id === p.id)
    )
  );
  for (const p of interfaces) if (old.type === 'router' && !p.logical) p.mode = 'routed';
  const blank: Device = {
    id: old.id,
    type: old.type,
    profile: old.profile,
    hostname: old.type === 'router' ? 'Router' : 'Switch',
    bootManaged: true,
    booted: true,
    bootStartedAt: e.state.clock,
    operatingSystem: old.operatingSystem,
    position: old.position,
    physicalPosition: old.physicalPosition,
    power: old.power,
    interfaces,
    vlans: [{ id: 1, name: 'default' }],
    routes: [],
    macTable: [],
    arpTable: [],
    pending: [],
    logs: [],
    dropped: 0,
    ...(saved ? { startupConfig: structuredClone(saved) } : {}),
    // Physical installation (rack, power source, PoE hardware) is not configuration.
    ...(old.infrastructure ? { infrastructure: structuredClone(old.infrastructure) } : {}),
    ...(old.poeSupply ? { poeSupply: structuredClone(old.poeSupply) } : {}),
    ...(old.poeDevice ? { poeDevice: structuredClone(old.poeDevice) } : {}),
    ...(old.system
      ? {
          system: {
            ...old.system,
            work: 0,
            processed: 0,
            cpuPercent: 0,
            nextReadyAt: e.state.clock,
            windowAt: e.state.clock,
            lastAt: e.state.clock,
          },
        }
      : {}),
  };
  const queueBefore = new Set(e.state.queue);
  e.state.devices = e.state.devices.map((d) => (d.id === id ? blank : d));
  e.state.queue = e.state.queue.filter((q) => !('device' in q.action && q.action.device === id));
  e.invalidateIndexes();
  if (old.operatingSystem) configureDiscovery(e, e.device(id), {});
  applyDefaultSpanningTree(e, e.device(id));
  const initial = { device: structuredClone(e.device(id)), queue: [...e.state.queue] };
  const touched = new Set([id]);
  for (const link of e.state.links)
    if (link.a.device === id || link.b.device === id) {
      touched.add(link.a.device);
      touched.add(link.b.device);
    }
  const reset = () => {
    e.state.devices = e.state.devices.map((d) => (d.id === id ? structuredClone(initial.device) : d));
    e.state.queue = [...initial.queue];
    e.invalidateIndexes();
  };
  const finish = () => {
    // Interfaces created during replay (e.g. Port-channels) return to their saved position.
    const order = new Map((saved?.interfaces ?? old.interfaces).map((p, index) => [p.id, index]));
    e.device(id).interfaces.sort((a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size));
    for (const link of e.state.links)
      if (link.a.device === id || link.b.device === id) negotiateLink(e.state, link);
    e.invalidateIndexes();
    e.refreshSpanningTree();
    e.refreshBgp();
    validateSnapshot(e.state, {
      changed: { devices: touched, queue: e.state.queue.filter((q) => !queueBefore.has(q)) },
    });
  };
  // Lines are normally only rolled back when the parser rejects them. If the result is still
  // inconsistent, the boot is replayed checking every line, so only the offending ones are lost.
  let rejected = e.deferRefresh(() => replay(e, id, registry, saved, false));
  try {
    finish();
    return rejected;
  } catch {
    reset();
  }
  rejected = replay(e, id, registry, saved, true);
  try {
    finish();
    return rejected;
  } catch (error) {
    reset();
    finish();
    return [
      ...rejected,
      `% startup-config could not be applied (${errorText(error)}); booted with defaults.`,
    ];
  }
}
function replay(
  e: SimulationEngine,
  id: string,
  registry: CommandRegistry,
  saved: Device['startupConfig'],
  strict: boolean
) {
  const context: Context = { mode: 'config' };
  const rejected: string[] = [];
  // A rejected line must not leave a half-applied change behind.
  const transaction = (label: string, change: () => void) => {
    const device = structuredClone(e.device(id)),
      queue = [...e.state.queue];
    try {
      change();
      if (strict) {
        e.refreshSpanningTree();
        e.refreshBgp();
        const before = new Set(queue);
        validateSnapshot(e.state, {
          changed: { devices: new Set([id]), queue: e.state.queue.filter((q) => !before.has(q)) },
        });
      }
    } catch (error) {
      e.state.devices = e.state.devices.map((d) => (d.id === id ? device : d));
      e.state.queue = queue;
      e.invalidateIndexes();
      rejected.push(`${label}\n% ${errorText(error)}`);
    }
  };
  (saved?.commands ?? []).forEach((raw, index) => {
    const command = raw.trim(),
      label = `line ${index + 1}: ${command.slice(0, 120)}`;
    // An open multi-line banner takes its text verbatim, blank and "!" lines included.
    if (context.banner) {
      transaction(label, () => registry.execute(raw, e, e.device(id), context));
      return;
    }
    if (!command || command.startsWith('!')) return;
    if (/^(?:(?:do\s+)*(?:copy|write|reload|erase|startup))(?:\s|$)/i.test(command)) {
      rejected.push(`${label}\n% Exec command ignored in startup-config.`);
      return;
    }
    transaction(label, () => registry.execute(command, e, e.device(id), context));
  });
  const protocols = saved?.protocols;
  for (const acl of protocols?.accessLists ?? [])
    transaction('ip access-list ' + acl.name, () => e.configureAcl(id, acl));
  if (protocols?.nat) transaction('ip nat', () => e.configureNat(id, protocols.nat));
  if (protocols?.ospf) transaction('router ospf', () => e.configureOspf(id, protocols.ospf));
  if (protocols?.rip) transaction('router rip', () => e.configureRip(id, protocols.rip));
  if (protocols?.bgp) transaction('router bgp', () => e.configureBgp(id, protocols.bgp));
  // Private configuration (RSA keys, SNMPv3 users) and vlan.dat (VTP) are not in the text.
  const hidden = protocols?.privateConfig;
  if (hidden) {
    const s = (e.device(id).iosSystem ??= {});
    if (hidden.rsaModulus) s.rsaModulus = hidden.rsaModulus;
    if (hidden.snmpUsers?.length) (s.snmp ??= {}).users = structuredClone(hidden.snmpUsers);
    if (hidden.vtp && !s.vtp) s.vtp = structuredClone(hidden.vtp);
  }
  return rejected;
}
/** The OSPF process as it starts after a reload: a configured router ID is in effect. */
function savedOspf(state: NonNullable<Device['ospf']>) {
  const config = ospfConfigSchema.parse(pick(state, Object.keys(ospfConfigSchema.shape)));
  if (config.pendingRouterId) config.routerId = config.pendingRouterId;
  delete config.pendingRouterId;
  return config;
}
/** NVRAM data IOS keeps outside the config text: RSA keys, SNMPv3 users and vlan.dat (VTP). */
function privateConfig(d: Device) {
  const s = d.iosSystem,
    hidden = {
      ...(s?.rsaModulus ? { rsaModulus: s.rsaModulus } : {}),
      ...(s?.snmp?.users?.length ? { snmpUsers: structuredClone(s.snmp.users) } : {}),
      ...(s?.vtp ? { vtp: structuredClone(s.vtp) } : {}),
    };
  return Object.keys(hidden).length ? hidden : undefined;
}
/** "write memory": NVRAM receives the running-config text, exactly what show running-config prints. */
export function saveStartup(e: SimulationEngine, d: Device, registry: CommandRegistry) {
  assertStartupCapable(d);
  const commands = runningConfigText(e, d, registry).split('\n');
  const interfaces = d.interfaces.map((p) => ({
    id: p.id,
    name: p.name,
    mac: p.mac,
    media: p.media,
    transceiver: p.transceiver,
    logical: p.logical,
    loopback: p.loopback,
    installedNic: p.installedNic,
    serial: p.serial,
    console: p.console,
  }));
  const protocols = {
    ospf: d.ospf ? savedOspf(d.ospf) : undefined,
    rip: d.rip ? ripConfigSchema.parse(pick(d.rip, Object.keys(ripConfigSchema.shape))) : undefined,
    bgp: bgpConfig(d),
    nat: d.nat
      ? pick(d.nat, [
          'enabled',
          'hairpin',
          'algSip',
          'statics',
          'portStatics',
          'pools',
          'iosPools',
          'poolRules',
          'interfaceRules',
        ])
      : undefined,
    accessLists: d.accessLists?.map((acl) => ({
      ...acl,
      implicitDrops: 0,
      // Counters and the ACL log rate-limit state are runtime data, not configuration.
      rules: acl.rules.map((rule) => {
        const saved = { ...rule, hits: 0 };
        delete saved.loggedAt;
        delete saved.logPending;
        return saved;
      }),
    })),
    privateConfig: privateConfig(d),
  };
  d.startupConfig = startupConfigurationSchema.parse({ version: 1, interfaces, commands, protocols });
  d.bootManaged = true;
  if (d.iosSystem?.archive?.writeMemory) archiveRunning(e, d, registry);
  return 'Building configuration...\n[OK]';
}
/**
 * Boot from NVRAM (power-on or the end of a reload). Returns the startup-config lines the
 * parser rejected, which IOS prints on the console while booting.
 */
export function reloadStartup(e: SimulationEngine, d: Device, registry: CommandRegistry) {
  assertStartupCapable(d);
  const rejected = rebuild(e, d.id, registry);
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    rejected.length
      ? 'Inicializado a partir da startup-config; ' + rejected.length + ' linha(s) rejeitada(s).'
      : 'Inicializado a partir da startup-config; sessões e contadores reiniciados.'
  );
  e.device(d.id).bootLog = rejected.slice(0, 64);
  return rejected;
}
/**
 * "reload": the device goes down immediately (its links drop and neighbors react), boots for
 * RELOAD_BOOT_MS of simulated time and comes back with its startup-config.
 */
export function beginReload(e: SimulationEngine, d: Device) {
  assertStartupCapable(d);
  e.setDevicePower(d.id, false);
  const token = e.id('reload'),
    at = e.state.clock + RELOAD_BOOT_MS;
  e.device(d.id).reloading = { token, at };
  e.scheduleAt(at, { kind: 'device-boot', device: d.id, token });
  e.emit(
    'LINK_DOWN',
    d.id,
    'Recarga solicitada pelo console; o equipamento reinicia em ' + RELOAD_BOOT_MS / 1000 + ' s.'
  );
  return (
    iosLogLine(e.state.clock, 'SYS-5-RELOAD', 'Reload requested by console. Reload Reason: Reload Command.') +
    '\nBooting from startup-config: the device returns in ' +
    RELOAD_BOOT_MS / 1000 +
    ' s of simulated time.'
  );
}
export function completeReload(e: SimulationEngine, device: string, token: string) {
  const d = e.state.devices.find((entry) => entry.id === device);
  if (!d || d.reloading?.token !== token) return;
  delete d.reloading;
  e.setDevicePower(device, true);
}
/** True when booting from startup-config would lose part of the current running-config. */
export function reloadLosesChanges(e: SimulationEngine, d: Device, registry: CommandRegistry) {
  assertStartupCapable(d);
  const running = runningConfigText(e, d, registry);
  if (d.startupConfig) return running !== d.startupConfig.commands.join('\n');
  // Without NVRAM contents the device would boot blank: compare with a blank boot of a copy.
  const scratch = new SimulationEngine();
  scratch.state.clock = e.state.clock;
  scratch.state.sequence = e.state.sequence;
  scratch.state.devices = [structuredClone(d)];
  rebuild(scratch, d.id, registry);
  return running !== runningConfigText(scratch, scratch.device(d.id), registry);
}
