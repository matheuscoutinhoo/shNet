import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  deviceProfiles,
  makeTemplate,
  linkOperational,
  validateSnapshot,
  wirelessConfig,
} from '@shlab/engine';
import {
  deviceCapabilities,
  deviceIntegrityIssues,
  inspectorTabIds,
} from '../apps/web/src/workspace/deviceCapabilities';

describe('Equipamentos de fábrica no canvas', () => {
  it('todo o catálogo começa sem provisionamento, eventos ou atividades de protocolo', () => {
    const e = new SimulationEngine();
    const devices = deviceProfiles.map((profile) => e.addFactoryProfile(profile.id));
    e.refreshSpanningTree();
    e.refreshVrrp();
    e.refreshBgp();
    expect(e.state.events).toEqual([]);
    expect(e.state.queue).toEqual([]);
    expect(e.state.links).toEqual([]);
    e.advanceTo(5000);
    expect(e.state.events).toEqual([]);
    const persisted = validateSnapshot(JSON.parse(JSON.stringify(e.snapshot())));
    expect(persisted.devices).toHaveLength(deviceProfiles.length);
    const addresses = persisted.devices.flatMap((d) => d.interfaces.map((p) => p.mac));
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const d of devices) {
      expect(deviceIntegrityIssues(d), d.profile).toEqual([]);
      expect(d.power, d.profile).toBe(['rack', 'patch-panel'].includes(d.profile!));
      expect(d.routes, d.profile).toEqual([]);
      expect(d.arpTable, d.profile).toEqual([]);
      expect(d.macTable, d.profile).toEqual([]);
      expect(d.logs, d.profile).toEqual([]);
      expect(d.gateway, d.profile).toBeUndefined();
      for (const key of [
        'wireless',
        'mesh',
        'wlc',
        'wtp',
        'dnsServer',
        'dhcpServer',
        'dhcp6Server',
        'tcpServices',
        'firewall',
        'ids',
        'phone',
        'printer',
        'broker',
        'proxy',
        'database',
        'aaaServer',
        'remoteManagement',
        'sdwan',
        'sdwanController',
        'telemetryCollector',
        'syslogServer',
        'networkClock',
        'spanningTree',
      ] as const) {
        expect(d[key], d.profile + ': ' + key).toBeUndefined();
      }
      for (const port of d.interfaces) {
        expect(port.ip, d.profile).toBeUndefined();
        expect(port.ipv6, d.profile).toBeUndefined();
        expect(port.gateway, d.profile).toBeUndefined();
        expect(port.dhcp, d.profile).toBeUndefined();
        expect(port.dhcp6, d.profile).toBeUndefined();
        expect(port.rx + port.tx + port.errors, d.profile).toBe(0);
      }
    }
    expect(persisted.devices.find((d) => d.profile === 'smartphone')!.interfaces.map((p) => p.media)).toEqual(
      ['wifi']
    );
    expect(
      persisted.devices.find((d) => d.profile === 'core')!.interfaces.every((p) => p.media === 'qsfp')
    ).toBe(true);
    expect(persisted.devices.find((d) => d.profile === 'patch-panel')!.infrastructure).toEqual({
      kind: 'patch-panel',
      pairs: [],
    });
  });

  it('os recursos do perfil permanecem disponíveis para a primeira configuração', () => {
    const e = new SimulationEngine();
    for (const id of ['ap', 'mesh', 'laptop', 'smartphone'])
      expect(inspectorTabIds(e.addFactoryProfile(id)), id).toContain('wireless');
    for (const id of ['wlc', 'sdwan-controller', 'database'])
      expect(inspectorTabIds(e.addFactoryProfile(id)), id).toContain(
        { wlc: 'advancedNetwork', 'sdwan-controller': 'sdwanController', database: 'database' }[id]
      );
    for (const [id, kind] of [
      ['phone', 'phone'],
      ['printer', 'printer'],
      ['mqtt', 'broker'],
      ['proxy', 'proxy'],
      ['load-balancer', 'proxy'],
    ] as const) {
      expect(deviceCapabilities(e.addFactoryProfile(id)).applicationKinds, id).toEqual([kind]);
    }
    expect(deviceCapabilities(e.addFactoryProfile('dns')).dnsServer).toBe(true);
    expect(deviceCapabilities(e.addFactoryProfile('dhcp')).dhcpServer).toBe(true);
    expect(deviceCapabilities(e.addFactoryProfile('syslog')).syslogServer).toBe(true);
    expect(deviceCapabilities(e.addFactoryProfile('snmp')).remoteKinds).toContain('collector');
  });

  it('adicionar rádios não configurados não altera associações, links ou timers existentes', () => {
    const e = new SimulationEngine();
    const ap = e.addProfile('ap', { x: 200, y: 200 });
    const client = e.addProfile('laptop', { x: 240, y: 200 });
    e.advanceTo(5000);
    expect(client.wireless!.phase).toBe('associated');
    const before = e.snapshot();
    const added = ['ap', 'mesh', 'laptop', 'smartphone'].map((id) => e.addFactoryProfile(id));
    e.refreshSpanningTree();
    e.refreshVrrp();
    e.refreshBgp();
    expect(e.state.events).toEqual(before.events);
    expect(e.state.links).toEqual(before.links);
    expect(e.state.queue).toEqual(before.queue);
    expect(ap.wireless).toEqual(before.devices[0].wireless);
    expect(client.wireless).toEqual(before.devices[1].wireless);
    e.advanceTo(10000);
    expect(e.state.events.filter((event) => added.some((d) => event.device === d.id))).toEqual([]);
    expect(
      e.state.links.some((link) => added.some((d) => [link.a.device, link.b.device].includes(d.id)))
    ).toBe(false);
    validateSnapshot(e.snapshot());
  });

  it.each(['rstp', 'vrrp', 'bgp'] as const)(
    'adição não modifica protocolos provisionados no lab %s',
    (template) => {
      const e = new SimulationEngine(makeTemplate(template));
      e.advanceTo(5000);
      e.refreshSpanningTree();
      e.refreshVrrp();
      e.refreshBgp();
      const before = e.snapshot();
      const fresh = e.addFactoryProfile('switch-l3');
      e.refreshSpanningTree();
      e.refreshVrrp();
      e.refreshBgp();
      expect(e.state.events).toEqual(before.events);
      expect(e.state.queue).toEqual(before.queue);
      expect(e.state.devices.slice(0, -1)).toEqual(before.devices);
      expect(fresh.ipRouting).toBeUndefined();
      expect(fresh.ipv6Routing).toBeUndefined();
      validateSnapshot(e.snapshot());
    }
  );

  it('hardware novo transmite HTTP somente após o usuário ligar, endereçar e habilitar o serviço', () => {
    const e = new SimulationEngine();
    const pc = e.addFactoryProfile('desktop');
    const server = e.addFactoryProfile('web');
    const cable = e.connect({ device: pc.id, port: 'p0' }, { device: server.id, port: 'p0' });
    expect(linkOperational(e.state, cable)).toBe(false);
    expect(server.tcpServices).toBeUndefined();
    expect(() => e.httpGet(pc.id, '192.0.2.20')).toThrow('TCP exige stack IP ligada.');
    for (const device of [pc, server]) e.setDevicePower(device.id, true);
    expect(linkOperational(e.state, cable)).toBe(true);
    Object.assign(pc.interfaces[0], { ip: '192.0.2.10', prefix: 24 });
    Object.assign(server.interfaces[0], { ip: '192.0.2.20', prefix: 24 });
    const disabledRequest = e.httpGet(pc.id, '192.0.2.20');
    e.advanceTo(1000);
    expect(pc.tcpConnections!.find((c) => c.id === disabledRequest)!.state).toBe('RESET');
    e.configureTcpService(server.id, {
      enabled: true,
      kind: 'http',
      port: 80,
      body: 'Configurado pelo usuário',
    });
    const id = e.httpGet(pc.id, '192.0.2.20');
    e.advanceTo(2000);
    expect(pc.tcpConnections!.find((c) => c.id === id)!.received).toContain('Configurado pelo usuário');
    validateSnapshot(e.snapshot());
  });

  it('rádio de fábrica pode ser configurado; um rádio órfão fora do perfil continua inválido', () => {
    const e = new SimulationEngine();
    const ap = e.addFactoryProfile('ap', { x: 200, y: 200 });
    const client = e.addFactoryProfile('smartphone', { x: 240, y: 200 });
    for (const d of [ap, client]) {
      e.setDevicePower(d.id, true);
      e.configureWireless(d.id, { ...wirelessConfig(d), ssid: 'Usuário' });
    }
    e.advanceTo(5000);
    expect(client.wireless!.phase).toBe('associated');
    validateSnapshot(e.snapshot());
    const unconfigured = new SimulationEngine();
    const invalid = unconfigured.addFactoryProfile('ap');
    invalid.profile = 'switch-l2';
    expect(() => validateSnapshot(unconfigured.snapshot())).toThrow(/Rádio sem configuração/);
  });

  it('demonstrações provisionadas e os modelos genéricos existentes mantêm seus defaults', () => {
    const e = new SimulationEngine();
    expect(e.addProfile('web').tcpServices?.[0]?.enabled).toBe(true);
    expect(e.addProfile('laptop').wireless?.enabled).toBe(true);
    expect(e.addProfile('patch-panel').infrastructure?.kind).toBe('patch-panel');
    expect(e.addDevice('pc').power).toBe(true);
    const factory = new SimulationEngine();
    for (const type of ['pc', 'server', 'switch', 'router'] as const)
      expect(factory.addFactoryDevice(type).power).toBe(false);
    expect(factory.state.events).toEqual([]);
    expect(factory.state.queue).toEqual([]);
    validateSnapshot(factory.snapshot());
  });
});
