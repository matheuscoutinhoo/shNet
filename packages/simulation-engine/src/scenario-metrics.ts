import type { Scenario } from './scenarios-model';

interface RecoverySample {
  flow: string;
  atMs: number;
  status: 'pending' | 'success' | 'failed';
  elapsedMs?: number;
}

// Recovery is an observed outage after the fault, followed by a successful response.
// It is not a causal attribution: concurrent faults can contribute to the same outage.
export function scenarioRecovery(scenario: Scenario, samples: RecoverySample[], atMs: number) {
  return scenario.flows.map((flow) => {
    const observations = samples.filter((s) => s.flow === flow.name && s.atMs >= atMs);
    const failed = observations.findIndex((s) => s.status === 'failed');
    const recovered =
      failed >= 0 ? observations.slice(failed + 1).find((s) => s.status === 'success') : undefined;
    return {
      flow: flow.name,
      recoveryMs: recovered ? recovered.atMs + recovered.elapsedMs! - atMs : null,
      observedFailure: failed >= 0,
      resolutionMs: scenario.intervalMs,
    };
  });
}
