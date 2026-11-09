import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface } from '../model';
import {
  ESP_TRANSFORMS,
  ISAKMP_ENCRYPTION,
  ISAKMP_HASH,
  emptyCrypto,
  type CryptoConfig,
} from '../protocols/ios-tunnel-model';
import {
  defaultTunnelMtu,
  ipLiteral,
  resetIosTunnel,
  tunnelSourceIp,
  tunnelSourcePort,
} from '../protocols/ios-tunnel';
import { interfaceBandwidthKbps } from '../protocols/ospf';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry, type Context } from './registry';
import { interfaceReference } from './ios-management';
import { ospfConfiguration } from './ospf';

const cryptoOf = (d: Device): CryptoConfig => (d.crypto ??= emptyCrypto());
const NAME = /^[\w.+@-]{1,64}$/;
function tunnelPort(d: Device, c: Context) {
  const p = currentPort(d, c);
  if (!p.iosTunnel) throw new Error('% This command applies to tunnel interfaces.');
  return p;
}
/** A tunnel setting changed: IOS restarts the tunnel (and its SA); MTU follows unless set. */
function changed(e: SimulationEngine, d: Device, p: NetworkInterface, before: number) {
  if (p.mtu === before) p.mtu = defaultTunnelMtu(p.iosTunnel!);
  resetIosTunnel(e, d, p);
}
const v4 = (value: string) => {
  if (!ipLiteral(value) || value.split('.').some((x) => Number(x) > 255))
    throw new Error('% Invalid IPv4 address.');
  return value;
};
function profileNamed(d: Device, c: Context) {
  const p = cryptoOf(d).ipsecProfiles.find((x) => x.name === c.name);
  if (!p) throw new Error('Select an IPsec profile.');
  return p;
}
/** Tunnels using a crypto object re-negotiate when it changes. */
function rekeyAll(e: SimulationEngine, d: Device) {
  for (const p of d.interfaces)
    if (p.iosTunnel && (p.iosTunnel.mode === 'ipsec' || p.iosTunnel.protection)) resetIosTunnel(e, d, p);
}

