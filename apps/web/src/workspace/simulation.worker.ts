import { SimulationRunner } from '@shlab/engine';
let runner: SimulationRunner | undefined,
  generation = 0;
self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  try {
    if (message.kind === 'load') {
      generation = message.generation;
      runner = new SimulationRunner(message.snapshot);
      self.postMessage({ kind: 'ready', generation });
    } else if (message.kind === 'step' && message.generation === generation && runner)
      self.postMessage({
        kind: 'delta',
        generation,
        delta: runner.step(message.maxSteps, runner.engine.state.devices.length > 200 ? 50 : 20),
      });
  } catch (error) {
    self.postMessage({
      kind: 'error',
      generation,
      message: error instanceof Error ? error.message : 'Falha no Worker.',
    });
  }
};
