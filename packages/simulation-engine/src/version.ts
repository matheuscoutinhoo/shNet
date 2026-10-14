// Increment when deterministic behavior or the scenario/report contract changes.
// A release manifest separately fingerprints the actual source and built assets.
export const ENGINE_CONTRACT_VERSION = '2026.10.13.7';
declare const __SHLAB_ENGINE_BUILD__: string;
export const ENGINE_BUILD =
  typeof __SHLAB_ENGINE_BUILD__ === 'undefined' ? 'development' : __SHLAB_ENGINE_BUILD__;
