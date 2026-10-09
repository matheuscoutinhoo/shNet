import { findDevice, findLink, linksAt } from './topology-index';
import { configureDatabase, queryDatabase } from '../protocols/database';
import {
  configureInfrastructure,
  configureSystem,
  passiveForward,
  processingDelay,
  refreshInfrastructure,
  setDevicePower as setInfrastructurePower,
} from '../devices/infrastructure';
import { clearFragmentWork } from '../protocols/fragment';
import {
  configureEapServer,
  configureEapAuthenticator,
  configureEapSupplicant,
} from '../protocols/enterprise';
import {
  configureWlc,
  configureWtp,
  handleCapwapTick,
  capwapFromRadio,
  sendCapwapFrame,
} from '../protocols/capwap';
import {
  configureMesh,
  refreshMesh,
  handleMeshTick,
  receiveMeshHello,
  protectMesh,
  unprotectMesh,
} from '../protocols/mesh';
import { configureIds } from '../protocols/ids';
import {
  configurePoe,
  setDevicePower,
  addHardwarePort,
  consoleCommand,
  refreshPower,
  serialFrame,
} from '../devices/hardware';
import {
  configureProxy,
  configurePrinter,
  configureBroker,
  connectIot,
  publishIot,
  subscribeIot,
  handleApplicationTick,
} from '../protocols/applications';
import { submitPrint } from '../protocols/applications-http';
import { configurePhone, callPhone, hangupPhone, handleVoiceTick } from '../protocols/voice';
import { expireSipAlg } from '../protocols/nat-sip';
import { handleHairpinExpiry, hairpinError } from '../protocols/nat-hairpin';
import { fragmentFrame, receiveFragment, handleFragmentAction } from '../protocols/fragment';
import { configureDhcpSnooping } from '../protocols/dhcp-snooping';
import { spanningPortState, frameVlan } from '../protocols/stp-scope';
import { addProfile } from '../devices/profiles';
import { configureTelemetry, configureCollector, handleTelemetry } from '../protocols/telemetry';
import { configureClock, configureNtp, handleNtp, stampNtp } from '../protocols/ntp';
import { configureRemote } from '../protocols/remote';
import {
  requestRemote,
  runAutomation,
  handleRemoteTimeout,
  handleAutomation,
} from '../protocols/remote-wire';
import { configureInspection, expireInspection } from '../protocols/inspection';
import { configureAaaServer, configureAaaClient, loginNetwork, handleAaaTimeout } from '../protocols/aaa';
import {
  configureDot1x,
  configureSupplicant,
  refreshDot1x,
  handleDot1xTick,
  receiveEapol,
  permitDot1x,
} from '../protocols/dot1x';
import { configureVxlan, sendVxlanFrame } from '../protocols/vxlan';
import { configureQos, enqueueQos, handleQosTick } from '../protocols/qos';
import { configureMpls, mplsRoute, pushMpls, receiveMpls } from '../protocols/mpls';
import { configureSdwan, configureSdwanController, handleSdwanTick, selectSdwan } from '../protocols/sdwan';
import { configureTunnel, handleTunnelTick, sendTunnelFrame } from '../protocols/tunnel';
import { protectWireless, unprotectWireless } from '../protocols/wireless-cipher';
import {
  configureWireless,
  refreshWireless,
  handleWirelessTick,
  receiveWireless,
} from '../protocols/wireless';
import { wirelessTargets, wirelessMetrics } from '../protocols/wireless-radio';
import { configureIpv6, handleIpv6Tick, ipv6Config } from '../protocols/ipv6-control';
import { configureRoute6, ping6, receiveIp6, sendIp6 } from '../protocols/ipv6';
import { handleNdpTimer, permit6, clearIpv6Port } from '../protocols/ipv6-wire';
import type { Packet6 } from '../model';
import { configureUdp6Service, sendUdp6 } from '../protocols/udp6';
import {
  configureDhcp6Server,
  configureDhcp6Client,
  handleDhcp6Tick,
  releaseDhcp6,
} from '../protocols/dhcp6';
import { bgpConfig, configureBgp, handleBgpTick, refreshBgp } from '../protocols/bgp';
import {
  configureLacp,
  removeLacp,
  handleLacpTick,
  lacpOutput,
  receiveLacp,
  refreshLacp,
} from '../protocols/lacp';
import { lacpMembers } from '../protocols/lacp-members';
import {
  BROADCAST,
  LIMITS,
  linkSchema,
  ipv4Schema,
  dnsRecordSchema,
  type DnsQuestion,
  type DnsRecord,
  type Action,
  type Device,
  type Frame,
  type Link,
  type NetworkEvent,
  type Packet,
  type Snapshot,
} from '../model';
import { createDevice } from '../devices/catalog';
import { endpoint, linkOperational, validateConnection } from '../links/physical';
import { enqueue, random } from './queue';
import { validateSnapshot } from './validation';
import { receiveArp, sendWithArp, handleArpTimer } from '../protocols/arp';
import { switchFrame, switchTransmit } from '../protocols/ethernet';
import {
  createLogicalInterface,
  interfaceUp,
  requireVrf,
  routingEnabled,
  sviOperational,
} from '../protocols/layer3';
import { ipNumber, receiveIp, resolveRoute } from '../protocols/ipv4';
import { configureDhcpPool, configureDhcpRelay } from '../protocols/dhcp-config';
import {
  disableDhcp,
  handleDhcpClientTimer,
  releaseDhcp,
  renewDhcp,
  startDhcp,
} from '../protocols/dhcp-client';
import { expireDhcpBinding } from '../protocols/dhcp-server';
import { configureDnsSecurity } from '../protocols/dnssec';
import { configureDnsRecord, configureDnsServers } from '../protocols/dns-records';
import { handleDnsTimeout, lookupDns } from '../protocols/dns-client';
import {
  configureSpanningTree,
  configureMultiSpanningTree,
  rebuildSpanningTree,
  handleSpanningTreeAction,
  receiveBpdu,
  refreshSpanningTree,
} from '../protocols/stp';

import { configureAcl, permitPacket } from '../protocols/acl';
import type { NetworkInterface } from '../model';
import { configureNat, expireNat, natOutbound } from '../protocols/nat';
import { closeTcp, handleTcpTimer, openTcp, writeTcp } from '../protocols/tcp';
import { configureTcpService } from '../protocols/tcp-services';
import { configureTcpSettings } from '../protocols/tcp-extensions';
import { configureDhcp6Relay } from '../protocols/dhcp6-relay';
import { configureFirewall, expireFirewall, permitFirewall } from '../protocols/firewall';
import { sendIcmpError } from '../protocols/icmp';
import { configureOspf, handleOspfTick } from '../protocols/ospf';
import { OSPF } from '../protocols/ospf-model';
import { configureRip, handleRipTick } from '../protocols/rip';
import { RIP } from '../protocols/rip-model';
import { VRRP } from '../protocols/vrrp-model';
import { configureVrrp, refreshVrrp, handleVrrpTimer, acceptsVrrpMac } from '../protocols/vrrp';
import { configureSnmpAgent, querySnmp, handleSnmpTimeout } from '../protocols/snmp';
import {
  configureSyslog,
  setSyslogEnabled,
  sendSyslog,
  forwardSyslogEvent,
  handleSyslogSend,
} from '../protocols/syslog';

