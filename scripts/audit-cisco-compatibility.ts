import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  SimulationEngine,
  TerminalSession,
  deviceCapabilities,
  deviceProfiles,
  inspectorTabIds,
  ENGINE_CONTRACT_VERSION,
  validateSnapshot,
} from '../packages/simulation-engine/src';
import { engineSourceHash } from './engine-build';

// A diagnostic baseline, not a Cisco certification or a percentage of product completion.
// Each case owns its engine so rejected commands and timers cannot affect other cases.
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const output = resolve(
  args.find((arg) => arg !== '--strict') ?? 'artifacts/cisco-completeness-audit-2026-10-26'
);
const checks: {
  id: string;
  requirement: string;
  profile: string;
  status: 'pass' | 'gap';
  transcript: { prompt: string; command: string; response: string }[];
}[] = [];

function check(
  id: string,
  requirement: string,
  profile: string,
  setup: string[],
  command: string,
  accepts: (response: string, cli: TerminalSession, engine: SimulationEngine) => boolean = (r) =>
    !r.startsWith('%')
) {
  const engine = new SimulationEngine();
  const device = engine.addProfile(profile);
  const cli = new TerminalSession(engine, device.id);
  const transcript: (typeof checks)[number]['transcript'] = [];
  for (const input of setup) {
    const prompt = cli.prompt;
    const response = cli.execute(input);
    transcript.push({ prompt, command: input, response });
    if (response.startsWith('%')) throw new Error(`${id}: setup failed: ${input}: ${response}`);
  }
  const prompt = cli.prompt;
  const response = cli.execute(command);
  transcript.push({ prompt, command, response });
  checks.push({
    id,
    requirement,
    profile,
    status: accepts(response, cli, engine) ? 'pass' : 'gap',
    transcript,
  });
}

