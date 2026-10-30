import { describe, expect, it } from 'vitest';
import { SimulationEngine, TerminalSession, validateSnapshot } from '../packages/simulation-engine/src';
import { hashIosSecret, verifyIosSecret } from '../packages/simulation-engine/src/cli/local-security';

describe('IOS local enable secrets', () => {
  it('rejects IOS startup commands on endpoints without changing their power lifecycle', () => {
    const e = new SimulationEngine(),
      pc = e.addDevice('pc'),
      cli = new TerminalSession(e, pc.id);
    cli.execute('enable');
    expect(cli.execute('erase startup-config')).toMatch(/^%/);
    expect(pc.bootManaged).toBeUndefined();
    e.setDevicePower(pc.id, false);
    e.setDevicePower(pc.id, true);
    validateSnapshot(e.snapshot());
  });
  it('matches independently published Cisco type 8/9 test vectors', () => {
    // Hashcat's public module self-test vectors (modules 09200 and 09300).
    for (const [type, salt, hash] of [
      [8, '84486783037343', '$8$84486783037343$pYNyVrtyMalQrZLxRi7ZLQS1Fl.jkYCgASUi5P8JNb2'],
      [9, '87023684531115', '$9$87023684531115$phio0TBQwaO7KZ8toQFyGFyDvyOzidaypRWN0uKX0hU'],
    ] as const) {
      expect(hashIosSecret('hashcat', type, salt)).toBe(hash);
      expect(verifyIosSecret('hashcat', hash)).toBe(true);
      expect(verifyIosSecret('wrong', hash)).toBe(false);
    }
  });
  it('requires a secret for enable, limits attempts and never records passwords', () => {
    const e = new SimulationEngine(),
      d = e.addProfile('router'),
      cli = new TerminalSession(e, d.id);
    for (const command of ['en', 'conf t', 'ena sec test-secret!', 'end', 'disable', 'en'])
      expect(cli.execute(command), command).not.toMatch(/^%/);
    expect(cli.prompt).toBe('Password:');
    expect(cli.secretInput).toBe(true);
    expect(cli.execute('wrong')).toBe('% Bad secrets');
    expect(cli.context.mode).toBe('user');
    expect(cli.execute('test-secret!')).toBe('');
    expect(cli.context.mode).toBe('privileged');
    expect(JSON.stringify({ history: cli.history, snapshot: e.snapshot() })).not.toContain('test-secret!');
    expect(cli.execute('show running-config')).toContain('enable secret 9 $9$');
    for (const command of ['disable', 'en', 'wrong', 'wrong', 'wrong']) cli.execute(command);
    expect(cli.secretInput).toBe(false);
    expect(cli.context.mode).toBe('user');
    expect(cli.execute('conf t')).toMatch(/^%/);
    validateSnapshot(e.snapshot());
  });
  it('preserves encoded secrets through startup and reload with no plaintext export', () => {
    const e = new SimulationEngine(),
      d = e.addProfile('router'),
      cli = new TerminalSession(e, d.id);
    for (const command of [
      'en',
      'conf t',
      'enable algorithm-type sha256 secret persistent-secret',
      'end',
      'write memory',
      'reload',
      '',
    ])
      expect(cli.execute(command), command).not.toMatch(/^%/);
    const restored = new SimulationEngine(e.snapshot()),
      rcli = new TerminalSession(restored, d.id);
    rcli.execute('enable');
    expect(rcli.secretInput).toBe(true);
    rcli.execute('persistent-secret');
    expect(rcli.context.mode).toBe('privileged');
    expect(rcli.execute('show startup-config')).toContain('enable secret 8 $8$');
    expect(JSON.stringify(e.snapshot())).not.toContain('persistent-secret');
    rcli.execute('conf t');
    rcli.execute('no enable secret');
    rcli.execute('end');
    rcli.execute('disable');
    rcli.execute('enable');
    expect(rcli.secretInput).toBe(false);
    validateSnapshot(restored.snapshot());
  });
  it('keeps UART password entry out of persisted console history and events', () => {
    const e = new SimulationEngine(),
      source = e.addDevice('pc'),
      target = e.addDevice('router');
    const a = e.addHardwarePort(source.id, 'console'),
      b = e.addHardwarePort(target.id, 'console');
    const link = e.connect({ device: source.id, port: a.id }, { device: target.id, port: b.id }, 'console');
    for (const command of [
      'en',
      'conf t',
      'enable secret uart-only-secret',
      'end',
      'disable',
      'en',
      'uart-only-secret',
    ])
      expect(e.consoleCommand(source.id, link.id, command), command).not.toMatch(/^%/);
    const state = e.snapshot();
    expect(state.devices.find((d) => d.id === target.id)!.consoleSessions![0].context.mode).toBe(
      'privileged'
    );
    expect(JSON.stringify(state)).not.toContain('uart-only-secret');
    validateSnapshot(state);
  });
});
