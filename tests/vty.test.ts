import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  type Device,
} from '../packages/simulation-engine/src';

const ok = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/m);
};
/** R1 (10.0.12.1) - R2 (10.0.12.2); R2 has a local admin user and VTY lines with "login local". */
function lab() {
  const e = new SimulationEngine();
  const [r1, r2] = [0, 1].map((i) => {
    const d = e.addFactoryProfile('router', { x: i * 200, y: 0 });
    e.setDevicePower(d.id, true);
    return d;
  });
  const port = (d: Device, name: string) => e.device(d.id).interfaces.find((p) => p.name === name)!.id;
  e.connect({ device: r1.id, port: port(r1, 'Gi0/1') }, { device: r2.id, port: port(r2, 'Gi0/1') });
  const [t1, t2] = [r1, r2].map((d) => {
    const t = new TerminalSession(e, d.id);
    ok(t, ['enable', 'configure terminal']);
    return t;
  });
  ok(t1, ['hostname R1', 'interface g0/1', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'end']);
  ok(t2, [
    'hostname R2',
    'enable secret class123',
    'username admin privilege 15 secret cisco123',
    'username oper password oper123',
    'ip domain-name lab.local',
    'interface g0/1',
    'ip address 10.0.12.2 255.255.255.0',
    'no shutdown',
    'line vty 0 4',
    'login local',
    'end',
  ]);
  e.advanceTo(e.state.clock + 5_000, 1_000_000);
  return { e, r1, r2, t1, t2 };
}

