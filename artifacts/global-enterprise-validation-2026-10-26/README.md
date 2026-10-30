# Six-site enterprise validation evidence

Read the [engineering report](../../docs/global-enterprise-validation-2026-10-26.md) and [verification summary](verification.json).

- `global-enterprise.shlab.json`: original failing configuration order.
- `global-enterprise-workaround.shlab.json`: Rapid PVST reapplied after routed-port configuration.
- `global-enterprise-converged.shlab.json`: same workaround topology at 65 seconds; useful for quick import and review.
- `ui-exported.shlab.json`: actual export after UI import, CLI, scenario, server replay and project persistence checks.

DHCP remains unavailable through the intended multilayer-switch SVIs. The workaround does not resolve that limitation. These files are synthetic test networks and contain no real enterprise configuration.

The original unrestricted run was interrupted because the forwarding storm prevented warmup completion. `profile-convergence.ts` and `diagnose-flood.ts` reproduce it with bounded work. The builder now exits after creating its artifacts unless `--run-original` is supplied.

`browser-attempt1.json` and `browser-attempt2.json` are preserved harness failures (xterm viewport and collapsed report); `browser-results.json` records the final passing end-to-end run. Their traces remain under `.data/global-enterprise-validation-2026-10-26/`. The screenshot named `scenario-failure.png` shows the second harness failure; the application had already completed and saved the scenario.

The test server uses built web assets and an in-memory database. All durable deliverables are in this directory; importing a topology does not require that disposable test account/database.
