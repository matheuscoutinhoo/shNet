import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface } from '../model';
import { commandSupported, terminalIdentity } from './device-commands';
import { expandCommand, nextKeywords, type Syntax } from './syntax';
export type Mode =
  | 'user'
  | 'privileged'
  | 'config'
  | 'interface'
  | 'vlan'
  | 'dhcp'
  | 'router'
  | 'address-family'
  | 'acl'
  | 'line'
  | 'vrf'
  | 'mst'
  | 'archive'
  | 'ip-sla'
  | 'route-map'
  | 'class-map'
  | 'policy-map'
  | 'policy-class'
  | 'key-chain'
  | 'key-chain-key'
  | 'bfd-template';
export const CONFIG_MODES: Mode[] = [
  'config',
  'interface',
  'vlan',
  'dhcp',
  'router',
  'address-family',
  'acl',
  'line',
  'vrf',
  'mst',
  'archive',
  'ip-sla',
  'route-map',
  'class-map',
  'policy-map',
  'policy-class',
  'key-chain','key-chain-key','bfd-template',
];
export const ALL_MODES: Mode[] = ['user', 'privileged', ...CONFIG_MODES];
export const EXEC_MODES: Mode[] = ['user', 'privileged'];
/** IOS global configuration commands: typed in a sub-mode, they run in and return to (config). */
export const GLOBAL_ONLY =
  /^(?:no )?(?:hostname|ip route|ipv6 route|ip name-server|ip domain|ip default-gateway|ip routing|ipv6 unicast-routing|ip multicast-routing|ip cef|ip ssh|ip http|ip dhcp (?:excluded-address|snooping(?: vlan|$))|ip nat (?:inside|outside) source|ip nat pool|ip sla schedule|access-list|enable (?:secret|password|algorithm-type)|username|banner|service |logging |snmp-server|ntp |clock |cdp run|lldp run|vtp |track |spanning-tree (?:mode|vlan|mst \d|loopguard default|portfast (?:default|bpduguard)|extend))/i;
