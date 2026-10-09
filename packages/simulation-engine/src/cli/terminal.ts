import { accountTacacs } from '../protocols/tacacs';
import { redactNetworkSecrets } from './aaa';
import type { SimulationEngine } from '../core/engine';
import type { Context } from './registry';
import { makeRegistry } from './commands';
import { validateSnapshot } from '../core/validation';
import { terminalText } from './tcp';
export class TerminalSession {
  context: Context = { mode: 'user' };
  history: string[] = [];
  private registry = makeRegistry();
  constructor(
    readonly engine: SimulationEngine,
    readonly deviceId: string
  ) {}
  get prompt() {
    const suffix = {
      user: '>',
      privileged: '#',
      config: '(config)#',
      interface: '(config-if)#',
      vlan: '(config-vlan)#',
      dhcp: '(config-dhcp)#',
    }[this.context.mode];
    return this.engine.device(this.deviceId).hostname + suffix;
  }
  execute(input: string) {
    const line = input.trim();
    if (!line) return '';
    if (line.length > 512 || [...line].some((c) => c.charCodeAt(0) < 32)) return '% Entrada inválida';
    this.history.push(redactNetworkSecrets(line));
    if (this.history.length > 200) this.history.shift();
    const before = this.engine.snapshot();
    const context = { ...this.context };
    try {
      const d = this.engine.device(this.deviceId);
      if (
        d.aaaClient?.enforceCli &&
        !/^(show|help|\?|aaa (?:login|logout)|ping|traceroute|nslookup|tcp|http|snmp (?:get|get-next)|syslog send|enable|end|exit)(?:\s|$)/i.test(
          line
        ) &&
        (!d.networkAuth || d.networkAuth.expiresAt <= this.engine.state.clock || d.networkAuth.privilege < 15)
      )
        throw new Error('AAA: configuração exige login de rede com privilégio 15.');
      if (
        d.aaaClient?.enforceCli &&
        d.networkAuth &&
        d.networkAuth.expiresAt > this.engine.state.clock &&
        !/^(help|\?|aaa (?:login|logout)|exit|end|enable)(?:\s|$)/i.test(line) &&
        !d.networkAuth.commands.some(
          (prefix) =>
            prefix === '*' ||
            line.toLowerCase() === prefix.toLowerCase() ||
            line.toLowerCase().startsWith(prefix.toLowerCase() + ' ')
        )
      )
        throw new Error('AAA: comando não autorizado pela política do servidor.');
      const result = this.registry.execute(
        line,
        this.engine,
        this.engine.device(this.deviceId),
        this.context
      );
      if (!/^aaa (?:login|logout)(?:\s|$)/i.test(line))
        accountTacacs(this.engine, d, redactNetworkSecrets(line));
      this.engine.refreshSpanningTree();
      this.engine.refreshBgp();
      validateSnapshot(this.engine.state);
      if (
        !/^(show|help|\?|ping|traceroute|nslookup|tcp|http|snmp (?:get|get-next)|syslog send|enable|end|exit|conf)/i.test(
          line
        )
      )
        this.engine.emit(
          'CONFIG_CHANGED',
          this.deviceId,
          'Comando aplicado: ' +
            redactNetworkSecrets(line)
              .replace(/^(snmp-server community) .+$/i, '$1 [redacted]')
              .replace(/(wireless .+ security .+ key) \S+/i, '$1 [redacted]')
              .replace(/(sdwan site .+ key) \S+/i, '$1 [redacted]')
              .replace(/("key"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
        );
      return terminalText(result);
    } catch (error) {
      this.engine.state = before;
      this.context = context;
      return '% ' + (error instanceof Error ? error.message : 'Comando inválido');
    }
  }
}
