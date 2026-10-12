import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  deviceProfiles,
  makeTemplate,
  validateSnapshot,
  wirelessConfig,
} from '@shlab/engine';
import { duplicateDevice } from '../apps/web/src/workspace/duplicateDevice';

describe('Duplicação de configuração de equipamentos', () => {
  it('duplicar os perfis de fábrica não provisiona serviços, rádios ou eventos', () => {
    const e = new SimulationEngine();
    const originals = deviceProfiles.map((profile) => e.addFactoryProfile(profile.id));
    for (const original of originals) {
      const { device: copy } = duplicateDevice(e, original);
      expect(copy.profile).toBe(original.profile);
      expect(copy.power).toBe(original.power);
      expect(copy.wireless).toBeUndefined();
      expect(copy.tcpServices).toBeUndefined();
      expect(copy.aaaServer).toBeUndefined();
      expect(copy.wlc).toBeUndefined();
      expect(copy.mesh).toBeUndefined();
      expect(copy.ids).toBeUndefined();
      expect(copy.sdwan).toBeUndefined();
      expect(copy.database).toBeUndefined();
      expect(copy.phone).toBeUndefined();
      expect(copy.printer).toBeUndefined();
      expect(copy.broker).toBeUndefined();
      expect(copy.proxy).toBeUndefined();
      expect(copy.interfaces.map((p) => p.mac)).not.toEqual(original.interfaces.map((p) => p.mac));
    }
    e.refreshSpanningTree();
    e.refreshVrrp();
    e.refreshBgp();
    expect(e.state.events).toEqual([]);
    expect(e.state.queue).toEqual([]);
    expect(e.state.links).toEqual([]);
    const snapshot = validateSnapshot(e.snapshot());
    const addresses = snapshot.devices.flatMap((d) => d.interfaces.map((p) => p.mac));
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('o HTTP duplicado responde com o serviço configurado pelo usuário, sem o texto do perfil', () => {
    const e = new SimulationEngine();
    const source = e.addFactoryProfile('web');
    e.setDevicePower(source.id, true);
    Object.assign(source.interfaces[0], { ip: '192.0.2.20', prefix: 24 });
    e.configureTcpService(source.id, { enabled: true, kind: 'http', port: 8081, body: 'Página pessoal' });
    const { device: copy } = duplicateDevice(e, source);
    expect(copy.interfaces[0].ip).toBeUndefined();
    Object.assign(copy.interfaces[0], { ip: '192.0.2.21', prefix: 24 });
    const pc = e.addDevice('pc');
    Object.assign(pc.interfaces[0], { ip: '192.0.2.10', prefix: 24 });
    e.connect({ device: pc.id, port: 'p0' }, { device: copy.id, port: 'p0' });
    const id = e.httpGet(pc.id, '192.0.2.21', 8081);
    e.advanceTo(1000);
    expect(pc.tcpConnections!.find((c) => c.id === id)!.received).toContain('Página pessoal');
    expect(copy.tcpServices).toEqual(source.tcpServices);
    validateSnapshot(e.snapshot());
  });

  it('rádio configurado mantém o SSID escolhido e reinicia associação e contadores', () => {
    const e = new SimulationEngine();
    const source = e.addFactoryProfile('ap');
    e.configureWireless(source.id, { ...wirelessConfig(source), ssid: 'Rede pessoal', channel: 11 });
    source.interfaces[0].tx = 80;
    const { device: copy } = duplicateDevice(e, source);
    expect(copy.wireless!.ssid).toBe('Rede pessoal');
    expect(copy.wireless!.channel).toBe(11);
    expect(copy.wireless!.token).not.toBe(source.wireless!.token);
    expect(copy.wireless!.association).toBeUndefined();
    expect(copy.wireless!.peers).toEqual([]);
    expect(copy.interfaces.every((p) => p.rx === 0 && p.tx === 0 && p.errors === 0)).toBe(true);
    validateSnapshot(e.snapshot());
  });

  it('serviços específicos preservam parâmetros explícitos e iniciam runtime separado', () => {
    const e = new SimulationEngine();
    const phone = e.addFactoryProfile('phone');
    e.configurePhone(phone.id, {
      enabled: false,
      number: 'Custom-22',
      sipPort: 5070,
      rtpPort: 22000,
      autoAnswer: false,
    });
    const printer = e.addFactoryProfile('printer');
    e.configurePrinter(printer.id, { enabled: false, port: 6631, pagesPerMinute: 12, paper: 47 });
    const broker = e.addFactoryProfile('mqtt');
    e.configureBroker(broker.id, { enabled: false, port: 2883 });
    const proxy = e.addFactoryProfile('load-balancer');
    e.configureProxy(proxy.id, {
      enabled: true,
      kind: 'load-balancer',
      port: 8085,
      algorithm: 'least-connections',
      backends: [{ address: '192.0.2.50', port: 8080 }],
      allowedNetworks: [],
      healthIntervalMs: 12000,
    });
    const database = e.addFactoryProfile('database');
    e.configureDatabase(database.id, { enabled: false, port: 9080, key: 'personal-database-key' });
    database.database!.tables = [{ name: 'items', columns: ['value'], rows: [{ value: 22 }] }];
    database.database!.queries = 23;
    const ids = e.addFactoryProfile('ids');
    e.configureIds(ids.id, {
      enabled: false,
      mode: 'ips',
      rules: [
        { id: 'custom-rule', name: 'Regra pessoal', protocol: 'TCP', pattern: 'blocked', action: 'drop' },
      ],
    });
    const [phoneCopy, printerCopy, brokerCopy, proxyCopy, dbCopy, idsCopy] = [
      phone,
      printer,
      broker,
      proxy,
      database,
      ids,
    ].map((d) => duplicateDevice(e, d).device);
    expect(phoneCopy.phone).toMatchObject({
      enabled: false,
      number: 'Custom-22',
      sipPort: 5070,
      rtpPort: 22000,
      autoAnswer: false,
      calls: [],
    });
    expect(printerCopy.printer).toMatchObject({
      enabled: false,
      port: 6631,
      pagesPerMinute: 12,
      paper: 47,
      jobs: [],
    });
    expect(brokerCopy.broker).toMatchObject({ enabled: false, port: 2883, clients: [] });
    expect(proxyCopy.proxy).toMatchObject({
      enabled: true,
      kind: 'load-balancer',
      port: 8085,
      algorithm: 'least-connections',
      healthIntervalMs: 12000,
      requests: [],
    });
    expect(proxyCopy.proxy!.token).not.toBe(proxy.proxy!.token);
    expect(dbCopy.database).toMatchObject({
      enabled: false,
      port: 9080,
      key: 'personal-database-key',
      tables: database.database!.tables,
      queries: 0,
    });
    expect(idsCopy.ids).toMatchObject({
      enabled: false,
      mode: 'ips',
      rules: ids.ids!.rules,
      alerts: [],
      dropped: 0,
    });
    expect(dbCopy.database!.tables).not.toBe(database.database!.tables);
    validateSnapshot(e.snapshot());
  });

  it('capacidade e infraestrutura física são preservadas sem eventos de provisionamento', () => {
    const e = new SimulationEngine();
    const source = e.addFactoryProfile('core');
    Object.assign(source.system!, {
      capacityPps: 275000,
      memoryLimitKiB: 90000,
      ambientC: 25,
      processed: 90,
      cpuPercent: 80,
    });
    const rack = e.addFactoryProfile('rack');
    if (rack.infrastructure?.kind !== 'rack') throw new Error('Rack esperado');
    Object.assign(rack.infrastructure, { units: 36, ambientC: 24, ventilation: 0.7 });
    const copy = duplicateDevice(e, source).device;
    const rackCopy = duplicateDevice(e, rack).device;
    expect(copy.system).toMatchObject({
      capacityPps: 275000,
      memoryLimitKiB: 90000,
      ambientC: 25,
      processed: 0,
      cpuPercent: 0,
      temperatureC: 25,
    });
    expect(rackCopy.infrastructure).toMatchObject({
      kind: 'rack',
      units: 36,
      ambientC: 24,
      ventilation: 0.7,
      slots: [],
    });
    expect(e.state.events).toEqual([]);
    expect(e.state.queue).toEqual([]);
    validateSnapshot(e.snapshot());
  });

  it('perfis previamente provisionados duplicam sem receber configurações demonstrativas novas', () => {
    const e = new SimulationEngine();
    const originals = deviceProfiles.map((profile) => e.addProfile(profile.id));
    for (const original of originals) duplicateDevice(e, original);
    validateSnapshot(e.snapshot());
  });

  it('WLC e SD-WAN duplicados conservam configuração sem sessões enquanto aguardam endereço próprio', () => {
    for (const role of ['wlc', 'sdwan'] as const) {
      const e = role === 'wlc' ? new SimulationEngine() : new SimulationEngine(makeTemplate('sdwan'));
      const source = role === 'wlc' ? e.addProfile('wlc') : e.state.devices.find((d) => !!d.sdwan)!;
      if (source.wlc) {
        Object.assign(source.interfaces[0], { ip: '192.0.2.20', prefix: 24 });
        e.configureWlc(source.id, {
          enabled: true,
          underlay: 'p0',
          key: source.wlc.key,
          allowedWtps: [],
          profiles: source.wlc.profiles,
        });
      }
      const copy = duplicateDevice(e, source).device;
      if (source.wlc) {
        expect(copy.wlc).toMatchObject({
          enabled: false,
          key: source.wlc.key,
          profiles: source.wlc.profiles,
          sessions: [],
        });
      }
      if (source.sdwan) {
        expect(copy.sdwan).toMatchObject({
          enabled: false,
          site: source.sdwan.site,
          policies: source.sdwan.policies,
          selected: [],
          requests: 0,
        });
      }
      validateSnapshot(e.snapshot());
    }
  });
});
