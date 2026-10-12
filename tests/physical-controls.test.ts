import { describe, expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot, wirelessConfig } from '@shlab/engine';
import { wlcPhysicalControls } from '../apps/web/src/workspace/physicalControls';

function controllerConfig() {
  const engine = new SimulationEngine();
  const device = engine.addDevice('switch');
  Object.assign(device.interfaces[0], { mode: 'routed', ip: '192.0.2.1', prefix: 24 });
  const config = {
    enabled: true,
    underlay: 'p0',
    key: 'controller-network-key',
    allowedWtps: [],
    profiles: [{ name: 'campus', vlan: 10, wireless: { ...wirelessConfig(device), role: 'ap' as const } }],
  };
  return { engine, device, config };
}

describe('Controles físicos dos perfis WLAN', () => {
  it('a criação de um perfil aceita obstrução por material e impede valores artificiais em JSON', () => {
    const { config } = controllerConfig();
    const radio = config.profiles[0].wireless;
    radio.attenuation = 12;
    expect(wlcPhysicalControls(config, undefined).profiles[0].wireless.attenuation).toBe(12);
    radio.attenuation = 7;
    expect(() => wlcPhysicalControls(config, undefined)).toThrow('obstrução do rádio');
    radio.attenuation = 0;
    radio.noise = -50;
    expect(() => wlcPhysicalControls(config, undefined)).toThrow('ruído ambiente');
  });

  it('mantém condições legadas ao renomear ou selecionar uma obstrução sem permitir outro número', () => {
    const { engine, device, config } = controllerConfig();
    const radio = config.profiles[0].wireless;
    radio.noise = -85;
    radio.attenuation = 7;
    engine.configureWlc(device.id, config);
    const previous = engine.device(device.id).wlc;
    config.profiles[0].name = 'renamed';
    expect(wlcPhysicalControls(config, previous).profiles[0].wireless).toMatchObject({
      noise: -85,
      attenuation: 7,
    });
    radio.attenuation = 8;
    expect(() => wlcPhysicalControls(config, previous)).toThrow('obstrução do rádio');
    radio.attenuation = 3;
    expect(wlcPhysicalControls(config, previous).profiles[0].wireless.attenuation).toBe(3);
    radio.noise = -86;
    expect(() => wlcPhysicalControls(config, previous)).toThrow('ruído ambiente');
    validateSnapshot(engine.snapshot());
    expect(new SimulationEngine(engine.snapshot()).snapshot()).toEqual(engine.snapshot());
  });

  it('preserva a associação das condições ao nome do perfil quando a lista é reordenada', () => {
    const { engine, device, config } = controllerConfig();
    config.profiles[0].wireless.noise = -85;
    config.profiles[0].wireless.attenuation = 7;
    config.profiles.push({
      name: 'second',
      vlan: 20,
      wireless: { ...config.profiles[0].wireless, noise: -90, attenuation: 9 },
    });
    engine.configureWlc(device.id, config);
    config.profiles.reverse();
    expect(wlcPhysicalControls(config, engine.device(device.id).wlc).profiles[0]).toMatchObject({
      name: 'second',
      wireless: { noise: -90, attenuation: 9 },
    });
    validateSnapshot(engine.snapshot());
  });
});