export class SimulationEngine {
  configureTcpSettings(deviceId: string, input: unknown) {
    configureTcpSettings(this, this.device(deviceId), input);
  }
  configureDhcp6Relay(deviceId: string, portId: string, input: unknown) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    configureDhcp6Relay(this, device, port, input);
  }
  state: Snapshot;
  constructor(snapshot?: unknown) {
    this.state = snapshot
      ? validateSnapshot(snapshot)
      : {
          schemaVersion: 1,
          clock: 0,
          seed: 42,
          sequence: 0,
          devices: [],
          links: [],
          queue: [],
          events: [],
          probes: [],
          notes: '',
          background: 'light',
          pattern: 'dots',
        };
  }
  snapshot(): Snapshot {
    return structuredClone(this.state);
  }
  id(prefix: string) {
    return prefix + '-' + ++this.state.sequence;
  }
  device(id: string) {
    const d = findDevice(this.state, id);
    if (!d) throw new Error('Equipamento não encontrado');
    return d;
  }
  addProfile(id: string, position = { x: 100, y: 100 }) {
    return addProfile(this, id, position);
  }
  addDevice(type: Device['type'], position = { x: 100, y: 100 }) {
    if (this.state.devices.length >= LIMITS.devices)
      throw new Error('Limite de ' + LIMITS.devices + ' equipamentos');
    const id = this.id('device');
    const d = createDevice(type, id, this.state.sequence, position);
    this.state.devices.push(d);
    return d;
  }
  addSubinterface(deviceId: string, parent: string, vlan: number) {
    return createLogicalInterface(this, this.device(deviceId), 'subinterface', vlan, parent);
  }
  configureLacp(
    deviceId: string,
    number: number,
    mode: 'active' | 'passive',
    members: string[],
    minLinks = 1
  ) {
    return configureLacp(this, this.device(deviceId), number, mode, members, minLinks);
  }
  removeLacp(deviceId: string, portId: string) {
    removeLacp(this, this.device(deviceId), endpoint(this.state, { device: deviceId, port: portId }).port);
  }
  configureTelemetry(deviceId: string, input: unknown) {
    configureTelemetry(this, this.device(deviceId), input);
  }
  configureCollector(deviceId: string, input: unknown) {
    configureCollector(this, this.device(deviceId), input);
  }
  configureClock(deviceId: string, input: unknown) {
    configureClock(this, this.device(deviceId), input);
  }
  configureNtp(deviceId: string, input: unknown) {
    configureNtp(this, this.device(deviceId), input);
  }
  configureRemote(deviceId: string, input: unknown) {
    configureRemote(this, this.device(deviceId), input);
  }
  requestRemote(deviceId: string, input: unknown) {
    return requestRemote(this, this.device(deviceId), input);
  }
  runAutomation(deviceId: string, input: unknown) {
    return runAutomation(this, this.device(deviceId), input);
  }
  configureAaaServer(deviceId: string, input: unknown) {
    configureAaaServer(this, this.device(deviceId), input);
  }
  configureAaaClient(deviceId: string, input: unknown) {
    configureAaaClient(this, this.device(deviceId), input);
  }
  loginNetwork(deviceId: string, username: string, password: string) {
    return loginNetwork(this, this.device(deviceId), username, password);
  }
  configureDot1x(deviceId: string, portId: string, input: unknown) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    configureDot1x(this, device, port, input);
  }
  configureSupplicant(deviceId: string, portId: string, input: unknown) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    configureSupplicant(this, device, port, input);
  }
  configureVxlan(deviceId: string, input: unknown) {
    return configureVxlan(this, this.device(deviceId), input);
  }
  configureQos(deviceId: string, portId: string, input: unknown) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    configureQos(this, device, port, input);
  }
  configureMpls(deviceId: string, input: unknown) {
    configureMpls(this, this.device(deviceId), input);
  }
  transmitQueued(deviceId: string, portId: string, frame: Frame, linkId: string) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    this.transmit(
      device,
      port,
      frame,
      this.state.links.find((l) => l.id === linkId),
      true
    );
  }
  configureSdwan(deviceId: string, input: unknown) {
    configureSdwan(this, this.device(deviceId), input);
  }
  configureSdwanController(deviceId: string, input: unknown) {
    configureSdwanController(this, this.device(deviceId), input);
  }
  configureTunnel(deviceId: string, input: unknown) {
    return configureTunnel(this, this.device(deviceId), input);
  }
  configureWireless(deviceId: string, input: unknown) {
    configureWireless(this, this.device(deviceId), input);
  }
  configureIpv6(deviceId: string, portId: string, input?: unknown) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    configureIpv6(this, device, port, input);
  }
  configureRoute6(deviceId: string, input: unknown, remove = false) {
    configureRoute6(this, this.device(deviceId), input, remove);
  }
  configureUdp6Service(deviceId: string, input: unknown) {
    configureUdp6Service(this, this.device(deviceId), input);
  }
  sendUdp6(deviceId: string, target: string, port: number, data: string, vrf?: string, scope?: string) {
    return sendUdp6(this, this.device(deviceId), target, port, data, vrf, scope);
  }
  configureDhcp6Server(deviceId: string, input: unknown) {
    configureDhcp6Server(this, this.device(deviceId), input);
  }
  configureDhcp6Client(deviceId: string, portId: string, input: unknown) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    configureDhcp6Client(this, device, port, input);
  }
  releaseDhcp6(deviceId: string, portId: string) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    releaseDhcp6(this, device, port);
  }
  ping6(deviceId: string, target: string, hopLimit = 64, vrf?: string, scope?: string, bytes = 104) {
    return ping6(this, this.device(deviceId), target, hopLimit, vrf, scope, bytes);
  }
  sendIp6(deviceId: string, packet: Packet6, ingress?: NetworkInterface, vrf = ingress?.vrf, scope?: string) {
    sendIp6(this, this.device(deviceId), packet, ingress, vrf, scope);
  }
  addSvi(deviceId: string, vlan: number) {
    return createLogicalInterface(this, this.device(deviceId), 'svi', vlan);
  }
  removeLogicalInterface(deviceId: string, portId: string) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    if (!port.logical && !port.tunnel && !port.vxlan)
      throw new Error('Somente interfaces lógicas/túneis podem ser removidos.');
    if (
      device.interfaces.some(
        (p) => p.tunnel?.underlay === portId || p.vxlan?.underlay === portId || p.dot1x?.underlay === portId
      ) ||
      device.mpls?.ingress.some((f) => f.port === portId) ||
      device.mpls?.lfib.some((f) => f.port === portId) ||
      device.sdwan?.underlay === portId ||
      device.wlc?.underlay === portId ||
      device.wtp?.underlay === portId ||
      device.eapAuthenticator?.underlay === portId ||
      device.routes6?.some((r) => r.port === portId) ||
      device.dhcpServer?.pools.some((p) => p.port === portId) ||
      device.dhcp6Server?.pools.some((p) => p.port === portId) ||
      device.interfaces.some((p) => p.dhcp6?.delegatePort === portId) ||
      device.ospf?.interfaces.some((p) => p.port === portId) ||
      device.rip?.interfaces.some((p) => p.port === portId) ||
      device.vrrp?.groups.some((g) => g.port === portId) ||
      device.vrrp?.groups.some((g) => g.track?.some((t) => t.port === portId)) ||
      device.firewall?.trustedPorts.includes(portId) ||
      device.firewall?.zonePolicy?.zones.some((z) => z.ports.includes(portId)) ||
      device.nat?.pools.some((p) => p.outside === portId) ||
      device.nat?.statics.some((p) => p.outside === portId)
    )
      throw new Error('Remova as referências de protocolos/políticas antes de excluir a interface.');
    for (const c of device.tcpConnections ?? [])
      if (c.localIp === port.ip && c.vrf === port.vrf) closeTcp(this, device, c.id, true);
    clearFragmentWork(this, device);
    clearIpv6Port(this, device, port);
    if (port.dhcp6) configureDhcp6Client(this, device, port, undefined);
    const removed6 = new Set(
      this.state.probes6?.filter((q) => q.device === deviceId && q.port === portId).map((q) => q.id)
    );
    this.state.probes6 = this.state.probes6?.filter((q) => !removed6.has(q.id));
    this.state.queue = this.state.queue.filter(
      ({ action: a }) => a.kind !== 'probe6-timeout' || !removed6.has(a.probeId)
    );
    device.interfaces = device.interfaces.filter((p) => p.id !== portId);
    device.arpTable = device.arpTable.filter((a) => a.port !== portId);
    device.pending = device.pending.filter((p) => p.port !== portId);
    device.arpResolutions = device.arpResolutions?.filter((a) => a.port !== portId);
    this.state.queue = this.state.queue.filter(
      ({ action }) => action.kind !== 'arp-timeout' || action.device !== deviceId || action.port !== portId
    );
    this.state.queue = this.state.queue.filter(
      ({ action: a }) => a.kind !== 'tunnel-tick' || a.device !== deviceId || a.port !== portId
    );
    if (device.sdwan) device.sdwan.selected = device.sdwan.selected.filter((p) => p.port !== portId);
    if (port.vxlan && device.bgp) this.configureBgp(deviceId, bgpConfig(device));
    this.emit('CONFIG_CHANGED', device.id, 'Interface ' + port.name + ' removida.');
  }
  configureVrf(deviceId: string, name: string, remove = false) {
    const device = this.device(deviceId);
    if (!['router', 'switch'].includes(device.type) || !/^[a-zA-Z0-9_-]{1,32}$/.test(name))
      throw new Error('Nome de VRF ou equipamento inválido.');
    if (
      remove &&
      (device.interfaces.some((p) => p.vrf === name) ||
        device.routes.some((r) => r.vrf === name) ||
        device.routes6?.some((r) => r.vrf === name) ||
        this.state.probes6?.some((q) => q.device === deviceId && q.vrf === name) ||
        device.tcpConnections?.some((c) => c.vrf === name) ||
        this.state.probes.some((p) => p.device === deviceId && p.vrf === name))
    )
      throw new Error('VRF ainda referenciada por interfaces, rotas ou tráfego.');
    const others = device.vrfs?.filter((v) => v !== name) ?? [];
    if (!remove && others.length >= 32) throw new Error('Limite de 32 VRFs.');
    device.vrfs = remove ? others : [...others, name];
    this.emit('CONFIG_CHANGED', device.id, 'VRF ' + name + (remove ? ' removida.' : ' configurada.'));
  }
  setInterfaceVrf(deviceId: string, portId: string, vrf?: string) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    requireVrf(device, vrf);
    if (port.mode !== 'routed') throw new Error('VRF exige interface routed.');
    if (device.routes6?.some((r) => r.port === portId && r.vrf !== vrf))
      throw new Error('Remova as rotas IPv6 antes de mudar a VRF.');
    if (
      vrf &&
      (port.dhcp ||
        port.dhcpRelay?.length ||
        device.nat?.enabled ||
        device.ospf?.interfaces.some((p) => p.port === portId) ||
        device.rip?.interfaces.some((p) => p.port === portId) ||
        device.vrrp?.groups.some((g) => g.port === portId))
    )
      throw new Error('Remova protocolos incompatíveis antes de associar a VRF.');
    for (const c of device.tcpConnections ?? [])
      if (c.vrf === port.vrf && c.localIp === port.ip) closeTcp(this, device, c.id, true);
    clearFragmentWork(this, device);
    port.vrf = vrf;
    if (port.ipv6) configureIpv6(this, device, port, ipv6Config(port));
    device.arpTable = device.arpTable.filter((a) => a.port !== portId);
    device.pending = device.pending.filter((p) => p.port !== portId);
    device.arpResolutions = device.arpResolutions?.filter((a) => a.port !== portId);
    this.state.queue = this.state.queue.filter(
      ({ action }) => action.kind !== 'arp-timeout' || action.device !== deviceId || action.port !== portId
    );
    this.emit('CONFIG_CHANGED', device.id, port.name + ' na tabela ' + (vrf ?? 'padrão') + '.', {
      port: portId,
    });
  }
  removeDevice(id: string) {
    for (const link of this.state.links.filter((l) => l.a.device === id || l.b.device === id))
      this.removeLink(link.id);
    for (const d of this.state.devices)
      if (
        d.wireless &&
        d.wireless.association &&
        d.wireless.association.bssid ===
          this.state.devices.find((v) => v.id === id)?.interfaces.find((p) => p.id === 'wlan0')?.mac
      ) {
        delete d.wireless.association;
        d.wireless.phase = 'scanning';
      }
    this.state.devices = this.state.devices.filter((d) => d.id !== id);
    for (const d of this.state.devices) {
      if (d.infrastructure?.kind === 'rack')
        d.infrastructure.slots = d.infrastructure.slots.filter((s) => s.device !== id);
      if (d.infrastructure?.kind === 'ups')
        d.infrastructure.loads = d.infrastructure.loads.filter((s) => s.device !== id);
    }
    this.state.canvasItems = this.state.canvasItems
      ?.map((item) => ({
        ...item,
        ...(item.members ? { members: item.members.filter((member) => member !== id) } : {}),
      }))
      .filter(
        (item) =>
          (item.kind !== 'group' || !!item.members?.length) &&
          !(item.anchor?.kind === 'device' && item.anchor.target === id)
      );
    const removed = new Set(this.state.probes.filter((p) => p.device === id).map((p) => p.id));
    this.state.probes = this.state.probes.filter((p) => p.device !== id);
    this.state.probes6 = this.state.probes6?.filter((p) => p.device !== id);
    this.state.queue = this.state.queue.filter((q) =>
      q.action.kind === 'probe-timeout' ? !removed.has(q.action.probeId) : q.action.device !== id
    );
  }
  connect(
    a: Link['a'],
    b: Link['b'],
    cable: Link['cable'] = 'copper',
    options: Partial<Pick<Link, 'latency' | 'jitter' | 'loss' | 'distance'>> = {}
  ) {
    const link = linkSchema.parse({
      id: this.id('link'),
      a,
      b,
      cable,
      up: true,
      latency: 2,
      jitter: 0,
      loss: 0,
      distance: 10,
      ...options,
    });
    if (this.state.links.length >= 8000) throw new Error('Limite de cabos atingido');
    validateConnection(this.state, link);
    this.state.links.push(link);
    refreshPower(this);
    this.emit('LINK_UP', a.device, 'Cabo conectado: ' + cable, {
      port: a.port,
      peer: b.device,
      link: link.id,
    });
    return link;
  }
  removeLink(id: string) {
    for (const d of this.state.devices) d.consoleSessions = d.consoleSessions?.filter((c) => c.link !== id);
    this.state.links = this.state.links.filter((l) => l.id !== id);
    this.state.canvasItems = this.state.canvasItems?.filter(
      (item) => !(item.anchor?.kind === 'link' && item.anchor.target === id)
    );
    refreshPower(this);
    this.state.queue = this.state.queue.filter((q) => q.action.kind !== 'deliver' || q.action.link !== id);
    for (const d of this.state.devices) {
      d.macTable = [];
      d.arpTable = [];
      for (const p of d.interfaces)
        if (p.qos) {
          for (const f of p.qos.queues.filter((f) => f.link === id)) {
            p.qos.stats.find((s) => s.name === f.class)!.dropped++;
            this.drop(d, 'QoS: enlace removido.', p.id);
          }
          p.qos.queues = p.qos.queues.filter((f) => f.link !== id);
        }
    }
  }
  setPort(deviceId: string, portId: string, up: boolean) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    port.adminUp = up;
    device.arpTable = device.arpTable.filter((a) => a.port !== portId);
    device.macTable = device.macTable.filter((m) => m.port !== portId);
    this.emit(
      up ? 'LINK_UP' : 'LINK_DOWN',
      deviceId,
      port.name + ' administrativamente ' + (up ? 'ativa' : 'desligada'),
      { port: portId }
    );
  }
  configureDhcpPool(deviceId: string, input: unknown) {
    const device = this.device(deviceId);
    const pool = configureDhcpPool(device, input);
    const remaining = new Set(device.dhcpServer!.bindings.map((binding) => binding.id));
    this.state.queue = this.state.queue.filter(
      ({ action }) =>
        action.kind !== 'dhcp-binding-expire' || action.device !== deviceId || remaining.has(action.binding)
    );
    this.emit('CONFIG_CHANGED', deviceId, 'Pool DHCP ' + pool.name + ' configurado.', { port: pool.port });
    return pool;
  }
  configureDhcpRelay(deviceId: string, portId: string, input: unknown) {
    configureDhcpRelay(this.device(deviceId), portId, input);
    this.emit('CONFIG_CHANGED', deviceId, 'Destinos DHCP relay atualizados.', { port: portId });
  }
  configureSpanningTree(deviceId: string, mode: 'off' | 'stp' | 'rstp', priority?: number) {
    configureSpanningTree(this, this.device(deviceId), mode, priority);
  }
  configureDhcpSnooping(deviceId: string, input: unknown) {
    configureDhcpSnooping(this, this.device(deviceId), input);
  }
  setDhcpConflictDetection(deviceId: string, portId: string, enabled: boolean) {
    const { port } = endpoint(this.state, { device: deviceId, port: portId });
    if (port.dhcp?.status === 'probing') throw new Error('Aguarde a verificação ARP em curso.');
    port.dhcpConflictDetection = enabled;
  }
  configureMultiSpanningTree(deviceId: string, input: unknown) {
    configureMultiSpanningTree(this, this.device(deviceId), input);
  }
  rebuildSpanningTree(deviceId: string) {
    rebuildSpanningTree(this, this.device(deviceId));
  }
  setSpanningTreePort(deviceId: string, portId: string, options: { edge?: boolean; cost?: number }) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    if (device.type !== 'switch') throw new Error('STP exige switch.');
    if (
      options.cost !== undefined &&
      (!Number.isInteger(options.cost) || options.cost < 1 || options.cost > 200000000)
    )
      throw new Error('Custo STP inválido.');
    if (options.edge !== undefined) port.stpEdge = options.edge;
    if (Object.hasOwn(options, 'cost')) {
      if (options.cost === undefined) delete port.stpCost;
      else port.stpCost = options.cost;
    }
    if (device.spanningTree?.enabled) rebuildSpanningTree(this, device);
  }
  refreshSpanningTree() {
    refreshPower(this);
    refreshMesh(this);
    refreshDot1x(this);
    refreshWireless(this);
    refreshLacp(this);
    refreshSpanningTree(this);
    refreshVrrp(this);
    refreshBgp(this);
  }
  configureWlc(device: string, input: unknown) {
    configureWlc(this, this.device(device), input);
  }
  configureEapServer(device: string, input: unknown) {
    configureEapServer(this, this.device(device), input);
  }
  configureEapAuthenticator(device: string, input: unknown) {
    configureEapAuthenticator(this, this.device(device), input);
  }
  configureEapSupplicant(device: string, input: unknown) {
    configureEapSupplicant(this, this.device(device), input);
  }
  configureWtp(device: string, input: unknown) {
    configureWtp(this, this.device(device), input);
  }
  configureMesh(device: string, input: unknown) {
    configureMesh(this, this.device(device), input);
  }
  configureIds(device: string, input: unknown) {
    configureIds(this, this.device(device), input);
  }
  configurePoe(device: string, supply: unknown, load?: unknown) {
    configurePoe(this, this.device(device), supply, load);
  }
  configureInfrastructure(device: string, input: unknown) {
    configureInfrastructure(this, this.device(device), input);
  }
  configureSystem(device: string, input: unknown) {
    configureSystem(this, this.device(device), input);
  }
  setDevicePower(device: string, power: boolean) {
    setInfrastructurePower(this, this.device(device), power);
    setDevicePower(this, this.device(device), power);
  }
  addHardwarePort(device: string, media: 'serial' | 'console', input?: unknown) {
    return addHardwarePort(this, this.device(device), media, input);
  }
  consoleCommand(source: string, link: string, line: string) {
    return consoleCommand(this, source, link, line);
  }
  configureDatabase(device: string, input: unknown) {
    configureDatabase(this, this.device(device), input);
  }
  queryDatabase(device: string, target: string, query: string, key: string, port = 8080) {
    return queryDatabase(this, this.device(device), target, query, key, port);
  }
  configureProxy(device: string, input: unknown) {
    configureProxy(this, this.device(device), input);
  }
  configurePrinter(device: string, input: unknown) {
    configurePrinter(this, this.device(device), input);
  }
  configureBroker(device: string, input: unknown) {
    configureBroker(this, this.device(device), input);
  }
  connectIot(device: string, target: string, clientId?: string, port = 1883, keepAlive = 30) {
    return connectIot(this, this.device(device), target, clientId, port, keepAlive);
  }
  publishIot(device: string, topic: string, payload: string, retain = false) {
    publishIot(this, this.device(device), topic, payload, retain);
  }
  subscribeIot(device: string, topic: string) {
    subscribeIot(this, this.device(device), topic);
  }
  submitPrint(
    device: string,
    target: string,
    name: string,
    pages: number,
    document?: string,
    operation = 2,
    jobId?: number
  ) {
    return submitPrint(this, this.device(device), target, name, pages, document, operation, jobId);
  }
  configurePhone(device: string, input: unknown) {
    configurePhone(this, this.device(device), input);
  }
  callPhone(device: string, target: string, port = 5060) {
    return callPhone(this, this.device(device), target, port);
  }
  hangupPhone(device: string, id: string) {
    hangupPhone(this, this.device(device), id);
  }
  configureDnsSecurity(deviceId: string, input: unknown, zones?: unknown) {
    configureDnsSecurity(this.device(deviceId), input, zones);
  }
  configureDnsRecord(deviceId: string, input: unknown, previous?: DnsRecord) {
    const record = configureDnsRecord(this.device(deviceId), input, previous);
    this.emit(
      'CONFIG_CHANGED',
      deviceId,
      'Registro DNS ' + record.name + ' ' + record.type + ' configurado.'
    );
    return record;
  }
  removeDnsRecord(deviceId: string, input: unknown) {
    const record = dnsRecordSchema.parse(input);
    const device = this.device(deviceId);
    if (!device.dnsServer) throw new Error('Serviço DNS não configurado.');
    device.dnsServer.records = device.dnsServer.records.filter(
      (entry) => entry.name !== record.name || entry.type !== record.type || entry.value !== record.value
    );
    this.emit('CONFIG_CHANGED', deviceId, 'Registro DNS removido: ' + record.name + '.');
  }
  setDnsEnabled(deviceId: string, enabled: boolean) {
    const device = this.device(deviceId);
    if (device.type !== 'server' && device.type !== 'router')
      throw new Error('Serviço DNS requer servidor ou roteador.');
    if (enabled && device.tcpServices?.some((service) => service.enabled && service.port === 53))
      throw new Error('TCP/53 já está ocupado por outro serviço.');
    device.dnsServer ??= { enabled, records: [] };
    device.dnsServer.enabled = enabled;
    this.emit('CONFIG_CHANGED', deviceId, 'Serviço DNS ' + (enabled ? 'habilitado.' : 'desabilitado.'));
  }
  lookupDns(
    deviceId: string,
    name: string,
    type: DnsQuestion['type'] = 'A',
    server?: string,
    pingTtl?: number,
    mode: 'auto' | 'udp' | 'tcp' = 'auto'
  ) {
    return lookupDns(this, this.device(deviceId), name, type, server, pingTtl, mode);
  }
  setDnsServers(deviceId: string, portId: string, input: unknown) {
    configureDnsServers(this.device(deviceId), portId, input);
    this.emit('CONFIG_CHANGED', deviceId, 'Servidores DNS da interface atualizados.', { port: portId });
  }
  clearDnsCache(deviceId: string) {
    this.device(deviceId).dnsCache = [];
    this.emit('CONFIG_CHANGED', deviceId, 'Cache DNS limpo.');
  }
  setDhcpEnabled(deviceId: string, enabled: boolean) {
    const device = this.device(deviceId);
    if (device.type !== 'server' && device.type !== 'router')
      throw new Error('Serviço DHCP requer servidor ou roteador.');
    device.dhcpServer ??= { enabled, pools: [], bindings: [] };
    device.dhcpServer.enabled = enabled;
    this.emit('CONFIG_CHANGED', deviceId, 'Serviço DHCP ' + (enabled ? 'habilitado.' : 'desabilitado.'));
  }
  removeDhcpPool(deviceId: string, name: string) {
    const device = this.device(deviceId);
    const server = device.dhcpServer;
    if (!server?.pools.some((pool) => pool.name === name)) throw new Error('Pool DHCP não encontrado.');
    const removed = new Set(
      server.bindings.filter((binding) => binding.pool === name).map((binding) => binding.id)
    );
    server.pools = server.pools.filter((pool) => pool.name !== name);
    server.bindings = server.bindings.filter((binding) => binding.pool !== name);
    this.state.queue = this.state.queue.filter(
      ({ action }) =>
        action.kind !== 'dhcp-binding-expire' || action.device !== deviceId || !removed.has(action.binding)
    );
    this.emit('CONFIG_CHANGED', deviceId, 'Pool DHCP ' + name + ' removido.');
  }
  requestDhcp(deviceId: string, portId: string) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    if (port.dhcp?.lease) renewDhcp(this, device, port);
    else startDhcp(this, device, port);
  }
  renewDhcp(deviceId: string, portId: string) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    renewDhcp(this, device, port);
  }
  releaseDhcp(deviceId: string, portId: string) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    releaseDhcp(this, device, port);
  }
  disableDhcp(deviceId: string, portId: string) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    disableDhcp(this, device, port);
  }
  configureAcl(deviceId: string, input: unknown) {
    const acl = configureAcl(this.device(deviceId), input);
    this.emit('CONFIG_CHANGED', deviceId, 'ACL ' + acl.name + ' atualizada.');
    return acl;
  }
  configureNat(deviceId: string, input: unknown) {
    return configureNat(this, this.device(deviceId), input);
  }
  configureTcpService(deviceId: string, input: unknown) {
    return configureTcpService(this, this.device(deviceId), input);
  }
  configureInspection(deviceId: string, input: unknown) {
    configureInspection(this, this.device(deviceId), input);
  }
  configureFirewall(deviceId: string, input: unknown) {
    configureFirewall(this, this.device(deviceId), input);
  }
  configureOspf(deviceId: string, input: unknown) {
    configureOspf(this, this.device(deviceId), input);
  }
  refreshBgp() {
    refreshBgp(this);
  }
  configureBgp(deviceId: string, input: unknown) {
    configureBgp(this, this.device(deviceId), input);
  }
  configureVrrp(deviceId: string, input: unknown) {
    configureVrrp(this, this.device(deviceId), input);
  }
  refreshVrrp() {
    refreshVrrp(this);
    refreshBgp(this);
  }
  configureRip(deviceId: string, input: unknown) {
    configureRip(this, this.device(deviceId), input);
  }
  openTcp(
    deviceId: string,
    target: string,
    port: number,
    data = '',
    autoClose = false,
    vrf?: string,
    scope?: string
  ) {
    return openTcp(this, this.device(deviceId), target, port, data, autoClose, undefined, vrf, scope);
  }
  writeTcp(deviceId: string, connection: string, data: string) {
    writeTcp(this, this.device(deviceId), connection, data);
  }
  closeTcp(deviceId: string, connection: string, reset = false) {
    closeTcp(this, this.device(deviceId), connection, reset);
  }
  httpGet(
    deviceId: string,
    target: string,
    port = 80,
    path = '/',
    vrf?: string,
    host?: string,
    scope?: string
  ) {
    if (host && !/^[a-zA-Z0-9.-]{1,253}(?::\d{1,5})?$/.test(host)) throw new Error('Host HTTP inválido.');
    if (!/^\/[^\s\r\n]{0,255}$/.test(path)) throw new Error('Caminho HTTP inválido.');
    return this.openTcp(
      deviceId,
      target,
      port,
      `GET ${path} HTTP/1.1\r\nHost: ${host ?? (target.includes(':') ? '[' + target + ']' : target)}\r\nConnection: close\r\n\r\n`,
      true,
      vrf,
      scope
    );
  }
  bindAcl(deviceId: string, portId: string, direction: 'in' | 'out', name?: string) {
    const { device, port } = endpoint(this.state, { device: deviceId, port: portId });
    if (port.mode !== 'routed' || (name && !device.accessLists?.some((acl) => acl.name === name)))
      throw new Error('ACL ou interface inválida.');
    const key = direction === 'in' ? 'aclIn' : 'aclOut';
    if (name) port[key] = name;
    else delete port[key];
    this.emit(
      'CONFIG_CHANGED',
      deviceId,
      'ACL ' + direction + ' em ' + port.name + ': ' + (name ?? 'nenhuma') + '.'
    );
  }
  configureSnmpAgent(deviceId: string, input: unknown) {
    configureSnmpAgent(this, this.device(deviceId), input);
  }
  querySnmp(
    deviceId: string,
    server: string,
    community: string,
    oids: string[],
    operation: 'get' | 'get-next' = 'get'
  ) {
    return querySnmp(this, this.device(deviceId), server, community, oids, operation);
  }
  configureSyslog(deviceId: string, input: unknown) {
    configureSyslog(this, this.device(deviceId), input);
  }
  setSyslogEnabled(deviceId: string, enabled: boolean) {
    setSyslogEnabled(this, this.device(deviceId), enabled);
  }
  sendSyslog(deviceId: string, text: string, severity = 6) {
    return sendSyslog(this, this.device(deviceId), text, severity);
  }
  removeAcl(deviceId: string, name: string) {
    const device = this.device(deviceId);
    if (device.interfaces.some((port) => port.aclIn === name || port.aclOut === name))
      throw new Error('Remova a ACL das interfaces antes de excluí-la.');
    device.accessLists = device.accessLists?.filter((acl) => acl.name !== name);
  }
  emit(
    type: NetworkEvent['type'],
    device: string,
    reason: string,
    details: Partial<Pick<NetworkEvent, 'port' | 'peer' | 'link' | 'frame'>> = {}
  ) {
    const event: NetworkEvent = {
      id: this.id('event'),
      time: this.state.clock,
      type,
      device,
      reason: reason.slice(0, 500),
      ...structuredClone(details),
    };
    this.state.events.push(event);
    if (this.state.events.length > LIMITS.events) this.state.events.shift();
    const d = findDevice(this.state, device);
    if (d) {
      d.logs.push((this.state.clock.toFixed(3) + ' ' + type + ' ' + reason).slice(0, 300));
      if (d.logs.length > 100) d.logs.shift();
      forwardSyslogEvent(this, d, event);
    }
    return event;
  }
  drop(d: Device, why: string, port?: string, frame?: Frame) {
    d.dropped++;
    if (port) {
      const p = d.interfaces.find((i) => i.id === port);
      if (p) p.errors++;
    }
    this.emit('PACKET_DROPPED', d.id, why, { port, frame });
  }
  schedule(delay: number, action: Action) {
    enqueue(this.state, delay, structuredClone(action));
  }
  sendFrame(deviceId: string, portId: string, frame: Frame) {
    const { device: d, port } = endpoint(this.state, { device: deviceId, port: portId });
    if (port.capwapPeer) {
      sendCapwapFrame(this, d, port, frame);
      return;
    }
    if (port.media === 'console') {
      this.drop(d, 'Console transporta somente comandos UART.', port.id, frame);
      return;
    }
    if (fragmentFrame(this, d, port, frame)) return;
    if (frame.ipv6 && !permit6(this, d, port, 'out', frame.ipv6)) return;
    if (port.vxlan) {
      sendVxlanFrame(this, d, port, frame);
      return;
    }
    if (port.tunnel) {
      sendTunnelFrame(this, d, port, frame);
      return;
    }
    if (port.aggregate) {
      if (
        !frame.bpdu &&
        spanningPortState(d, port, frameVlan(port, frame.vlan)) &&
        spanningPortState(d, port, frameVlan(port, frame.vlan))?.state !== 'forwarding'
      ) {
        this.drop(d, 'STP: EtherChannel bloqueado.', portId, frame);
        return;
      }
      if (
        (frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes ?? frame.mpls?.bytes ?? 28) >
        port.mtu
      ) {
        this.drop(d, 'MTU do EtherChannel excedida.', portId, frame);
        return;
      }
      if (frame.packet && port.mode === 'routed' && !permitPacket(this, d, port, 'out', frame.packet)) return;
      lacpOutput(this, d, port, frame);
      return;
    }
    if (port.logical) {
      if (!d.power || !interfaceUp(d, port)) {
        this.drop(d, 'Interface lógica desligada.', portId, frame);
        return;
      }
      if (
        (frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes ?? frame.mpls?.bytes ?? 28) >
        port.mtu
      ) {
        this.drop(d, 'MTU da interface lógica excedida.', portId, frame);
        return;
      }
      if (frame.packet && !permitPacket(this, d, port, 'out', frame.packet)) return;
      port.tx++;
      if (port.logical.kind === 'subinterface') {
        this.sendFrame(deviceId, port.logical.parent!, { ...frame, vlan: port.logical.vlan });
      } else if (sviOperational(this.state, d, port)) {
        switchTransmit(this, d, frame, port.logical.vlan);
      } else this.drop(d, 'SVI sem porta operacional na VLAN.', portId, frame);
      return;
    }
    if (port.media === 'wifi' && !port.meshPeer) {
      const targets = wirelessTargets(this.state, d, frame);
      if (!targets.length && !frame.wifi)
        this.drop(d, 'Wi-Fi: sem associação autorizada ou rádio sem alcance/canal.', portId, frame);
      for (const link of targets) this.transmit(d, port, frame, link);
      return;
    }
    const link = linksAt(this.state, deviceId, portId)[0];
    this.transmit(d, port, frame, link);
  }
  private transmit(d: Device, port: NetworkInterface, frame: Frame, link?: Link, dequeued = false) {
    const deviceId = d.id,
      portId = port.id;
    const radio =
      link && ['wireless', 'mesh'].includes(link.cable) ? wirelessMetrics(this.state, link) : undefined;
    if (
      !link ||
      !((frame.wifi || frame.meshHello) && radio ? radio.operational : linkOperational(this.state, link))
    ) {
      this.drop(d, 'Interface sem link operacional.', portId, frame);
      return;
    }
    if (!permitDot1x(this, d, port, frame, 'out')) return;
    if (frame.hops <= 0) {
      this.drop(
        d,
        'Limite de hops Ethernet: possível loop L2. Revise os links e o estado de STP/RSTP.',
        portId,
        frame
      );
      return;
    }
    if (
      !frame.eapol &&
      !frame.bpdu &&
      !frame.lacp &&
      !frame.wifi &&
      !frame.meshHello &&
      spanningPortState(d, port, frameVlan(port, frame.vlan)) &&
      spanningPortState(d, port, frameVlan(port, frame.vlan))?.state !== 'forwarding'
    ) {
      this.drop(d, 'STP: porta de saída não encaminha dados.', portId, frame);
      return;
    }
    if (!dequeued && enqueueQos(this, d, port, frame, link.id)) return;
    if (
      frame.packet &&
      (d.type !== 'switch' || port.mode === 'routed') &&
      !permitPacket(this, d, port, 'out', frame.packet)
    )
      return;
    if (
      (frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes ?? frame.mpls?.bytes ?? 28) >
      port.mtu
    ) {
      this.drop(d, 'Frame excede MTU da interface de saída.', portId, frame);
      return;
    }
    if (frame.packet?.protocol === 'UDP') stampNtp(this, d, frame.packet);
    const originalBytes =
      frame.packet?.bytes ??
      frame.fragment?.bytes ??
      frame.ipv6?.bytes ??
      frame.secure?.innerBytes ??
      frame.mpls?.bytes ??
      28;
    if (link.cable === 'mesh' && !frame.meshHello) frame = protectMesh(this.state, d, link, frame);
    else if (radio && !frame.wifi) frame = protectWireless(this.state, d, link, frame);
    if (port.media === 'serial') frame = serialFrame(frame);
    const remote = link.a.device === deviceId ? link.b : link.a;
    port.tx++;
    this.emit('FRAME_SENT', deviceId, 'Frame transmitido em ' + port.name + '.', {
      port: portId,
      peer: remote.device,
      link: link.id,
      frame,
    });
    if (random(this.state) < (radio?.loss ?? link.loss)) {
      this.drop(
        d,
        radio ? 'Perda no rádio por SNR/interferência.' : 'Perda configurada no cabo.',
        portId,
        frame
      );
      return;
    }
    const serialization =
      port.media === 'serial'
        ? ((originalBytes + 6) * 8 * 1000) /
          (port.serial?.role === 'DCE'
            ? port.serial.clockRate
            : endpoint(this.state, remote).port.serial!.clockRate)
        : ((originalBytes + (frame.secure ? 48 : 18)) * 8) / ((radio?.speed ?? port.speed) * 1000);
    const workDelay = processingDelay(this, d);
    if (workDelay === undefined) {
      this.drop(d, 'Memória do equipamento esgotada.', port.id, frame);
      return;
    }
    const delay = Math.max(
      0.001,
      (radio?.latency ?? link.latency) +
        (random(this.state) * 2 - 1) * link.jitter +
        serialization +
        workDelay
    );
    this.schedule(delay, {
      kind: 'deliver',
      device: remote.device,
      port: remote.port,
      from: deviceId,
      link: link.id,
      frame: { ...frame, hops: frame.hops - 1 },
    });
  }
  sendIp(deviceId: string, packet: Packet, ingress?: NetworkInterface, vrf = ingress?.vrf) {
    const d = this.device(deviceId);
    refreshPower(this);
    packet = hairpinError(d, packet) ?? packet;
    requireVrf(d, vrf);
    if (!d.power) {
      this.drop(d, 'Equipamento desligado');
      return;
    }
    const local = d.interfaces.find(
      (port) => interfaceUp(d, port) && port.vrf === vrf && port.ip === packet.dst
    );
    if (local) {
      receiveIp(this, d, local, packet, local.mac, false);
      return;
    }
    const labelRoute = mplsRoute(d, packet, vrf);
    const baseline = labelRoute ?? resolveRoute(d, packet.dst, vrf);
    const connected = baseline && !baseline.port.tunnel && baseline.nextHop === packet.dst;
    const selection = !vrf && !connected && !labelRoute ? selectSdwan(this, d, packet) : undefined;
    const route = selection?.blocked ? undefined : (selection?.route ?? baseline);
    if (!route) {
      this.drop(d, 'Nenhuma rota corresponde a ' + packet.dst + ' e não há gateway/rota padrão válido.');
      if (ingress && routingEnabled(d)) sendIcmpError(this, d, ingress, packet, 'unreachable', 0);
      return;
    }
    this.emit(
      'ROUTE_SELECTED',
      d.id,
      'Longest prefix match /' + route.prefix + ' via ' + route.nextHop + ' em ' + route.port.name + '.',
      { port: route.port.id }
    );
    if (ingress && !permitFirewall(this, d, ingress, route.port, packet)) return;
    const translated = natOutbound(this, d, ingress, route.port, packet);
    if (!translated) return;
    // A locally generated MTU error must quote the packet before source NAT.
    // Sending an error to our translated address would consume it in our own stack.
    if (
      ingress &&
      ingress.natRole === 'inside' &&
      route.port.natRole === 'outside' &&
      translated.src !== packet.src &&
      'df' in packet &&
      packet.df &&
      translated.bytes > route.port.mtu
    ) {
      if (!permitPacket(this, d, route.port, 'out', translated)) return;
      this.drop(d, 'IPv4 DF: MTU ' + route.port.mtu + ' excedida; ICMP Fragmentation Needed.', route.port.id);
      sendIcmpError(this, d, ingress, packet, 'unreachable', 4, route.port.mtu);
      return;
    }
    if (route.port.tunnel) {
      this.sendFrame(d.id, route.port.id, {
        src: route.port.mac,
        dst: route.port.mac,
        etherType: 'IPv4',
        packet: translated,
        hops: LIMITS.l2Hops,
      });
      return;
    }
    if (labelRoute) pushMpls(this, d, route.port, route.nextHop, translated, labelRoute.fec.labels);
    else sendWithArp(this, d, route.port, route.nextHop, translated);
  }
  ping(deviceId: string, target: string, ttl = 64, vrf?: string, bytes = 84, df = false) {
    const d = this.device(deviceId);
    requireVrf(d, vrf);
    const destination =
      this.state.devices
        .find((v) => v.hostname.toLowerCase() === target.toLowerCase())
        ?.interfaces.find((i) => i.ip)?.ip ?? target;
    if (!ipv4Schema.safeParse(destination).success && !/^[\d.]+$/.test(destination))
      return this.lookupDns(deviceId, destination, 'A', undefined, ttl);
    ipNumber(destination);
    if (d.type === 'switch' && !d.interfaces.some((p) => p.mode === 'routed' && !!p.ip))
      throw new Error('Configure uma SVI para usar a stack IP do switch.');
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 255) throw new Error('TTL inválido');
    if (!Number.isInteger(bytes) || bytes < 28 || bytes > 65535)
      throw new Error('Tamanho IPv4 deve estar entre 28 e 65535 bytes.');
    const route = resolveRoute(d, destination, vrf);
    const source = route?.port.ip ?? d.interfaces.find((i) => i.ip && i.vrf === vrf)?.ip;
    if (!source) throw new Error('Configure um endereço IPv4 na interface de origem');
    if (this.state.probes.length >= LIMITS.probes) {
      const finished = this.state.probes.findIndex((p) => p.status !== 'pending');
      if (finished < 0) throw new Error('Muitos probes pendentes');
      const [old] = this.state.probes.splice(finished, 1);
      this.state.queue = this.state.queue.filter(
        (q) => q.action.kind !== 'probe-timeout' || q.action.probeId !== old.id
      );
    }
    const probe = {
      id: this.id('probe'),
      device: deviceId,
      target: destination,
      start: this.state.clock,
      status: 'pending' as const,
      ttl,
      ...(vrf ? { vrf } : {}),
    };
    this.state.probes.push(probe);
    this.emit('PACKET_SENT', d.id, 'ICMP Echo Request para ' + destination + '; TTL ' + ttl + '.');
    if (d.power && d.interfaces.some((i) => interfaceUp(d, i) && i.vrf === vrf && i.ip === destination)) {
      Object.assign(probe, { status: 'success', rtt: 0, responder: destination });
      this.emit('PING_SUCCESS', d.id, 'Destino local: entregue à própria stack IPv4.');
    } else {
      this.sendIp(
        deviceId,
        {
          src: source,
          dst: destination,
          ttl,
          protocol: 'ICMP',
          kind: 'echo-request',
          probeId: probe.id,
          traceId: probe.id,
          bytes,
          ...(df ? { df: true } : {}),
        },
        undefined,
        vrf
      );
      this.schedule(LIMITS.probeTimeout, { kind: 'probe-timeout', probeId: probe.id });
    }
    return probe.id;
  }
  step() {
    refreshDot1x(this);
    refreshWireless(this);
    refreshLacp(this);
    refreshSpanningTree(this);
    refreshVrrp(this);
    refreshBgp(this);
    const item = this.state.queue.shift();
    if (!item) return false;
    this.state.clock = item.at;
    refreshInfrastructure(this);
    for (const d of this.state.devices) {
      d.macTable = d.macTable.filter((m) => m.expires > this.state.clock);
      d.arpTable = d.arpTable.filter((a) => a.expires > this.state.clock);
      if (d.dnsCache) d.dnsCache = d.dnsCache.filter((entry) => entry.expiresAt > this.state.clock);
    }
    const a = item.action;
    if (a.kind === 'telemetry-tick') handleTelemetry(this, a);
    else if (a.kind === 'ntp-tick') handleNtp(this, a);
    else if (a.kind === 'remote-timeout') handleRemoteTimeout(this, a);
    else if (a.kind === 'automation-next') handleAutomation(this, a);
    else if (a.kind === 'dot1x-tick') handleDot1xTick(this, a);
    else if (a.kind === 'inspection-expire') expireInspection(this, this.device(a.device), a.flow, a.at);
    else if (a.kind === 'aaa-timeout') handleAaaTimeout(this, a);
    else if (a.kind === 'sdwan-tick') handleSdwanTick(this, a);
    else if (a.kind === 'qos-tick') handleQosTick(this, a);
    else if (a.kind === 'tunnel-tick') handleTunnelTick(this, a);
    else if (a.kind === 'wireless-tick') handleWirelessTick(this, a);
    else if (a.kind === 'ipv6-tick') handleIpv6Tick(this, a);
    else if (a.kind === 'ndp-timer') handleNdpTimer(this, a);
    else if (a.kind === 'probe6-timeout') {
      const q = this.state.probes6?.find((q) => q.id === a.probeId && q.device === a.device);
      if (q?.status === 'pending') {
        q.status = 'timeout';
        this.emit('PING_TIMEOUT', q.device, 'IPv6: sem Echo Reply em 30 s virtuais.');
      }
    } else if (a.kind === 'lacp-tick') handleLacpTick(this, a);
    else if (a.kind === 'stp-hello' || a.kind === 'stp-transition' || a.kind === 'stp-info-expire')
      handleSpanningTreeAction(this, a);
    else if (a.kind === 'nat-expire') expireNat(this, this.device(a.device), a.binding, a.expiresAt);
    else if (a.kind === 'tcp-timer') handleTcpTimer(this, a);
    else if (a.kind === 'dhcp6-tick') handleDhcp6Tick(this, a);
    else if (a.kind === 'ospf-tick') handleOspfTick(this, a);
    else if (a.kind === 'rip-tick') handleRipTick(this, a);
    else if (a.kind === 'vrrp-timer') handleVrrpTimer(this, a);
    else if (a.kind === 'bgp-tick') handleBgpTick(this, a);
    else if (a.kind === 'firewall-expire') expireFirewall(this, this.device(a.device), a.session, a.at);
    else if (a.kind === 'snmp-timeout') handleSnmpTimeout(this, this.device(a.device), a.queryId, a.attempt);
    else if (a.kind === 'syslog-send') handleSyslogSend(this, this.device(a.device), a.server, a.message);
    else if (a.kind === 'probe-timeout') {
      const probe = this.state.probes.find((p) => p.id === a.probeId);
      if (probe?.status === 'pending') {
        probe.status = 'timeout';
        this.emit(
          'PING_TIMEOUT',
          probe.device,
          'Sem Echo Reply dentro de 30 s virtuais. Consulte os descartes anteriores.'
        );
      }
    } else if (a.kind === 'arp-timeout') handleArpTimer(this, a);
    else if (a.kind === 'fragment-expire' || a.kind === 'fragment-arp') handleFragmentAction(this, a);
    else if (a.kind === 'capwap-tick') handleCapwapTick(this, a);
    else if (a.kind === 'mesh-tick') handleMeshTick(this, a);
    else if (a.kind === 'application-tick') handleApplicationTick(this, a);
    else if (a.kind === 'voice-tick') handleVoiceTick(this, a);
    else if (a.kind === 'sip-alg-expire') expireSipAlg(this, a);
    else if (a.kind === 'nat-hairpin-expire') handleHairpinExpiry(this, a);
    else if (a.kind === 'dhcp-client-timer') handleDhcpClientTimer(this, a);
    else if (a.kind === 'dns-timeout') handleDnsTimeout(this, a);
    else if (a.kind === 'dhcp-binding-expire')
      expireDhcpBinding(this, this.device(a.device), a.binding, a.expiresAt);
    else this.receive(a);
    refreshDot1x(this);
    refreshWireless(this);
    refreshLacp(this);
    refreshVrrp(this);
    refreshBgp(this);
    return true;
  }
  private receive(a: Extract<Action, { kind: 'deliver' }>) {
    const { device: d, port: physical } = endpoint(this.state, { device: a.device, port: a.port });
    let port = physical;
    const link = findLink(this.state, a.link);
    if (
      !link ||
      !((a.frame.wifi && link.cable === 'wireless') || (a.frame.meshHello && link.cable === 'mesh')
        ? wirelessMetrics(this.state, link).operational
        : linkOperational(this.state, link))
    ) {
      this.drop(d, 'Link caiu antes da chegada do frame.', port.id, a.frame);
      return;
    }
    if (
      (a.frame.packet?.bytes ??
        a.frame.fragment?.bytes ??
        a.frame.ipv6?.bytes ??
        a.frame.secure?.innerBytes ??
        a.frame.mpls?.bytes ??
        28) > port.mtu
    ) {
      this.drop(d, 'MTU excedida na recepção.', port.id, a.frame);
      return;
    }
    if (physical.media === 'console') {
      this.drop(d, 'Console não encaminha frames IP.', port.id);
      return;
    }
    if (physical.media === 'serial') {
      if (!a.frame.wan || a.frame.wan.fcs !== serialFrame(a.frame).wan.fcs) {
        this.drop(d, 'HDLC FCS inválido.', port.id, a.frame);
        return;
      }
    } else if (a.frame.wan) {
      this.drop(d, 'HDLC recebido fora de interface serial.', port.id, a.frame);
      return;
    }
    port.rx++;
    this.emit('FRAME_RECEIVED', d.id, 'Frame recebido em ' + port.name + '.', {
      port: port.id,
      peer: a.from,
      link: a.link,
      frame: a.frame,
    });
    if (passiveForward(this, d, port.id, a.frame)) return;
    if (a.frame.meshHello) {
      receiveMeshHello(this, d, port.id, a.frame, a.from);
      return;
    }
    if (link.cable === 'mesh') {
      try {
        a.frame = unprotectMesh(this.state, d, link, a.frame);
      } catch (error) {
        this.drop(d, (error as Error).message, port.id, a.frame);
        return;
      }
    }
    if (a.frame.wan) {
      a.frame = { ...a.frame };
      delete a.frame.wan;
    }
    if (a.frame.secure && link.cable === 'wireless') {
      try {
        a.frame = unprotectWireless(this.state, d, link, a.frame);
      } catch (error) {
        this.drop(d, (error as Error).message, port.id, a.frame);
        return;
      }
    }
    if (a.frame.eapol) {
      receiveEapol(this, d, physical, a.frame);
      return;
    }
    if (!permitDot1x(this, d, physical, a.frame, 'in')) return;
    if (a.frame.wifi) {
      receiveWireless(this, d, a.frame, a.link);
      return;
    }
    if (a.frame.lacp) {
      receiveLacp(this, d, physical, a.frame);
      return;
    }
    if (physical.channel) {
      const aggregate = d.interfaces.find((p) => p.id === physical.channel);
      if (!aggregate || !lacpMembers(this.state, d, aggregate).includes(physical.id)) {
        this.drop(d, 'LACP: membro não sincronizado.', physical.id, a.frame);
        return;
      }
      port = aggregate;
      port.rx++;
    }
    if (a.frame.bpdu) {
      if (d.type === 'switch') receiveBpdu(this, d, port, a.frame);
      return;
    }
    if (capwapFromRadio(this, d, port, a.frame)) return;
    if (d.type === 'switch' && port.mode !== 'routed') {
      switchFrame(this, d, port, a.frame);
      return;
    }
    const logical =
      a.frame.vlan === undefined
        ? undefined
        : d.interfaces.find(
            (p) =>
              p.logical?.kind === 'subinterface' &&
              p.logical.parent === port.id &&
              p.logical.vlan === a.frame.vlan
          );
    if (a.frame.vlan !== undefined && !logical) {
      this.drop(
        d,
        'Endpoint routed não aceita frame 802.1Q; use porta access/native VLAN.',
        port.id,
        a.frame
      );
      return;
    }
    const input = logical ?? port;
    if (
      (a.frame.packet?.bytes ??
        a.frame.fragment?.bytes ??
        a.frame.ipv6?.bytes ??
        a.frame.secure?.innerBytes ??
        a.frame.mpls?.bytes ??
        28) > input.mtu
    ) {
      this.drop(d, 'MTU da interface lógica excedida na recepção.', input.id, a.frame);
      return;
    }
    if (!interfaceUp(d, input)) {
      this.drop(d, 'Interface lógica de entrada desligada.', input.id, a.frame);
      return;
    }
    if (logical) logical.rx++;
    if (
      a.frame.dst !== input.mac &&
      a.frame.dst !== BROADCAST &&
      !(a.frame.ipv6 && a.frame.dst.startsWith('33:33:')) &&
      !acceptsVrrpMac(this.state, d, input, a.frame.dst) &&
      !(a.frame.packet?.protocol === 'VRRP' && a.frame.dst === VRRP.mac) &&
      !(a.frame.packet?.protocol === 'OSPF' && a.frame.dst === OSPF.mac) &&
      !(
        a.frame.packet?.protocol === 'UDP' &&
        a.frame.packet.payload.protocol === 'RIP' &&
        a.frame.dst === RIP.mac
      )
    )
      return;
    if (a.frame.mpls) receiveMpls(this, d, input, a.frame);
    else if (a.frame.ipv6) receiveIp6(this, d, input, a.frame);
    else if (a.frame.etherType === 'ARP') receiveArp(this, d, input, a.frame);
    else if (a.frame.fragment) receiveFragment(this, d, input, a.frame);
    else if (a.frame.packet) receiveIp(this, d, input, a.frame.packet, a.frame.src);
  }
  advanceTo(time: number, maxSteps = 20000) {
    if (!Number.isFinite(time) || time < this.state.clock) throw new Error('Instante virtual inválido.');
    if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('Orçamento de eventos inválido.');
    refreshPower(this);
    refreshDot1x(this);
    refreshWireless(this);
    refreshLacp(this);
    refreshSpanningTree(this);
    refreshVrrp(this);
    refreshBgp(this);
    let count = 0;
    while (this.state.queue.length && this.state.queue[0].at <= time && count < maxSteps) {
      this.step();
      count++;
    }
    if (this.state.queue.length && this.state.queue[0].at <= time)
      throw new Error('Orçamento de simulação esgotado antes do instante solicitado.');
    this.state.clock = time;
    refreshInfrastructure(this, true);
    refreshDot1x(this);
    refreshWireless(this);
    refreshLacp(this);
    for (const device of this.state.devices) {
      device.macTable = device.macTable.filter((entry) => entry.expires > time);
      device.arpTable = device.arpTable.filter((entry) => entry.expires > time);
      if (device.dnsCache) device.dnsCache = device.dnsCache.filter((entry) => entry.expiresAt > time);
    }
    return count;
  }
  run(maxSteps = 20000) {
    let count = 0;
    while (count < maxSteps && this.step()) count++;
    if (this.state.queue.length) throw new Error('Orçamento de simulação esgotado; revise loops na rede.');
    return count;
  }
}
