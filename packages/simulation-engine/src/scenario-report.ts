import { canonicalScenarioJson } from './canonical-json';
import { z } from 'zod';
import { eventSchema } from './model';
import { scenarioSchema } from './scenarios-model';
import { scenarioRecovery } from './scenario-metrics';
import { ENGINE_CONTRACT_VERSION } from './version';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
const ms = z.number().finite().nonnegative();
const name = z.string().min(1).max(100);
function finalDenialSemantics(contract?: string) {
  const parts = contract?.split('.').map(Number),
    boundary = [2026, 10, 15, 9];
  if (!parts || parts.length !== 4 || parts.some((v) => !Number.isInteger(v))) return false;
  const different = parts.findIndex((v, i) => v !== boundary[i]);
  return different === -1 || parts[different] > boundary[different];
}
const sampleSchema = z
  .object({
    flow: name,
    atMs: ms,
    epoch: z.number().int().nonnegative().max(16).optional(),
    id: z.string().min(1).max(100).optional(),
    status: z.enum(['pending', 'success', 'failed']),
    elapsedMs: ms.optional(),
    reason: z.string().max(2000).optional(),
    responseReceived: z.boolean().optional(),
    evidence: z
      .object({
        cause: z.enum(['policy', 'link', 'transport', 'response', 'timeout', 'unknown']),
        events: z
          .array(
            z
              .object({
                id: z.string().max(100),
                atMs: ms,
                device: z.string().max(100),
                type: eventSchema.shape.type,
                reason: z.string().max(500),
              })
              .strict()
          )
          .max(16),
        path: z.array(z.string().max(100)).max(64),
        hops: z
          .array(
            z
              .object({
                id: z.string().max(100),
                atMs: ms,
                device: z.string().max(100),
                port: z.string().max(80).optional(),
                direction: z.enum(['sent', 'received']),
              })
              .strict()
          )
          .max(128)
          .optional(),
        truncated: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const scenarioReportSchema = z
  .object({
    format: z.literal('shlab-scenario-v1'),
    engineVersion: z.string().min(1).max(32),
    engineContract: z.string().min(1).max(32).optional(),
    engineBuild: z.union([z.literal('development'), z.string().regex(/^[a-f0-9]{64}$/)]).optional(),
    engineArtifact: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    integrityVersion: z.literal(2).optional(),
    name,
    clock: z.literal('virtual-ms'),
    complete: z.literal(true),
    passed: z.boolean(),
    scenario: scenarioSchema,
    flows: z
      .array(
        z
          .object({
            name,
            expect: z.enum(['allow', 'deny']),
            sent: z.number().int().min(1).max(180),
            received: z.number().int().min(0).max(180),
            lossPercent: z.number().min(0).max(100),
            p95Ms: ms.nullable(),
            p99Ms: ms.nullable(),
            jitterP95Ms: ms.nullable(),
            passed: z.boolean(),
          })
          .strict()
      )
      .min(1)
      .max(16),
    samples: z.array(sampleSchema).min(1).max(180),
    warnings: z
      .array(
        z
          .object({
            code: name,
            severity: z.enum(['error', 'warning', 'info']),
            devices: z.array(z.string().max(100)).max(2000),
            message: z.string().max(2000),
            recommendation: z.string().max(2000),
          })
          .strict()
      )
      .max(5000),
    faults: z
      .array(
        z
          .object({
            ...scenarioSchema.shape.faults.element.shape,
            recovery: z
              .array(
                z
                  .object({
                    flow: name,
                    recoveryMs: ms.nullable(),
                    observedFailure: z.boolean(),
                    resolutionMs: ms,
                    recoveryResponseAtMs: ms.nullable().optional(),
                    firstFailedAttemptAtMs: ms.nullable().optional(),
                    measurement: z.literal('response-timestamp').optional(),
                  })
                  .strict()
              )
              .max(16),
          })
          .strict()
      )
      .max(32),
    diagnostics: z.array(eventSchema).max(4000),
    captureDropped: z.number().int().nonnegative(),
    actions: z
      .array(
        z
          .object({
            ...scenarioSchema.shape.actions.unwrap().element.shape,
            epoch: z.number().int().nonnegative().max(16),
            beforeClock: ms,
            afterClock: ms,
            snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
            configurationHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            changedObjects: z.number().int().nonnegative().max(200000).optional(),
          })
          .strict()
      )
      .max(16)
      .optional(),
    assertions: z
      .array(
        z
          .object({
            name,
            atMs: ms,
            epoch: z.number().int().nonnegative().max(16),
            observed: z.string().max(100),
            passed: z.boolean(),
          })
          .strict()
      )
      .max(64)
      .optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const names = r.scenario.flows.map((f) => f.name);
    const actions = [...(r.scenario.actions ?? [])].sort((a, b) => a.atMs - b.atMs);
    if (actions.length !== (r.actions?.length ?? 0))
      ctx.addIssue({ code: 'custom', message: 'Ações incompletas.' });
    const hashes = new Map<string, string>(),
      configurations = new Map<string, string>();
    let epoch = 0;
    r.actions?.forEach((result, i) => {
      const expected = actions[i],
        {
          beforeClock,
          afterClock,
          snapshotHash,
          configurationHash,
          changedObjects,
          epoch: recordedEpoch,
          ...action
        } = result;
      if (action.kind === 'checkpoint') hashes.set(action.checkpoint, snapshotHash);
      else if (action.kind === 'restore') epoch++;
      else if (action.kind === 'configure') configurations.set(action.checkpoint, snapshotHash);
      const patch = ['configure', 'rollback'].includes(action.kind);
      if (
        canonicalScenarioJson(expected) !== canonicalScenarioJson(action) ||
        recordedEpoch !== epoch ||
        (action.kind !== 'restore' && beforeClock !== afterClock) ||
        (action.kind === 'restore' && hashes.get(action.checkpoint) !== snapshotHash) ||
        (patch && (configurationHash === undefined || changedObjects === undefined)) ||
        (action.kind === 'configure' &&
          configurationHash !==
            bytesToHex(sha256(new TextEncoder().encode(canonicalScenarioJson(action.changes))))) ||
        (!patch && (configurationHash !== undefined || changedObjects !== undefined)) ||
        (action.kind === 'rollback' &&
          (configurations.get(action.checkpoint) !== snapshotHash || configurationHash !== snapshotHash))
      )
        ctx.addIssue({ code: 'custom', message: 'Evidência de checkpoint divergente.' });
      if (action.kind === 'rollback') configurations.delete(action.checkpoint);
    });
    if (
      r.scenario.actions &&
      r.samples.some(
        (s) => s.epoch !== r.actions!.filter((a) => a.kind === 'restore' && a.atMs <= s.atMs).length
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Amostra pertence a outra época da simulação.' });
    const assertions = [...(r.scenario.assertions ?? [])].sort((a, b) => a.atMs - b.atMs);
    if (assertions.length !== (r.assertions?.length ?? 0))
      ctx.addIssue({ code: 'custom', message: 'Assertions incompletas.' });
    r.assertions?.forEach((a, i) => {
      const definition = assertions[i];
      if (
        !definition ||
        a.name !== definition.name ||
        a.atMs !== definition.atMs ||
        a.passed !== (a.observed === String(definition.expected)) ||
        a.epoch !== (r.actions ?? []).filter((r) => r.kind === 'restore' && r.atMs <= a.atMs).length
      )
        ctx.addIssue({ code: 'custom', message: 'Resumo de assertion divergente.' });
    });
    if (
      r.name !== r.scenario.name ||
      r.flows.length !== names.length ||
      r.samples.some(
        (s) => !names.includes(s.flow) || s.status === 'pending' || s.atMs >= r.scenario.durationMs
      ) ||
      r.faults.length !== r.scenario.faults.length ||
      r.passed !== (r.flows.every((f) => f.passed) && (r.assertions ?? []).every((a) => a.passed))
    )
      ctx.addIssue({ code: 'custom', message: 'Relatório incompleto ou incompatível com a definição.' });
    r.flows.forEach((f, i) => {
      const samples = r.samples.filter((s) => s.flow === f.name),
        successful = samples.filter((s) => s.status === 'success'),
        received = successful.length;
      const flow = r.scenario.flows[i];
      const latencies = successful.flatMap((s) => (s.elapsedMs !== undefined ? [s.elapsedMs] : []));
      const percentile = (values: number[], p: number) =>
        values.length
          ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]
          : null;
      const jitter = latencies.slice(1).map((n, i) => Math.abs(n - latencies[i]));
      const passed =
        (!flow.requireFinalSuccess ||
          (flow.expect === 'deny' && finalDenialSemantics(r.engineContract)) ||
          samples.at(-1)?.status === 'success') &&
        (flow.expect === 'deny'
          ? received === 0 &&
            samples.every(
              (s) =>
                s.id &&
                !s.responseReceived &&
                (flow.denyEvidence !== 'policy' || s.evidence?.cause === 'policy')
            )
          : (100 * (samples.length - received)) / samples.length <= flow.maxLossPercent &&
            (flow.maxLatencyMs === undefined || successful.every((s) => s.elapsedMs! <= flow.maxLatencyMs!)));
      if (
        f.name !== names[i] ||
        f.expect !== r.scenario.flows[i].expect ||
        f.sent !== samples.length ||
        f.received !== received ||
        Math.abs(f.lossPercent - (100 * (samples.length - received)) / samples.length) > 0.000001 ||
        samples.length !== Math.ceil(r.scenario.durationMs / r.scenario.intervalMs) ||
        samples.some(
          (s, i) =>
            s.atMs !== i * r.scenario.intervalMs ||
            (s.status === 'success' && (s.elapsedMs === undefined || s.elapsedMs > r.scenario.deadlineMs))
        ) ||
        f.passed !== passed ||
        f.p95Ms !== percentile(latencies, 0.95) ||
        f.p99Ms !== percentile(latencies, 0.99) ||
        f.jitterP95Ms !== percentile(jitter, 0.95)
      )
        ctx.addIssue({ code: 'custom', message: 'Resumo de fluxo divergente das amostras.' });
    });
    r.faults.forEach((f, i) => {
      const { recovery, ...fault } = f;
      if (
        canonicalScenarioJson(fault) !== canonicalScenarioJson(r.scenario.faults[i]) ||
        recovery.length !== names.length ||
        canonicalScenarioJson(recovery) !==
          canonicalScenarioJson(
            scenarioRecovery(
              r.scenario,
              r.samples,
              f.atMs,
              r.engineContract === ENGINE_CONTRACT_VERSION ||
                r.engineContract === '2026.10.13.7' ||
                r.engineContract === '2026.10.14.1' ||
                r.engineContract === '2026.10.14.2' ||
                r.engineContract === '2026.10.15.1' ||
                r.engineContract === '2026.10.15.2' ||
                r.engineContract === '2026.10.15.3' ||
                r.engineContract === '2026.10.15.4' ||
                recovery.some((v) => v.measurement !== undefined)
            )
          )
      )
        ctx.addIssue({ code: 'custom', message: 'Falhas e recuperação divergentes da definição.' });
    });
  });
export type ScenarioReport = z.infer<typeof scenarioReportSchema>;
// Stable JSON ordering fingerprints JSONB snapshots independently of key order.
export { canonicalScenarioJson } from './canonical-json';
