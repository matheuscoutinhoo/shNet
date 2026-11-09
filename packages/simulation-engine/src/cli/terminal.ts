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
import type { Device } from '../model';
import { accountCommand, accountExec, authorizeCommand } from './aaa-login';

/** IOS routers and switches have a console line with its own login. */
const iosConsole = (d: Device) => (d.type === 'router' || d.type === 'switch') && !terminalIdentity(d).host;
const consoleLine = (d: Device): IosLine =>
  d.iosSystem?.lines?.find((l) => l.kind === 'con') ?? { kind: 'con', first: 0, last: 0 };
/** Whether the console asks for a login, and whether it starts with a username. */
function consoleLogin(d: Device) {
  if (!iosConsole(d)) return undefined;
  const line = consoleLine(d);
  return vtyLogin(d, line).noLogin ? undefined : { username: vtyNeedsUsername(d, line) };
}
const consoleAvailable = (d: Device) =>
  '\n' + d.hostname + ' con0 is now available\n\n\n\n\n\nPress RETURN to get started.';
// Commands that move between modes or end the session; IOS does not authorize or account them.
const SESSION_COMMAND = /^(?:end|exit|disable|logout|quit)$/i;
export class TerminalSession {
  private ownContext: Context = { mode: 'user' };
  // The device's boot this session belongs to: a reboot ends the console session.
  private bootEpoch?: number;
  // Who is logged in to this EXEC session and on which line, for AAA authorization and accounting.
  execUser?: string;
  execLine?: IosLine;
  private execTask?: string;
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
  ) {
    const d = engine.state.devices.find((v) => v.id === deviceId);
    this.bootEpoch = d?.bootStartedAt;
    const login = d && consoleLogin(d);
    if (login)
      this.ownContext.consoleLogin = { stage: login.username ? 'username' : 'password', failures: 0 };
  }
  /**
   * A console session belongs to one boot of the device: after a reload or power cycle the
   * console starts over and, if the line requires it, asks for a new login.
   */
  private syncConsole() {
    if (this.remote || this.ownContext.vtySession) return;
    const d = this.engine.state.devices.find((v) => v.id === this.deviceId);
    if (!d || d.bootStartedAt === this.bootEpoch || !d.power || d.reloading) return;
    this.bootEpoch = d.bootStartedAt;
    delete this.execTask;
    delete this.execUser;
    const login = consoleLogin(d);
    if (login)
      this.ownContext = {
        mode: 'user',
        consoleLogin: { stage: login.username ? 'username' : 'password', failures: 0 },
      };
  }
  /** Starts an authenticated EXEC session: exec accounting START when configured. */
  beginExec(user: string | undefined, line: IosLine | undefined) {
    this.execUser = user;
    this.execLine = line;
    this.execTask = this.engine.id('exec');
    accountExec(this.engine, this.engine.device(this.deviceId), line, user, 'start', this.execTask);
  }
  /** Ends the EXEC session: exec accounting STOP when configured. */
  endExec() {
    const task = this.execTask,
      d = this.engine.state.devices.find((v) => v.id === this.deviceId);
    delete this.execTask;
    if (task && d?.power && !d.reloading)
      accountExec(this.engine, d, this.execLine, this.execUser, 'stop', task);
    delete this.execUser;
  }
  /** Console login dialog: "Press RETURN to get started", then Username/Password. */
  private consoleLoginStep(input: string) {
    const d = this.engine.device(this.deviceId),
      login = this.ownContext.consoleLogin!,
      need = consoleLogin(d),
      banners = d.iosSystem?.banners;
    if (!need) {
      // Nothing to ask (or the line changed meanwhile): RETURN opens the EXEC session.
      delete this.ownContext.consoleLogin;
      this.beginExec(undefined, consoleLine(d));
      return [banners?.motd, banners?.exec].filter((b) => b !== undefined).join('\n');
    }
    if (login.stage === 'idle') {
      this.ownContext.consoleLogin = { stage: need.username ? 'username' : 'password', failures: 0 };
      return [banners?.motd, banners?.login, '\nUser Access Verification\n']
        .filter((b) => b !== undefined)
        .join('\n');
    }
    if (login.stage === 'username') {
      const name = input.trim();
      if (!name) return '';
      login.username = name;
      login.stage = 'password';
      return '';
    }
    const line = consoleLine(d),
      user = login.username,
      result = verifyVtyLogin(this.engine, d, line, user, input),
      device = this.engine.device(this.deviceId);
    if (typeof result === 'object') {
      this.ownContext = { mode: result.privilege >= 15 ? 'privileged' : 'user' };
      this.beginExec(user, line);
      return device.iosSystem?.banners?.exec ?? '';
    }
    if (result === 'unauthorized') {
      this.ownContext.consoleLogin = { stage: 'idle', failures: 0 };
      return '% Authorization failed.\n' + consoleAvailable(device);
    }
    // A line password is asked again silently; IOS gives up after three attempts.
    const linePassword = vtyLogin(device, line).methods[0] === 'line';
    if (++login.failures >= 3) {
      this.ownContext.consoleLogin = { stage: 'idle', failures: 0 };
      return (linePassword ? '% Bad passwords' : '% Login invalid') + '\n' + consoleAvailable(device);
    }
    if (linePassword) return '';
    login.stage = need.username ? 'username' : 'password';
    delete login.username;
    return '% Login invalid\n';
  }
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
    this.syncConsole();
    const login = this.ownContext.consoleLogin;
    if (login)
      return login.stage === 'username' ? 'Username: ' : login.stage === 'password' ? 'Password: ' : '';
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
      'ipv6-acl': '(config-ipv6-acl)#',
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
    this.syncConsole();
    return !!this.context.auth || this.ownContext.consoleLogin?.stage === 'password';
  }
  /** Text IOS shows when this session opens: the MOTD banner, then the exec banner or the login. */
  get banners() {
    const d = this.engine.device(this.deviceId),
      login = this.ownContext.consoleLogin;
    if (login && login.stage !== 'idle')
      return [d.iosSystem?.banners?.motd, d.iosSystem?.banners?.login, '\nUser Access Verification\n']
        .filter((b) => b !== undefined)
        .join('\n');
    return sessionBanners(d).join('\n');
  }
  displayInput(input: string): string {
    if (this.remote)
      return this.remote.session ? this.remote.session.displayInput(input) : this.secretInput ? '' : input;
    if (this.secretInput) return '';
    if (this.context.confirm || this.ownContext.consoleLogin) return input;
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
    if (this.secretInput || this.context.confirm || this.ownContext.consoleLogin) return '';
    try {
      return this.registry.help(input, this.engine.device(this.deviceId), this.context);
    } catch (error) {
      return '% ' + (error instanceof Error ? error.message : 'Invalid input');
    }
  }
  complete(input: string): string {
    if (this.remote) return this.remote.session ? this.remote.session.complete(input) : input;
    if (this.secretInput || this.context.confirm || this.ownContext.consoleLogin) return input;
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
    this.syncConsole();
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
    if (this.ownContext.consoleLogin) return this.consoleLoginStep(input);
    let line = input.trim();
    // Inside a multi-line banner every line is literal text until the delimiter.
    const banner = !!this.context.banner;
    if (!line && !banner) return '';
    if (line.length > 512 || [...line].some((c) => c.charCodeAt(0) < 32)) return '% Entrada inválida';
    if (!banner && line.startsWith('!')) return '';
    if (!banner && line.endsWith('?')) return this.help(line.slice(0, -1).trimEnd());
    const device = this.engine.device(this.deviceId);
    // exit/logout in EXEC ends the console session; the console waits for RETURN.
    if (
      !banner &&
      iosConsole(device) &&
      !this.ownContext.vtySession &&
      ['user', 'privileged'].includes(this.context.mode) &&
      /^(?:exi?t?|logo(?:ut?)?|quit)$/i.test(line)
    ) {
      this.endExec();
      this.ownContext = { mode: 'user', consoleLogin: { stage: 'idle', failures: 0 } };
      return consoleAvailable(device);
    }
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
      // IOS "aaa authorization commands 15": privilege 15 commands are authorized before they run.
      const level15 =
        !banner &&
        iosConsole(d) &&
        this.context.mode !== 'user' &&
        !SESSION_COMMAND.test(authorized) &&
        !this.registry.userLevel(authorized, d);
      const audited = redactNetworkSecrets(authorized);
      if (
        level15 &&
        !authorizeCommand(
          this.engine,
          d,
          { console: !this.ownContext.vtySession, user: this.execUser },
          audited
        )
      )
        return 'Command authorization failed.';
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
      if (level15) accountCommand(this.engine, this.engine.device(this.deviceId), this.execUser, audited);
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
    r.session?.endExec();
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
    session.beginExec(r.username, r.line);
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
      const result = verifyVtyLogin(this.engine, target, r.line, r.username, input);
      if (typeof result === 'object') return this.openRemote(result.privilege);
      if (result === 'unauthorized') return this.closed('% Authorization failed.');
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
    if (this.secretInput || this.context.confirm || this.context.banner || this.ownContext.consoleLogin)
      return false;
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
