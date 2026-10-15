import type { Action, Device, Snapshot } from '../model';
import type { SimulationEngine } from '../core/engine';
import { hmiScanConfigSchema, hmiScanStateSchema } from './industrial-process-model';
import { modbusRequest, decodeModbus } from './modbus';
import { isUnicast } from './dhcp-config';
export function hmiScanConfig(d: Device) {
  const state = d.hmiScan;
  if (!state) throw new Error('Varredura HMI não configurada.');
  return hmiScanConfigSchema.parse(
    Object.fromEntries(
      Object.keys(hmiScanConfigSchema.shape).map((key) => [key, state[key as keyof typeof state]])
    )
  );
}
export function configureHmiScan(e: SimulationEngine, d: Device, input: unknown) {
  const config = hmiScanConfigSchema.parse(input);
  if (!['pc', 'server'].includes(d.type) || d.infrastructure || !isUnicast(config.target))
    throw new Error('Varredura HMI exige host IP e destino Modbus IPv4 unicast.');
  if (d.hmiScan?.pending && d.tcpConnections?.some((c) => c.id === d.hmiScan!.pending!.connection))
    e.closeTcp(d.id, d.hmiScan.pending.connection, true);
  d.hmiScan = hmiScanStateSchema.parse({
    ...config,
    token: e.id('hmi-scan'),
    tickAt: e.state.clock + 100,
    nextPollAt: e.state.clock + 100,
    transaction: 0,
    values: [],
    samples: 0,
    missed: 0,
    consecutiveMisses: 0,
    communicationAlarm: false,
    processAlarm: false,
  });
  e.state.queue = e.state.queue.filter((q) => q.action.kind !== 'hmi-scan-tick' || q.action.device !== d.id);
  e.schedule(100, { kind: 'hmi-scan-tick', device: d.id, token: d.hmiScan.token });
  e.emit('CONFIG_CHANGED', d.id, 'Varredura periódica HMI/SCADA/MES por Modbus TCP configurada.');
}
function miss(e: SimulationEngine, d: Device, reason: string) {
  const h = d.hmiScan!;
  h.missed++;
  h.consecutiveMisses++;
  h.lastError = reason.slice(0, 200);
  if (!h.communicationAlarm && h.consecutiveMisses >= h.missedBeforeAlarm) {
    h.communicationAlarm = true;
    e.emit(
      'HMI_STATE_CHANGED',
      d.id,
      'Alarme de comunicação: ' + h.consecutiveMisses + ' leituras consecutivas perdidas.'
    );
  }
  if (h.pending && d.tcpConnections?.some((c) => c.id === h.pending!.connection))
    e.closeTcp(d.id, h.pending.connection, true);
  delete h.pending;
}
function collect(e: SimulationEngine, d: Device) {
  const h = d.hmiScan!,
    pending = h.pending;
  if (!pending) return;
  const c = d.tcpConnections?.find((c) => c.id === pending.connection);
  if (c?.responseAt !== undefined && c.responseAt <= pending.deadlineAt) {
    try {
      const response = decodeModbus(c.received);
      if (
        response.exception ||
        response.transaction !== pending.transaction ||
        response.unit !== h.unit ||
        response.function !== h.function ||
        response.pdu[1] !== h.quantity * 2 ||
        response.pdu.length !== 2 + h.quantity * 2
      )
        throw new Error('Resposta Modbus divergente ou exceção de aplicação.');
      h.values = Array.from(
        { length: h.quantity },
        (_, n) => response.pdu[2 + n * 2] * 256 + response.pdu[3 + n * 2]
      );
      h.receivedAt = c.responseAt;
      h.latencyMs = c.responseAt - pending.startedAt;
      h.samples++;
      h.consecutiveMisses = 0;
      delete h.lastError;
      const alarm =
        (h.lowAlarm !== undefined && h.values[0] <= h.lowAlarm) ||
        (h.highAlarm !== undefined && h.values[0] >= h.highAlarm);
      if (h.communicationAlarm || alarm !== h.processAlarm)
        e.emit(
          'HMI_STATE_CHANGED',
          d.id,
          `${h.communicationAlarm ? 'Comunicação recuperada' : 'Amostra recebida'}; alarme do valor amostrado: ${alarm}.`
        );
      h.communicationAlarm = false;
      h.processAlarm = alarm;
      delete h.pending;
      e.emit(
        'HMI_SAMPLE',
        d.id,
        `${h.target}: ${h.values.join(', ')}; resposta em ${h.latencyMs.toFixed(3)} ms.`
      );
    } catch (error) {
      miss(e, d, (error as Error).message);
    }
  } else if (!c || ['RESET', 'TIMED-OUT'].includes(c.state) || e.state.clock >= pending.deadlineAt)
    miss(e, d, !c ? 'Conexão removida.' : 'Leitura sem resposta válida dentro do deadline.');
}
export function handleHmiScan(e: SimulationEngine, a: Extract<Action, { kind: 'hmi-scan-tick' }>) {
  const d = e.device(a.device),
    h = d.hmiScan;
  if (!h || h.token !== a.token || h.tickAt !== e.state.clock) return;
  if (!d.power || !h.enabled) {
    if (h.pending && d.tcpConnections?.some((c) => c.id === h.pending!.connection))
      e.closeTcp(d.id, h.pending.connection, true);
    delete h.pending;
    h.nextPollAt = e.state.clock + 100;
  } else {
    collect(e, d);
    if (!h.pending && h.nextPollAt <= e.state.clock) {
      h.nextPollAt = e.state.clock + h.intervalMs;
      h.transaction = (h.transaction + 1) & 65535;
      try {
        const connection = modbusRequest(
          e,
          d,
          h.target,
          {
            transaction: h.transaction,
            unit: h.unit,
            function: h.function,
            address: h.address,
            quantity: h.quantity,
          },
          h.port
        );
        h.pending = {
          connection,
          startedAt: e.state.clock,
          deadlineAt: e.state.clock + h.deadlineMs,
          transaction: h.transaction,
        };
      } catch (error) {
        miss(e, d, (error as Error).message);
      }
    }
  }
  h.tickAt = e.state.clock + 100;
  e.schedule(100, a);
}
export function validateHmiScans(s: Snapshot) {
  const used = new Set<object>();
  for (const d of s.devices) {
    const h = d.hmiScan;
    if (!h) continue;
    if (
      !['pc', 'server'].includes(d.type) ||
      d.infrastructure ||
      !isUnicast(h.target) ||
      (h.receivedAt ?? 0) > s.clock ||
      h.consecutiveMisses > h.missed ||
      h.communicationAlarm !== h.consecutiveMisses >= h.missedBeforeAlarm ||
      (h.samples === 0) !== (h.receivedAt === undefined) ||
      (h.samples > 0 && h.values.length !== h.quantity) ||
      h.processAlarm !==
        (h.values.length > 0 &&
          ((h.lowAlarm !== undefined && h.values[0] <= h.lowAlarm) ||
            (h.highAlarm !== undefined && h.values[0] >= h.highAlarm))) ||
      (h.receivedAt === undefined) !== (h.latencyMs === undefined) ||
      h.values.length > h.quantity ||
      (h.pending &&
        (h.pending.startedAt > s.clock ||
          h.pending.deadlineAt !== h.pending.startedAt + h.deadlineMs ||
          h.pending.transaction !== h.transaction ||
          !d.tcpConnections?.some(
            (c) =>
              c.id === h.pending!.connection &&
              c.role === 'client' &&
              c.service === 'modbus' &&
              c.remoteIp === h.target &&
              c.remotePort === h.port
          )))
    )
      throw new Error('Estado de varredura HMI inconsistente.');
    const timers = s.queue.filter((q) => q.action.kind === 'hmi-scan-tick' && q.action.device === d.id);
    if (
      timers.length !== 1 ||
      timers[0].at !== h.tickAt ||
      h.tickAt < s.clock ||
      h.tickAt > s.clock + 100 ||
      timers[0].action.kind !== 'hmi-scan-tick' ||
      timers[0].action.token !== h.token
    )
      throw new Error('Timer HMI inconsistente.');
    used.add(timers[0].action);
  }
  for (const q of s.queue)
    if (q.action.kind === 'hmi-scan-tick' && !used.has(q.action)) throw new Error('Timer HMI órfão.');
}
