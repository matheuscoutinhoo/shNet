import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  deviceCommandHelp,
  deviceProfiles,
  inspectorTabIds,
  wirelessConfig,
  validateSnapshot,
} from '@shlab/engine';

describe('Terminais por função do equipamento', () => {
  it('exemplos de configuração são válidos nos perfis que os oferecem', () => {
    for (const profile of deviceProfiles) {
      const e = new SimulationEngine(),
        d = e.addFactoryProfile(profile.id),
        cli = new TerminalSession(e, d.id);
      if (d.interfaces[0]?.mode === 'routed')
        Object.assign(d.interfaces[0], { ip: '192.168.10.20', prefix: 24 });
      const examples = deviceCommandHelp(d, cli.context).filter((entry) =>
        / configure |^service |^dns record |^ip dhcp pool /.test(entry.example)
      );
      cli.execute('enable');
      cli.execute('configure terminal');
      for (const entry of examples)
        expect(cli.execute(entry.example), profile.id + ': ' + entry.example).not.toMatch(/^%/);
    }
  });
  it.each(deviceProfiles)('$id anuncia somente exemplos reconhecidos pelo terminal', (profile) => {
    const e = new SimulationEngine(),
      d = e.addFactoryProfile(profile.id),
      cli = new TerminalSession(e, d.id);
    for (const entry of deviceCommandHelp(d, cli.context)) {
      expect(cli.execute(entry.example), profile.id + ': ' + entry.example).not.toMatch(
        /Comando não reconhecido|Este comando não se aplica|Invalid input detected at '\^' marker/
      );
    }
    validateSnapshot(e.snapshot());
  });
  it('laptop configura IP e enlace com comandos de host, sem criar VLANs ou roteamento dinâmico', () => {
    const e = new SimulationEngine(),
      d = e.addProfile('laptop'),
      cli = new TerminalSession(e, d.id);
    const port = d.interfaces.find((p) => p.media === 'rj45')!;
    expect(cli.prompt).toBe(d.hostname + '$');
    expect(cli.execute(`ip addr add 192.0.2.10/24 dev ${port.name}`)).toBe('OK');
    expect(e.device(d.id).interfaces.find((p) => p.id === port.id)?.ip).toBe('192.0.2.10');
    expect(cli.execute('ip route add default via 192.0.2.1')).toBe('OK');
    expect(cli.execute('ipconfig /all')).toContain('Gateway: 192.0.2.1');
    expect(cli.execute(`ip link set dev ${port.name} down`)).toBe('OK');
    expect(e.device(d.id).interfaces.find((p) => p.id === port.id)?.adminUp).toBe(false);
    const before = e.snapshot();
    for (const command of [
      'vlan 20',
      'show spanning-tree',
      'router ospf 1.1.1.1',
      'wireless ap ssid Campus security open channel 6',
      'printer configure {}',
    ]) {
      expect(cli.execute(command)).toContain('não se aplica');
      expect(e.snapshot()).toEqual(before);
    }
  });
  it('dois hosts usam IPs locais e ping real pelo switch', () => {
    const e = new SimulationEngine(),
      a = e.addProfile('desktop'),
      b = e.addProfile('desktop'),
      sw = e.addProfile('switch-l2');
    e.connect({ device: a.id, port: 'p0' }, { device: sw.id, port: 'p0' });
    e.connect({ device: b.id, port: 'p0' }, { device: sw.id, port: 'p1' });
    const ca = new TerminalSession(e, a.id),
      cb = new TerminalSession(e, b.id);
    expect(ca.execute(`ip addr add 192.0.2.10/24 dev ${a.interfaces[0].name}`)).toBe('OK');
    expect(cb.execute(`ip addr add 192.0.2.20/24 dev ${b.interfaces[0].name}`)).toBe('OK');
    ca.execute('ping 192.0.2.20');
    e.run();
    expect(e.state.probes.at(-1)?.status).toBe('success');
  });
  it('consultas de host não emitem eventos de mudança de configuração', () => {
    const e = new SimulationEngine(),
      d = e.addProfile('laptop'),
      cli = new TerminalSession(e, d.id);
    const count = e.state.events.filter((event) => event.type === 'CONFIG_CHANGED').length;
    for (const command of [
      'ipconfig',
      'ipconfig /all',
      'ip addr show',
      'ip link show',
      'ip route show',
      'route print',
      'arp -a',
      'wifi scan',
    ])
      cli.execute(command);
    expect(e.state.events.filter((event) => event.type === 'CONFIG_CHANGED')).toHaveLength(count);
  });
  it('ipconfig renew e release percorrem a negociação DHCP real', () => {
    const e = new SimulationEngine(),
      d = e.addProfile('desktop'),
      server = e.addProfile('dhcp'),
      cli = new TerminalSession(e, d.id);
    Object.assign(server.interfaces[0], { ip: '192.0.2.1', prefix: 24 });
    e.connect({ device: d.id, port: 'p0' }, { device: server.id, port: 'p0' });
    e.configureDhcpPool(server.id, {
      name: 'Hosts',
      port: 'p0',
      network: '192.0.2.0',
      prefix: 24,
      start: '192.0.2.10',
      end: '192.0.2.20',
      dns: [],
      excluded: [],
      leaseMs: 60000,
    });
    expect(cli.execute('ipconfig /renew')).toContain('DHCP iniciada');
    e.advanceTo(1000);
    expect(e.device(d.id).interfaces[0].ip).toBe('192.0.2.10');
    expect(cli.execute('ipconfig /release')).toContain('liberado');
    expect(e.device(d.id).interfaces[0].ip).toBeUndefined();
  });
  it.each(['ap', 'wlc'])(
    '%s aceita VLAN e SVI de gerenciamento, mas não oferece STP ou roteamento dinâmico',
    (profile) => {
      const e = new SimulationEngine(),
        d = e.addFactoryProfile(profile),
        cli = new TerminalSession(e, d.id);
      cli.execute('enable');
      cli.execute('configure terminal');
      for (const command of ['vlan 10', 'exit', 'interface Vlan10', 'ip address 192.0.2.1/24'])
        expect(cli.execute(command)).toBe('OK');
      expect(cli.execute('do show vlan')).toContain('10');
      expect(cli.execute('do show spanning-tree')).toContain('não se aplica');
      expect(cli.execute('do show ip ospf')).toContain('não se aplica');
      validateSnapshot(e.snapshot());
    }
  );
  it('switch conserva VLAN, MAC e STP; rejeita comandos de host e rádio', () => {
    const e = new SimulationEngine(),
      d = e.addProfile('switch-l2'),
      cli = new TerminalSession(e, d.id);
    expect(cli.prompt).toBe(d.hostname + '>');
    cli.execute('enable');
    cli.execute('configure terminal');
    expect(cli.execute('vlan 20')).toBe('');
    expect(cli.execute('do show vlan')).toContain('20');
    for (const command of ['ipconfig', 'wifi scan', 'router ospf 1.1.1.1', 'service http 80'])
      expect(cli.execute(command)).toContain('não se aplica');
    expect(cli.execute('do show spanning-tree')).not.toMatch(/não se aplica|não reconhecido|Invalid input detected at/);
  });
  it.each(['phone', 'printer', 'mqtt', 'proxy'])(
    '%s possui serviço próprio e rejeita os demais perfis',
    (profile) => {
      const e = new SimulationEngine(),
        d = e.addProfile(profile),
        cli = new TerminalSession(e, d.id);
      const service = profile === 'mqtt' ? 'broker' : profile;
      expect(cli.execute('help')).toContain('show ' + service);
      expect(cli.execute('show ' + service)).not.toContain('não se aplica');
      for (const other of ['phone', 'printer', 'broker', 'proxy'].filter((k) => k !== service))
        expect(cli.execute('show ' + other)).toContain('não se aplica');
    }
  );
  it.each(['ids', 'ips'])('%s oferece inspeção, sem anunciar OSPF, BGP ou VPN', (profile) => {
    const e = new SimulationEngine(),
      d = e.addFactoryProfile(profile),
      cli = new TerminalSession(e, d.id);
    expect(cli.execute('help')).toContain('show ids');
    for (const tab of ['ospf', 'rip', 'vrrp', 'bgp', 'tunnels'])
      expect(inspectorTabIds(d)).not.toContain(tab);
    for (const cmd of ['show ip ospf', 'show ip bgp summary', 'show tunnels'])
      expect(cli.execute(cmd)).toContain('não se aplica');
  });
  it('wifi connect negocia pelo rádio e oculta a chave no histórico e nos eventos', () => {
    const e = new SimulationEngine(),
      ap = e.addProfile('ap', { x: 100, y: 100 }),
      client = e.addProfile('laptop', { x: 130, y: 100 });
    e.configureWireless(ap.id, {
      ...wirelessConfig(ap),
      ssid: 'Campus',
      security: 'wpa2-psk',
      key: 'SenhaWireless123',
    });
    const cli = new TerminalSession(e, client.id);
    expect(cli.execute('wifi connect Campus security wpa2-psk key SenhaWireless123')).toContain(
      'Avance a simulação'
    );
    expect(cli.history.at(-1)).not.toContain('SenhaWireless123');
    expect(e.state.events.filter((event) => event.type === 'CONFIG_CHANGED').at(-1)?.reason).not.toContain(
      'SenhaWireless123'
    );
    e.advanceTo(5000);
    expect(e.device(client.id).wireless?.phase).toBe('associated');
  });
  it('banco oferece configuração própria; um host consulta pela rede e não vira servidor', () => {
    const e = new SimulationEngine(),
      host = e.addProfile('desktop'),
      server = e.addFactoryProfile('database'),
      clientCli = new TerminalSession(e, host.id),
      serverCli = new TerminalSession(e, server.id);
    server.power = true;
    Object.assign(host.interfaces[0], { ip: '192.0.2.10', prefix: 24 });
    Object.assign(server.interfaces[0], { ip: '192.0.2.20', prefix: 24 });
    e.connect({ device: host.id, port: 'p0' }, { device: server.id, port: 'p0' });
    serverCli.execute('enable');
    serverCli.execute('configure terminal');
    expect(serverCli.execute('database configure {"enabled":true,"port":8080,"key":"chave-do-lab"}')).toBe(
      'OK'
    );
    const query = {
      target: '192.0.2.20',
      port: 8080,
      key: 'chave-do-lab',
      query: 'CREATE TABLE sensores (id, valor)',
    };
    expect(clientCli.execute('database query ' + JSON.stringify(query))).toContain('Consulta enviada');
    e.advanceTo(500);
    expect(e.device(host.id).tcpConnections?.at(-1)?.received).toContain('200 OK');
    expect(serverCli.execute('show database')).toContain('sensores');
    expect(serverCli.execute('show database')).not.toContain('chave-do-lab');
    expect(clientCli.history.at(-1)).not.toContain('chave-do-lab');
    expect(
      clientCli.execute('database configure {"enabled":true,"port":8080,"key":"chave-do-lab"}')
    ).toContain('não se aplica');
    validateSnapshot(e.snapshot());
  });
  it('wifi connect também associa a uma rede aberta sem exigir uma chave', () => {
    const e = new SimulationEngine(),
      ap = e.addProfile('ap', { x: 100, y: 100 }),
      client = e.addProfile('laptop', { x: 130, y: 100 }),
      cli = new TerminalSession(e, client.id);
    e.configureWireless(ap.id, { ...wirelessConfig(ap), ssid: 'Aberta', security: 'open', key: undefined });
    expect(cli.execute('wifi connect Aberta security open')).toContain('Avance a simulação');
    e.advanceTo(5000);
    expect(e.device(client.id).wireless?.phase).toBe('associated');
  });
});
