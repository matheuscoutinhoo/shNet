import { proxyConfigSchema, printerConfigSchema, brokerConfigSchema } from './protocols/applications-model';
import { phoneConfigSchema } from './protocols/voice-model';
import {
  eapServerConfigSchema,
  eapAuthenticatorConfigSchema,
  eapSupplicantConfigSchema,
} from './protocols/enterprise-model';
import { wlcConfigSchema, wtpConfigSchema } from './protocols/capwap-model';
import { meshConfigSchema } from './protocols/mesh-model';
import { dhcp6ServerConfigSchema, dhcp6ClientConfigSchema } from './protocols/dhcp6-model';
import { advancedLabs, prepareAdvancedLab, evaluateAdvancedLab } from './advanced-labs';
import { remoteConfig } from './protocols/remote';
import { telemetryConfig } from './protocols/telemetry';
import { ntpConfig } from './protocols/ntp';
import { dot1xConfig, supplicantConfig } from './protocols/dot1x';
import { qosConfig } from './protocols/qos';
import { tunnelConfig } from './protocols/tunnel';
import { sdwanConfig } from './protocols/sdwan';
import { wirelessConfig } from './protocols/wireless';
import { ipv6Config } from './protocols/ipv6-control';
import { bgpConfig } from './protocols/bgp';
import { vrrpConfigGroups } from './protocols/vrrp';
import { SimulationEngine } from './core/engine';
import { makeTemplate } from './templates';
import { sameSubnet } from './protocols/ipv4';
import type { Snapshot } from './model';

export const labs = [
  ...advancedLabs,
  {
    id: 'lan-foundations',
    name: 'Primeira LAN',
    category: 'Fundamentos',
    difficulty: 'Iniciante',
    template: 'empty',
    objective: 'Conecte dois PCs por um switch, configure IPv4 e valide a comunicação.',
  },
  {
    id: 'routing-repair',
    name: 'Reconecte as sub-redes',
    category: 'Roteamento',
    difficulty: 'Intermediário',
    template: 'broken',
    objective: 'Diagnostique o enlace indisponível e recupere a comunicação de ponta a ponta.',
  },
  {
    id: 'dhcp-basics',
    name: 'Concessões em operação',
    category: 'Serviços',
    difficulty: 'Iniciante',
    template: 'dhcp',
    objective: 'Configure os clientes para obter endereço por DHCP e valide os leases.',
  },
  {
    id: 'vlan-segmentation',
    name: 'VLAN 20 de ponta a ponta',
    category: 'Switching',
    difficulty: 'Intermediário',
    template: 'vlan',
    objective: 'Crie VLAN 20 nos switches, configure access/trunk e mantenha a conectividade.',
  },
  {
    id: 'nat-boundary',
    name: 'Tradução na borda',
    category: 'Segurança',
    difficulty: 'Intermediário',
    template: 'nat',
    objective: 'Implemente NAT e libere ICMP, bloqueando consultas DNS com uma ACL.',
  },
  {
    id: 'rstp-failover',
    name: 'Caminho resiliente',
    category: 'Switching',
    difficulty: 'Intermediário',
    template: 'rstp',
    objective: 'Mantenha comunicação após a queda de um uplink sem formar um loop Ethernet.',
  },
] as const;
export type LabId = (typeof labs)[number]['id'];
export interface LabTaskResult {
  id: string;
  label: string;
  passed: boolean;
}
export interface LabEvaluation {
  labId: LabId;
  tasks: LabTaskResult[];
  passed: number;
  total: number;
  complete: boolean;
}
export function describeLabTasks(id: LabId) {
  return evaluateLab(id, new SimulationEngine().snapshot()).tasks;
}

export function makeLab(id: LabId) {
  const lab = labs.find((entry) => entry.id === id);
  if (!lab) throw new Error('Lab não encontrado.');
  const state = makeTemplate(lab.template);
  if (advancedLabs.some((l) => l.id === id)) {
    const engine = new SimulationEngine(state);
    prepareAdvancedLab(id, engine);
    return engine.snapshot();
  }
  if (id === 'nat-boundary') {
    const engine = new SimulationEngine(state);
    const server = engine.state.devices.at(-1)!;
    engine.configureDnsRecord(server.id, {
      name: 'outside.lab',
      type: 'A',
      value: server.interfaces[0].ip!,
      ttl: 0,
    });
    engine.setDnsServers(engine.state.devices[0].id, 'p0', [server.interfaces[0].ip!]);
    return engine.snapshot();
  }
  return state;
}

