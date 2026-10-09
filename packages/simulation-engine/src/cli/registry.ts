import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface } from '../model';
export type Mode = 'user' | 'privileged' | 'config' | 'interface' | 'vlan' | 'dhcp';
export const CONFIG_MODES: Mode[] = ['config', 'interface', 'vlan', 'dhcp'];
export const ALL_MODES: Mode[] = ['user', 'privileged', ...CONFIG_MODES];
export interface Context {
  mode: Mode;
  port?: string;
  vlan?: number;
  pool?: string;
}
export interface Command {
  pattern: RegExp;
  modes: Mode[];
  run: (match: RegExpMatchArray, engine: SimulationEngine, device: Device, context: Context) => string | void;
}
export function currentPort(d: Device, c: Context): NetworkInterface {
  const p = d.interfaces.find((i) => i.id === c.port);
  if (!p) throw new Error('Selecione uma interface');
  return p;
}
export class CommandRegistry {
  private commands: Command[] = [];
  register(command: Command) {
    this.commands.push(command);
    return this;
  }
  execute(input: string, e: SimulationEngine, d: Device, c: Context) {
    for (const command of this.commands) {
      const match = input.match(command.pattern);
      if (match) {
        if (!command.modes.includes(c.mode))
          throw new Error('Comando indisponível neste modo. Use enable / configure terminal.');
        return command.run(match, e, d, c) ?? 'OK';
      }
    }
    throw new Error('Comando não reconhecido. Digite help.');
  }
}