export interface Context {
  mode: Mode;
  port?: string;
  vlan?: number;
  pool?: string;
  ports?: string[];
  router?: 'ospf' | 'bgp' | 'rip';
  process?: number;
  acl?: string;
  aclType?: 'standard' | 'extended';
  line?: 'console' | 'vty';
  vrf?: string;
  sla?: number;
  name?: string;
  sequence?: number;
  className?: string;
  auth?: { kind: 'enable'; attempts: number };
  // Pending IOS reload dialog: "Save? [yes/no]" (save) then "Proceed with reload? [confirm]" (reload).
  confirm?: { kind: 'save' | 'reload' };
}
export interface Command {
  pattern: RegExp;
  modes: Mode[];
  syntax?: string | string[];
  available?: (device: Device, context: Context) => boolean;
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
  private syntax(d: Device, c: Context): Syntax[] {
    return this.commands.flatMap((command) => {
      if (!command.modes.includes(c.mode)) return [];
      if (command.available && !command.available(d, c)) return [];
      // A literal prefix also exposes the existing simulator extensions to help.
      const prefix = command.pattern.source
        .replace(/^\^/, '')
        .match(/^[a-z][a-z0-9 -]*/i)?.[0]
        ?.trim();
      const forms = command.syntax
        ? Array.isArray(command.syntax)
          ? command.syntax
          : [command.syntax]
        : prefix
          ? [prefix + (command.pattern.source === '^' + prefix + '$' ? '' : ' <arguments...>')]
          : [];
      return forms
        .filter((form) => commandSupported(d, form, c))
        .map((form) => ({ words: form.split(' '), modes: command.modes }));
    });
  }
  normalize(input: string, d: Device, c: Context): string {
    if (terminalIdentity(d).host) return input;
    if (/^do\s+/i.test(input)) {
      if (!CONFIG_MODES.includes(c.mode)) throw new Error('do is available in configuration modes only.');
      return 'do ' + this.normalize(input.replace(/^do\s+/i, ''), d, { mode: 'privileged' });
    }
    if (this.commands.some((command) => command.pattern.test(input))) return input;
    try {
      return expandCommand(input, this.syntax(d, c));
    } catch (error) {
      // Abbreviations of parent-mode commands are expanded like IOS implicit exits.
      for (let parent = parentContext(c); parent; parent = parentContext(parent))
        try {
          return expandCommand(input, this.syntax(d, parent));
        } catch {
          /* Try the next parent mode. */
        }
      throw error;
    }
  }
  help(input: string, d: Device, c: Context): string {
    if (/^do\s/i.test(input) && CONFIG_MODES.includes(c.mode))
      return this.help(input.replace(/^do\s+/i, ''), d, { mode: 'privileged' });
    return (
      nextKeywords(input, this.syntax(d, c))
        .map((word) => '  ' + word)
        .join('\n') || '% Invalid input'
    );
  }
  complete(input: string, d: Device, c: Context): string {
    if (/^do\s/i.test(input) && CONFIG_MODES.includes(c.mode))
      return 'do ' + this.complete(input.replace(/^do\s+/i, ''), d, { mode: 'privileged' });
    const split = input.lastIndexOf(' '),
      head = input.slice(0, split + 1),
      tail = input.slice(split + 1);
    const words = nextKeywords(head.trim(), this.syntax(d, c)).filter(
      (w) => !w.startsWith('<') && w.toLowerCase().startsWith(tail.toLowerCase())
    );
    return words.length === 1 ? head + words[0] + ' ' : input;
  }
  private find(input: string, d: Device, c: Context) {
    let wrongMode = false;
    for (const command of this.commands) {
      const match = input.match(command.pattern);
      if (!match) continue;
      if (!commandSupported(d, input, c))
        throw new Error(
          'Este comando não se aplica a ' +
            terminalIdentity(d).name +
            '. Digite help para os comandos deste equipamento.'
        );
      if (!terminalIdentity(d).host && CONFIG_MODES.includes(c.mode) && /^show\s/i.test(input))
        throw new Error('EXEC command requires do in configuration mode.');
      if (!terminalIdentity(d).host && c.mode === 'user' && /^show (?:running|startup)-config$/i.test(input))
        throw new Error('Privileged EXEC mode required. Use enable.');
      if (!command.modes.includes(c.mode)) {
        wrongMode = true;
        continue;
      }
      if (command.available && !command.available(d, c)) continue;
      return { command, match, wrongMode };
    }
    return { wrongMode };
  }
  private run(command: Command, match: RegExpMatchArray, input: string, e: SimulationEngine, d: Device, c: Context) {
    if (c.ports?.length && c.mode === 'interface' && !/^interface\s/i.test(input)) {
      const [first, ...rest] = c.ports;
      const work: Context = { ...c, port: first, ports: undefined };
      const output = command.run(match, e, d, work) ?? 'OK';
      // exit, end and global commands leave the range once instead of running per member.
      if (work.mode !== 'interface' || work.port !== first) {
        replaceContext(c, work);
        return output;
      }
      if (GLOBAL_ONLY.test(input)) {
        replaceContext(c, { mode: 'config' });
        return output;
      }
      for (const id of rest) command.run(match, e, d, { ...c, port: id, ports: undefined });
      return output;
    }
    const mode = c.mode;
    const output = command.run(match, e, d, c) ?? 'OK';
    // IOS executes a global command typed in a sub-mode in global configuration mode.
    if (mode !== 'config' && c.mode === mode && CONFIG_MODES.includes(mode) && GLOBAL_ONLY.test(input))
      replaceContext(c, { mode: 'config' });
    return output;
  }
  execute(input: string, e: SimulationEngine, d: Device, c: Context): string {
    if (/^do\s+/i.test(input)) {
      if (terminalIdentity(d).host || !CONFIG_MODES.includes(c.mode))
        throw new Error('do is available in configuration modes only.');
      const inner = input.replace(/^do\s+/i, '');
      if (/^do\s/i.test(inner)) throw new Error('Nested do is invalid.');
      return this.execute(inner, e, d, { mode: 'privileged' });
    }
    const found = this.find(input, d, c);
    if (found.command) return this.run(found.command, found.match, input, e, d, c);
    // IOS implicit exit: a command that belongs to a parent configuration mode runs there.
    if (!terminalIdentity(d).host)
      for (let parent = parentContext(c); parent; parent = parentContext(parent)) {
        const up = this.find(input, d, parent);
        if (up.command) {
          replaceContext(c, parent);
          return this.run(up.command, up.match, input, e, d, c);
        }
      }
    if (terminalIdentity(d).host) {
      if (found.wrongMode) throw new Error('Comando indisponível neste modo. Use enable / configure terminal.');
      throw new Error('Comando não reconhecido. Digite help.');
    }
    if (found.wrongMode) throw new Error('Command not available in this mode. Use enable or configure terminal.');
    throw new Error("Invalid input detected at '^' marker.");
  }
}
/** Parent configuration context used by "exit" and by IOS implicit sub-mode exits. */
export function parentContext(c: Context): Context | undefined {
  if (!CONFIG_MODES.includes(c.mode) || c.mode === 'config') return undefined;
  if (c.mode === 'policy-class') return { mode: 'policy-map', name: c.name };
  if (c.mode === 'key-chain-key') return { mode: 'key-chain', name: c.name };
  if (c.mode === 'address-family')
    return c.vrf ? { mode: 'vrf', vrf: c.vrf } : { mode: 'router', router: c.router, process: c.process };
  return { mode: 'config' };
}
function replaceContext(c: Context, next: Context) {
  for (const key of Object.keys(c)) Reflect.deleteProperty(c, key);
  Object.assign(c, next);
}
