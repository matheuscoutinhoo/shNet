import type { Action, Device, Snapshot } from '../model';
import type { SimulationEngine } from '../core/engine';
import { plcProcessConfigSchema, plcProcessStateSchema } from './industrial-process-model';

export function plcProcessConfig(d: Device) {
  if (!d.plcProcess) throw new Error('Processo PLC não configurado.');
  return plcProcessConfigSchema.parse(
    Object.fromEntries(
      Object.keys(plcProcessConfigSchema.shape).map((key) => [
        key,
        d.plcProcess![key as keyof typeof d.plcProcess],
      ])
    )
  );
}
export function configurePlcProcess(e: SimulationEngine, d: Device, input: unknown) {
  const config = plcProcessConfigSchema.parse(input);
  if (!['server', 'router'].includes(d.type) || d.infrastructure || !d.modbus)
    throw new Error('Configure o servidor Modbus do PLC antes do processo.');
  const modbus = structuredClone(d.modbus);
  while (modbus.registers.length <= config.setpointRegister) modbus.registers.push(500);
  modbus.inputRegisters ??= [];
  while (modbus.inputRegisters.length <= config.levelInputRegister) modbus.inputRegisters.push(0);
  modbus.coils ??= [];
  while (modbus.coils.length <= config.pumpCoil) modbus.coils.push(false);
  modbus.discreteInputs ??= [];
  while (modbus.discreteInputs.length <= config.alarmDiscreteInput) modbus.discreteInputs.push(false);
  modbus.inputRegisters[config.levelInputRegister] = config.initialLevel;
  const process = plcProcessStateSchema.parse({
    ...config,
    token: e.id('plc-process'),
    tickAt: e.state.clock + config.scanMs,
    lastAt: e.state.clock,
    levelMilli: config.initialLevel * 1000,
    lastPump: false,
    scans: 0,
    alarms: {
      low: false,
      high: false,
      invalidSetpoint: false,
      latched: false,
      acknowledged: false,
      changedAt: e.state.clock,
    },
  });
  modbus.discreteInputs[config.alarmDiscreteInput] = false;
  d.modbus = modbus;
  d.plcProcess = process;
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'plc-process-tick' || q.action.device !== d.id
  );
  e.schedule(config.scanMs, { kind: 'plc-process-tick', device: d.id, token: process.token });
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    'Processo de tanque e ciclo PLC configurados; nível em milésimos da capacidade.'
  );
}
export function acknowledgeProcessAlarm(e: SimulationEngine, d: Device) {
  const p = d.plcProcess;
  if (!p) throw new Error('Processo PLC não configurado.');
  p.alarms.acknowledged = true;
  if (!p.alarms.low && !p.alarms.high && !p.alarms.invalidSetpoint) p.alarms.latched = false;
  p.alarms.changedAt = e.state.clock;
  d.modbus!.discreteInputs![p.alarmDiscreteInput] = p.alarms.latched;
  e.emit(
    'PROCESS_ALARM_CHANGED',
    d.id,
    'Alarme reconhecido; condição ativa não é apagada pelo reconhecimento.'
  );
}
export function handlePlcProcess(e: SimulationEngine, a: Extract<Action, { kind: 'plc-process-tick' }>) {
  const d = e.device(a.device),
    p = d.plcProcess;
  if (!p || p.token !== a.token || p.tickAt !== e.state.clock) return;
  const dt = Math.max(0, e.state.clock - p.lastAt);
  p.lastAt = e.state.clock;
  if (p.enabled) {
    // Lumped integration at scan boundaries; a powered-off PLC puts the pump in its safe off state.
    p.levelMilli = Math.max(
      0,
      Math.min(
        1000000,
        Math.round(p.levelMilli + ((d.power && p.lastPump ? p.fillPerSecond : 0) - p.drainPerSecond) * dt)
      )
    );
    if (!d.power) p.lastPump = false;
    else {
      const m = d.modbus!,
        measured = Math.round(p.levelMilli / 1000),
        setpoint = m.registers[p.setpointRegister];
      const low = p.alarms.low ? measured < p.lowAlarm + p.hysteresis : measured <= p.lowAlarm;
      const high = p.alarms.high ? measured > p.highAlarm - p.hysteresis : measured >= p.highAlarm;
      const invalid = p.control === 'automatic' && setpoint > 1000;
      const changed = low !== p.alarms.low || high !== p.alarms.high || invalid !== p.alarms.invalidSetpoint;
      if (changed) {
        const active = low || high || invalid;
        Object.assign(p.alarms, { low, high, invalidSetpoint: invalid, changedAt: e.state.clock });
        if (active) {
          p.alarms.latched = true;
          p.alarms.acknowledged = false;
        } else if (p.alarms.acknowledged) p.alarms.latched = false;
        e.emit(
          'PROCESS_ALARM_CHANGED',
          d.id,
          `Tanque: baixo=${low}, alto=${high}, setpoint inválido=${invalid}.`
        );
      }
      if (p.control === 'automatic') {
        if (invalid) p.lastPump = false;
        else if (measured <= setpoint - p.hysteresis) p.lastPump = true;
        else if (measured >= setpoint + p.hysteresis) p.lastPump = false;
        m.coils![p.pumpCoil] = p.lastPump;
      } else p.lastPump = m.coils![p.pumpCoil];
      m.inputRegisters![p.levelInputRegister] = measured;
      m.discreteInputs![p.alarmDiscreteInput] = p.alarms.latched;
      p.scans++;
      e.emit(
        'PLC_SCAN',
        d.id,
        `Scan ${p.scans}: nível ${measured}/1000, bomba ${p.lastPump ? 'ligada' : 'desligada'}.`
      );
    }
  }
  p.tickAt = e.state.clock + p.scanMs;
  e.schedule(p.scanMs, a);
}
export function validatePlcBindings(d: Device, modbus = d.modbus) {
  const p = d.plcProcess;
  if (!p) return;
  if (
    !modbus ||
    p.setpointRegister >= modbus.registers.length ||
    p.levelInputRegister >= (modbus.inputRegisters?.length ?? 0) ||
    p.pumpCoil >= (modbus.coils?.length ?? 0) ||
    p.alarmDiscreteInput >= (modbus.discreteInputs?.length ?? 0)
  )
    throw new Error('Bancos Modbus ainda são referenciados pelo processo PLC.');
}
export function validatePlcProcesses(s: Snapshot) {
  const used = new Set<object>();
  for (const d of s.devices) {
    const p = d.plcProcess;
    if (!p) continue;
    if (
      !['server', 'router'].includes(d.type) ||
      d.infrastructure ||
      p.lastAt > s.clock ||
      p.alarms.changedAt > s.clock
    )
      throw new Error('Estado PLC incompatível.');
    validatePlcBindings(d);
    if ((p.alarms.low || p.alarms.high || p.alarms.invalidSetpoint) && !p.alarms.latched)
      throw new Error('Alarme PLC inconsistente.');
    const timers = s.queue.filter((q) => q.action.kind === 'plc-process-tick' && q.action.device === d.id);
    if (
      timers.length !== 1 ||
      timers[0].at !== p.tickAt ||
      p.tickAt < s.clock ||
      p.tickAt > s.clock + p.scanMs ||
      timers[0].action.kind !== 'plc-process-tick' ||
      timers[0].action.token !== p.token
    )
      throw new Error('Timer PLC inconsistente.');
    used.add(timers[0].action);
  }
  for (const q of s.queue)
    if (q.action.kind === 'plc-process-tick' && !used.has(q.action)) throw new Error('Timer PLC órfão.');
}
