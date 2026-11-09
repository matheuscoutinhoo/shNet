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
import { beginReload, saveStartup } from './startup';
import { sessionBanners } from './ios-management';
import { answerClear, applyOutputModifier, parseOutputModifier } from './ios-exec';
import { deleteVlanDat } from './ios-show2';
import { vtyLogin, vtyNeedsUsername, vtyServerConnection, verifyVtyLogin, type VtyConnection } from './vty';
import { vtyLineFor } from '../protocols/vty';
import type { IosLine } from '../protocols/ios-system-model';
export class TerminalSession {
  private ownContext: Context = { mode: 'user' };
  // Telnet/SSH session opened from this terminal: its login dialog, then the remote CLI.
  private remote?: {
    v: VtyConnection;
    line: IosLine;
    stage: 'username' | 'password' | 'open';
    username?: string;
    failures: number;
    session?: TerminalSession;
  };
  /** The mode and dialog state of the CLI the operator is typing into (the remote one over Telnet/SSH). */
  get context(): Context {
    return this.remote?.session?.context ?? this.ownContext;
  }
  set context(value: Context) {
    if (this.remote?.session) this.remote.session.context = value;
    else this.ownContext = value;
  }
  /** Whether a Telnet/SSH session opened from this terminal is active. */
  get connected() {
    return !!this.remote;
  }
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
  get prompt(): string {
    if (this.remote)
      return this.remote.stage === 'username'
        ? 'Username: '
        : this.remote.stage === 'password'
          ? 'Password: '
          : this.remote.session!.prompt;
    if (this.secretInput) return 'Password:';
    const confirm = this.context.confirm;
    if (confirm)
      return {
        save: 'System configuration has been modified. Save? [yes/no]:',
        reload: 'Proceed with reload? [confirm]',
        'clear-counters':
          'Clear "show interface" counters on ' +
          (confirm.port ? 'this interface' : 'all interfaces') +
          ' [confirm]',
        'clear-logging': 'Clear logging buffer [confirm]',
        'clear-ospf': 'Reset ALL OSPF processes? [no]:',
        'delete-name': 'Delete filename [vlan.dat]?',
        'delete-file': 'Delete flash:/vlan.dat? [confirm]',
      }[confirm.kind];
    // Banner text lines are typed without a prompt until the delimiter.
    if (this.context.banner) return '';
    const tacacs = this.context.aaaKind === 'tacacs';
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
      'key-chain': '(config-keychain)#',
      'key-chain-key': '(config-keychain-key)#',
      'bfd-template': '(config-bfd)#',
      'aaa-server': tacacs ? '(config-server-tacacs)#' : '(config-radius-server)#',
      'aaa-group': tacacs ? '(config-sg-tacacs+)#' : '(config-sg-radius)#',
      'isakmp-policy': '(config-isakmp)#',
      'transform-set': '(cfg-crypto-trans)#',
      'ipsec-profile': '(ipsec-profile)#',
      'ikev2-proposal': '(config-ikev2-proposal)#',
      'ikev2-policy': '(config-ikev2-policy)#',
      'ikev2-keyring': '(config-ikev2-keyring)#',
      'ikev2-keyring-peer': '(config-ikev2-keyring-peer)#',
      'ikev2-profile': '(config-ikev2-profile)#',
      'zbf-zone': '(config-sec-zone)#',
      'zbf-class-map': '(config-cmap)#',
      'zbf-policy-map': '(config-pmap)#',
      'zbf-policy-class': '(config-pmap-c)#',
      'zbf-zone-pair': '(config-sec-zone-pair)#',
    }[this.context.mode];
    return (
      this.engine.device(this.deviceId).hostname +
      (this.context.ports?.length && this.context.mode === 'interface' ? '(config-if-range)#' : suffix)
    );
  }
  get secretInput(): boolean {
    if (this.remote)
      return (
        this.remote.stage === 'password' || (this.remote.stage === 'open' && this.remote.session!.secretInput)
      );
    return !!this.context.auth;
  }
  /** Text IOS shows when this session opens: the MOTD banner, then the exec banner. */
  get banners() {
    return sessionBanners(this.engine.device(this.deviceId)).join('\n');
  }
  displayInput(input: string): string {
    if (this.remote)
      return this.remote.session ? this.remote.session.displayInput(input) : this.secretInput ? '' : input;
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
    if (this.remote) {
      // Ctrl-C during the login abandons the connection; inside the session it reaches the remote CLI.
      if (this.remote.session) this.remote.session.cancel();
      else this.disconnect();
      return;
    }
    delete this.context.auth;
    delete this.context.confirm;
  }
  help(input: string): string {
    if (this.remote) return this.remote.session ? this.remote.session.help(input) : '';
    if (this.secretInput || this.context.confirm) return '';
    try {
      return this.registry.help(input, this.engine.device(this.deviceId), this.context);
    } catch (error) {
      return '% ' + (error instanceof Error ? error.message : 'Invalid input');
    }
  }
  complete(input: string): string {
    if (this.remote) return this.remote.session ? this.remote.session.complete(input) : input;
    if (this.secretInput || this.context.confirm) return input;
    try {
      return this.registry.complete(input, this.engine.device(this.deviceId), this.context);
    } catch {
      return input;
    }
  }
  end() {
    if (this.remote) {
      this.remote.session?.end();
      return;
    }
    if (!CONFIG_MODES.includes(this.context.mode)) return;
    this.context = { mode: 'privileged' };
    if (!this.identity.host)
      this.engine.emit(
        'CONFIG_CHANGED',
        this.deviceId,
        '%SYS-5-CONFIG_I: Configured from console by console'
      );
  }
  private answerReload(answer: string) {
    const before = this.engine.checkpoint(),
      confirm = this.context.confirm!,
      kind = confirm.kind;
    try {
      const d = this.engine.device(this.deviceId);
      if (kind === 'delete-name') {
        // Enter keeps the proposed name; IOS then asks for confirmation.
        this.context.confirm = { kind: 'delete-file' };
        if (answer && answer !== 'vlan.dat' && answer !== 'flash:vlan.dat') {
          delete this.context.confirm;
          return '%Error deleting flash:/' + answer + ' (No such file or directory)';
        }
        return '';
      }
      if (kind === 'delete-file') {
        delete this.context.confirm;
        if (answer && !/^(?:y|yes|confirm)$/.test(answer)) return '';
        deleteVlanDat(this.engine, d);
        return '';
      }
      if (kind === 'clear-counters' || kind === 'clear-logging' || kind === 'clear-ospf') {
        delete this.context.confirm;
        // [confirm] accepts Enter or "y"; "[no]:" prompts need an explicit yes.
        const accepted =
          kind === 'clear-ospf' ? /^y(?:es?)?$/.test(answer) : !answer || /^(?:y|yes|confirm)$/.test(answer);
        if (!accepted) return '';
        answerClear(this.engine, d, kind, confirm.port);
        validateSnapshot(this.engine.state);
        return '';
      }
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
      const output = beginReload(this.engine, d);
      this.context = { mode: 'user' };
      return output;
    } catch (error) {
      this.engine.state = before;
      delete this.context.confirm;
      return '% ' + cliErrorText(error);
    }
  }
  execute(input: string): string {
    if (this.remote) return this.executeRemote(input);
    this.lastMark = undefined;
    const reloading = this.engine.device(this.deviceId).reloading;
    if (reloading) {
      // The console only shows boot progress until the reload finishes.
      this.context = { mode: 'user' };
      return (
        '% ' +
        this.engine.device(this.deviceId).hostname +
        ' is reloading; it boots from startup-config in ' +
        Math.max(1, Math.ceil((reloading.at - this.engine.state.clock) / 1000)) +
        ' s of simulated time.'
      );
    }
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
    // Inside a multi-line banner every line is literal text until the delimiter.
    const banner = !!this.context.banner;
    if (!line && !banner) return '';
    if (line.length > 512 || [...line].some((c) => c.charCodeAt(0) < 32)) return '% Entrada inválida';
    if (!banner && line.startsWith('!')) return '';
    if (!banner && line.endsWith('?')) return this.help(line.slice(0, -1).trimEnd());
    const context = { ...this.context };
    let before: StateMark | undefined;
    try {
      const d = this.engine.device(this.deviceId);
      const modifier = banner ? undefined : parseOutputModifier(line);
      if (modifier) line = modifier.command;
      if (!banner) line = this.registry.normalize(line, d, this.context);
      const safe = redactNetworkSecrets(line);
      this.history.push(safe === line ? input.trim() : safe);
      if (this.history.length > 200) this.history.shift();
      const authorized = line.replace(/^do\s+/i, '');
      if (
        !banner &&
        d.aaaClient?.enforceCli &&
        !/^(show|help|\?|aaa (?:login|logout)|ping|traceroute|nslookup|tcp|http|snmp (?:get|get-next)|syslog send|enable|end|exit)(?:\s|$)/i.test(
          authorized
        ) &&
        (!d.networkAuth || d.networkAuth.expiresAt <= this.engine.state.clock || d.networkAuth.privilege < 15)
      )
        throw new Error('AAA: configuração exige login de rede com privilégio 15.');
      if (
        !banner &&
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
      const readOnly = !banner && READ_ONLY.test(authorized);
      if (!readOnly) before = this.engine.mark();
      let result = this.registry.execute(line, this.engine, this.engine.device(this.deviceId), this.context);
      if (!readOnly) refreshInterfacePat(this.engine, this.engine.device(this.deviceId));
      // IOS logs leaving configuration mode (end, Ctrl-Z, exit from global configuration).
      if (
        !this.identity.host &&
        CONFIG_MODES.includes(context.mode) &&
        !CONFIG_MODES.includes(this.context.mode)
      )
        this.engine.emit(
          'CONFIG_CHANGED',
          this.deviceId,
          '%SYS-5-CONFIG_I: Configured from console by console'
        );
      if (modifier) {
        if (!/^show\s/i.test(authorized)) throw new Error('Output modifiers require a show command.');
        result = applyOutputModifier(result, modifier);
      }
      if (!/^aaa (?:login|logout)(?:\s|$)/i.test(line))
        accountTacacs(this.engine, d, redactNetworkSecrets(line));
      // IOS prints nothing for a successful configuration command.
      if (result === 'OK' && /IOS/.test(this.identity.family)) result = '';
      // "telnet"/"ssh" opened a connection: the login dialog of the remote device follows.
      const vty = this.ownContext.vty;
      if (vty) {
        delete this.ownContext.vty;
        return this.startRemote(vty, terminalText(result));
      }
      if (readOnly) return terminalText(result);
      this.engine.refreshSpanningTree();
      this.engine.refreshBgp();
      // Only devices changed by this command need their own invariants rechecked.
      const changed = changedSince(before!, this.engine.state);
      validateSnapshot(this.engine.state, changed ? { changed } : { trustedLogs: true });
      if (
        !banner &&
        !/^(ipconfig(?: \/all)?$|ip (?:addr|address|link|route) show$|route print$|arp -a$|wifi scan$)/i.test(
          authorized
        ) &&
        !/^(show|help|\?|ping|traceroute|tracert|nslookup|tcp|http|snmp (?:get|get-next)|syslog send|enable|end|exit|conf|debug|no debug|u\w* all|undebug|terminal|clear|telnet|ssh)/i.test(
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
  /** Closes the Telnet/SSH session opened from this terminal, if any. */
  disconnect() {
    const r = this.remote;
    if (!r) return;
    r.session?.disconnect();
    delete this.remote;
    const origin = this.engine.state.devices.find((d) => d.id === this.deviceId);
    const client = origin?.tcpConnections?.find((c) => c.id === r.v.connection);
    if (client && ['ESTABLISHED', 'CLOSE-WAIT'].includes(client.state))
      this.engine.closeTcp(this.deviceId, r.v.connection);
  }
  private closed(text: string) {
    const address = this.remote!.v.address;
    this.disconnect();
    return (text ? text + '\n' : '') + '\n[Connection to ' + address + ' closed by foreign host]';
  }
  /** Login dialog after "telnet"/"ssh" connected: banners, then Username/Password as the VTY line requires. */
  private startRemote(v: VtyConnection, output: string) {
    const target = this.engine.device(v.target);
    const line = vtyLineFor(target, v.transport)!;
    this.remote = {
      v,
      line,
      stage: 'password',
      failures: 0,
      ...(v.username ? { username: v.username } : {}),
    };
    const login = vtyLogin(target, line);
    const banners = [target.iosSystem?.banners?.motd, target.iosSystem?.banners?.login].filter(
      (b): b is string => b !== undefined
    );
    const head = [output, ...banners].filter(Boolean).join('\n');
    if (login.noLogin) return [head, this.openRemote(line.privilege ?? 1)].filter(Boolean).join('\n');
    if (v.transport === 'ssh') {
      // The SSH server authenticates users: the local database or AAA, never a line password alone.
      if (!vtyNeedsUsername(target, line)) {
        this.disconnect();
        return [head, '[Connection to ' + v.address + ' aborted: error status 0]'].filter(Boolean).join('\n');
      }
      return head;
    }
    if (login.methods.length === 1 && login.methods[0] === 'line' && !line.password)
      return this.closed([head, '', 'Password required, but none set'].join('\n'));
    if (vtyNeedsUsername(target, line)) this.remote.stage = 'username';
    return [head, '', 'User Access Verification', ''].join('\n');
  }
  private openRemote(privilege: number) {
    const r = this.remote!;
    const target = this.engine.device(r.v.target);
    const server = vtyServerConnection(this.engine, this.engine.device(this.deviceId), r.v);
    if (server && r.username) server.vtyUser = r.username;
    const session = new TerminalSession(this.engine, r.v.target);
    session.context = {
      mode: privilege >= 15 ? 'privileged' : 'user',
      ...(server ? { vtySession: server.id } : {}),
    };
    r.session = session;
    r.stage = 'open';
    return target.iosSystem?.banners?.exec ?? '';
  }
  private executeRemote(input: string): string {
    const r = this.remote!;
    this.lastMark = undefined;
    const origin = this.engine.state.devices.find((d) => d.id === this.deviceId);
    const target = this.engine.state.devices.find((d) => d.id === r.v.target);
    const client = origin?.tcpConnections?.find((c) => c.id === r.v.connection);
    // The remote end went away (reload, power, link loss reset the TCP connection).
    if (!target?.power || target.reloading || client?.state !== 'ESTABLISHED') return this.closed('');
    if (r.stage === 'username') {
      const name = input.trim();
      if (!name) return '';
      r.username = name;
      r.stage = 'password';
      return '';
    }
    if (r.stage === 'password') {
      const result = verifyVtyLogin(target, r.line, r.username, input);
      if (result) return this.openRemote(result.privilege);
      const telnet = r.v.transport === 'telnet';
      const message = telnet ? '% Login invalid' : '% Authentication failed.';
      if (++r.failures >= 3) return this.closed(message);
      if (telnet && vtyNeedsUsername(target, r.line)) r.stage = 'username';
      return message + (telnet ? '\n' : '');
    }
    const session = r.session!;
    const line = input.trim();
    if (
      !session.connected &&
      ['user', 'privileged'].includes(session.context.mode) &&
      /^(?:exi?t?|logo(?:ut?)?|quit)$/i.test(line)
    )
      return this.closed('');
    if (line && !session.secretInput) {
      this.history.push(redactNetworkSecrets(line));
      if (this.history.length > 200) this.history.shift();
    }
    const output = session.execute(input);
    this.lastMark = session.lastMark;
    return output;
  }
  /** Whether a line only reads state, so callers can skip undo checkpoints and revalidation. */
  readOnly(input: string): boolean {
    if (this.remote) return this.remote.session ? this.remote.session.readOnly(input) : false;
    if (this.secretInput || this.context.confirm || this.context.banner) return false;
    const trimmed = input.trim();
    let line: string;
    try {
      line = parseOutputModifier(trimmed)?.command ?? trimmed;
    } catch {
      return true;
    }
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
export function cliErrorText(error: unknown) {
  const issues = (error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)?.issues;
  if (error instanceof Error && Array.isArray(issues) && issues.length)
    return (
      'Valor inválido: ' +
      issues
        .slice(0, 3)
        .map((issue) => (issue.path.length ? issue.path.join('.') + ' — ' : '') + issue.message)
        .join('; ')
    );
  // Messages that already carry the IOS "%" marker are not prefixed twice ("% % ...").
  return error instanceof Error ? error.message.replace(/^%\s*/, '') : 'Comando inválido';
}
