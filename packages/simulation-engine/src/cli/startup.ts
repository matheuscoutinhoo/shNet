import { SimulationEngine } from '../core/engine';
import { interfaceSchema, startupConfigurationSchema, type Device, type NetworkInterface } from '../model';
import type { CommandRegistry } from './registry';
import { validateSnapshot } from '../core/validation';
import { ospfConfigSchema } from '../protocols/ospf-model';
import { ripConfigSchema } from '../protocols/rip-model';
import { bgpConfig } from '../protocols/bgp';
import { configureDiscovery } from '../protocols/discovery';
import { archiveRunning } from './ios-operations';
import { applyDefaultSpanningTree } from '../protocols/stp';
import { hardwareSpeed, negotiateLink } from '../links/physical';

// Initial boot contract: core IOS switching/routing. Refuse an unrepresentable
// feature before saving/reloading rather than silently losing its configuration.
const deviceFields = new Set([
  'id',
  'type',
  'profile',
  'hostname',
  'position',
  'physicalPosition',
  'power',
  'interfaces',
  'vlans',
  'routes',
  'routes6',
  'vrfs',
  'ipRouting',
  'ipv6Routing',
  'macTable',
  'arpTable',
  'pending',
  'arpResolutions',
  'logs',
  'dropped',
  'startupConfig',
  'system',
  'ospf',
  'rip',
  'bgp',
  'accessLists',
  'nat',
  'spanningTree',
  'multiSpanningTree',
  'neighbors6',
  'pending6',
  'resolutions6',
  'gateway',
]);
const portFields = new Set([
  'id',
  'name',
  'mac',
  'media',
  'transceiver',
  'adminUp',
  'speed',
  'duplex',
  'mtu',
  'mode',
  'logical',
  'loopback',
  'installedNic',
  'serial',
  'console',
  'vrf',
  'accessVlan',
  'nativeVlan',
  'allowedVlans',
  'ip',
  'prefix',
  'ipv4Mode',
  'description',
  'aclIn',
  'aclOut',
  'natRole',
  'rx',
  'tx',
  'errors',
  'stpEdge',
  'stpCost',
  'spanningTree',
  'spanningInstances',
  'mstBoundary',
]);
deviceFields.add('bootManaged');
deviceFields.add('booted');
deviceFields.add('bootStartedAt');
deviceFields.add('operatingSystem');
portFields.add('bpduGuard');
portFields.add('errDisabled');
deviceFields.add('discovery');
deviceFields.add('hsrp');
portFields.add('hsrpVersion');
portFields.add('dhcpRelay');
for (const key of ['voiceVlan', 'portSecurity', 'stpGuard', 'ospfAuthentication']) portFields.add(key);
deviceFields.add('dhcpSnooping');
deviceFields.add('loopGuardDefault');
for (const field of ['iosSystem', 'ntp', 'networkClock', 'syslogClient', 'snmpAgent'])
  deviceFields.add(field);
deviceFields.add('monitoring');
deviceFields.add('routingPolicy');
deviceFields.add('mqc');
portFields.add('qos');
deviceFields.add('dot1xSystemAuthControl');
portFields.add('authenticationControl');
portFields.add('udld');
portFields.add('bfd');
deviceFields.add('enableSecret');
for (const key of ['cdpEnabled', 'lldpTransmit', 'lldpReceive']) portFields.add(key);
// EtherChannel and DHCP server configuration replay from running-config lines.
for (const key of ['channel', 'aggregate', 'ospfSettings', 'speedAuto', 'maxSpeed']) portFields.add(key);
deviceFields.add('dhcpServer');
for (const key of [
  'tcpConnections',
  'arpResolutions',
  'reassemblies',
  'fragmentPending',
  'dnsQueries',
  'dnsCache',
  'snmpQueries',
  'remoteQueries',
  'aaaQueries',
  'networkAuth',
  'udp6Records',
  'consoleSessions',
])
  deviceFields.add(key);