function configuration(schema: { shape: Record<string, unknown> }, value: object) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key in schema.shape));
}
export function freshSimulation(snapshot: Snapshot) {
  if (
    snapshot.devices.length > 24 ||
    snapshot.links.length > 48 ||
    snapshot.devices.reduce(
      (count, device) => count + (device.accessLists?.reduce((sum, acl) => sum + acl.rules.length, 0) ?? 0),
      0
    ) > 128
  )
    throw new Error('Avaliação guiada limitada a 24 equipamentos, 48 conexões e 128 regras ACL.');
  const engine = new SimulationEngine(snapshot);
  engine.state.queue = [];
  engine.state.events = [];
  engine.state.probes = [];
  engine.state.probes6 = [];
  for (const device of engine.state.devices) {
    if (device.wireless) engine.configureWireless(device.id, wirelessConfig(device));
    for (const p of device.interfaces)
      if (p.vxlan) p.vxlan = { ...p.vxlan, local: [], routes: [], learned: [], sent: 0, received: 0 };
    for (const port of device.interfaces)
      if (port.tunnel) engine.configureTunnel(device.id, tunnelConfig(port));
    if (device.sdwan) engine.configureSdwan(device.id, sdwanConfig(device));
    for (const p of device.interfaces)
      if (p.qos) {
        const config = qosConfig(p);
        delete p.qos;
        engine.configureQos(device.id, p.id, config);
      }
    if (device.dhcp6Server)
      engine.configureDhcp6Server(device.id, configuration(dhcp6ServerConfigSchema, device.dhcp6Server));
    device.routes6 = device.routes6?.filter((r) => !r.dhcp6Lease);
    device.neighbors6 = [];
    device.pending6 = [];
    device.resolutions6 = [];
    for (const port of device.interfaces)
      if (port.ipv6) engine.configureIpv6(device.id, port.id, ipv6Config(port));
    for (const port of device.interfaces)
      if (port.dhcp6)
        engine.configureDhcp6Client(device.id, port.id, configuration(dhcp6ClientConfigSchema, port.dhcp6));
    delete device.reassemblies;
    delete device.fragmentPending;
    device.arpTable = [];
    device.macTable = [];
    device.pending = [];
    device.arpResolutions = [];
    device.logs = [];
    delete device.dnsQueries;
    delete device.dnsCache;
    delete device.remoteQueries;
    delete device.automationJobs;
    if (device.remoteManagement) engine.configureRemote(device.id, remoteConfig(device));
    if (device.telemetry) engine.configureTelemetry(device.id, telemetryConfig(device));
    if (device.telemetryCollector)
      engine.configureCollector(device.id, {
        enabled: device.telemetryCollector.enabled,
        key: device.telemetryCollector.key,
      });
    if (device.ntp) engine.configureNtp(device.id, ntpConfig(device));
    delete device.aaaQueries;
    delete device.networkAuth;
    if (device.aaaServer) {
      device.aaaServer.accepted = 0;
      device.aaaServer.rejected = 0;
      device.aaaServer.accounting = [];
    }
    for (const p of device.interfaces) {
      if (p.dot1x) engine.configureDot1x(device.id, p.id, dot1xConfig(p));
      if (p.supplicant) engine.configureSupplicant(device.id, p.id, supplicantConfig(p));
    }
    delete device.tcpConnections;
    if (device.proxy) engine.configureProxy(device.id, configuration(proxyConfigSchema, device.proxy));
    if (device.printer) {
      device.printer.jobs = [];
      engine.configurePrinter(device.id, configuration(printerConfigSchema, device.printer));
    }
    if (device.broker) {
      device.broker.clients = [];
      device.broker.retained = [];
      engine.configureBroker(device.id, configuration(brokerConfigSchema, device.broker));
    }
    if (device.iot) {
      const c = device.iot;
      delete device.iot;
      engine.connectIot(device.id, c.broker, c.clientId, c.port, c.keepAlive);
    }
    if (device.phone) engine.configurePhone(device.id, configuration(phoneConfigSchema, device.phone));
    if (device.eapServer)
      engine.configureEapServer(device.id, configuration(eapServerConfigSchema, device.eapServer));
    if (device.eapAuthenticator)
      engine.configureEapAuthenticator(
        device.id,
        configuration(eapAuthenticatorConfigSchema, device.eapAuthenticator)
      );
    if (device.eapSupplicant)
      engine.configureEapSupplicant(
        device.id,
        configuration(eapSupplicantConfigSchema, device.eapSupplicant)
      );
    if (device.wlc) engine.configureWlc(device.id, configuration(wlcConfigSchema, device.wlc));
    if (device.wtp) engine.configureWtp(device.id, configuration(wtpConfigSchema, device.wtp));
    if (device.mesh) engine.configureMesh(device.id, configuration(meshConfigSchema, device.mesh));
    if (device.dhcpSnooping) {
      device.dhcpSnooping.bindings = [];
      device.dhcpSnooping.requests = [];
    }
    if (device.nat) {
      device.nat.hairpins = [];
      device.nat.sipBindings = [];
    }
    if (device.ids) {
      device.ids.flows = [];
      device.ids.counters = [];
      device.ids.alerts = [];
    }
    delete device.snmpQueries;
    for (const port of device.interfaces)
      if (port.aggregate) {
        port.aggregate = {
          ...port.aggregate,
          received: [],
          selected: [],
          token: engine.id('lacp'),
          tickAt: engine.state.clock + 0.001,
        };
        engine.schedule(0.001, {
          kind: 'lacp-tick',
          device: device.id,
          port: port.id,
          token: port.aggregate.token,
        });
      }
    if (device.syslogServer) device.syslogServer.entries = [];
    if (device.dhcpServer) device.dhcpServer.bindings = [];
    if (device.nat) device.nat.bindings = [];
    if (device.firewall) {
      device.firewall.sessions = [];
      if (device.firewall.application) device.firewall.application.flows = [];
    }
  }
  for (const device of engine.state.devices) {
    if (device.spanningTree?.enabled)
      engine.configureSpanningTree(device.id, device.spanningTree.mode, device.spanningTree.priority);
    const ospf = device.ospf;
    if (ospf) {
      delete device.ospf;
      engine.configureOspf(device.id, {
        enabled: ospf.enabled,
        routerId: ospf.routerId,
        areas: ospf.areas,
        externalRoutes: ospf.externalRoutes,
        interfaces: ospf.interfaces,
      });
    }
    const bgp = bgpConfig(device);
    if (bgp) {
      delete device.bgp;
      engine.configureBgp(device.id, bgp);
    }
    const vrrp = device.vrrp;
    if (vrrp) {
      const groups = vrrpConfigGroups(device);
      delete device.vrrp;
      engine.configureVrrp(device.id, { enabled: vrrp.enabled, groups });
    }
    const rip = device.rip;
    if (rip) {
      delete device.rip;
      engine.configureRip(device.id, {
        enabled: rip.enabled,
        interfaces: rip.interfaces,
        holdDownMs: rip.holdDownMs,
        redistributeStatic: rip.redistributeStatic,
        staticMetric: rip.staticMetric,
        staticTag: rip.staticTag,
      });
    }
  }
  const convergenceMs = Math.max(
    31000,
    ...engine.state.devices.flatMap((device) =>
      device.vrrp?.enabled ? device.vrrp.groups.map((group) => 4 * group.advertMs + 1000) : []
    ),
    ...engine.state.devices.flatMap((device) =>
      device.ospf?.enabled
        ? device.ospf.interfaces
            .filter((port) => !port.passive)
            .map((port) => port.deadMs + 2 * port.helloMs + 1000)
        : []
    )
  );
  engine.advanceTo(engine.state.clock + convergenceMs, 20000);
  for (const device of engine.state.devices)
    for (const port of device.interfaces)
      if (port.ipv4Mode === 'dhcp') {
        delete port.dhcp;
        engine.requestDhcp(device.id, port.id);
      }
  engine.advanceTo(engine.state.clock + 1000, 3000);
  return engine;
}