export function registerIosTunnelCommands(r: CommandRegistry) {
  // --- interface TunnelN ---------------------------------------------------------------------------
  r.register({
    pattern: /^(no )?tunnel source(?: (\S+))?$/i,
    syntax: ['tunnel source <interface|address>', 'no tunnel source'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = tunnelPort(d, c),
        t = p.iosTunnel!,
        before = p.mtu;
      if (m[1]) delete t.source;
      else if (!m[2]) throw new Error('% Incomplete command.');
      else t.source = ipLiteral(m[2]) ? v4(m[2]) : interfaceReference(d, m[2]);
      if (t.source && tunnelSourcePort(d, t) === p)
        throw new Error('% A tunnel cannot use itself as source.');
      changed(e, d, p, before);
    },
  });
  r.register({
    pattern: /^(no )?tunnel destination(?: (\S+))?$/i,
    syntax: ['tunnel destination <address>', 'no tunnel destination'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = tunnelPort(d, c),
        t = p.iosTunnel!,
        before = p.mtu;
      if (m[1]) delete t.destination;
      else if (!m[2]) throw new Error('% Incomplete command.');
      else if (!ipLiteral(m[2])) throw new Error('% Use the IPv4 address of the tunnel destination.');
      else t.destination = v4(m[2]);
      changed(e, d, p, before);
    },
  });
  r.register({
    pattern: /^(no )?tunnel mode(?: (gre ip|gre|ipsec ipv4|gre multipoint|.+))?$/i,
    syntax: ['tunnel mode gre ip', 'tunnel mode ipsec ipv4'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = tunnelPort(d, c),
        t = p.iosTunnel!,
        before = p.mtu,
        mode = m[1] ? 'gre ip' : (m[2]?.toLowerCase() ?? '');
      if (mode === 'gre multipoint')
        throw new Error('% DMVPN (mGRE with NHRP) is not modeled: use point-to-point GRE or IPsec tunnels.');
      if (!['gre', 'gre ip', 'ipsec ipv4'].includes(mode))
        throw new Error('% Supported modes: gre ip, ipsec ipv4.');
      t.mode = mode === 'ipsec ipv4' ? 'ipsec' : 'gre';
      if (t.mode === 'ipsec') {
        delete t.key;
        delete t.keepalive;
      }
      changed(e, d, p, before);
    },
  });
  r.register({
    pattern: /^(no )?tunnel key(?: (\d+))?$/i,
    syntax: ['tunnel key <number>', 'no tunnel key'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = tunnelPort(d, c),
        t = p.iosTunnel!,
        before = p.mtu;
      if (t.mode !== 'gre') throw new Error('% Tunnel keys apply to GRE tunnels.');
      if (m[1]) delete t.key;
      else if (!m[2] || Number(m[2]) > 4294967295) throw new Error('% Key is 0-4294967295.');
      else t.key = Number(m[2]);
      changed(e, d, p, before);
    },
  });
  r.register({
    pattern: /^(no )?keepalive(?: (\d+)(?: (\d+))?)?$/i,
    syntax: ['keepalive <period> <retries>', 'no keepalive'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = tunnelPort(d, c),
        t = p.iosTunnel!;
      if (m[1]) delete t.keepalive;
      else {
        if (t.mode !== 'gre') throw new Error('% GRE keepalives are not supported in this tunnel mode.');
        const periodS = Number(m[2] ?? 10),
          retries = Number(m[3] ?? 3);
        if (periodS < 1 || periodS > 32767 || retries < 1 || retries > 255)
          throw new Error('% Keepalive period is 1-32767 s and retries 1-255.');
        t.keepalive = { periodS, retries };
      }
      changed(e, d, p, p.mtu);
    },
  });
  r.register({
    pattern: /^(no )?tunnel protection ipsec profile(?: (\S+))?(?: shared)?$/i,
    syntax: ['tunnel protection ipsec profile <name>', 'no tunnel protection ipsec profile'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = tunnelPort(d, c),
        t = p.iosTunnel!,
        before = p.mtu;
      if (m[1]) delete t.protection;
      else {
        if (!m[2]) throw new Error('% Incomplete command.');
        if (!cryptoOf(d).ipsecProfiles.some((x) => x.name === m[2]))
          throw new Error('% IPSEC profile ' + m[2] + ' not found.');
        t.protection = m[2];
      }
      changed(e, d, p, before);
    },
  });
  r.register({
    pattern: /^(no )?ip mtu(?: (\d+))?$/i,
    syntax: ['ip mtu <bytes>', 'no ip mtu'],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (p.mode !== 'routed') throw new Error('% ip mtu applies to routed interfaces.');
      const fallback = p.iosTunnel ? defaultTunnelMtu(p.iosTunnel) : p.loopback ? 9216 : 1500;
      if (m[1]) p.mtu = fallback;
      else if (!m[2] || Number(m[2]) < 68 || Number(m[2]) > 9216)
        throw new Error('% IP MTU is 68-9216 bytes.');
      else p.mtu = Number(m[2]);
    },
  });
  r.register({
    pattern: /^(no )?bandwidth(?: (\d+))?$/i,
    syntax: ['bandwidth <kbps>', 'no bandwidth'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c);
      if (m[1]) delete p.bandwidthKbps;
      else if (!m[2] || Number(m[2]) < 1 || Number(m[2]) > 100000000)
        throw new Error('% Bandwidth is 1-100000000 kbit/s.');
      else p.bandwidthKbps = Number(m[2]);
      // OSPF auto-cost follows the configured bandwidth.
      if (d.ospf) e.configureOspf(d.id, ospfConfiguration(d));
    },
  });
  // --- crypto isakmp (IKEv1) ----------------------------------------------------------------------
  r.register({
    pattern: /^(no )?crypto isakmp policy (\d+)$/i,
    syntax: 'crypto isakmp policy <priority>',
    modes: CONFIG_MODES,
    run: (m, e, d, c) => {
      const priority = Number(m[2]),
        policies = cryptoOf(d).isakmpPolicies;
      if (priority < 1 || priority > 10000) throw new Error('% Priority is 1-10000.');
      if (m[1]) {
        cryptoOf(d).isakmpPolicies = policies.filter((x) => x.priority !== priority);
        rekeyAll(e, d);
        return;
      }
      if (!policies.some((x) => x.priority === priority)) {
        if (policies.length >= 16) throw new Error('% At most 16 ISAKMP policies.');
        // IOS defaults of a new policy.
        policies.push({
          priority,
          encryption: 'des',
          hash: 'sha',
          authentication: 'rsa-sig',
          group: 1,
          lifetimeS: 86400,
        });
      }
      c.mode = 'isakmp-policy';
      c.sequence = priority;
    },
  });
  const policy = (d: Device, c: Context) => {
    const p = cryptoOf(d).isakmpPolicies.find((x) => x.priority === c.sequence);
    if (!p) throw new Error('Select an ISAKMP policy.');
    return p;
  };
  r.register({
    pattern: /^(?:encr|encryption) (des|3des|aes(?: (?:128|192|256))?)$/i,
    syntax: ['encryption aes 256', 'encryption aes', 'encryption 3des'],
    modes: ['isakmp-policy'],
    run: (m, e, d, c) => {
      const value = m[1].toLowerCase().replace(/^aes 128$/, 'aes') as (typeof ISAKMP_ENCRYPTION)[number];
      policy(d, c).encryption = value;
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^hash (md5|sha|sha256|sha384|sha512)$/i,
    syntax: ['hash sha256', 'hash sha'],
    modes: ['isakmp-policy'],
    run: (m, e, d, c) => {
      policy(d, c).hash = m[1].toLowerCase() as (typeof ISAKMP_HASH)[number];
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^authentication (pre-share|rsa-sig)$/i,
    syntax: ['authentication pre-share'],
    modes: ['isakmp-policy'],
    run: (m, e, d, c) => {
      policy(d, c).authentication = m[1].toLowerCase() as 'pre-share' | 'rsa-sig';
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^group (1|2|5|14|15|16|19|20|21|24)$/i,
    syntax: ['group 14'],
    modes: ['isakmp-policy'],
    run: (m, e, d, c) => {
      policy(d, c).group = Number(m[1]);
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^lifetime (\d+)$/i,
    syntax: 'lifetime <seconds>',
    modes: ['isakmp-policy'],
    run: (m, _e, d, c) => {
      const s = Number(m[1]);
      if (s < 60 || s > 86400) throw new Error('% Lifetime is 60-86400 seconds.');
      policy(d, c).lifetimeS = s;
    },
  });
  r.register({
    pattern: /^(no )?crypto isakmp key (?:(0|6) )?(\S+) address ([\d.]+)(?: ([\d.]+))?(?: no-xauth)?$/i,
    syntax: ['crypto isakmp key <key> address <peer>', 'crypto isakmp key <key> address 0.0.0.0 0.0.0.0'],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      if (m[2] === '6') throw new Error('% Type 6 keys need the AES master key; use a clear-text key.');
      const address = v4(m[4]),
        maskValue = m[5] ? v4(m[5]) : '255.255.255.255',
        keys = cryptoOf(d).isakmpKeys.filter((k) => !(k.address === address && k.mask === maskValue));
      if (!m[1]) {
        if (keys.length >= 64) throw new Error('% At most 64 ISAKMP keys.');
        keys.push({ address, mask: maskValue, key: m[3] });
      }
      cryptoOf(d).isakmpKeys = keys;
      rekeyAll(e, d);
    },
  });
  // --- crypto ipsec -------------------------------------------------------------------------------
  r.register({
    pattern: /^(no )?crypto ipsec transform-set (\S+)((?: (?:esp-[\w-]+(?: (?:128|192|256))?|ah-[\w-]+))*)$/i,
    syntax: [
      'crypto ipsec transform-set <name> esp-aes 256 esp-sha256-hmac',
      'crypto ipsec transform-set <name> esp-gcm 256',
    ],
    modes: CONFIG_MODES,
    run: (m, e, d, c) => {
      const name = m[2],
        sets = cryptoOf(d).transformSets;
      if (!NAME.test(name)) throw new Error('% Invalid transform-set name.');
      if (m[1]) {
        cryptoOf(d).transformSets = sets.filter((x) => x.name !== name);
        rekeyAll(e, d);
        return;
      }
      const words = m[3].trim().toLowerCase().split(/\s+/).filter(Boolean),
        transforms: string[] = [];
      for (let i = 0; i < words.length; i++)
        transforms.push(/^\d+$/.test(words[i + 1] ?? '') ? words[i] + ' ' + words[++i] : words[i]);
      const known = transforms.map((x) => x.replace(/ 128$/, '')) as (typeof ESP_TRANSFORMS)[number][];
      if (known.some((x) => !(ESP_TRANSFORMS as readonly string[]).includes(x)))
        throw new Error(
          '% Supported transforms: esp-aes [128|192|256], esp-gcm, esp-3des, esp-sha*-hmac, esp-md5-hmac.'
        );
      const existing = sets.find((x) => x.name === name);
      if (!known.length && !existing) throw new Error('% Specify at least one transform.');
      if (existing) {
        if (known.length) existing.transforms = known;
      } else {
        if (sets.length >= 16) throw new Error('% At most 16 transform sets.');
        sets.push({ name, transforms: known, mode: 'tunnel' });
      }
      c.mode = 'transform-set';
      c.name = name;
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^mode (tunnel|transport)$/i,
    syntax: ['mode tunnel', 'mode transport'],
    modes: ['transform-set'],
    run: (m, _e, d, c) => {
      const set = cryptoOf(d).transformSets.find((x) => x.name === c.name);
      if (!set) throw new Error('Select a transform set.');
      set.mode = m[1].toLowerCase() as 'tunnel' | 'transport';
    },
  });
  r.register({
    pattern: /^(no )?crypto ipsec profile (\S+)$/i,
    syntax: 'crypto ipsec profile <name>',
    modes: CONFIG_MODES,
    run: (m, e, d, c) => {
      const profiles = cryptoOf(d).ipsecProfiles;
      if (!NAME.test(m[2])) throw new Error('% Invalid profile name.');
      if (m[1]) {
        if (d.interfaces.some((p) => p.iosTunnel?.protection === m[2]))
          throw new Error('% The profile is applied to a tunnel interface.');
        cryptoOf(d).ipsecProfiles = profiles.filter((x) => x.name !== m[2]);
        return;
      }
      if (!profiles.some((x) => x.name === m[2])) {
        if (profiles.length >= 16) throw new Error('% At most 16 IPsec profiles.');
        profiles.push({ name: m[2], transformSets: [] });
      }
      c.mode = 'ipsec-profile';
      c.name = m[2];
    },
  });
  r.register({
    pattern: /^(no )?set (transform-set|ikev2-profile|pfs|security-association lifetime seconds)(?: (.+))?$/i,
    syntax: [
      'set transform-set <name>',
      'set ikev2-profile <name>',
      'set pfs group14',
      'set security-association lifetime seconds <s>',
    ],
    modes: ['ipsec-profile'],
    run: (m, e, d, c) => {
      const p = profileNamed(d, c),
        what = m[2].toLowerCase(),
        value = m[3]?.trim();
      if (what === 'transform-set') {
        const names = value ? value.split(/\s+/) : [];
        if (!m[1]) {
          if (!names.length) throw new Error('% Incomplete command.');
          const missing = names.find((n) => !cryptoOf(d).transformSets.some((x) => x.name === n));
          if (missing) throw new Error('% Transform set ' + missing + ' does not exist.');
        }
        p.transformSets = m[1] ? [] : names.slice(0, 6);
      } else if (what === 'ikev2-profile') {
        if (m[1]) delete p.ikev2Profile;
        else if (!value || !cryptoOf(d).ikev2Profiles.some((x) => x.name === value))
          throw new Error('% IKEv2 profile ' + (value ?? '') + ' does not exist.');
        else p.ikev2Profile = value;
      } else if (what === 'pfs') {
        const group = /^group(\d+)$/i.exec(value ?? '')?.[1];
        if (m[1]) delete p.pfs;
        else if (!group) throw new Error('% Use set pfs group<N>.');
        else p.pfs = Number(group);
      } else if (m[1]) delete p.lifetimeS;
      else if (!value || Number(value) < 120 || Number(value) > 86400)
        throw new Error('% Lifetime is 120-86400 seconds.');
      else p.lifetimeS = Number(value);
      rekeyAll(e, d);
    },
  });
  // --- crypto ikev2 --------------------------------------------------------------------------------
  r.register({
    pattern: /^(no )?crypto ikev2 (proposal|policy|keyring|profile) (\S+)$/i,
    syntax: [
      'crypto ikev2 proposal <name>',
      'crypto ikev2 policy <name>',
      'crypto ikev2 keyring <name>',
      'crypto ikev2 profile <name>',
    ],
    modes: CONFIG_MODES,
    run: (m, e, d, c) => {
      const kind = m[2].toLowerCase() as 'proposal' | 'policy' | 'keyring' | 'profile',
        name = m[3],
        x = cryptoOf(d);
      if (!NAME.test(name)) throw new Error('% Invalid name.');
      const lists = {
        proposal: x.ikev2Proposals,
        policy: x.ikev2Policies,
        keyring: x.ikev2Keyrings,
        profile: x.ikev2Profiles,
      };
      const list = lists[kind] as { name: string }[];
      if (m[1]) {
        list.splice(
          list.findIndex((y) => y.name === name),
          list.some((y) => y.name === name) ? 1 : 0
        );
        rekeyAll(e, d);
        return;
      }
      if (!list.some((y) => y.name === name)) {
        if (list.length >= 8) throw new Error('% At most 8 IKEv2 ' + kind + 's.');
        if (kind === 'proposal') x.ikev2Proposals.push({ name, encryption: [], integrity: [], groups: [] });
        else if (kind === 'policy') x.ikev2Policies.push({ name, proposals: [] });
        else if (kind === 'keyring') x.ikev2Keyrings.push({ name, peers: [] });
        else x.ikev2Profiles.push({ name, remote: [] });
      }
      c.mode = ('ikev2-' + kind) as Context['mode'];
      c.name = name;
    },
  });
  const proposal = (d: Device, c: Context) => {
    const p = cryptoOf(d).ikev2Proposals.find((x) => x.name === c.name);
    if (!p) throw new Error('Select an IKEv2 proposal.');
    return p;
  };
  r.register({
    pattern: /^(encryption|integrity|group) (.+)$/i,
    syntax: ['encryption aes-cbc-256', 'integrity sha256', 'group 14'],
    modes: ['ikev2-proposal'],
    run: (m, e, d, c) => {
      const p = proposal(d, c),
        values = m[2].trim().toLowerCase().split(/\s+/);
      if (m[1].toLowerCase() === 'group') {
        if (values.some((v) => !/^\d+$/.test(v))) throw new Error('% Use DH group numbers.');
        p.groups = values.map(Number).slice(0, 4);
      } else if (values.some((v) => !/^[\w-]{2,24}$/.test(v))) throw new Error('% Invalid algorithm.');
      else if (m[1].toLowerCase() === 'encryption') p.encryption = values.slice(0, 4);
      else p.integrity = values.slice(0, 4);
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^(no )?proposal (\S+)$/i,
    syntax: 'proposal <name>',
    modes: ['ikev2-policy'],
    run: (m, e, d, c) => {
      const p = cryptoOf(d).ikev2Policies.find((x) => x.name === c.name);
      if (!p) throw new Error('Select an IKEv2 policy.');
      p.proposals = p.proposals.filter((x) => x !== m[2]);
      if (!m[1]) {
        if (!cryptoOf(d).ikev2Proposals.some((x) => x.name === m[2]))
          throw new Error('% IKEv2 proposal ' + m[2] + ' does not exist.');
        p.proposals.push(m[2]);
      }
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^(no )?peer (\S+)$/i,
    syntax: 'peer <name>',
    modes: ['ikev2-keyring'],
    run: (m, e, d, c) => {
      const k = cryptoOf(d).ikev2Keyrings.find((x) => x.name === c.name);
      if (!k) throw new Error('Select an IKEv2 keyring.');
      if (m[1]) {
        k.peers = k.peers.filter((x) => x.name !== m[2]);
        rekeyAll(e, d);
        return;
      }
      if (!k.peers.some((x) => x.name === m[2])) {
        if (k.peers.length >= 64) throw new Error('% At most 64 peers.');
        k.peers.push({ name: m[2] });
      }
      c.mode = 'ikev2-keyring-peer';
      c.peer = m[2];
    },
  });
  const keyringPeer = (d: Device, c: Context) => {
    const p = cryptoOf(d)
      .ikev2Keyrings.find((x) => x.name === c.name)
      ?.peers.find((x) => x.name === c.peer);
    if (!p) throw new Error('Select a keyring peer.');
    return p;
  };
  r.register({
    pattern: /^(no )?address(?: ([\d.]+)(?: ([\d.]+))?)?$/i,
    syntax: 'address <ip> [mask]',
    modes: ['ikev2-keyring-peer'],
    run: (m, e, d, c) => {
      const p = keyringPeer(d, c);
      if (m[1]) {
        delete p.address;
        delete p.mask;
      } else if (!m[2]) throw new Error('% Incomplete command.');
      else {
        p.address = v4(m[2]);
        if (m[3]) p.mask = v4(m[3]);
        else delete p.mask;
      }
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^(no )?pre-shared-key(?: (?:local |remote )?(?:(0|6) )?(\S+))?$/i,
    syntax: 'pre-shared-key <key>',
    modes: ['ikev2-keyring-peer'],
    run: (m, e, d, c) => {
      const p = keyringPeer(d, c);
      if (m[2] === '6') throw new Error('% Type 6 keys need the AES master key; use a clear-text key.');
      if (m[1]) delete p.key;
      else if (!m[3]) throw new Error('% Incomplete command.');
      else p.key = m[3];
      rekeyAll(e, d);
    },
  });
  const ikev2Profile = (d: Device, c: Context) => {
    const p = cryptoOf(d).ikev2Profiles.find((x) => x.name === c.name);
    if (!p) throw new Error('Select an IKEv2 profile.');
    return p;
  };
  r.register({
    pattern: /^(no )?match identity remote address ([\d.]+)(?: ([\d.]+))?$/i,
    syntax: 'match identity remote address <ip> <mask>',
    modes: ['ikev2-profile'],
    run: (m, e, d, c) => {
      const p = ikev2Profile(d, c),
        address = v4(m[2]),
        maskValue = m[3] ? v4(m[3]) : '255.255.255.255';
      p.remote = p.remote.filter((x) => !(x.address === address && x.mask === maskValue));
      if (!m[1]) p.remote.push({ address, mask: maskValue });
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^(no )?authentication (local|remote) pre-share$/i,
    syntax: ['authentication local pre-share', 'authentication remote pre-share'],
    modes: ['ikev2-profile'],
    run: (m, e, d, c) => {
      const p = ikev2Profile(d, c),
        field = m[2].toLowerCase() === 'local' ? 'localAuth' : 'remoteAuth';
      if (m[1]) delete p[field];
      else p[field] = 'pre-share';
      rekeyAll(e, d);
    },
  });
  r.register({
    pattern: /^(no )?keyring local(?: (\S+))?$/i,
    syntax: 'keyring local <name>',
    modes: ['ikev2-profile'],
    run: (m, e, d, c) => {
      const p = ikev2Profile(d, c);
      if (m[1]) delete p.keyring;
      else if (!m[2] || !cryptoOf(d).ikev2Keyrings.some((x) => x.name === m[2]))
        throw new Error('% Keyring ' + (m[2] ?? '') + ' does not exist.');
      else p.keyring = m[2];
      rekeyAll(e, d);
    },
  });
  // --- show ----------------------------------------------------------------------------------------
  r.register({
    pattern: /^show crypto (isakmp|ikev2) sa$/i,
    syntax: ['show crypto isakmp sa', 'show crypto ikev2 sa'],
    modes: ALL_MODES,
    run: (m, e, d) => {
      const v2 = m[1].toLowerCase() === 'ikev2',
        tunnels = d.interfaces.filter((p) => p.iosTunnel?.sa?.version === (v2 ? 2 : 1));
      if (!v2)
        return [
          'IPv4 Crypto ISAKMP SA',
          'dst             src             state          conn-id status',
          ...tunnels.map(
            (p, i) =>
              (p.iosTunnel!.sa!.initiator
                ? p.iosTunnel!.destination!
                : tunnelSourceIp(d, p.iosTunnel!)!
              ).padEnd(16) +
              (p.iosTunnel!.sa!.initiator
                ? tunnelSourceIp(d, p.iosTunnel!)!
                : p.iosTunnel!.destination!
              ).padEnd(16) +
              'QM_IDLE'.padEnd(15) +
              String(1001 + i).padStart(7) +
              ' ACTIVE'
          ),
        ].join('\n');
      return [
        ' IPv4 Crypto IKEv2  SA ',
        '',
        'Tunnel-id Local                 Remote                fvrf/ivrf            Status ',
        ...tunnels.flatMap((p, i) => {
          const t = p.iosTunnel!,
            sa = t.sa!,
            [enc, prf, group] = (sa.proposal ?? '').split('/');
          return [
            String(i + 1).padEnd(10) +
              (tunnelSourceIp(d, t) + '/500').padEnd(22) +
              (t.destination + '/500').padEnd(22) +
              'none/none'.padEnd(21) +
              'READY',
            `      Encr: ${enc?.toUpperCase()}, PRF: ${prf?.toUpperCase()}, Hash: ${prf?.toUpperCase()}, DH Grp:${group?.replace('group', '')}, Auth sign: PSK, Auth verify: PSK`,
            `      Life/Active Time: 86400/${Math.round((e.state.clock - (sa.establishedAt ?? 0)) / 1000)} sec`,
          ];
        }),
      ].join('\n');
    },
  });
  r.register({
    pattern: /^show crypto ipsec sa$/i,
    syntax: 'show crypto ipsec sa',
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      d.interfaces
        .filter((p) => p.iosTunnel && (p.iosTunnel.mode === 'ipsec' || p.iosTunnel.protection))
        .map((p) => {
          const t = p.iosTunnel!,
            sa = t.sa,
            local = tunnelSourceIp(d, t) ?? '0.0.0.0',
            gre = t.mode === 'gre';
          return [
            `interface: ${p.name}`,
            `    Crypto map tag: ${p.name}-head-0, local addr ${local}`,
            '',
            '   protected vrf: (none)',
            `   local  ident (addr/mask/prot/port): (${gre ? local + '/255.255.255.255/47/0' : '0.0.0.0/0.0.0.0/0/0'})`,
            `   remote ident (addr/mask/prot/port): (${gre ? t.destination + '/255.255.255.255/47/0' : '0.0.0.0/0.0.0.0/0/0'})`,
            `   current_peer ${t.destination ?? '0.0.0.0'} port 500`,
            '     PERMIT, flags={origin_is_acl,}',
            `    #pkts encaps: ${sa?.encaps ?? 0}, #pkts encrypt: ${sa?.encaps ?? 0}, #pkts digest: ${sa?.encaps ?? 0}`,
            `    #pkts decaps: ${sa?.decaps ?? 0}, #pkts decrypt: ${sa?.decaps ?? 0}, #pkts verify: ${sa?.decaps ?? 0}`,
            '',
            `     local crypto endpt.: ${local}, remote crypto endpt.: ${t.destination ?? '0.0.0.0'}`,
            `     current outbound spi: 0x${(sa?.outSpi ?? '0').toUpperCase()}(${parseInt(sa?.outSpi ?? '0', 16)})`,
            '',
            '     inbound esp sas:',
            ...(sa
              ? [
                  `      spi: 0x${sa.inSpi.toUpperCase()}(${parseInt(sa.inSpi, 16)})`,
                  `        transform: ${sa.transform} ,`,
                  '        status: ACTIVE',
                ]
              : []),
            '',
            '     outbound esp sas:',
            ...(sa?.outSpi
              ? [
                  `      spi: 0x${sa.outSpi.toUpperCase()}(${parseInt(sa.outSpi, 16)})`,
                  `        transform: ${sa.transform} ,`,
                  '        status: ACTIVE',
                ]
              : []),
          ].join('\n');
        })
        .join('\n\n') || 'No IPsec security associations.',
  });
  r.register({
    pattern: /^show crypto session$/i,
    syntax: 'show crypto session',
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      [
        'Crypto session current status',
        '',
        ...d.interfaces
          .filter((p) => p.iosTunnel && (p.iosTunnel.mode === 'ipsec' || p.iosTunnel.protection))
          .flatMap((p) => {
            const t = p.iosTunnel!,
              up = t.sa?.phase === 'established';
            return [
              `Interface: ${p.name}`,
              `Session status: ${up ? 'UP-ACTIVE' : 'DOWN'}`,
              `Peer: ${t.destination ?? '0.0.0.0'} port 500`,
              ...(up
                ? [
                    `  IKEv${t.sa!.version} SA: local ${tunnelSourceIp(d, t)}/500 remote ${t.destination}/500 Active`,
                    `  IPSEC FLOW: permit ${t.mode === 'gre' ? '47 host ' + tunnelSourceIp(d, t) + ' host ' + t.destination : 'ip 0.0.0.0/0.0.0.0 0.0.0.0/0.0.0.0'}`,
                    '        Active SAs: 2, origin: crypto map',
                  ]
                : t.negotiation?.lastError
                  ? ['  Last IKE failure: ' + t.negotiation.lastError]
                  : []),
              '',
            ];
          }),
      ].join('\n'),
  });
}

// --- running-config ----------------------------------------------------------------------------------
/** Lines of an IOS tunnel interface (inside its "interface TunnelN" block). */
export function iosTunnelInterfaceLines(p: NetworkInterface) {
  const t = p.iosTunnel;
  return [
    ...(p.bandwidthKbps !== undefined ? [' bandwidth ' + p.bandwidthKbps] : []),
    ...(t
      ? [
          ...(p.mtu !== defaultTunnelMtu(t) ? [' ip mtu ' + p.mtu] : []),
          ...(t.keepalive ? [` keepalive ${t.keepalive.periodS} ${t.keepalive.retries}`] : []),
          ...(t.source ? [' tunnel source ' + t.source] : []),
          ...(t.mode === 'ipsec' ? [' tunnel mode ipsec ipv4'] : []),
          ...(t.destination ? [' tunnel destination ' + t.destination] : []),
          ...(t.key !== undefined ? [' tunnel key ' + t.key] : []),
          ...(t.protection ? [' tunnel protection ipsec profile ' + t.protection] : []),
        ]
      : []),
  ];
}
/** Global crypto configuration, printed before the interfaces like IOS. */
export function cryptoRunningConfig(d: Device) {
  const c = d.crypto;
  if (!c) return [];
  return [
    ...c.ikev2Proposals.flatMap((x) => [
      'crypto ikev2 proposal ' + x.name,
      ...(x.encryption.length ? [' encryption ' + x.encryption.join(' ')] : []),
      ...(x.integrity.length ? [' integrity ' + x.integrity.join(' ')] : []),
      ...(x.groups.length ? [' group ' + x.groups.join(' ')] : []),
      'exit',
    ]),
    ...c.ikev2Policies.flatMap((x) => [
      'crypto ikev2 policy ' + x.name,
      ...x.proposals.map((n) => ' proposal ' + n),
      'exit',
    ]),
    ...c.ikev2Keyrings.flatMap((x) => [
      'crypto ikev2 keyring ' + x.name,
      ...x.peers.flatMap((peer) => [
        ' peer ' + peer.name,
        ...(peer.address ? ['  address ' + peer.address + (peer.mask ? ' ' + peer.mask : '')] : []),
        ...(peer.key ? ['  pre-shared-key ' + peer.key] : []),
        ' exit',
      ]),
      'exit',
    ]),
    ...c.ikev2Profiles.flatMap((x) => [
      'crypto ikev2 profile ' + x.name,
      ...x.remote.map((r) => ' match identity remote address ' + r.address + ' ' + r.mask),
      ...(x.remoteAuth ? [' authentication remote pre-share'] : []),
      ...(x.localAuth ? [' authentication local pre-share'] : []),
      ...(x.keyring ? [' keyring local ' + x.keyring] : []),
      'exit',
    ]),
    ...[...c.isakmpPolicies]
      .sort((a, b) => a.priority - b.priority)
      .flatMap((x) => [
        'crypto isakmp policy ' + x.priority,
        ...(x.encryption !== 'des' ? [' encryption ' + x.encryption] : []),
        ...(x.hash !== 'sha' ? [' hash ' + x.hash] : []),
        ...(x.authentication !== 'rsa-sig' ? [' authentication ' + x.authentication] : []),
        ...(x.group !== 1 ? [' group ' + x.group] : []),
        ...(x.lifetimeS !== 86400 ? [' lifetime ' + x.lifetimeS] : []),
        'exit',
      ]),
    ...c.isakmpKeys.map(
      (k) =>
        `crypto isakmp key ${k.key} address ${k.address}${k.mask !== '255.255.255.255' ? ' ' + k.mask : ''}`
    ),
    ...c.transformSets.flatMap((x) => [
      `crypto ipsec transform-set ${x.name} ${x.transforms.join(' ')}`,
      ' mode ' + x.mode,
      'exit',
    ]),
    ...c.ipsecProfiles.flatMap((x) => [
      'crypto ipsec profile ' + x.name,
      ...(x.lifetimeS ? [' set security-association lifetime seconds ' + x.lifetimeS] : []),
      ...(x.transformSets.length ? [' set transform-set ' + x.transformSets.join(' ')] : []),
      ...(x.pfs ? [' set pfs group' + x.pfs] : []),
      ...(x.ikev2Profile ? [' set ikev2-profile ' + x.ikev2Profile] : []),
      'exit',
    ]),
  ];
}
/** "show interfaces TunnelN" lines after the generic interface header. */
export function iosTunnelShowLines(d: Device, p: NetworkInterface) {
  const t = p.iosTunnel;
  if (!t) return [];
  const source = tunnelSourcePort(d, t);
  return [
    `  Tunnel source ${tunnelSourceIp(d, t) ?? 'UNKNOWN'}${source && t.source && !ipLiteral(t.source) ? ' (' + source.name + ')' : ''}, destination ${t.destination ?? 'UNKNOWN'}`,
    `  Tunnel protocol/transport ${t.mode === 'ipsec' ? 'IPSEC/IP' : 'GRE/IP'}`,
    ...(t.mode === 'gre' ? [`    Key ${t.key !== undefined ? t.key : 'disabled'}, sequencing disabled`] : []),
    ...(t.keepalive ? [`  Keepalive set (${t.keepalive.periodS} sec), retries ${t.keepalive.retries}`] : []),
    ...(t.protection ? [`  Tunnel protection via IPSec (profile "${t.protection}")`] : []),
  ];
}
export const tunnelBandwidthKbps = interfaceBandwidthKbps;
