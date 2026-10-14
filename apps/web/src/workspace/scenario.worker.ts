import { ScenarioRunner } from '@shlab/engine/runtime';
let run = 0;
self.onmessage = (event: MessageEvent) => {
  const generation = ++run;
  try {
    const runner = new ScenarioRunner(event.data.snapshot, event.data.scenario);
    let lastUpdate = 0;
    const next = () => {
      if (generation !== run) return;
      try {
        const complete = runner.step(20);
        if (complete)
          self.postMessage({
            kind: 'complete',
            report: {
              ...runner.report(),
              ...(event.data.artifact ? { engineArtifact: event.data.artifact } : {}),
            },
          });
        else {
          if (performance.now() - lastUpdate > 100) {
            self.postMessage({ kind: 'progress', progress: runner.progress });
            lastUpdate = performance.now();
          }
          setTimeout(next, 0);
        }
      } catch (e) {
        self.postMessage({ kind: 'error', message: (e as Error).message });
      }
    };
    next();
  } catch (e) {
    self.postMessage({ kind: 'error', message: (e as Error).message });
  }
};