export function evaluateLab(id: LabId, snapshot: Snapshot): LabEvaluation {
  if (!labs.some((lab) => lab.id === id)) throw new Error('Lab não encontrado.');
  const engine = freshSimulation(snapshot);
  if (advancedLabs.some((l) => l.id === id)) return evaluateAdvancedLab(id, engine);
  const tasks: LabTaskResult[] = [];
  const add = (taskId: string, label: string, passed: boolean) => tasks.push({ id: taskId, label, passed });
  const hosts = engine.state.devices.filter((device) => device.type === 'pc' || device.type === 'server');
  const switches = engine.state.devices.filter((device) => device.type === 'switch');
  const router = engine.state.devices.find((device) => device.type === 'router');
  const ping = () => {
    const source = hosts[0],
      destination = hosts.at(-1);
    if (
      !source ||
      !destination ||
      source.id === destination.id ||
      !source.interfaces.some((port) => port.ip) ||
      !destination.interfaces[0].ip
    )
      return false;
    try {
      const probeId = engine.ping(source.id, destination.interfaces[0].ip);
      engine.advanceTo(engine.state.clock + 31000, 3000);
      return engine.state.probes.find((probe) => probe.id === probeId)?.status === 'success';
    } catch {
      return false;
    }
  };
  if (id === 'lan-foundations') {
    add(
      'devices',
      'Adicionar dois PCs e um switch',
      hosts.filter((device) => device.type === 'pc').length >= 2 && switches.length >= 1
    );
    add(
      'links',
      'Conectar fisicamente os hosts',
      hosts.length >= 2 &&
        hosts
          .slice(0, 2)
          .every((host) =>
            engine.state.links.some((link) => link.a.device === host.id || link.b.device === host.id)
          )
    );
    const first = hosts[0]?.interfaces[0],
      second = hosts[1]?.interfaces[0];
    add(
      'ipv4',
      'Configurar IPs distintos na mesma subnet',
      !!first?.ip &&
        !!second?.ip &&
        first.ip !== second.ip &&
        first.prefix === second.prefix &&
        sameSubnet(first.ip, second.ip, first.prefix!)
    );
  } else if (id === 'routing-repair') {
    add(
      'router',
      'Restaurar as interfaces do roteador',
      !!router && router.interfaces.slice(0, 2).every((port) => port.adminUp && !!port.ip)
    );
    add(
      'gateways',
      'Configurar os gateways dos hosts',
      hosts.length >= 2 &&
        hosts.every((host) => !!host.gateway || host.interfaces.some((port) => !!port.gateway))
    );
  } else if (id === 'dhcp-basics') {
    const clients = hosts.filter((device) => device.type === 'pc');
    add(
      'service',
      'Habilitar o serviço e um pool DHCP',
      hosts.some((host) => host.dhcpServer?.enabled && host.dhcpServer.pools.length > 0)
    );
    add(
      'clients',
      'Obter leases válidos nos dois PCs',
      clients.length >= 2 &&
        clients.every((client) => client.interfaces.some((port) => port.dhcp?.status === 'bound'))
    );
    add(
      'unique',
      'Receber endereços sem duplicação',
      clients.length >= 2 &&
        new Set(clients.map((client) => client.interfaces[0].ip)).size === clients.length &&
        clients.every((client) => !!client.interfaces[0].ip)
    );
  } else if (id === 'vlan-segmentation') {
    add(
      'vlans',
      'Criar VLAN 20 nos dois switches',
      switches.length >= 2 && switches.every((device) => device.vlans.some((vlan) => vlan.id === 20))
    );
    add(
      'access',
      'Configurar as portas access na VLAN 20',
      switches.length >= 2 && switches.every((device) => device.interfaces[0].accessVlan === 20)
    );
    add(
      'trunk',
      'Permitir VLAN 20 nos trunks',
      switches.length >= 2 &&
        switches.every(
          (device) => device.interfaces[1].mode === 'trunk' && device.interfaces[1].allowedVlans.includes(20)
        )
    );
  } else if (id === 'nat-boundary') {
    add(
      'nat',
      'Habilitar NAT na borda',
      !!router?.nat?.enabled && router.nat.statics.length + router.nat.pools.length > 0
    );
    add(
      'acl',
      'Aplicar ACL na interface de entrada',
      !!router?.interfaces.some((port) => port.natRole === 'inside' && port.aclIn)
    );
    const source = hosts[0];
    let denied = false;
    if (source?.interfaces[0].ip) {
      try {
        engine.state.events = [];
        engine.lookupDns(source.id, 'outside.lab');
        engine.advanceTo(engine.state.clock + 11000, 3000);
        denied = engine.state.events.some(
          (event) => event.type === 'ACL_DENY' && event.device === router?.id && event.reason.includes('UDP')
        );
      } catch {
        denied = false;
      }
    }
    add('dns-denied', 'Bloquear DNS por ACL, não por ausência de serviço', denied);
  } else if (id === 'rstp-failover') {
    add(
      'rstp',
      'Habilitar RSTP nos três switches',
      switches.length >= 3 &&
        switches.every((device) => device.spanningTree?.enabled && device.spanningTree.mode === 'rstp')
    );
    add(
      'alternate',
      'Manter uma porta alternate bloqueada',
      switches.some((device) =>
        device.interfaces.some(
          (port) => port.spanningTree?.role === 'alternate' && port.spanningTree.state === 'discarding'
        )
      )
    );
    const access = engine.state.devices.find((device) => device.hostname === 'SW-03');
    if (access) {
      engine.setPort(access.id, 'p1', false);
      engine.advanceTo(engine.state.clock + 1000, 3000);
    }
    add(
      'failover',
      'Promover o caminho alternativo após falha',
      !!access &&
        access.interfaces[2].spanningTree?.role === 'root' &&
        access.interfaces[2].spanningTree.state === 'forwarding'
    );
  }
  add(
    'ping',
    id === 'rstp-failover'
      ? 'Validar ping com o uplink indisponível'
      : 'Validar comunicação com tráfego novo',
    ping()
  );
  if (id === 'nat-boundary')
    add(
      'translated',
      'Observar tradução NAT no tráfego de validação',
      engine.state.events.some((event) => event.type === 'NAT_TRANSLATED' && event.device === router?.id)
    );
  const passed = tasks.filter((task) => task.passed).length;
  return { labId: id, tasks, passed, total: tasks.length, complete: passed === tasks.length };
}
