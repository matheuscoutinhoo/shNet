import { describe, it, expect } from 'vitest';
import { SimulationEngine, deviceProfiles, validateSnapshot, wirelessConfig } from '@shlab/engine';
import {
  deviceCapabilities,
  inspectorTabIds,
  deviceIntegrityIssues,
  devicePresentationProfile,
} from '../apps/web/src/workspace/deviceCapabilities';

describe('Integridade dos perfis de equipamentos', () => {
  it('todos os perfis persistem com MACs únicos e mídias coerentes', () => {
    const e = new SimulationEngine();
    for (const profile of deviceProfiles) e.addProfile(profile.id);
    const snapshot = validateSnapshot(JSON.parse(JSON.stringify(e.snapshot())));
    const addresses = snapshot.devices.flatMap((d) => d.interfaces.map((p) => p.mac));
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const d of snapshot.devices) {
      expect(deviceIntegrityIssues(d), d.profile).toEqual([]);
      expect(new Set(inspectorTabIds(d)).size).toBe(inspectorTabIds(d).length);
      const spec = deviceProfiles.find((p) => p.id === d.profile)!;
      expect(d.type).toBe(spec.type);
      if (['ap', 'mesh', 'wlc', 'printer', 'phone', 'patch-panel'].includes(spec.id)) {
        expect(d.interfaces.some((p) => ['sfp', 'qsfp'].includes(p.media))).toBe(false);
      }
      if (['ap', 'mesh'].includes(spec.id)) {
        expect(d.hostname).not.toMatch(/^SW-/);
        expect(d.wireless?.role).toBe('ap');
        expect(d.interfaces.filter((p) => p.media === 'wifi')).toHaveLength(1);
      }
    }
    expect(e.state.devices.find((d) => d.profile === 'smartphone')!.interfaces.map((p) => p.media)).toEqual([
      'wifi',
    ]);
    expect(
      e.state.devices.find((d) => d.profile === 'access')!.interfaces.filter((p) => p.media === 'sfp')
    ).toHaveLength(2);
    expect(e.state.devices.find((d) => d.profile === 'wlc')!.wireless).toBeUndefined();
  });

  it('sinaliza AP antigo com portas indevidas sem alterar a topologia salva', () => {
    const e = new SimulationEngine();
    const old = e.addDevice('switch');
    old.profile = 'mesh';
    const before = JSON.stringify(old);
    expect(deviceIntegrityIssues(old)).toHaveLength(3);
    expect(JSON.stringify(old)).toBe(before);
    expect(inspectorTabIds(old)).not.toContain('vxlan');
  });

  it.each(['laptop', 'smartphone'])('%s associa ao AP de catálogo e recebe HTTP pelo rádio', (profile) => {
    const e = new SimulationEngine();
    const ap = e.addProfile('ap', { x: 200, y: 200 });
    const client = e.addProfile(profile, { x: 240, y: 200 });
    const server = e.addProfile('web', { x: 100, y: 200 });
    e.configureWireless(ap.id, { ...wirelessConfig(ap), ssid: 'Integridade' });
    e.configureWireless(client.id, { ...wirelessConfig(client), ssid: 'Integridade' });
    Object.assign(
      client.interfaces.find((p) => p.media === 'wifi')!,
      { ip: '192.0.2.10', prefix: 24 }
    );
    Object.assign(server.interfaces[0], { ip: '192.0.2.20', prefix: 24 });
    e.connect({ device: ap.id, port: 'p0' }, { device: server.id, port: 'p0' });
    e.advanceTo(5000);
    expect(client.wireless?.phase).toBe('associated');
    const id = e.httpGet(client.id, '192.0.2.20');
    e.advanceTo(7000);
    expect(client.tcpConnections?.find((c) => c.id === id)?.received).toContain('servidor HTTP');
    validateSnapshot(e.snapshot());
  });

  it('perfis AP e WLC centralizam HTTP por CAPWAP usando uma SVI de gerenciamento', () => {
    const e = new SimulationEngine();
    const wlc = e.addProfile('wlc', { x: 400, y: 300 });
    const ap = e.addProfile('ap', { x: 80, y: 80 });
    const client = e.addProfile('laptop', { x: 85, y: 85 });
    const server = e.addProfile('web');
    Object.assign(wlc.interfaces[0], { mode: 'routed', ip: '192.0.2.1', prefix: 24 });
    const management = e.addSvi(ap.id, 1);
    Object.assign(management, { ip: '192.0.2.2', prefix: 24 });
    wlc.vlans.push({ id: 10, name: 'WLAN' });
    wlc.interfaces[1].accessVlan = 10;
    Object.assign(server.interfaces[0], { ip: '10.0.0.20', prefix: 24 });
    e.connect({ device: wlc.id, port: 'p0' }, { device: ap.id, port: 'p0' });
    e.connect({ device: server.id, port: 'p0' }, { device: wlc.id, port: 'p1' });
    const radio = {
      ...wirelessConfig(ap),
      ssid: 'Integridade-CAPWAP',
      security: 'wpa2-psk' as const,
      key: 'wireless-campus-key',
      noise: -110,
    };
    e.configureWireless(ap.id, radio);
    e.configureWireless(client.id, { ...radio, role: 'client' });
    Object.assign(
      client.interfaces.find((p) => p.media === 'wifi')!,
      { ip: '10.0.0.10', prefix: 24 }
    );
    e.configureWlc(wlc.id, {
      enabled: true,
      underlay: 'p0',
      key: 'controller-network-key',
      allowedWtps: [ap.id],
      profiles: [{ name: 'campus', vlan: 10, wireless: radio }],
    });
    e.configureWtp(ap.id, {
      enabled: true,
      underlay: management.id,
      controller: '192.0.2.1',
      key: 'controller-network-key',
      profile: 'campus',
    });
    e.advanceTo(7000);
    expect(ap.wtp?.phase).toBe('RUN');
    expect(wlc.wlc?.sessions[0]?.phase).toBe('RUN');
    expect(client.wireless?.phase).toBe('associated');
    const id = e.httpGet(client.id, '10.0.0.20');
    e.advanceTo(9000);
    expect(client.tcpConnections?.find((c) => c.id === id)?.received).toContain('servidor HTTP');
    expect(deviceIntegrityIssues(ap)).toEqual([]);
    expect(deviceIntegrityIssues(wlc)).toEqual([]);
    validateSnapshot(e.snapshot());
  });

  it('APs, WLCs, switches e endpoints possuem opções distintas', () => {
    const e = new SimulationEngine();
    const mesh = e.addProfile('mesh'),
      wlc = e.addProfile('wlc'),
      sw = e.addProfile('switch-l2');
    expect(deviceCapabilities(mesh).advancedKinds).toEqual(['eapAuthenticator', 'mesh', 'wtp']);
    for (const d of [mesh, wlc]) {
      for (const tab of [
        'lacp',
        'vxlan',
        'tunnels',
        'ospf',
        'rip',
        'vrrp',
        'sdwanController',
        'database',
        'applications',
      ]) {
        expect(inspectorTabIds(d), d.profile + ': ' + tab).not.toContain(tab);
      }
    }
    expect(deviceCapabilities(wlc).advancedKinds).toEqual(['wlc']);
    expect(inspectorTabIds(wlc)).not.toContain('wireless');
    expect(inspectorTabIds(sw)).toContain('stp');
    expect(inspectorTabIds(sw)).not.toContain('wireless');
    expect(deviceCapabilities(e.addProfile('phone')).applicationKinds).toEqual(['phone']);
    expect(deviceCapabilities(e.addProfile('printer')).applicationKinds).toEqual(['printer']);
    expect(deviceCapabilities(e.addProfile('mqtt')).applicationKinds).toEqual(['broker']);
    expect(deviceCapabilities(e.addProfile('proxy')).applicationKinds).toEqual(['proxy']);
    const iot = deviceCapabilities(e.addProfile('iot'));
    expect(iot.applicationKinds).toEqual([]);
    expect(iot.clientApplications).toBe(true);
    expect(deviceCapabilities(e.addProfile('dns')).dhcpServer).toBe(false);
    expect(deviceCapabilities(e.addProfile('dhcp')).dnsServer).toBe(false);
    expect(inspectorTabIds(e.addProfile('switch-l3'))).toContain('bgp');
    // The engine currently supports OSPF/RIP/VRRP only on routers: do not offer unusable forms.
    expect(inspectorTabIds(e.addProfile('switch-l3'))).not.toContain('ospf');
  });

  it('equipamentos passivos não oferecem energia nem configurações de host', () => {
    const e = new SimulationEngine();
    const patch = e.addProfile('patch-panel'),
      rack = e.addProfile('rack');
    expect(deviceCapabilities(patch).power).toBe(false);
    expect(deviceCapabilities(rack).power).toBe(false);
    expect(inspectorTabIds(patch)).toEqual(['overview', 'interfaces', 'infrastructure', 'logs']);
    expect(inspectorTabIds(rack)).toEqual(['overview', 'infrastructure', 'logs']);
    expect(deviceCapabilities(e.addProfile('phone')).poeSupply).toBe(false);
    expect(deviceCapabilities(e.addProfile('ap')).poeLoad).toBe(true);
    expect(deviceCapabilities(e.addProfile('switch-l2')).poeSupply).toBe(true);
    expect(deviceCapabilities(e.addProfile('core')).poeSupply).toBe(false);
    expect(deviceCapabilities(e.addProfile('remote')).remoteKinds).toContain('automation');
    expect(deviceCapabilities(e.addProfile('virtual-router')).serial).toBe(false);
    expect(deviceCapabilities(e.addProfile('virtual-router')).console).toBe(false);
  });

  it('representa AP e switch L3 de templates sem perfil explícito pelo papel configurado', () => {
    const e = new SimulationEngine();
    const ap = e.addDevice('switch');
    e.configureWireless(ap.id, { ...wirelessConfig(ap), role: 'ap' });
    const l3 = e.addDevice('switch');
    l3.ipRouting = true;
    expect(devicePresentationProfile(ap)?.id).toBe('ap');
    expect(devicePresentationProfile(l3)?.layer).toBe('L2/L3');
    expect(devicePresentationProfile(e.addDevice('pc'))).toBeUndefined();
  });
});
