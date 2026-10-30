import {
  deviceProfiles,
  wirelessConfig,
  qosConfig,
  remoteConfig,
  aaaServerConfig,
  ntpConfig,
  sdwanConfig,
  plcProcessConfig,
  hmiScanConfig,
  hsrpConfig,
  discoveryConfig,
  type Device,
  type SimulationEngine,
} from '@shlab/engine';
import { scheduleMonitoring } from '../../../../packages/simulation-engine/src/protocols/monitoring';
import { configureUdld } from '../../../../packages/simulation-engine/src/protocols/udld';
import { configureBfd } from '../../../../packages/simulation-engine/src/protocols/bfd';

/** Duplicate explicit configuration, without synthesizing profile demonstrations. */
export function duplicateDevice(e: SimulationEngine, d: Device) {
  const position = { x: d.position.x + 50, y: d.position.y + 80 };
  const copy =
    d.profile && deviceProfiles.some((profile) => profile.id === d.profile)
      ? e.addFactoryProfile(d.profile, position)
      : e.addFactoryDevice(d.type, position);
  copy.profile = d.profile;
  copy.enableSecret = d.enableSecret;
  if (d.modbus) copy.modbus = structuredClone(d.modbus);
  copy.power = d.power;
  if (copy.bootManaged && copy.power) copy.booted = true;
  copy.hostname = d.hostname.slice(0, 24) + '-copy';
  let suffix = 2;
  while (e.state.devices.some((other) => other.id !== copy.id && other.hostname === copy.hostname))
    copy.hostname = d.hostname.slice(0, 22) + '-copy' + suffix++;
  copy.ipRouting = d.ipRouting;
  copy.ipv6Routing = d.ipv6Routing;
  copy.loopGuardDefault = d.loopGuardDefault;
  if(d.keyChains)copy.keyChains=structuredClone(d.keyChains);
  if(d.bfdTemplates)copy.bfdTemplates=structuredClone(d.bfdTemplates);
  copy.dot1xSystemAuthControl = d.dot1xSystemAuthControl;
  if (d.iosSystem)
    copy.iosSystem = {
      ...structuredClone(d.iosSystem),
      ...(d.iosSystem.archive ? { archive: { ...d.iosSystem.archive, copies: [] } } : {}),
    };
  if (d.routingPolicy) copy.routingPolicy = structuredClone(d.routingPolicy);
  if (d.mqc) copy.mqc = structuredClone(d.mqc);
  if (d.system)
    copy.system = {
      ...structuredClone(d.system),
      windowAt: e.state.clock,
      work: 0,
      processed: 0,
      nextReadyAt: e.state.clock,
      lastAt: e.state.clock,
      cpuPercent: 0,
      memoryKiB: 64,
      temperatureC: d.system.ambientC,
      throttled: false,
    };
  if (d.infrastructure) {
    copy.infrastructure = structuredClone(d.infrastructure);
    if (copy.infrastructure.kind === 'rack') copy.infrastructure.slots = [];
    if (copy.infrastructure.kind === 'ups') {
      copy.infrastructure.loads = [];
      copy.infrastructure.lastAt = e.state.clock;
      copy.infrastructure.output =
        copy.power && (copy.infrastructure.mains || copy.infrastructure.remainingWh > 0);
    }
  }
  if (d.wireless) e.configureWireless(copy.id, wirelessConfig(d));
  copy.vrfs = structuredClone(d.vrfs);
  const physical = copy.interfaces;
  const sourcePorts = d.interfaces.filter((p) => !p.capwapPeer && !p.meshPeer);
  const portMapping = new Map(
    sourcePorts.map((p, i) => [
      p.id,
      p.logical
        ? e.id('interface')
        : p.aggregate || p.bond || p.tunnel || p.vxlan
          ? p.id
          : (physical[i]?.id ?? p.id),
    ])
  );
  copy.interfaces = sourcePorts.map((p, i) => ({
    ...structuredClone(p),
    id: portMapping.get(p.id)!,
    mac: p.bond
      ? physical[0].mac.split(':').slice(0, 4).join(':') +
        ':07:' +
        p.bond.number.toString(16).padStart(2, '0')
      : p.aggregate
        ? physical[0].mac.split(':').slice(0, 4).join(':') +
          ':02:' +
          p.aggregate.number.toString(16).padStart(2, '0')
        : p.vxlan
          ? physical[0].mac.split(':').slice(0, 4).join(':') + ':05:' + i.toString(16).padStart(2, '0')
          : p.tunnel
            ? physical[0].mac.split(':').slice(0, 4).join(':') +
              ':04:' +
              p.tunnel.number.toString(16).padStart(2, '0')
            : p.logical
              ? physical[0].mac.split(':').slice(0, 4).join(':') + ':01:' + i.toString(16).padStart(2, '0')
              : (physical[i]?.mac ?? physical[0].mac.slice(0, -2) + i.toString(16).padStart(2, '0')),
    ...(p.logical
      ? {
          logical: {
            ...p.logical,
            ...(p.logical.parent ? { parent: portMapping.get(p.logical.parent)! } : {}),
          },
        }
      : {}),
    rx: 0,
    tx: 0,
    errors: 0,
  }));
  const reserved = new Set(e.state.devices.flatMap((d) => d.interfaces.flatMap((p) => (p.ip ? [p.ip] : []))));
  let addressIndex = 1;
  const isolatedAddress = () => {
    while (addressIndex < 65535) {
      const ip = `10.255.${addressIndex >> 8}.${addressIndex++ & 255}`;
      if (!reserved.has(ip)) {
        reserved.add(ip);
        return ip;
      }
    }
    throw new Error('Sem endereço livre para o transporte isolado do clone.');
  };
  const transports = new Set(
    sourcePorts.flatMap((p) => (p.vxlan ? [portMapping.get(p.vxlan.underlay)!] : []))
  );
  copy.interfaces.forEach((p) => {
    if (p.dot1x) p.accessVlan = p.dot1x.baseVlan;
    delete p.dot1x;
    delete p.authenticationControl;
    if (p.udld) configureUdld(e, copy, p, p.udld.mode);
    if (p.bfd) configureBfd(e, copy, p, p.bfd);
    delete p.supplicant;
    delete p.ip;
    delete p.prefix;
    if (p.loopback || transports.has(p.id)) {
      p.ip = isolatedAddress();
      p.prefix = 32;
    }
    delete p.gateway;
    delete p.dns;
    delete p.dhcp;
    delete p.dhcpRelay;
    delete p.spanningTree;
    delete p.spanningInstances;
    delete p.mstBoundary;
    delete p.errDisabled;
    if (p.portSecurity) {
      p.portSecurity.learned = [];
      p.portSecurity.violations = 0;
    }
    delete p.ipv6;
    delete p.dhcp6;
    delete p.dhcp6Relay;
    if (p.qos) {
      const c = qosConfig(p);
      delete p.qos;
      e.configureQos(copy.id, p.id, c);
    }
    if (p.vxlan)
      p.vxlan = {
        ...p.vxlan,
        enabled: false,
        underlay: portMapping.get(p.vxlan.underlay)!,
        local: [],
        routes: [],
        learned: [],
        sent: 0,
        received: 0,
      };
    if (p.tunnel) {
      p.ip = p.tunnel.ip;
      p.prefix = p.tunnel.prefix;
      p.tunnel = {
        ...p.tunnel,
        enabled: false,
        underlay: portMapping.get(p.tunnel.underlay)!,
        status: 'down',
        token: e.id('tunnel'),
        tickAt: e.state.clock + 0.001,
        samples: [],
        remotePrefixes: [],
        txSequence: 0,
        receivedSequences: [],
        sent: 0,
        received: 0,
        lastRx: undefined,
        peerNonce: undefined,
        peerEndpoint: undefined,
        pending: undefined,
      };
      e.schedule(0.001, { kind: 'tunnel-tick', device: copy.id, port: p.id, token: p.tunnel.token });
    }
    if (p.aggregate) {
      p.aggregate = {
        ...p.aggregate,
        members: p.aggregate.members.map((id) => portMapping.get(id)!),
        received: [],
        selected: [],
        token: e.id('lacp'),
        tickAt: e.state.clock + 0.001,
      };
      e.schedule(0.001, { kind: 'lacp-tick', device: copy.id, port: p.id, token: p.aggregate.token });
    }
    if (p.bond) {
      p.bond = {
        ...p.bond,
        members: p.bond.members.map((id) => portMapping.get(id)!),
        primary: portMapping.get(p.bond.primary)!,
        active: undefined,
        startedAt: e.state.clock,
        nextProbeAt: e.state.clock,
        health: p.bond.members.map((id) => ({ port: portMapping.get(id)! })),
        token: e.id('bond'),
        tickAt: e.state.clock + 100,
        announcements: 0,
        announceAt: e.state.clock,
      };
      e.schedule(100, { kind: 'bond-tick', device: copy.id, port: p.id, token: p.bond.token });
    }
    if (p.ipv4Mode === 'dhcp') e.requestDhcp(copy.id, p.id);
  });
  copy.vlans = structuredClone(d.vlans);
  copy.routes = structuredClone(d.routes).map((route) => ({
    ...route,
    ...(route.port ? { port: portMapping.get(route.port)! } : {}),
  }));
  if (d.monitoring) {
    copy.monitoring = {
      token: e.id('monitor'),
      operations: d.monitoring.operations.map((o) => ({
        id: o.id,
        target: o.target,
        sourcePort: o.sourcePort ? portMapping.get(o.sourcePort) : undefined,
        timeoutMs: o.timeoutMs,
        frequencyMs: o.frequencyMs,
        scheduled: o.scheduled,
        status: 'unknown',
      })),
      tracks: d.monitoring.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        operation: t.operation,
        port: t.port ? portMapping.get(t.port) : undefined,
        state: false,
        changedAt: e.state.clock,
      })),
    };
    scheduleMonitoring(e, copy);
  }
  if (d.discovery&&!d.phone) e.configureDiscovery(copy.id, discoveryConfig(d));
  if (d.hsrp)
    e.configureHsrp(copy.id, {
      groups: hsrpConfig(d).map((g) => ({
        ...g,
        port: portMapping.get(g.port)!,
        vip: undefined,
        track: g.track.map((t) => ({ ...t, port: portMapping.get(t.port)! })),
      })),
    });
  if (copy.infrastructure?.kind === 'patch-panel')
    copy.infrastructure.pairs = copy.infrastructure.pairs.map((pair) => ({
      a: portMapping.get(pair.a)!,
      b: portMapping.get(pair.b)!,
    }));
  if (d.accessLists)
    copy.accessLists = structuredClone(d.accessLists).map((acl) => ({
      ...acl,
      implicitDrops: 0,
      rules: acl.rules.map((rule) => ({ ...rule, hits: 0 })),
    }));
  if (d.dnsServer) copy.dnsServer = structuredClone(d.dnsServer);
  if (d.tcpServices)
    copy.tcpServices = structuredClone(d.tcpServices).filter(
      (service) => !['database', 'proxy', 'load-balancer', 'ipp', 'mqtt'].includes(service.kind)
    );
  if (d.udp6Services) copy.udp6Services = structuredClone(d.udp6Services);
  if (d.firewall) {
    copy.firewall = { ...structuredClone(d.firewall), sessions: [], dropped: 0 };
    // A duplicate must not join the original HA pair until explicitly configured.
    delete copy.stateSync;
    if (copy.firewall.application) copy.firewall.application.flows = [];
    copy.firewall.trustedPorts = copy.firewall.trustedPorts.map((p) => portMapping.get(p)!);
    if (copy.firewall.zonePolicy)
      copy.firewall.zonePolicy.zones.forEach((zone) => {
        zone.ports = zone.ports.map((p) => portMapping.get(p)!);
      });
  }
  if (d.remoteManagement) e.configureRemote(copy.id, remoteConfig(d));
  if (d.networkClock) e.configureClock(copy.id, structuredClone(d.networkClock));
  if (d.telemetryCollector)
    e.configureCollector(copy.id, {
      enabled: d.telemetryCollector.enabled,
      key: d.telemetryCollector.key,
    });
  if (d.snmpAgent) copy.snmpAgent = { ...structuredClone(d.snmpAgent), startedAt: e.state.clock };
  if (d.syslogClient) copy.syslogClient = structuredClone(d.syslogClient);
  if (d.syslogServer) copy.syslogServer = { enabled: d.syslogServer.enabled, entries: [] };
  if (d.tcpSettings) copy.tcpSettings = structuredClone(d.tcpSettings);
  if (d.dhcpServer)
    // Address-dependent pools must be rebuilt after the duplicate receives its own IP.
    copy.dhcpServer = { enabled: d.dhcpServer.enabled, pools: [], bindings: [] };
  if (d.aaaServer) e.configureAaaServer(copy.id, aaaServerConfig(d));
  if (d.aaaClient) e.configureAaaClient(copy.id, structuredClone(d.aaaClient));
  if (d.ntp) e.configureNtp(copy.id, ntpConfig(d));
  if (d.phone)
    e.configurePhone(copy.id, {
      enabled: d.phone.enabled,
      number: d.phone.number,
      sipPort: d.phone.sipPort,
      rtpPort: d.phone.rtpPort,
      autoAnswer: d.phone.autoAnswer,
      autoVoiceVlan:d.phone.autoVoiceVlan,
    });
  if(d.phone&&d.discovery)e.configureDiscovery(copy.id,discoveryConfig(d));
  if (d.printer)
    e.configurePrinter(copy.id, {
      enabled: d.printer.enabled,
      port: d.printer.port,
      pagesPerMinute: d.printer.pagesPerMinute,
      paper: d.printer.paper,
    });
  if (d.broker) e.configureBroker(copy.id, { enabled: d.broker.enabled, port: d.broker.port });
  if (d.proxy)
    e.configureProxy(copy.id, {
      enabled: d.proxy.enabled,
      kind: d.proxy.kind,
      port: d.proxy.port,
      algorithm: d.proxy.algorithm,
      backends: structuredClone(d.proxy.backends),
      allowedNetworks: structuredClone(d.proxy.allowedNetworks),
      healthIntervalMs: d.proxy.healthIntervalMs,
    });
  if (d.database) {
    e.configureDatabase(copy.id, {
      enabled: d.databaseHa ? false : d.database.enabled,
      port: d.database.port,
      key: d.database.key,
    });
    copy.database!.tables = d.databaseHa ? [] : structuredClone(d.database.tables);
  }
  if (d.ids)
    e.configureIds(copy.id, {
      enabled: d.ids.enabled,
      mode: d.ids.mode,
      rules: structuredClone(d.ids.rules),
    });
  if (d.wlc)
    e.configureWlc(copy.id, {
      enabled: false,
      underlay: portMapping.get(d.wlc.underlay)!,
      key: d.wlc.key,
      allowedWtps: structuredClone(d.wlc.allowedWtps),
      profiles: structuredClone(d.wlc.profiles),
    });
  if (d.wtp) {
    copy.wtp = {
      enabled: false,
      underlay: portMapping.get(d.wtp.underlay)!,
      controller: d.wtp.controller,
      key: d.wtp.key,
      profile: d.wtp.profile,
      token: e.id('wtp'),
      nextAt: e.state.clock + 1000,
      session: e.id('capwap-session'),
      nonce: e.id('wtp-nonce'),
      secret: d.wtp.secret,
      phase: 'DISCOVERY',
      lastAt: e.state.clock,
      txSequence: 0,
      receivedSequences: [],
      attempts: 0,
    };
    e.schedule(1000, { kind: 'capwap-tick', device: copy.id, role: 'wtp', token: copy.wtp.token });
  }
  if (d.mesh)
    e.configureMesh(copy.id, {
      enabled: d.mesh.enabled,
      meshId: d.mesh.meshId,
      key: d.mesh.key,
      root: d.mesh.root,
      priority: d.mesh.priority,
      maxDistance: d.mesh.maxDistance,
    });
  if (d.sdwanController) e.configureSdwanController(copy.id, structuredClone(d.sdwanController));
  if (d.sdwan) {
    copy.sdwan = {
      ...sdwanConfig(d),
      enabled: false,
      ...(d.sdwan.underlay ? { underlay: portMapping.get(d.sdwan.underlay)! } : {}),
      receivedPolicies: [],
      token: e.id('sdwan'),
      tickAt: e.state.clock + 0.001,
      requests: 0,
      selected: [],
    };
    e.schedule(0.001, { kind: 'sdwan-tick', device: copy.id, token: copy.sdwan.token });
  }
  if (d.multiSpanningTree)
    e.configureMultiSpanningTree(copy.id, {
      mode: d.multiSpanningTree.mode,
      protocol: d.multiSpanningTree.protocol,
      region: d.multiSpanningTree.region,
      revision: d.multiSpanningTree.revision,
      priorities: d.multiSpanningTree.priorities,
      mappings: d.multiSpanningTree.mappings,
    });
  else if (d.spanningTree?.enabled)
    e.configureSpanningTree(copy.id, d.spanningTree.mode, d.spanningTree.priority);
  if (d.plcProcess)
    e.configurePlcProcess(copy.id, {
      ...plcProcessConfig(d),
      initialLevel: Math.round(d.plcProcess.levelMilli / 1000),
    });
  if (d.hmiScan) e.configureHmiScan(copy.id, { ...hmiScanConfig(d), enabled: false });
  return { device: copy, portMapping };
}
