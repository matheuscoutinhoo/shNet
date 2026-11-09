import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  aaaServerConfig,
  validateSnapshot,
  type Device,
} from '../packages/simulation-engine/src';

const ok = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/m);
};
/**
 * R1 (10.0.12.1) - R2 (10.0.12.2; Gi0/2 10.0.50.1) - ISE (10.0.50.10: TACACS+ and RADIUS).
 * R2 is the NAS: "aaa authentication login default group ISE local", with a local fallback user.
 */
function lab() {
  const e = new SimulationEngine();
  const [r1, r2] = [0, 1].map((i) => {
    const d = e.addFactoryProfile('router', { x: i * 200, y: 0 });
    e.setDevicePower(d.id, true);
    return d;
  });
  const ise = e.addDevice('server', { x: 400, y: 200 });
  Object.assign(ise.interfaces[0], { ip: '10.0.50.10', prefix: 24 });
  ise.gateway = '10.0.50.1';
  const port = (d: Device, name: string) => e.device(d.id).interfaces.find((p) => p.name === name)!.id;
  e.connect({ device: r1.id, port: port(r1, 'Gi0/1') }, { device: r2.id, port: port(r2, 'Gi0/1') });
  e.connect({ device: r2.id, port: port(r2, 'Gi0/2') }, { device: ise.id, port: ise.interfaces[0].id });
  e.configureAaaServer(ise.id, {
    enabled: true,
    radius: true,
    tacacs: true,
    key: 'Tac-Key-1',
    clients: [],
    users: [
      { username: 'netadmin', password: 'Adm1n-Pass', privilege: 15, sessionMs: 600000 },
      { username: 'helpdesk', password: 'Help-Pass1', privilege: 1, sessionMs: 600000 },
      {
        username: 'operator',
        password: 'Oper-Pass1',
        privilege: 15,
        sessionMs: 600000,
        commands: ['configure terminal', 'interface', 'description'],
      },
    ],
  });
  const [t1, t2] = [r1, r2].map((d) => {
    const t = new TerminalSession(e, d.id);
    ok(t, ['enable', 'configure terminal']);
    return t;
  });
  ok(t1, ['hostname R1', 'interface g0/1', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'end']);
  ok(t2, [
    'hostname R2',
    'username backup privilege 15 secret Backup-Pass1',
    'interface g0/1',
    'ip address 10.0.12.2 255.255.255.0',
    'no shutdown',
    'interface g0/2',
    'ip address 10.0.50.1 255.255.255.0',
    'no shutdown',
    'exit',
    'aaa new-model',
    'tacacs server ISE-1',
    'address ipv4 10.0.50.10',
    'key Tac-Key-1',
    'exit',
    'aaa group server tacacs+ ISE',
    'server name ISE-1',
    'exit',
    'aaa authentication login default group ISE local',
    'end',
  ]);
  e.advanceTo(e.state.clock + 5_000, 1_000_000);
  return { e, r1, r2, ise, t1, t2 };
}
/** Telnet from R1 to R2 and log in; returns the output of the password line. */
function telnet(t: TerminalSession, user: string, password: string) {
  expect(t.execute('telnet 10.0.12.2')).toContain('Open');
  expect(t.prompt).toBe('Username: ');
  t.execute(user);
  return t.execute(password);
}