const pick = (value: object, keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
function assertBootSupported(d: Device) {
  if (d.routes.some((route) => route.metric !== 1))
    throw new Error('Startup replay does not yet support custom static-route metrics.');
  if (!['router', 'switch'].includes(d.type) || ['ap', 'mesh', 'wlc'].includes(d.profile ?? ''))
    throw new Error('Startup lifecycle currently requires a core IOS routing/switching profile.');
  const unsupported = Object.keys(d).filter(
    (key) => d[key as keyof Device] !== undefined && !deviceFields.has(key)
  );
  for (const p of d.interfaces)
    for (const key of Object.keys(p))
      if (p[key as keyof NetworkInterface] !== undefined && !portFields.has(key))
        unsupported.push(p.name + '.' + key);
  if (unsupported.length)
    throw new Error(
      'Startup lifecycle does not yet support: ' +
        unsupported.join(', ') +
        '. Laboratory save/export still preserves the complete state.'
    );
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
    allowedVlans: [1],
    description: '',
    rx: 0,
    tx: 0,
    errors: 0,
  });
}
function restore(draft: SimulationEngine, id: string, registry: CommandRegistry) {
  const old = draft.device(id),
    saved = old.startupConfig;
  // Port-channels are recreated by their members' channel-group commands.
  const aggregate = (p: { id: string; name: string }) =>
    /^Port-channel\d+$/.test(p.name) || !!old.interfaces.find((port) => port.id === p.id)?.aggregate;
  const hardware = (saved?.interfaces ?? old.interfaces.filter((p) => !p.logical && !p.loopback)).filter(
    (p) => !aggregate(p)
  );
  const physical = old.interfaces.filter(
    (p) => !p.logical && !p.loopback && !aggregate(p) && !hardware.some((port) => port.id === p.id)
  );
  const interfaces = [...hardware, ...physical].map((p) =>
    emptyPort(p as NetworkInterface, old.interfaces.find((port) => port.id === p.id))
  );
  for (const p of interfaces) if (old.type === 'router' && !p.logical) p.mode = 'routed';
  const blank: Device = {
    id: old.id,
    type: old.type,
    profile: old.profile,
    hostname: old.type === 'router' ? 'Router' : 'Switch',
    bootManaged: true,
    booted: true,
    bootStartedAt: draft.state.clock,
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
    ...(old.system
      ? {
          system: {
            ...old.system,
            work: 0,
            processed: 0,
            cpuPercent: 0,
            nextReadyAt: draft.state.clock,
            windowAt: draft.state.clock,
            lastAt: draft.state.clock,
          },
        }
      : {}),
  };
  draft.state.devices = draft.state.devices.map((d) => (d.id === id ? blank : d));
  draft.state.queue = draft.state.queue.filter((q) => !('device' in q.action && q.action.device === id));
  // Rebuild indexes after replacing the device, before commands resolve IDs.
  draft.state = structuredClone(draft.state);
  const d = draft.device(id),
    context = { mode: 'config' as const };
  if (old.operatingSystem) configureDiscovery(draft, d, {});
  applyDefaultSpanningTree(draft, d);
  for (const command of saved?.commands ?? []) {
    if (!command.trim() || command.trim().startsWith('!')) continue;
    if (/^(?:(?:do\s+)*(?:copy|write|reload|erase|startup))(?:\s|$)/i.test(command.trim()))
      throw new Error('Invalid command in startup configuration.');
    try {
      registry.execute(command.trim(), draft, d, context);
    } catch (error) {
      throw new Error(
        'startup-config line "' +
          command.trim().slice(0, 80) +
          '" was rejected: ' +
          (error instanceof Error ? error.message : String(error)),
        { cause: error }
      );
    }
  }
  const protocols = saved?.protocols;
  if (protocols?.accessLists) for (const acl of protocols.accessLists) draft.configureAcl(id, acl);
  if (protocols?.nat) draft.configureNat(id, protocols.nat);
  if (protocols?.ospf) draft.configureOspf(id, protocols.ospf);
  if (protocols?.rip) draft.configureRip(id, protocols.rip);
  if (protocols?.bgp) draft.configureBgp(id, protocols.bgp);
  // Interfaces created during replay (e.g. Port-channels) return to their saved position.
  const order = new Map((saved?.interfaces ?? old.interfaces).map((p, index) => [p.id, index]));
  draft
    .device(id)
    .interfaces.sort((a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size));
  for (const link of draft.state.links)
    if (link.a.device === id || link.b.device === id) negotiateLink(draft.state, link);
  draft.refreshSpanningTree();
  draft.refreshBgp();
  validateSnapshot(draft.state);
}
export function saveStartup(e: SimulationEngine, d: Device, registry: CommandRegistry) {
  assertBootSupported(d);
  const commands = registry.execute('show running-config', e, d, { mode: 'privileged' }).split('\n');
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
    ospf: d.ospf ? ospfConfigSchema.parse(pick(d.ospf, Object.keys(ospfConfigSchema.shape))) : undefined,
    rip: d.rip ? ripConfigSchema.parse(pick(d.rip, Object.keys(ripConfigSchema.shape))) : undefined,
    bgp: bgpConfig(d),
    nat: d.nat
      ? pick(d.nat, ['enabled', 'hairpin', 'algSip', 'statics', 'pools', 'interfaceRules'])
      : undefined,
    accessLists: d.accessLists?.map((acl) => ({
      ...acl,
      implicitDrops: 0,
      rules: acl.rules.map((rule) => ({ ...rule, hits: 0 })),
    })),
  };
  const saved = startupConfigurationSchema.parse({ version: 1, interfaces, commands, protocols });
  const draft = new SimulationEngine(e.snapshot());
  draft.device(d.id).startupConfig = saved;
  restore(draft, d.id, registry);
  const restored = registry.execute('show running-config', draft, draft.device(d.id), { mode: 'privileged' });
  if (restored !== commands.join('\n'))
    throw new Error('Configuration cannot yet be reproduced by startup replay. Save refused.');
  d.startupConfig = saved;
  d.bootManaged = true;
  if (d.iosSystem?.archive?.writeMemory) archiveRunning(e, d, registry);
  return 'Building configuration...\n[OK]';
}
export function reloadStartup(e: SimulationEngine, d: Device, registry: CommandRegistry) {
  if (!['router', 'switch'].includes(d.type) || ['ap', 'mesh', 'wlc'].includes(d.profile ?? ''))
    throw new Error('Reload currently requires a core routing/switching profile.');
  const draft = new SimulationEngine(e.snapshot());
  restore(draft, d.id, registry);
  draft.emit(
    'CONFIG_CHANGED',
    d.id,
    'Device reloaded from startup configuration; runtime sessions and counters reset.'
  );
  e.state = draft.state;
  return 'Reload complete.';
}
/** True when booting from startup-config would lose part of the current running-config. */
export function reloadLosesChanges(e: SimulationEngine, d: Device, registry: CommandRegistry) {
  if (!['router', 'switch'].includes(d.type) || ['ap', 'mesh', 'wlc'].includes(d.profile ?? ''))
    throw new Error('Reload currently requires a core routing/switching profile.');
  const draft = new SimulationEngine(e.snapshot());
  restore(draft, d.id, registry);
  const show = (engine: SimulationEngine) =>
    registry.execute('show running-config', engine, engine.device(d.id), { mode: 'privileged' });
  return show(draft) !== show(e);
}