const config = ['enable', 'configure terminal'];
check('CLI-01', 'Unambiguous keyword abbreviations', 'router', [], 'en');
check('CLI-02', 'Abbreviated operational command', 'router', ['enable'], 'sh ip int br');
check('CLI-03', 'Context-sensitive keyword help', 'router', ['enable'], 'show ip ?');
check('CLI-04', 'EXEC command from configuration mode', 'router', config, 'do show ip interface brief');
check(
  'CLI-05',
  'Disable returns to user EXEC',
  'router',
  ['enable'],
  'disable',
  (r, c) => !r.startsWith('%') && c.context.mode === 'user'
);
check(
  'CLI-06',
  'Running configuration requires privileged EXEC by default',
  'router',
  [],
  'show running-config',
  (r) => r.startsWith('%')
);
check(
  'CLI-07',
  'EXEC show requires do in configuration mode',
  'router',
  config,
  'show ip interface brief',
  (r) => r.startsWith('%')
);
check(
  'CLI-08',
  'Remove interface description with the standard no form',
  'router',
  [...config, 'interface Gi0/1', 'description AUDIT-DESCRIPTION'],
  'no description',
  (r, c, e) => !r.startsWith('%') && !e.device(c.deviceId).interfaces[0].description
);
check('CLI-09', 'Full GigabitEthernet interface name', 'router', config, 'interface GigabitEthernet0/1');
check('CLI-10', 'Interface range configuration', 'switch-l2', config, 'interface range Gi0/1 - 2');
check('CLI-11', 'Output filters', 'router', ['enable'], 'show running-config | include hostname');
check('CLI-12', 'Platform identification', 'router', ['enable'], 'show version');
check(
  'CFG-01',
  'Save running configuration to startup configuration',
  'router',
  ['enable'],
  'copy running-config startup-config'
);
check('CFG-02', 'Inspect startup configuration', 'router', ['enable'], 'show startup-config');
check('CFG-03', 'Reload with startup configuration lifecycle', 'router', ['enable'], 'reload');
check('CFG-04', 'Erase startup configuration', 'router', ['enable'], 'erase startup-config');
check(
  'CFG-05',
  'Running config preserves interface description',
  'router',
  [...config, 'interface Gi0/1', 'description AUDIT-DESCRIPTION', 'end'],
  'show running-config',
  (r) => r.includes('description AUDIT-DESCRIPTION')
);
check(
  'CFG-06',
  'Running config preserves nondefault MTU',
  'router',
  [...config, 'interface Gi0/1', 'mtu 1400', 'end'],
  'show running-config',
  (r) => r.includes('mtu 1400')
);
check(
  'L2-01',
  'Access VLAN configuration',
  'switch-l2',
  [...config, 'vlan 10', 'exit', 'interface Gi0/1'],
  'switchport access vlan 10'
);
check(
  'L2-02',
  'Incremental trunk allowed VLAN updates',
  'switch-l2',
  [...config, 'interface Gi0/1', 'switchport mode trunk'],
  'switchport trunk allowed vlan add 10'
);
check('L2-03', 'Rapid PVST mode', 'switch-l2', config, 'spanning-tree mode rapid-pvst');
check('L2-04', 'Per-VLAN STP bridge priority', 'switch-l2', config, 'spanning-tree vlan 1 priority 4096');
check(
  'L2-05',
  'BPDU Guard on edge ports',
  'switch-l2',
  [...config, 'interface Gi0/1'],
  'spanning-tree bpduguard enable'
);
check('L2-06', 'Trunk operational diagnostics', 'switch-l2', ['enable'], 'show interfaces trunk');
check(
  'L2-07',
  'LACP active membership',
  'switch-l2',
  [...config, 'interface Gi0/1'],
  'channel-group 1 mode active'
);
check('L2-08', 'CDP neighbor diagnostics', 'switch-l2', ['enable'], 'show cdp neighbors');
check('L2-09', 'LLDP neighbor diagnostics', 'switch-l2', ['enable'], 'show lldp neighbors');
check('L3-01', 'L2 switch management SVI', 'switch-l2', config, 'interface Vlan1');
check('L3-02', 'L2 switch management default gateway', 'switch-l2', config, 'ip default-gateway 192.0.2.1');
check(
  'L3-03',
  'IOS OSPF numeric process ID and router configuration mode',
  'router',
  config,
  'router ospf 1',
  (r, c) => !r.startsWith('%') && String(c.context.mode) === 'router'
);
check(
  'L3-04',
  'IOS OSPF interface process binding',
  'router',
  [...config, 'interface Gi0/1'],
  'ip ospf 1 area 0'
);
check('L3-05', 'OSPF supported on multilayer switches', 'switch-l3', config, 'router ospf 1');
check(
  'L3-06',
  'BGP router configuration submode',
  'router',
  config,
  'router bgp 65001',
  (r, c) => !r.startsWith('%') && String(c.context.mode) === 'router'
);
check(
  'L3-07',
  'RIP router configuration submode',
  'router',
  config,
  'router rip',
  (r, c) => !r.startsWith('%') && String(c.context.mode) === 'router'
);
check(
  'L3-08',
  'Floating static routes with administrative distance',
  'router',
  config,
  'ip route 198.51.100.0 255.255.255.0 192.0.2.1 200'
);
check('L3-09', 'HSRP virtual gateway', 'router', [...config, 'interface Gi0/1'], 'standby 1 ip 192.0.2.254');
check('SEC-01', 'Named extended ACL configuration submode', 'router', config, 'ip access-list extended WEB');
check(
  'SEC-02',
  'Cisco static NAT syntax',
  'router',
  config,
  'ip nat inside source static 192.0.2.10 198.51.100.10'
);
check('SEC-03', 'SSH virtual terminal line configuration', 'router', config, 'line vty 0 4');
check('SEC-04', 'Enable secret configuration', 'router', config, 'enable secret AuditOnly-12345');
check(
  'OPS-01',
  'Down interfaces are absent from installed connected routes',
  'router',
  [...config, 'interface Gi0/1', 'ip address 192.0.2.1 255.255.255.0', 'shutdown', 'end'],
  'show ip route',
  (r) => !r.includes('C 192.0.2.0/24')
);
check(
  'OPS-02',
  'DHCP pool submode',
  'router',
  [...config, 'interface Gi0/1', 'ip address 192.0.2.1 255.255.255.0', 'exit'],
  'ip dhcp pool USERS',
  (r, c) => !r.startsWith('%') && c.context.mode === 'dhcp'
);

const profiles = deviceProfiles.map((profile) => {
  const engine = new SimulationEngine();
  const device = engine.addFactoryProfile(profile.id);
  const capabilities = deviceCapabilities(device);
  const cli = new TerminalSession(engine, device.id);
  const help = cli.execute('help');
  validateSnapshot(engine.snapshot());
  validateSnapshot(new SimulationEngine(engine.snapshot()).snapshot());
  return {
    id: profile.id,
    model: profile.model,
    type: profile.type,
    terminal: cli.identity.family,
    power: device.power,
    tabs: inspectorTabIds(device),
    capabilities,
    smokePassed: !help.startsWith('%'),
  };
});
const report = {
  date: '2026-10-26',
  engineContract: ENGINE_CONTRACT_VERSION,
  engineSourceHash: engineSourceHash(),
  scope: 'Selected IOS/IOS XE baseline commands plus catalog, help, schema and restore smoke checks',
  limitations:
    'No Cisco firmware, physical device, Cisco CML comparison, or full standards certification. Passing catalog smoke checks do not validate all device protocols.',
  summary: {
    checks: checks.length,
    passed: checks.filter((c) => c.status === 'pass').length,
    gaps: checks.filter((c) => c.status === 'gap').length,
    profiles: profiles.length,
    profileSmokePassed: profiles.filter((p) => p.smokePassed).length,
  },
  checks,
  profiles,
};
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'cisco-compatibility.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary));
for (const c of checks.filter((c) => c.status === 'gap')) console.log(`${c.id}: ${c.requirement}`);
if (strict && report.summary.gaps) process.exitCode = 1;
