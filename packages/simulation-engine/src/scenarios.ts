import { SimulationEngine } from './core/engine';
import type { Snapshot } from './model';
import { scenarioSchema, type Scenario } from './scenarios-model';
import { modbusRequest, decodeModbus } from './protocols/modbus';
export { scenarioSchema, type Scenario } from './scenarios-model';
import { preflight } from './preflight';
export interface ScenarioSample {
  flow: string;
  atMs: number;
  id?: string;
  status: 'pending' | 'success' | 'failed';
  elapsedMs?: number;
  reason?: string;
}
const percentile = (values: number[], p: number) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
export class ScenarioRunner {
  readonly engine: SimulationEngine;
  readonly scenario: Scenario;
  readonly samples: ScenarioSample[] = [];
  readonly warnings: ReturnType<typeof preflight>;
  private started: number;
  private tasks: { at: number; flow?: number; fault?: number }[] = [];
  private resolved = new Map<string, string>();
  constructor(snapshot: Snapshot, input: unknown) {
    this.scenario = scenarioSchema.parse(input);
    this.engine = new SimulationEngine(snapshot);
    this.engine.state.probes = [];
    this.warnings = preflight(this.engine.state);
    this.started = this.engine.state.clock;
    for (const f of this.scenario.flows) {
      const d = this.engine.state.devices.find((d) => d.id === f.source || d.hostname === f.source);
      if (!d) throw new Error('Origem inexistente: ' + f.source);
      this.resolved.set(f.source, d.id);
    }
    this.scenario.faults.forEach((f, i) => {
      if (
        f.kind === 'device' &&
        !this.engine.state.devices.some((d) => d.id === f.target || d.hostname === f.target)
      )
        throw new Error('Equipamento inexistente: ' + f.target);
      if (f.kind === 'link' && !this.engine.state.links.some((l) => l.id === f.target))
        throw new Error('Enlace inexistente: ' + f.target);
      this.tasks.push({ at: f.atMs, fault: i });
    });
    for (let at = 0; at < this.scenario.durationMs; at += this.scenario.intervalMs)
      this.scenario.flows.forEach((_, i) => this.tasks.push({ at, flow: i }));
    this.tasks.sort(
      (a, b) =>
        a.at - b.at ||
        Number(b.fault !== undefined) - Number(a.fault !== undefined) ||
        (a.flow ?? a.fault ?? 0) - (b.flow ?? b.fault ?? 0)
    );
  }
  private observe() {
    for (const s of this.samples.filter((s) => s.status === 'pending')) {
      const flow = this.scenario.flows.find((f) => f.name === s.flow)!;
      const d = this.engine.device(this.resolved.get(flow.source)!);
      if (flow.protocol === 'icmp') {
        const p = this.engine.state.probes.find((p) => p.id === s.id);
        if (p?.status === 'success') {
          s.elapsedMs = p.rtt;
          s.status = p.rtt! <= this.scenario.deadlineMs ? 'success' : 'failed';
          s.reason = p.rtt! > this.scenario.deadlineMs ? 'Deadline excedido' : undefined;
        } else if (p && p.status !== 'pending') {
          s.status = 'failed';
          s.reason = p.status;
        }
      } else if (flow.protocol === 'modbus') {
        const c = d.tcpConnections?.find((c) => c.id === s.id);
        if (c?.received.includes('\n')) {
          try {
            const response = decodeModbus(c.received.split('\n')[0]);
            const request = flow.modbus!;
            const p = response.pdu;
            const registers =
              request.function === 3 && p.length === 2 + request.quantity * 2 && p[1] === request.quantity * 2
                ? Array.from({ length: request.quantity }, (_, i) => (p[2 + i * 2] << 8) | p[3 + i * 2])
                : undefined;
            const written = request.function === 6 ? request.values[0] : request.quantity;
            const valid =
              response.transaction === request.transaction &&
              response.unit === request.unit &&
              response.function === request.function &&
              !response.exception &&
              (request.function === 3
                ? Boolean(registers)
                : p.length === 5 &&
                  ((p[1] << 8) | p[2]) === request.address &&
                  ((p[3] << 8) | p[4]) === written) &&
              (!flow.expectedRegisters ||
                JSON.stringify(registers) === JSON.stringify(flow.expectedRegisters));
            s.elapsedMs = (c.responseAt ?? c.updatedAt) - (this.started + s.atMs);
            s.status = valid && s.elapsedMs <= this.scenario.deadlineMs ? 'success' : 'failed';
            s.reason = response.exception
              ? 'Exceção Modbus ' + response.exception
              : valid
                ? undefined
                : 'Resposta Modbus divergente';
          } catch (err) {
            s.status = 'failed';
            s.reason = (err as Error).message;
          }
        } else if (c && ['RESET', 'TIMED-OUT'].includes(c.state)) {
          s.status = 'failed';
          s.reason = c.state;
        }
      } else {
        const c = d.tcpConnections?.find((c) => c.id === s.id);
        const status = c?.received.match(/^HTTP\/1\.[01] (\d{3})/);
        const headerEnd = c?.received.indexOf('\r\n\r\n') ?? -1;
        const length = c?.received.match(/\r\nContent-Length: (\d+)/i)?.[1];
        const fullResponse =
          c &&
          headerEnd >= 0 &&
          length !== undefined &&
          new TextEncoder().encode(c.received.slice(headerEnd + 4)).length >= Number(length);
        if (status && c && fullResponse) {
          s.elapsedMs = (c.responseAt ?? c.updatedAt) - (this.started + s.atMs);
          s.status = status[1] === '200' && s.elapsedMs <= this.scenario.deadlineMs ? 'success' : 'failed';
          s.reason = 'HTTP ' + status[1];
        } else if (c && ['RESET', 'TIMED-OUT'].includes(c.state)) {
          s.status = 'failed';
          s.reason = c.state;
        }
      }
      if (
        s.status === 'pending' &&
        this.engine.state.clock >= this.started + s.atMs + this.scenario.deadlineMs
      ) {
        s.status = 'failed';
        s.reason = 'Deadline sem resposta';
      }
    }
  }
  step(wallMs = 20) {
    const start = performance.now();
    const end = this.started + this.scenario.durationMs + this.scenario.deadlineMs;
    while (performance.now() - start < wallMs) {
      const task = this.tasks[0];
      const target = task ? this.started + task.at : end;
      this.engine.advanceTo(target, 20000, Math.max(1, Math.min(100, wallMs - (performance.now() - start))));
      this.observe();
      if (this.engine.state.clock < target) break;
      if (!task) return true;
      this.tasks.shift();
      if (task.fault !== undefined) {
        const f = this.scenario.faults[task.fault];
        if (f.kind === 'device')
          this.engine.setDevicePower(
            this.engine.state.devices.find((d) => d.id === f.target || d.hostname === f.target)!.id,
            f.up
          );
        else {
          this.engine.state.links.find((l) => l.id === f.target)!.up = f.up;
          this.engine.refreshSpanningTree();
          this.engine.refreshVrrp();
        }
      } else if (task.flow !== undefined) {
        const flow = this.scenario.flows[task.flow],
          sample: ScenarioSample = { flow: flow.name, atMs: task.at, status: 'pending' };
        this.samples.push(sample);
        try {
          sample.id =
            flow.protocol === 'icmp'
              ? this.engine.ping(this.resolved.get(flow.source)!, flow.target)
              : flow.protocol === 'modbus'
                ? modbusRequest(
                    this.engine,
                    this.engine.device(this.resolved.get(flow.source)!),
                    flow.target,
                    flow.modbus!,
                    flow.port ?? 502
                  )
                : this.engine.httpGet(this.resolved.get(flow.source)!, flow.target, flow.port ?? 80);
        } catch (e) {
          sample.status = 'failed';
          sample.reason = (e as Error).message;
        }
      }
    }
    return false;
  }
  get progress() {
    return Math.min(
      1,
      (this.engine.state.clock - this.started) / (this.scenario.durationMs + this.scenario.deadlineMs)
    );
  }
  report() {
    const flows = this.scenario.flows.map((f) => {
      const samples = this.samples.filter((s) => s.flow === f.name),
        successful = samples.filter((s) => s.status === 'success');
      const latencies = successful.flatMap((s) => (s.elapsedMs !== undefined ? [s.elapsedMs] : []));
      const lossPercent = samples.length
        ? ((samples.length - successful.length) * 100) / samples.length
        : 100;
      const jitter = latencies.slice(1).map((n, i) => Math.abs(n - latencies[i]));
      return {
        name: f.name,
        expect: f.expect,
        sent: samples.length,
        received: successful.length,
        lossPercent,
        p95Ms: percentile(latencies, 0.95),
        p99Ms: percentile(latencies, 0.99),
        jitterP95Ms: percentile(jitter, 0.95),
        passed:
          samples.length > 0 &&
          !samples.some((s) => s.status === 'pending') &&
          (!f.requireFinalSuccess || samples.at(-1)?.status === 'success') &&
          (f.expect === 'deny'
            ? successful.length === 0 && samples.every((s) => s.id)
            : lossPercent <= f.maxLossPercent &&
              (f.maxLatencyMs === undefined || latencies.every((n) => n <= f.maxLatencyMs!))),
      };
    });
    return {
      format: 'shlab-scenario-v1',
      engineVersion: '0.1.0',
      name: this.scenario.name,
      clock: 'virtual-ms',
      complete: this.progress === 1,
      passed: this.progress === 1 && flows.every((f) => f.passed),
      scenario: this.scenario,
      flows,
      samples: this.samples,
      warnings: this.warnings,
      faults: this.scenario.faults.map((f) => ({
        ...f,
        recovery: this.scenario.flows.map((flow) => {
          const samples = this.samples.filter((s) => s.flow === flow.name && s.atMs >= f.atMs);
          const failed = samples.findIndex((s) => s.status === 'failed');
          const recovered =
            failed >= 0 ? samples.slice(failed + 1).find((s) => s.status === 'success') : undefined;
          return {
            flow: flow.name,
            recoveryMs: recovered ? recovered.atMs + recovered.elapsedMs! - f.atMs : null,
            observedFailure: failed >= 0,
            resolutionMs: this.scenario.intervalMs,
          };
        }),
      })),
      diagnostics: this.engine.state.diagnostics ?? [],
      captureDropped: this.engine.state.capture?.dropped ?? 0,
    };
  }
}