describe('IOS AAA logins against TACACS+ and RADIUS servers', () => {
  it('authenticates VTY logins on the server and applies exec authorization like IOS', () => {
    const { e, ise, t1, t2 } = lab();
    // Authenticated by ISE, but without "aaa authorization exec" the session starts at level 1.
    expect(telnet(t1, 'netadmin', 'Adm1n-Pass')).toBe('');
    expect(t1.prompt).toBe('R2>');
    expect(t1.execute('exit')).toContain('closed by foreign host');
    // A server reject ends the login: the local database is not consulted.
    expect(telnet(t1, 'netadmin', 'wrong')).toBe('% Login invalid\n');
    t1.execute('backup');
    expect(t1.execute('Backup-Pass1')).toBe('% Login invalid\n');
    t1.cancel();
    expect(t1.connected).toBe(false);
    // With exec authorization the privilege is the server's priv-lvl.
    ok(t2, ['configure terminal', 'aaa authorization exec default group ISE local', 'end']);
    expect(telnet(t1, 'netadmin', 'Adm1n-Pass')).toBe('');
    expect(t1.prompt).toBe('R2#');
    t1.execute('exit');
    expect(telnet(t1, 'helpdesk', 'Help-Pass1')).toBe('');
    expect(t1.prompt).toBe('R2>');
    t1.execute('exit');
    expect(
      e.state.events.some(
        (v) => v.type === 'AAA_RESULT' && v.device === ise.id && v.reason.includes('netadmin')
      )
    ).toBe(true);
    const servers = t2.execute('show aaa servers');
    expect(servers).toMatch(
      /^TACACS\+: id 1, priority 1, host 10\.0\.50\.10, auth-port 49, hostname ISE-1$/m
    );
    expect(servers).toMatch(/Authen: request 5, timeouts 0,/);
    expect(servers).toMatch(/Response: accept 3, reject 2, challenge 0/);
    validateSnapshot(e.snapshot());
  });

  it('uses the local database only after the TACACS+ server times out', () => {
    const { e, t1, t2 } = lab();
    // Nothing answers at the configured address: no reset, only silence until the 5 s timeout.
    ok(t2, [
      'configure terminal',
      'aaa authorization exec default group ISE local',
      'tacacs server ISE-1',
      'address ipv4 10.0.50.99',
      'end',
    ]);
    const start = e.state.clock;
    expect(telnet(t1, 'backup', 'Backup-Pass1')).toBe('');
    expect(e.state.clock - start).toBeGreaterThanOrEqual(5000);
    expect(t1.prompt).toBe('R2#');
    t1.execute('exit');
    expect(t2.execute('show aaa servers')).toMatch(/Authen: request 1, timeouts 1,/);
    // Server-only users cannot log in while the server does not answer.
    expect(telnet(t1, 'netadmin', 'Adm1n-Pass')).toBe('% Login invalid\n');
    t1.cancel();
    validateSnapshot(e.snapshot());
  });

  it('fails over at once when the server is unreachable or refuses the connection', () => {
    const { e, ise, t1, t2 } = lab();
    // TACACS+ disabled on the server: the TCP connection is reset and IOS moves on immediately.
    e.configureAaaServer(ise.id, { ...aaaServerConfig(e.device(ise.id)), tacacs: false });
    let start = e.state.clock;
    expect(telnet(t1, 'backup', 'Backup-Pass1')).toBe('');
    expect(e.state.clock - start).toBeLessThan(1000);
    t1.execute('exit');
    // Server powered off: its link drops, R2 has no route and does not wait either.
    e.setDevicePower(ise.id, false);
    start = e.state.clock;
    expect(telnet(t1, 'backup', 'Backup-Pass1')).toBe('');
    expect(e.state.clock - start).toBeLessThan(1000);
    t1.execute('exit');
    expect(t2.execute('show aaa servers')).toMatch(/Authen: request 2, timeouts 2,/);
    validateSnapshot(e.snapshot());
  });

  it('uses RADIUS on UDP 1645 by default and the Access-Accept privilege on a named list', () => {
    const { e, t1, t2 } = lab();
    ok(t2, [
      'configure terminal',
      'radius server NPS-1',
      'address ipv4 10.0.50.10',
      'key Tac-Key-1',
      'exit',
      'aaa authentication login VTY group radius local',
      'aaa authorization exec VTY group radius',
      'line vty 0 4',
      'login authentication VTY',
      'authorization exec VTY',
      'end',
    ]);
    expect(telnet(t1, 'netadmin', 'Adm1n-Pass')).toBe('');
    expect(t1.prompt).toBe('R2#');
    t1.execute('exit');
    expect(
      e.state.events.some(
        (v) =>
          v.frame?.packet?.protocol === 'UDP' &&
          v.frame.packet.payload.protocol === 'RADIUS' &&
          v.frame.packet.destinationPort === 1645
      )
    ).toBe(true);
    expect(t2.execute('show aaa servers')).toMatch(
      /^RADIUS: id 2, priority 2, host 10\.0\.50\.10, auth-port 1645, acct-port 1646, hostname NPS-1$/m
    );
    // The server rejects a wrong password.
    expect(telnet(t1, 'netadmin', 'nope')).toBe('% Login invalid\n');
    t1.cancel();
    validateSnapshot(e.snapshot());
  });

  it('authorizes and accounts privilege 15 commands per command with TACACS+', () => {
    const { e, r2, ise, t1, t2 } = lab();
    ok(t2, [
      'configure terminal',
      'aaa authorization exec default group ISE local',
      'aaa authorization commands 15 default group ISE local',
      'aaa accounting exec default start-stop group ISE',
      'aaa accounting commands 15 default start-stop group ISE',
      'end',
    ]);
    expect(telnet(t1, 'operator', 'Oper-Pass1')).toBe('');
    expect(t1.prompt).toBe('R2#');
    expect(t1.execute('configure terminal')).toBe('');
    expect(t1.execute('interface Gi0/1')).toBe('');
    expect(t1.execute('description UPLINK')).toBe('');
    expect(t1.execute('hostname HACKED')).toBe('Command authorization failed.');
    expect(e.device(r2.id).hostname).toBe('R2');
    expect(t1.execute('end')).toBe('');
    // Privilege 1 commands are not sent for authorization.
    expect(t1.execute('show ip interface brief')).toMatch(
      /^GigabitEthernet0\/1 +10\.0\.12\.2 +YES manual up +up$/m
    );
    expect(t1.execute('exit')).toContain('closed by foreign host');
    e.advanceTo(e.state.clock + 3000, 1_000_000);
    const audit = e.device(ise.id).aaaServer!.accounting.filter((a) => a.username === 'operator');
    expect(audit.filter((a) => a.stage === 'start')).toHaveLength(1);
    expect(audit.filter((a) => a.stage === 'stop')).toHaveLength(1);
    expect(
      audit
        .filter((a) => a.stage === 'command')
        .map((a) => a.command)
        .sort()
    ).toEqual(['configure terminal', 'description UPLINK', 'interface Gi0/1']);
    expect(t2.execute('show aaa servers')).toMatch(
      /Author: request 4, timeouts 0,[^\n]*\n {13}Response: accept 3, reject 1/
    );
    validateSnapshot(e.snapshot());
  });

  it('protects the console with AAA but authorizes it only with "aaa authorization console"', () => {
    const { e, r2, t2 } = lab();
    ok(t2, ['configure terminal', 'aaa authorization exec default group ISE local', 'end']);
    const con = new TerminalSession(e, r2.id);
    expect(con.banners).toBe('\nUser Access Verification\n');
    expect(con.prompt).toBe('Username: ');
    con.execute('netadmin');
    expect(con.secretInput).toBe(true);
    expect(con.execute('Adm1n-Pass')).toBe('');
    expect(con.prompt).toBe('R2>');
    expect(con.execute('exit')).toBe('\nR2 con0 is now available\n\n\n\n\n\nPress RETURN to get started.');
    ok(t2, ['configure terminal', 'aaa authorization console', 'end']);
    expect(con.execute('')).toBe('\nUser Access Verification\n');
    con.execute('netadmin');
    con.execute('Adm1n-Pass');
    expect(con.prompt).toBe('R2#');
    expect(t2.execute('test aaa group ISE netadmin Adm1n-Pass legacy')).toBe(
      'Attempting authentication test to server-group ISE using tacacs+\nUser was successfully authenticated.'
    );
    expect(t2.execute('test aaa group ISE netadmin nope legacy')).toContain(
      'User authentication request was rejected by server.'
    );
    expect(t2.execute('test aaa group NOPE a b legacy')).toMatch(/^% Server group NOPE not found/);
    validateSnapshot(e.snapshot());
  });
});

