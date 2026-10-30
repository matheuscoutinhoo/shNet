import { accountTacacs } from '../protocols/tacacs';
import { redactNetworkSecrets } from './aaa';
import type { SimulationEngine } from '../core/engine';
import { changedSince, type StateMark } from '../core/state-mark';
import type { Context } from './registry';
import { makeRegistry } from './commands';
import { validateSnapshot } from '../core/validation';
import { terminalText } from './tcp';
import { terminalIdentity } from './device-commands';
import { CONFIG_MODES } from './registry';
import { verifyIosSecret } from './local-security';
import { refreshInterfacePat } from '../protocols/nat';
import { reloadStartup, saveStartup } from './startup';
export class TerminalSession {
  context: Context = { mode: 'user' };
  history: string[] = [];
  /** State before the last successful mutating command, for undo history (see StateMark). */
  lastMark?: StateMark;
  private registry = makeRegistry();
  constructor(
    readonly engine: SimulationEngine,
    readonly deviceId: string
  ) {}
  get identity() {
    return terminalIdentity(this.engine.device(this.deviceId));
  }
  get prompt() {
    if (this.secretInput) return 'Password:';
    if (this.context.confirm)
      return this.context.confirm.kind === 'save'
        ? 'System configuration has been modified. Save? [yes/no]:'
        : 'Proceed with reload? [confirm]';
    const suffix = {
      user: this.identity.host ? '$' : '>',
      privileged: '#',
      config: '(config)#',
      interface: '(config-if)#',
      vlan: '(config-vlan)#',
      dhcp: '(config-dhcp)#',
      router: '(config-router)#',
      'address-family': '(config-router-af)#',
      acl: this.context.aclType === 'standard' ? '(config-std-nacl)#' : '(config-ext-nacl)#',
      line: '(config-line)#',
      vrf: '(config-vrf)#',
      mst: '(config-mst)#',
      archive: '(config-archive)#',
      'ip-sla': '(config-ip-sla)#',
      'route-map': '(config-route-map)#',
      'class-map': '(config-cmap)#',
      'policy-map': '(config-pmap)#',
      'policy-class': '(config-pmap-c)#',
      'key-chain':'(config-keychain)#',
      'key-chain-key':'(config-keychain-key)#',
      'bfd-template':'(config-bfd)#',
    }[this.context.mode];
    return (
      this.engine.device(this.deviceId).hostname +
      (this.context.ports?.length && this.context.mode === 'interface' ? '(config-if-range)#' : suffix)
    );
  }
  get secretInput() {
    return !!this.context.auth;
  }
  displayInput(input: string) {
    if (this.secretInput) return '';
    if (this.context.confirm) return input;
    try {
      const canonical = this.registry.normalize(
          input.trim(),
          this.engine.device(this.deviceId),
          this.context
        ),
        safe = redactNetworkSecrets(canonical);
      return safe === canonical ? input : safe;
    } catch {
      return redactNetworkSecrets(input);
    }
  }
  cancel() {
    delete this.context.auth;
    delete this.context.confirm;
  }
  help(input: string) {
    if (this.secretInput || this.context.confirm) return '';
    try {
      return this.registry.help(input, this.engine.device(this.deviceId), this.context);
    } catch (error) {
      return '% ' + (error instanceof Error ? error.message : 'Invalid input');
    }
  }
  complete(input: string) {
    if (this.secretInput || this.context.confirm) return input;
    try {
      return this.registry.complete(input, this.engine.device(this.deviceId), this.context);
    } catch {
      return input;
    }
  }
  end() {
    if (CONFIG_MODES.includes(this.context.mode)) this.context = { mode: 'privileged' };
  }
  private answerReload(answer: string) {
    const before = this.engine.checkpoint(),
      kind = this.context.confirm!.kind;
    try {
      const d = this.engine.device(this.deviceId);
      if (kind === 'save') {
        if (/^no?$/.test(answer)) {
          this.context.confirm = { kind: 'reload' };
          return '';
        }
        if (!/^y(?:es?)?$/.test(answer)) return "% Please answer 'yes' or 'no'.";
        const saved = saveStartup(this.engine, d, this.registry);
        this.context.confirm = { kind: 'reload' };
        return saved;
      }
      delete this.context.confirm;
      // As on IOS, Enter or "y" confirms; any other answer cancels.
      if (answer && !/^(?:y|yes|confirm)$/.test(answer)) return '';
      const output = reloadStartup(this.engine, d, this.registry);
      this.context = { mode: 'user' };
      return output;
    } catch (error) {
      this.engine.state = before;
      delete this.context.confirm;
      return '% ' + cliErrorText(error);
    }
  }
  execute(input: string) {
    this.lastMark = undefined;
    if (this.context.auth) {
      const secret = this.engine.device(this.deviceId).enableSecret;
      if (secret && verifyIosSecret(input, secret)) {
        delete this.context.auth;
        this.context.mode = 'privileged';
        return '';
      }
      if (++this.context.auth.attempts >= 3) delete this.context.auth;
      return '% Bad secrets';
    }
    if (this.context.confirm) return this.answerReload(input.trim().toLowerCase());
    let line = input.trim();
    if (!line) return '';
    if (line.length > 512 || [...line].some((c) => c.charCodeAt(0) < 32)) return '% Entrada inválida';
    if (line.startsWith('!')) return '';
    if (line.endsWith('?')) return this.help(line.slice(0, -1).trimEnd());
    const context = { ...this.context };
    let before: StateMark | undefined;
    try {
      const d = this.engine.device(this.deviceId);
      const filter = /\s*\|\s*(include|exclude|begin)\s+(.+)$/i.exec(line);
      if (filter) line = line.slice(0, filter.index).trimEnd();
      line = this.registry.normalize(line, d, this.context);
      const safe = redactNetworkSecrets(line);
      this.history.push(safe === line ? input.trim() : safe);
      if (this.history.length > 200) this.history.shift();
      const authorized = line.replace(/^do\s+/i, '');
      if (
        d.aaaClient?.enforceCli &&
        !/^(show|help|\?|aaa (?:login|logout)|ping|traceroute|nslookup|tcp|http|snmp (?:get|get-next)|syslog send|enable|end|exit)(?:\s|$)/i.test(
          authorized
        ) &&
        (!d.networkAuth || d.networkAuth.expiresAt <= this.engine.state.clock || d.networkAuth.privilege < 15)
      )
        throw new Error('AAA: configuração exige login de rede com privilégio 15.');
      if (
        d.aaaClient?.enforceCli &&
        d.networkAuth &&
        d.networkAuth.expiresAt > this.engine.state.clock &&
        !/^(help|\?|aaa (?:login|logout)|exit|end|enable)(?:\s|$)/i.test(authorized) &&
        !d.networkAuth.commands.some(
          (prefix) =>
            prefix === '*' ||
            authorized.toLowerCase() === prefix.toLowerCase() ||
            authorized.toLowerCase().startsWith(prefix.toLowerCase() + ' ')
        )
      )
        throw new Error('AAA: comando não autorizado pela política do servidor.');
      // Reads and mode changes need no rollback point, protocol refresh or revalidation.
      const readOnly = READ_ONLY.test(authorized);
      if (!readOnly) before = this.engine.mark();
      let result = this.registry.execute(line, this.engine, this.engine.device(this.deviceId), this.context);
      if (!readOnly) refreshInterfacePat(this.engine, this.engine.device(this.deviceId));
      if (filter) {
        if (!/^show\s/i.test(authorized)) throw new Error('Output filters require a show command.');
        if (filter[2].length > 128 || /[(){}+*?\\]/.test(filter[2]))
          throw new Error('Use a literal text or alternatives separated by |.');
        const needles = filter[2].split('|').filter(Boolean),
          lines = result.split('\n');
        const matches = (text: string) => needles.some((needle) => text.includes(needle));
        result =
          filter[1].toLowerCase() === 'begin'
            ? lines.slice(lines.findIndex(matches) < 0 ? lines.length : lines.findIndex(matches)).join('\n')
            : lines.filter((text) => matches(text) !== (filter[1].toLowerCase() === 'exclude')).join('\n');
      }
      if (!/^aaa (?:login|logout)(?:\s|$)/i.test(line))
        accountTacacs(this.engine, d, redactNetworkSecrets(line));
      // IOS prints nothing for a successful configuration command.
      if (result === 'OK' && /IOS/.test(this.identity.family)) result = '';
      if (readOnly) return terminalText(result);
      this.engine.refreshSpanningTree();
      this.engine.refreshBgp();
      // Only devices changed by this command need their own invariants rechecked.
      const changed = changedSince(before!, this.engine.state);
      validateSnapshot(this.engine.state, changed ? { changed } : { trustedLogs: true });
      if (
        !/^(ipconfig(?: \/all)?$|ip (?:addr|address|link|route) show$|route print$|arp -a$|wifi scan$)/i.test(
          authorized
        ) &&
        !/^(show|help|\?|ping|traceroute|nslookup|tcp|http|snmp (?:get|get-next)|syslog send|enable|end|exit|conf)/i.test(
          authorized
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
      this.lastMark = before;
      return terminalText(result);
    } catch (error) {
      if (before) this.engine.restore(before);
      this.context = context;
      return '% ' + cliErrorText(error);
    }
  }
  /** Whether a line only reads state, so callers can skip undo checkpoints and revalidation. */
  readOnly(input: string) {
    if (this.secretInput || this.context.confirm) return false;
    const line = input.trim().replace(/\s*\|\s*(?:include|exclude|begin)\s+.+$/i, '');
    if (!line || line.startsWith('!') || line.endsWith('?')) return true;
    try {
      return READ_ONLY.test(
        this.registry.normalize(line, this.engine.device(this.deviceId), this.context).replace(/^do\s+/i, '')
      );
    } catch {
      return true;
    }
  }
}

// Commands that only read state or change the terminal mode.
const READ_ONLY = /^(?:show|help|enable|disable|end|exit|configure terminal|conf t)(?:\s|$)/i;

/** Schema failures are reported per field instead of as raw JSON. */
function cliErrorText(error: unknown) {
  const issues = (error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)?.issues;
  if (error instanceof Error && Array.isArray(issues) && issues.length)
    return (
      'Valor inválido: ' +
      issues
        .slice(0, 3)
        .map((issue) => (issue.path.length ? issue.path.join('.') + ' — ' : '') + issue.message)
        .join('; ')
    );
  return error instanceof Error ? error.message : 'Comando inválido';
}
