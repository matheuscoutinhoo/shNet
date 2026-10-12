import { describe, expect, it } from 'vitest';
import {
  cableMetrics,
  linkOperational,
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  wirelessConfig,
  wirelessMetrics,
} from '@shlab/engine';

function firstCableDelivery(distance: number) {
  const engine = new SimulationEngine();
  const source = engine.addDevice('pc');
  const target = engine.addDevice('server');
  Object.assign(source.interfaces[0], { ip: '192.0.2.1', prefix: 24 });
  Object.assign(target.interfaces[0], { ip: '192.0.2.2', prefix: 24 });
  const link = engine.connect(
    { device: source.id, port: 'p0' },
    { device: target.id, port: 'p0' },
    'copper',
    { distance, latency: 4 }
  );
  engine.ping(source.id, '192.0.2.2');
  const delivery = engine.state.queue.find(
    (entry) => entry.action.kind === 'deliver' && entry.action.from === source.id
  );
  expect(delivery).toBeDefined();
  validateSnapshot(engine.snapshot());
  return { engine, link, at: delivery!.at };
}

describe('Condições físicas de transporte', () => {
  it('permite instalar o cabo com equipamentos desligados sem energizar ou habilitar as portas', () => {
    const engine = new SimulationEngine();
    const a = engine.addDevice('pc');
    const b = engine.addDevice('server');
    for (const device of [a, b]) {
      engine.setDevicePower(device.id, false);
      device.interfaces[0].adminUp = false;
    }
    const link = engine.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    expect([a.power, b.power]).toEqual([false, false]);
    expect([a.interfaces[0].adminUp, b.interfaces[0].adminUp]).toEqual([false, false]);
    expect(linkOperational(engine.state, link)).toBe(false);
    expect(engine.state.events.filter((event) => event.link === link.id).at(-1)?.type).toBe('CONFIG_CHANGED');
    for (const device of [a, b]) engine.setDevicePower(device.id, true);
    expect(linkOperational(engine.state, link)).toBe(false);
    a.interfaces[0].adminUp = true;
    b.interfaces[0].adminUp = true;
    expect(linkOperational(engine.state, link)).toBe(true);
    validateSnapshot(engine.snapshot());
  });

  it('o comprimento altera o tempo real de entrega sem substituir as condições internas do cenário', () => {
    const short = firstCableDelivery(10);
    const long = firstCableDelivery(100);
    expect(long.at - short.at).toBeCloseTo(90 / 200000, 8);
    expect(long.link.latency).toBe(4);
    expect(cableMetrics(long.link)).toEqual({
      propagation: 0.0005,
      latency: 4.0005,
      jitter: 0,
      loss: 0,
    });
    Object.assign(long.link, { jitter: 2, loss: 0.15 });
    expect(cableMetrics(long.link)).toMatchObject({ jitter: 2, loss: 0.15 });
    expect(new SimulationEngine(long.engine.snapshot()).snapshot()).toEqual(long.engine.snapshot());
  });

  it('uma obstrução reduz sinal e SNR; a interferência continua resultando dos rádios próximos', () => {
    const engine = new SimulationEngine();
    const ap = engine.addDevice('switch', { x: 100, y: 100 });
    const client = engine.addDevice('pc', { x: 180, y: 100 });
    engine.configureWireless(ap.id, { ...wirelessConfig(ap), ssid: 'Physical', enabled: true });
    engine.configureWireless(client.id, {
      ...wirelessConfig(client),
      ssid: 'Physical',
      enabled: true,
    });
    const link = engine.state.links.find((entry) => entry.cable === 'wireless')!;
    const baseline = wirelessMetrics(engine.state, link);
    const cli = new TerminalSession(engine, client.id);
    cli.execute('enable');
    cli.execute('conf t');
    expect(cli.execute('wireless obstruction concrete')).toBe('OK');
    const obstructed = wirelessMetrics(engine.state, link);
    expect(obstructed.rssi).toBeCloseTo(baseline.rssi - 12);
    expect(obstructed.snr).toBeCloseTo(baseline.snr - 12);
    expect(obstructed.loss).toBeGreaterThan(baseline.loss);
    expect(obstructed.interference).toBe(0);

    const neighbor = engine.addDevice('switch', { x: 120, y: 100 });
    engine.configureWireless(neighbor.id, {
      ...wirelessConfig(neighbor),
      ssid: 'Neighbor',
      channel: 2,
      enabled: true,
    });
    expect(wirelessMetrics(engine.state, link).interference).toBeGreaterThan(0);
    engine.configureWireless(neighbor.id, { ...wirelessConfig(neighbor), channel: 11 });
    expect(wirelessMetrics(engine.state, link).interference).toBe(0);
    validateSnapshot(engine.snapshot());
    expect(new SimulationEngine(engine.snapshot()).snapshot()).toEqual(engine.snapshot());
  });

  it('a CLI aceita material e potência e não aceita valores artificiais de ruído ou atenuação', () => {
    const engine = new SimulationEngine();
    const device = engine.addDevice('pc');
    const cli = new TerminalSession(engine, device.id);
    cli.execute('enable');
    cli.execute('conf t');
    const unconfigured = engine.snapshot();
    expect(cli.execute('wireless tx-power 18')).toMatch(/^% Configure o SSID/);
    expect(cli.execute('wireless obstruction concrete')).toMatch(/^% Configure o SSID/);
    expect(cli.execute('service wireless')).toMatch(/^% Configure o SSID/);
    expect(engine.snapshot()).toEqual(unconfigured);
    engine.configureWireless(device.id, { ...wirelessConfig(device), ssid: 'Physical', enabled: false });
    expect(cli.execute('wireless tx-power 18')).toBe('OK');
    expect(engine.device(device.id).wireless?.txPower).toBe(18);
    expect(cli.execute('wireless obstruction drywall')).toBe('OK');
    expect(engine.device(device.id).wireless?.attenuation).toBe(3);
    const before = engine.snapshot();
    expect(cli.execute('wireless noise -40')).toMatch(/^%/);
    expect(cli.execute('wireless attenuation 20')).toMatch(/^%/);
    expect(engine.snapshot()).toEqual(before);
    expect(cli.execute('show running-config')).toContain('wireless obstruction drywall');
    expect(cli.execute('show running-config')).not.toMatch(/wireless (noise|attenuation) /);
    validateSnapshot(engine.snapshot());
  });
});
