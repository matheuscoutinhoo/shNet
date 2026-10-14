// Entry point for execution contexts: no templates, lessons or UI catalog exports.
export { SimulationEngine } from './core/engine';
export { SimulationRunner, applySimulationDelta } from './core/runner';
export { validateSnapshot } from './core/validation';
export { ScenarioRunner } from './scenarios';
export type { Snapshot, Device, NetworkEvent } from './model';
