import { SimulationEngine } from './core/engine';
import { ENGINE_CONTRACT_VERSION, ENGINE_BUILD } from './version';
import { observeAssertion } from './scenario-assertions';
import { canonicalScenarioJson } from './canonical-json';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Snapshot } from './model';
import { scenarioSchema, type Scenario } from './scenarios-model';
import { modbusRequest, decodeModbus, modbusFrameLength } from './protocols/modbus';
export { scenarioSchema, type Scenario } from './scenarios-model';
import { preflight } from './preflight';
import { scenarioRecovery } from './scenario-metrics';
import { scenarioEvidence, type ScenarioEvidence } from './scenario-evidence';
import { applyConfigurationPatch } from './configuration-patch';
import type { ConfigurationPatch } from './configuration-patch-model';
import {
  applyScenarioFault,
  validateScenarioFault,
  validateProtocolFlow,
  scenarioDevice,
  startProtocol,
  observeProtocol,
  type ProtocolAttempt,
} from './scenario-protocols';
export interface ScenarioSample {
  flow: string;
  atMs: number;
  id?: string;
  status: 'pending' | 'success' | 'failed';
  elapsedMs?: number;
  reason?: string;
  responseReceived?: boolean;
  evidence?: ScenarioEvidence;
  epoch?: number;
}
const percentile = (values: number[], p: number) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
export class ScenarioRunner {
  readonly engine: SimulationEngine;
  readonly scenario: Scenario;
  readonly samples: ScenarioSample[] = [];
  readonly warnings: ReturnType<typeof preflight>;
  private started: number;
  private tasks: { at: number; flow?: number; fault?: number; action?: number; assertion?: number }[] = [];
  private epoch = 0;
  private advanceTarget?: number;
  private restoredCaptureDrops = 0;
  private checkpoints = new Map<string, { snapshot: Snapshot; hash: string; bytes: number }>();
  private configurations = new Map<string, { rollback: ConfigurationPatch; hash: string; bytes: number }>();
  private actionResults: {
    atMs: number;
    kind: 'checkpoint' | 'restore' | 'configure' | 'rollback';
    checkpoint: string;
    changes?: ConfigurationPatch;
    epoch: number;
    beforeClock: number;
    afterClock: number;
    snapshotHash: string;
    configurationHash?: string;
    changedObjects?: number;
  }[] = [];
  private assertionResults: {
    name: string;
    atMs: number;
    epoch: number;
    observed: string;
    passed: boolean;
  }[] = [];
  private resolved = new Map<string, string>();
  private attempts = new Map<ScenarioSample, ProtocolAttempt>();
  constructor(snapshot: Snapshot, input: unknown) {
    this.scenario = scenarioSchema.parse(input);
    this.engine = new SimulationEngine(snapshot);
    this.engine.state.probes = [];
    this.engine.state.probes6 = [];
    this.warnings = preflight(this.engine.state);
    this.started = this.engine.state.clock + (this.scenario.warmupMs ?? 0);
    for (const f of this.scenario.flows) {
      const d = this.engine.state.devices.find((d) => d.id === f.source || d.hostname === f.source);
      if (!d) throw new Error('Origem inexistente: ' + f.source);
      this.resolved.set(f.source, d.id);
      validateProtocolFlow(this.engine, f);
    }
    const owners = this.scenario.flows
      .filter((f) => ['dhcp', 'mqtt', 'ntp'].includes(f.protocol))
      .flatMap((f) => [
        scenarioDevice(this.engine, f.source).id,
        ...(f.mqtt?.receiver ? [scenarioDevice(this.engine, f.mqtt.receiver).id] : []),
      ]);
    if (new Set(owners).size !== owners.length)
      throw new Error('Fluxos com estado compartilham o mesmo equipamento por nome/ID.');
    this.scenario.faults.forEach((f, i) => {
      validateScenarioFault(this.engine, f);
      this.tasks.push({ at: f.atMs, fault: i });
    });
    this.scenario.actions?.forEach((a, i) => this.tasks.push({ at: a.atMs, action: i }));
    this.scenario.assertions?.forEach((a, i) => {
      observeAssertion(this.engine, a);
      this.tasks.push({ at: a.atMs, assertion: i });
    });
    for (let at = 0; at < this.scenario.durationMs; at += this.scenario.intervalMs)
      this.scenario.flows.forEach((_, i) => this.tasks.push({ at, flow: i }));
    this.tasks.sort(
      (a, b) =>
        a.at - b.at ||
        Number(b.action !== undefined) - Number(a.action !== undefined) ||
        Number(b.fault !== undefined) - Number(a.fault !== undefined) ||
        Number(b.assertion !== undefined) - Number(a.assertion !== undefined) ||
        (a.flow ?? a.fault ?? 0) - (b.flow ?? b.fault ?? 0)
    );
  }
  private observe() {
    for (const s of this.samples.filter((s) => s.status === 'pending')) {
      const flow = this.scenario.flows.find((f) => f.name === s.flow)!;
      const d = this.engine.device(this.resolved.get(flow.source)!);
      if (flow.protocol === 'icmp') {
        const p = (flow.target.includes(':') ? this.engine.state.probes6 : this.engine.state.probes)?.find(
          (p) => p.id === s.id
        );
        if (p?.status === 'success') {
          s.responseReceived = true;
          s.elapsedMs = p.rtt;
          s.status = p.rtt! <= this.scenario.deadlineMs ? 'success' : 'failed';
          s.reason = p.rtt! > this.scenario.deadlineMs ? 'Deadline excedido' : undefined;
        } else if (p && p.status !== 'pending') {
          s.responseReceived = !['timeout', 'failed'].includes(p.status);
          s.status = 'failed';
          s.reason = p.status;
        }
      } else if (flow.protocol === 'modbus') {
        const c = d.tcpConnections?.find((c) => c.id === s.id);
        if (c?.responseAt !== undefined) {
          s.responseReceived = true;
          try {
            const response = decodeModbus(c.received.slice(0, modbusFrameLength(c.received, c.encoding)));
            const request = flow.modbus!;
            const p = response.pdu;
            const registers =
              [3, 4].includes(request.function) &&
              p.length === 2 + request.quantity * 2 &&
              p[1] === request.quantity * 2
                ? Array.from({ length: request.quantity }, (_, i) => (p[2 + i * 2] << 8) | p[3 + i * 2])
                : undefined;
            const bits =
              [1, 2].includes(request.function) &&
              p.length === 2 + Math.ceil(request.quantity / 8) &&
              p[1] === Math.ceil(request.quantity / 8)
                ? Array.from({ length: request.quantity }, (_, i) => !!(p[2 + (i >> 3)] & (1 << (i % 8))))
                : undefined;
            const written =
              request.function === 6
                ? request.values[0]
                : request.function === 5
                  ? request.values[0]
                    ? 0xff00
                    : 0
                  : request.quantity;
            const valid =
              response.transaction === request.transaction &&
              response.unit === request.unit &&
              response.function === request.function &&
              !response.exception &&
              ([3, 4].includes(request.function)
                ? Boolean(registers)
                : [1, 2].includes(request.function)
                  ? Boolean(bits)
                  : p.length === 5 &&
                    ((p[1] << 8) | p[2]) === request.address &&
                    ((p[3] << 8) | p[4]) === written) &&
              (!flow.expectedRegisters ||
                JSON.stringify(registers) === JSON.stringify(flow.expectedRegisters)) &&
              (!flow.expectedBits || JSON.stringify(bits) === JSON.stringify(flow.expectedBits));
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
      } else if (flow.protocol === 'http') {
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
          s.responseReceived = true;
          s.elapsedMs = (c.responseAt ?? c.updatedAt) - (this.started + s.atMs);
          s.status = status[1] === '200' && s.elapsedMs <= this.scenario.deadlineMs ? 'success' : 'failed';
          s.reason = 'HTTP ' + status[1];
        } else if (c && ['RESET', 'TIMED-OUT'].includes(c.state)) {
          s.status = 'failed';
          s.reason = c.state;
        }
      } else {
        const attempt = this.attempts.get(s);
        if (attempt) {
          const result = observeProtocol(this.engine, d, flow, attempt, this.started + s.atMs);
          if (result) {
            s.elapsedMs = result.at - (this.started + s.atMs);
            s.responseReceived = result.received;
            s.status = result.valid && s.elapsedMs <= this.scenario.deadlineMs ? 'success' : 'failed';
            s.reason =
              result.reason ?? (s.elapsedMs > this.scenario.deadlineMs ? 'Deadline excedido' : undefined);
          }
        }
      }
      if (
        s.status === 'pending' &&
        this.engine.state.clock >= this.started + s.atMs + this.scenario.deadlineMs
      ) {
        s.status = 'failed';
        s.reason = 'Deadline sem resposta';
      }
      if (s.status === 'failed' && !s.evidence)
        s.evidence = scenarioEvidence(
          this.engine,
          d,
          flow,
          s.id,
          this.started + s.atMs,
          this.engine.state.clock,
          Boolean(s.responseReceived)
        );
    }
  }
  step(wallMs = 20) {
    const start = performance.now();
    while (performance.now() - start < wallMs) {
      const end = this.started + this.scenario.durationMs + this.scenario.deadlineMs;
      const task = this.tasks[0];
      const taskTime = task ? this.started + task.at : end;
      const deadline = Math.min(
        ...this.samples
          .filter((s) => s.status === 'pending')
          .map((s) => this.started + s.atMs + this.scenario.deadlineMs)
      );
      // Preserve the virtual boundary across incomplete wall-time slices.
      const refreshState = this.advanceTarget === undefined;
      const target = this.advanceTarget ?? Math.min(taskTime, this.engine.state.clock + 100, deadline);
      this.advanceTarget = target;
      this.engine.advanceTo(
        target,
        20000,
        Math.max(1, Math.min(100, wallMs - (performance.now() - start))),
        refreshState
      );
      if (this.engine.state.clock < target || (this.engine.state.queue[0]?.at ?? Infinity) <= target) break;
      this.advanceTarget = undefined;
      this.observe();
      if (this.engine.state.clock < taskTime) continue;
      if (!task) return true;
      this.tasks.shift();
      if (task.action !== undefined) {
        const action = this.scenario.actions![task.action],
          beforeClock = this.engine.state.clock;
        let configurationHash: string | undefined, changedObjects: number | undefined, snapshotHash: string;
        if (action.kind === 'configure' || action.kind === 'rollback') {
          const proposal =
            action.kind === 'configure'
              ? action.changes!
              : this.configurations.get(action.checkpoint)!.rollback;
          const candidate = new SimulationEngine(this.engine.snapshot());
          const result = applyConfigurationPatch(candidate, proposal);
          const encoded = new TextEncoder().encode(canonicalScenarioJson(result.rollback));
          if (
            encoded.length + [...this.configurations.values()].reduce((n, c) => n + c.bytes, 0) >
            8 * 1024 * 1024
          )
            throw new Error('Reversões de configuração excedem 8 MiB. Divida o ensaio.');
          const hash = bytesToHex(sha256(encoded));
          if (action.kind === 'configure')
            this.configurations.set(action.checkpoint, {
              rollback: result.rollback,
              hash,
              bytes: encoded.length,
            });
          snapshotHash = this.configurations.get(action.checkpoint)!.hash;
          configurationHash =
            action.kind === 'rollback'
              ? snapshotHash
              : bytesToHex(sha256(new TextEncoder().encode(canonicalScenarioJson(proposal))));
          changedObjects = result.diff.length;
          this.engine.state = candidate.state;
          if (action.kind === 'rollback') this.configurations.delete(action.checkpoint);
        } else if (action.kind === 'checkpoint') {
          const snapshot = this.engine.snapshot(),
            encoded = new TextEncoder().encode(canonicalScenarioJson(snapshot));
          if (
            encoded.length + [...this.checkpoints.values()].reduce((n, c) => n + c.bytes, 0) >
            32 * 1024 * 1024
          )
            throw new Error('Checkpoints excedem 32 MiB. Reduza a captura ou divida o ensaio.');
          this.checkpoints.set(action.checkpoint, {
            snapshot,
            bytes: encoded.length,
            hash: bytesToHex(sha256(encoded)),
          });
          snapshotHash = this.checkpoints.get(action.checkpoint)!.hash;
        } else {
          for (const sample of this.samples.filter((s) => s.status === 'pending')) {
            sample.status = 'failed';
            sample.reason = 'Tentativa interrompida por restauração de checkpoint.';
            sample.elapsedMs = beforeClock - (this.started + sample.atMs);
            sample.responseReceived = false;
          }
          this.attempts.clear();
          const priorDrops = this.engine.state.capture?.dropped ?? 0;
          this.engine.state = new SimulationEngine(this.checkpoints.get(action.checkpoint)!.snapshot).state;
          this.restoredCaptureDrops += Math.max(0, priorDrops - (this.engine.state.capture?.dropped ?? 0));
          this.started = this.engine.state.clock - task.at;
          this.epoch++;
          snapshotHash = this.checkpoints.get(action.checkpoint)!.hash;
        }
        this.actionResults.push({
          ...action,
          epoch: this.epoch,
          beforeClock,
          afterClock: this.engine.state.clock,
          snapshotHash,
          ...(configurationHash ? { configurationHash, changedObjects } : {}),
        });
      } else if (task.fault !== undefined) {
        const f = this.scenario.faults[task.fault];
        applyScenarioFault(this.engine, f);
      } else if (task.assertion !== undefined) {
        const assertion = this.scenario.assertions![task.assertion],
          observed = observeAssertion(this.engine, assertion);
        this.assertionResults.push({
          name: assertion.name,
          atMs: assertion.atMs,
          epoch: this.epoch,
          observed,
          passed: observed === String(assertion.expected),
        });
      } else if (task.flow !== undefined) {
        const flow = this.scenario.flows[task.flow],
          sample: ScenarioSample = { flow: flow.name, atMs: task.at, status: 'pending' };
        if (this.scenario.actions) sample.epoch = this.epoch;
        this.samples.push(sample);
        try {
          sample.id =
            flow.protocol === 'icmp'
              ? flow.target.includes(':')
                ? this.engine.ping6(this.resolved.get(flow.source)!, flow.target, 64, flow.vrf, flow.scope)
                : this.engine.ping(this.resolved.get(flow.source)!, flow.target, 64, flow.vrf)
              : flow.protocol === 'modbus'
                ? modbusRequest(
                    this.engine,
                    this.engine.device(this.resolved.get(flow.source)!),
                    flow.target,
                    flow.modbus!,
                    flow.port ?? 502,
                    flow.vrf,
                    flow.scope
                  )
                : flow.protocol === 'http'
                  ? this.engine.httpGet(
                      this.resolved.get(flow.source)!,
                      flow.target,
                      flow.port ?? 80,
                      '/',
                      flow.vrf,
                      undefined,
                      flow.scope
                    )
                  : (() => {
                      const attempt = startProtocol(
                        this.engine,
                        this.engine.device(this.resolved.get(flow.source)!),
                        flow
                      );
                      this.attempts.set(sample, attempt);
                      return attempt.id;
                    })();
        } catch (e) {
          sample.status = 'failed';
          sample.reason = (e as Error).message;
        }
      }
    }
    return false;
  }
  get progress() {
    return Math.max(
      0,
      Math.min(
        1,
        (this.engine.state.clock - this.started) / (this.scenario.durationMs + this.scenario.deadlineMs)
      )
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
            ? successful.length === 0 &&
              samples.every(
                (s) =>
                  s.id &&
                  !s.responseReceived &&
                  (f.denyEvidence !== 'policy' || s.evidence?.cause === 'policy')
              )
            : lossPercent <= f.maxLossPercent &&
              (f.maxLatencyMs === undefined || latencies.every((n) => n <= f.maxLatencyMs!))),
      };
    });
    return {
      format: 'shlab-scenario-v1',
      engineVersion: '0.1.0',
      engineContract: ENGINE_CONTRACT_VERSION,
      engineBuild: ENGINE_BUILD,
      integrityVersion: 2 as const,
      name: this.scenario.name,
      clock: 'virtual-ms',
      complete: this.progress === 1,
      passed:
        this.progress === 1 && flows.every((f) => f.passed) && this.assertionResults.every((a) => a.passed),
      scenario: this.scenario,
      flows,
      samples: this.samples,
      warnings: this.warnings,
      faults: this.scenario.faults.map((f) => ({
        ...f,
        recovery: scenarioRecovery(this.scenario, this.samples, f.atMs),
      })),
      diagnostics: this.engine.state.diagnostics ?? [],
      captureDropped: (this.engine.state.capture?.dropped ?? 0) + this.restoredCaptureDrops,
      ...(this.scenario.actions ? { actions: this.actionResults } : {}),
      ...(this.scenario.assertions ? { assertions: this.assertionResults } : {}),
    };
  }
}