describe('IOS console line login', () => {
  it('asks for the line password, ends the session on exit and starts over after a reload', () => {
    const { e, r1, t1 } = lab();
    ok(t1, [
      'configure terminal',
      'enable secret Class-Pass1',
      'line con 0',
      'password Con-Pass1',
      'login',
      'end',
    ]);
    // The open session is not affected; the next one must log in.
    expect(t1.execute('exit')).toBe('\nR1 con0 is now available\n\n\n\n\n\nPress RETURN to get started.');
    expect(t1.prompt).toBe('');
    expect(t1.execute('')).toBe('\nUser Access Verification\n');
    expect(t1.prompt).toBe('Password: ');
    expect(t1.secretInput).toBe(true);
    expect(t1.displayInput('Con-Pass1')).toBe('');
    // A wrong line password is asked again silently.
    expect(t1.execute('wrong')).toBe('');
    expect(t1.prompt).toBe('Password: ');
    expect(t1.execute('Con-Pass1')).toBe('');
    expect(t1.prompt).toBe('R1>');
    ok(t1, ['enable']);
    expect(t1.prompt).toBe('Password:');
    ok(t1, ['Class-Pass1']);
    expect(t1.prompt).toBe('R1#');
    // Three wrong passwords end the attempt.
    t1.execute('logout');
    t1.execute('');
    t1.execute('a');
    t1.execute('b');
    expect(t1.execute('c')).toBe(
      '% Bad passwords\n\nR1 con0 is now available\n\n\n\n\n\nPress RETURN to get started.'
    );
    // A new console connection asks at once.
    const fresh = new TerminalSession(e, r1.id);
    expect(fresh.banners).toBe('\nUser Access Verification\n');
    expect(fresh.prompt).toBe('Password: ');
    ok(fresh, ['Con-Pass1', 'enable', 'Class-Pass1', 'write memory', 'reload', '']);
    e.advanceTo(e.state.clock + 61_000, 1_000_000);
    expect(fresh.prompt).toBe('Password: ');
    expect(fresh.execute('Con-Pass1')).toBe('');
    expect(fresh.prompt).toBe('R1>');
    validateSnapshot(e.snapshot());
  });

  it('uses the local database with "login local" and needs nothing by default', () => {
    const { e, r1, t1 } = lab();
    // Default console: no login at all.
    expect(new TerminalSession(e, r1.id).prompt).toBe('R1>');
    ok(t1, [
      'configure terminal',
      'username ops privilege 15 secret Ops-Pass1',
      'line con 0',
      'login local',
      'end',
    ]);
    const con = new TerminalSession(e, r1.id);
    expect(con.prompt).toBe('Username: ');
    con.execute('ops');
    expect(con.execute('bad')).toBe('% Login invalid\n');
    expect(con.prompt).toBe('Username: ');
    con.execute('ops');
    expect(con.execute('Ops-Pass1')).toBe('');
    // Without AAA, "login local" applies the user's privilege level.
    expect(con.prompt).toBe('R1#');
  });
});
