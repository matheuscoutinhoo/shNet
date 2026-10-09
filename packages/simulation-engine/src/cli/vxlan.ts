import type { Device } from '../model';
import { vxlanConfig } from '../protocols/vxlan';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';
export function registerVxlanCommands(r: CommandRegistry) {
  r.register({
    pattern: /^vxlan configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      e.configureVxlan(d.id, JSON.parse(m[1]));
    },
  });
  r.register({
    pattern: /^(no )?service vxlan (\d+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.vxlan?.vni === Number(m[2]));
      if (!p) throw new Error('VNI inexistente.');
      e.configureVxlan(d.id, { ...vxlanConfig(p), enabled: !m[1] });
    },
  });
  r.register({
    pattern: /^no vxlan (\d+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.vxlan?.vni === Number(m[1]));
      if (!p) throw new Error('VNI inexistente.');
      e.removeLogicalInterface(d.id, p.id);
    },
  });
  r.register({
    pattern: /^show (vxlan|evpn)$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      JSON.stringify(
        d.interfaces.filter((p) => p.vxlan).map((p) => ({ name: p.name, ...p.vxlan })),
        null,
        2
      ),
  });
}
export function vxlanRunningConfig(d: Device) {
  return d.interfaces.filter((p) => p.vxlan).map((p) => 'vxlan configure ' + JSON.stringify(vxlanConfig(p)));
}