describe('Telnet and SSH between devices', () => {
  it('logs in over Telnet with the local database and configures the remote router', () => {
    const { e, r1, r2, t1 } = lab();
    const open = t1.execute('telnet 10.0.12.2');
    expect(open).toBe('Trying 10.0.12.2 ... Open\n\nUser Access Verification\n');
    expect(t1.prompt).toBe('Username: ');
    expect(t1.execute('admin')).toBe('');
    expect(t1.prompt).toBe('Password: ');
    expect(t1.secretInput).toBe(true);
    expect(t1.displayInput('wrong')).toBe('');
    expect(t1.execute('wrong')).toBe('% Login invalid\n');
    expect(t1.prompt).toBe('Username: ');
    t1.execute('admin');
    expect(t1.execute('cisco123')).toBe('');
    // Privilege 15 users land in privileged EXEC on the remote device.
    expect(t1.prompt).toBe('R2#');
    const users = t1.execute('show users');
    expect(users).toMatch(/^\* +\d+ vty 0 +admin +idle +\d\d:\d\d:\d\d +10\.0\.12\.1$/m);
    expect(users).toMatch(/^ {3}0 con 0 /m);
    ok(t1, ['configure terminal', 'hostname R2-CORE', 'end']);
    expect(e.device(r2.id).hostname).toBe('R2-CORE');
    expect(t1.prompt).toBe('R2-CORE#');
    expect(t1.execute('exit')).toBe('\n[Connection to 10.0.12.2 closed by foreign host]');
    expect(t1.prompt).toBe('R1#');
    expect(t1.connected).toBe(false);
    e.advanceTo(e.state.clock + 5_000, 1_000_000);
    expect(e.device(r1.id).tcpConnections?.find((c) => c.remotePort === 23)?.state).not.toBe('ESTABLISHED');
    validateSnapshot(e.snapshot());
  });

  it('requires RSA keys for SSH and honours transport input and access-class', () => {
    const { e, t1, t2 } = lab();
    expect(t1.execute('ssh -l admin 10.0.12.2')).toBe('% Connection refused by remote host');
    t2.execute('configure terminal');
    expect(t2.execute('crypto key generate rsa modulus 2048')).toContain('SSH 2.0 has been enabled');
    ok(t2, ['line vty 0 4', 'transport input ssh', 'end']);
    expect(t1.execute('telnet 10.0.12.2')).toBe('Trying 10.0.12.2 ... \n% Connection refused by remote host');
    expect(t1.execute('ssh -l oper 10.0.12.2')).toBe('');
    expect(t1.prompt).toBe('Password: ');
    expect(t1.execute('nope')).toBe('% Authentication failed.');
    expect(t1.execute('oper123')).toBe('');
    // A privilege 1 user starts in user EXEC and needs the remote enable secret.
    expect(t1.prompt).toBe('R2>');
    expect(t1.execute('enable')).toBe('');
    expect(t1.prompt).toBe('Password:');
    expect(t1.execute('class123')).toBe('');
    expect(t1.prompt).toBe('R2#');
    expect(t1.execute('logout')).toBe('\n[Connection to 10.0.12.2 closed by foreign host]');
    ok(t2, [
      'configure terminal',
      'access-list 10 permit 10.9.9.0 0.0.0.255',
      'line vty 0 4',
      'access-class 10 in',
      'end',
    ]);
    expect(t1.execute('ssh -l admin 10.0.12.2')).toBe('% Connection refused by remote host');
    expect(t2.execute('show access-lists 10')).toContain('10.9.9.0');
    validateSnapshot(e.snapshot());
  });

  it('uses the line password, refuses SSH without users and reports unreachable hosts', () => {
    const { e, t1, t2 } = lab();
    ok(t2, ['configure terminal', 'line vty 0 4', 'login', 'end']);
    expect(t1.execute('telnet 10.0.12.2')).toBe(
      'Trying 10.0.12.2 ... Open\n\nPassword required, but none set\n\n[Connection to 10.0.12.2 closed by foreign host]'
    );
    ok(t2, ['configure terminal', 'line vty 0 4', 'password vtypass', 'end']);
    expect(t1.execute('telnet 10.0.12.2')).toContain('User Access Verification');
    expect(t1.prompt).toBe('Password: ');
    expect(t1.execute('vtypass')).toBe('');
    expect(t1.prompt).toBe('R2>');
    t1.execute('exit');
    t2.execute('configure terminal');
    t2.execute('crypto key generate rsa modulus 2048');
    t2.execute('end');
    expect(t1.execute('ssh -l admin 10.0.12.2')).toBe('[Connection to 10.0.12.2 aborted: error status 0]');
    expect(t1.prompt).toBe('R1#');
    expect(t1.execute('telnet 10.99.99.99')).toBe(
      'Trying 10.99.99.99 ... \n% Destination unreachable; gateway or host down'
    );
    expect(t1.execute('telnet 10.0.12.9')).toBe(
      'Trying 10.0.12.9 ... \n% Connection timed out; remote host not responding'
    );
    validateSnapshot(e.snapshot());
  });

  it('chains sessions and drops them when the remote device reloads', () => {
    const { t1 } = lab();
    t1.execute('telnet 10.0.12.2');
    t1.execute('admin');
    t1.execute('cisco123');
    // From R2, a second hop back to R1 (no VTY password on R1: "no login").
    t1.execute('configure terminal');
    t1.execute('end');
    const back = new TerminalSession(t1.engine, t1.deviceId);
    ok(back, ['enable', 'configure terminal', 'line vty 0 4', 'no login', 'end']);
    expect(t1.execute('telnet 10.0.12.1')).toBe('Trying 10.0.12.1 ... Open');
    expect(t1.prompt).toBe('R1>');
    expect(t1.execute('exit')).toBe('\n[Connection to 10.0.12.1 closed by foreign host]');
    expect(t1.prompt).toBe('R2#');
    t1.execute('reload');
    // The configuration changed since the last save: IOS asks before reloading.
    if (t1.prompt.startsWith('System configuration has been modified')) t1.execute('no');
    expect(t1.prompt).toBe('Proceed with reload? [confirm]');
    t1.execute('');
    expect(t1.execute('show clock')).toBe('\n[Connection to 10.0.12.2 closed by foreign host]');
    expect(t1.prompt).toBe('R1#');
  });
});
