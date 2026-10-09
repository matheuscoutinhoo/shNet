import type { SimulationEngine } from '../core/engine';
import type { Device, Frame, Snapshot } from '../model';
import { infrastructureConfigSchema, systemConfigSchema } from './infrastructure-model';
export function configureInfrastructure(e: SimulationEngine, d: Device, input: unknown) {
  const value = infrastructureConfigSchema.parse(input);
  const before = d.infrastructure;
  d.infrastructure = value;
  try {
    validateInfrastructure(e.state);
  } catch (error) {
    d.infrastructure = before;
    throw error;
  }
  refreshInfrastructure(e);
  e.emit('CONFIG_CHANGED', d.id, 'Infraestrutura ' + value.kind + ' configurada.');
}
export function configureSystem(e: SimulationEngine, d: Device, input: unknown) {
  const c = systemConfigSchema.parse(input);
  d.system = {
    ...c,
    windowAt: e.state.clock,
    work: 0,
    processed: 0,
    nextReadyAt: e.state.clock,
    lastAt: e.state.clock,
    cpuPercent: 0,
    memoryKiB: 64,
    temperatureC: c.ambientC,
    throttled: false,
  };
  e.emit('CONFIG_CHANGED', d.id, 'Capacidade, memória e modelo térmico configurados.');
}
export function updateSystem(s: Snapshot, d: Device) {
  const c = d.system;
  if (!c?.enabled) return;
  const rack = s.devices.find(
    (r) => r.infrastructure?.kind === 'rack' && r.infrastructure.slots.some((slot) => slot.device === d.id)
  )?.infrastructure;
  const ambient = rack?.kind === 'rack' ? rack.ambientC + (1 - rack.ventilation) * 15 : c.ambientC;
  const elapsed = Math.max(0, s.clock - c.lastAt);
  if (!elapsed) return;
  const cpu = d.power
    ? Math.min(100, (100 * c.work * 1000) / (c.capacityPps * Math.max(1, s.clock - c.windowAt)))
    : 0;
  c.cpuPercent = cpu;
  const target = ambient + (d.power ? 8 + cpu * 0.45 : 0);
  c.temperatureC = target + (c.temperatureC - target) * Math.exp(-elapsed / 30000);
  c.throttled = c.temperatureC >= c.thermalLimitC;
  const state = { ...d };
  delete state.system;
  c.memoryKiB = 64 + Math.ceil(new TextEncoder().encode(JSON.stringify(state)).length / 1024);
  c.lastAt = s.clock;
  if (s.clock - c.windowAt >= 1000) {
    c.windowAt = s.clock;
    c.work = 0;
  }
}
export function processingDelay(e: SimulationEngine, d: Device) {
  const c = d.system;
  if (!c?.enabled) return 0;
  updateSystem(e.state, d);
  if (c.memoryKiB > c.memoryLimitKiB) return undefined;
  c.work++;
  c.processed++;
  const delay = 1000 / (c.capacityPps * (c.throttled ? 0.5 : 1));
  c.nextReadyAt = Math.max(e.state.clock, c.nextReadyAt) + delay;
  return c.nextReadyAt - e.state.clock;
}
export function refreshInfrastructure(e: SimulationEngine, metrics = false) {
  const s = e.state;
  for (const d of s.devices) {
    const ups = d.infrastructure;
    if (ups?.kind !== 'ups') continue;
    const hours = Math.max(0, s.clock - ups.lastAt) / 3600000;
    const load = ups.loads.filter((l) => l.requested).reduce((total, l) => total + l.watts, 0);
    const available = d.power && load <= ups.maxWatts && (ups.mains || ups.remainingWh > 0);
    if (ups.mains && d.power)
      ups.remainingWh = Math.min(ups.capacityWh, ups.remainingWh + hours * ups.chargeWatts * ups.efficiency);
    else if (available) ups.remainingWh = Math.max(0, ups.remainingWh - (hours * load) / ups.efficiency);
    ups.output = d.power && load <= ups.maxWatts && (ups.mains || ups.remainingWh > 0);
    ups.lastAt = s.clock;
    for (const entry of ups.loads) {
      const target = s.devices.find((p) => p.id === entry.device);
      if (!target) continue;
      const on = entry.requested && ups.output;
      if (target.power !== on) {
        target.power = on;
        if (!on) {
          target.arpTable = [];
          target.macTable = [];
        }
        e.emit(
          on ? 'LINK_UP' : 'LINK_DOWN',
          target.id,
          on ? 'UPS: alimentação disponível.' : 'UPS: bateria esgotada, sobrecarga ou saída desligada.'
        );
      }
    }
  }
  if (metrics) for (const d of s.devices) updateSystem(s, d);
}
export function setDevicePower(e: SimulationEngine, d: Device, on: boolean) {
  for (const supply of e.state.devices)
    if (supply.infrastructure?.kind === 'ups')
      for (const entry of supply.infrastructure.loads) if (entry.device === d.id) entry.requested = on;
  if (d.poeDevice) d.poeDevice.requested = on;
  d.power = on;
  refreshInfrastructure(e);
}
export function passiveForward(e: SimulationEngine, d: Device, port: string, frame: Frame) {
  const panel = d.infrastructure;
  if (panel?.kind !== 'patch-panel') return false;
  const pair = panel.pairs.find((p) => p.a === port || p.b === port);
  if (!pair || frame.hops <= 0) {
    e.drop(d, 'Patch panel: porta sem jumper ou limite de hops.', port, frame);
    return true;
  }
  e.sendFrame(d.id, pair.a === port ? pair.b : pair.a, frame);
  return true;
}
export function validateInfrastructure(s: Snapshot) {
  const mounted = new Set<string>(),
    powered = new Set<string>();
  for (const d of s.devices) {
    const c = d.infrastructure;
    if (c?.kind === 'rack') {
      const units = new Set<number>();
      for (const slot of c.slots) {
        const device = s.devices.find((v) => v.id === slot.device);
        if (
          !device ||
          device.id === d.id ||
          device.infrastructure?.kind === 'rack' ||
          mounted.has(device.id) ||
          slot.unit + slot.units - 1 > c.units
        )
          throw new Error('Rack: equipamento, montagem ou altura inválidos.');
        mounted.add(device.id);
        for (let n = slot.unit; n < slot.unit + slot.units; n++) {
          if (units.has(n)) throw new Error('Rack: unidades sobrepostas.');
          units.add(n);
        }
      }
    }
    if (c?.kind === 'patch-panel') {
      const ports = new Set<string>();
      for (const pair of c.pairs) {
        const a = d.interfaces.find((p) => p.id === pair.a),
          b = d.interfaces.find((p) => p.id === pair.b);
        if (
          !a ||
          !b ||
          a.id === b.id ||
          ports.has(a.id) ||
          ports.has(b.id) ||
          a.media !== b.media ||
          a.speed !== b.speed ||
          a.logical ||
          b.logical
        )
          throw new Error('Patch panel: jumper incompatível ou porta repetida.');
        ports.add(a.id);
        ports.add(b.id);
      }
    }
    if (c?.kind === 'ups') {
      if (c.lastAt > s.clock || c.remainingWh > c.capacityWh)
        throw new Error('UPS: capacidade/relógio inválidos.');
      for (const load of c.loads) {
        const target = s.devices.find((v) => v.id === load.device);
        if (
          !target ||
          target.id === d.id ||
          target.infrastructure?.kind === 'ups' ||
          target.poeDevice?.required ||
          powered.has(target.id)
        )
          throw new Error('UPS: carga inexistente, duplicada ou com outra alimentação.');
        powered.add(target.id);
      }
    }
    if (d.system && (d.system.lastAt > s.clock || d.system.windowAt > s.clock))
      throw new Error('Métricas: relógio inválido.');
  }
}
