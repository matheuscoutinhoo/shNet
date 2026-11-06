import type { Device, NetworkInterface } from '../model';
import { dhcpSnoopingConfigSchema } from '../protocols/dhcp-snooping-model';
import { CONFIG_MODES, ALL_MODES, currentPort, type CommandRegistry } from './registry';
import { interfaceName } from './operational';
import { configureUdld } from '../protocols/udld';
import { dottedMac } from '../protocols/interface-name';
import { interfaceOperational } from '../protocols/layer3';
function snooping(d: Device) {
  const old = d.dhcpSnooping;
  return dhcpSnoopingConfigSchema.parse(
    old
      ? Object.fromEntries(
          Object.keys(dhcpSnoopingConfigSchema.shape).map((k) => [k, old[k as keyof typeof old]])
        )
      : { enabled: false, vlans: [], trustedPorts: [] }
  );
}
function vlans(value: string) {
  return [
    ...new Set(
      value.split(',').flatMap((s) => {
        const [a, b] = s.split('-').map(Number);
        if (a < 1 || (b ?? a) > 4094 || (b ?? a) < a) throw new Error('Invalid VLAN range.');
        return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
      })
    ),
  ];
}
export function registerCampusCommands(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?udld port(?: (aggressive))?$/i,
    modes: ['interface'],
    run: (m, e, d, c) =>
      configureUdld(e, d, currentPort(d, c), m[1] ? undefined : m[2] ? 'aggressive' : 'normal'),
  });
  r.register({
    pattern: /^udld reset$/i,
    modes: ['privileged'],
    run: (_m, e, d) => {
      for (const p of d.interfaces)
        if (p.errDisabled?.reason === 'udld') {
          delete p.errDisabled;
          configureUdld(e, d, p, p.udld?.mode);
        }
      e.refreshSpanningTree();
    },
  });
  r.register({
    pattern: /^show udld(?: interface (\S+))?$/i,
    modes: ALL_MODES,
    run: (m, _e, d) =>
      d.interfaces
        .filter((p) => p.udld && (!m[1] || p.name.toLowerCase() === interfaceName(m[1]).toLowerCase()))
        .map((p) => `${p.name}: ${p.udld!.mode}, ${p.udld!.state}, neighbors ${p.udld!.peers.length}`)
        .join('\n') || 'UDLD is not configured.',
  });
  r.register({
    pattern: /^(no )?ip source binding ([a-f0-9.:-]+) vlan (\d+) ([\d.]+) interface (\S+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const c = snooping(d),
        p = d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(m[5]).toLowerCase()),
        mac = m[2].replace(/[.:-]/g, '').match(/../g)?.join(':').toLowerCase();
      if (!p || !mac) throw new Error('Invalid source binding.');
      const vlan = Number(m[3]);
      c.staticBindings = c.staticBindings.filter((b) => b.port !== p.id || b.mac !== mac || b.vlan !== vlan);
      if (!m[1]) c.staticBindings.push({ port: p.id, mac, vlan, ip: m[4] });
      e.configureDhcpSnooping(d.id, c);
    },
  });
  r.register({
    pattern: /^(no )?ip dhcp snooping$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureDhcpSnooping(d.id, { ...snooping(d), enabled: !m[1] }),
  });
  r.register({
    pattern: /^(no )?ip dhcp snooping vlan ([\d,-]+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const c = snooping(d),
        ids = vlans(m[2]);
      e.configureDhcpSnooping(d.id, {
        ...c,
        vlans: m[1] ? c.vlans.filter((v) => !ids.includes(v)) : [...new Set([...c.vlans, ...ids])],
      });
    },
  });
  r.register({
    pattern: /^(no )?ip dhcp snooping trust$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const v = snooping(d),
        p = currentPort(d, c);
      e.configureDhcpSnooping(d.id, {
        ...v,
        trustedPorts: [...v.trustedPorts.filter((id) => id !== p.id), ...(m[1] ? [] : [p.id])],
      });
    },
  });
  r.register({
    pattern: /^(no )?ip dhcp snooping information option$/i,
    syntax: ['ip dhcp snooping information option', 'no ip dhcp snooping information option'],
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureDhcpSnooping(d.id, { ...snooping(d), informationOption: !m[1] }),
  });
  r.register({
    pattern: /^(no )?ip dhcp snooping limit rate(?: (\d+))?$/i,
    syntax: ['ip dhcp snooping limit rate <pps>', 'no ip dhcp snooping limit rate'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const v = snooping(d),
        p = currentPort(d, c),
        pps = Number(m[2]);
      if (!m[1] && m[2] === undefined) throw new Error('% Incomplete command.');
      if (!m[1] && !(pps >= 1 && pps <= 2048))
        throw new Error('% The rate limit is 1-2048 packets per second.');
      e.configureDhcpSnooping(d.id, {
        ...v,
        rateLimits: [...v.rateLimits.filter((r) => r.port !== p.id), ...(m[1] ? [] : [{ port: p.id, pps }])],
      });
    },
  });
  r.register({
    pattern: /^(no )?ip arp inspection vlan ([\d,-]+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const c = snooping(d),
        ids = vlans(m[2]);
      e.configureDhcpSnooping(d.id, {
        ...c,
        arpInspectionVlans: m[1]
          ? c.arpInspectionVlans.filter((v) => !ids.includes(v))
          : [...new Set([...c.arpInspectionVlans, ...ids])],
      });
    },
  });
  r.register({
    pattern: /^(no )?ip arp inspection trust$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const v = snooping(d),
        p = currentPort(d, c);
      e.configureDhcpSnooping(d.id, {
        ...v,
        arpTrustedPorts: [...v.arpTrustedPorts.filter((id) => id !== p.id), ...(m[1] ? [] : [p.id])],
      });
    },
  });
  r.register({
    pattern: /^(no )?ip verify source$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const v = snooping(d),
        p = currentPort(d, c);
      e.configureDhcpSnooping(d.id, {
        ...v,
        sourceGuardPorts: [...v.sourceGuardPorts.filter((id) => id !== p.id), ...(m[1] ? [] : [p.id])],
      });
    },
  });
  r.register({
    pattern: /^(no )?switchport voice vlan(?: (\d+))?$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (d.type !== 'switch' || p.mode === 'routed') throw new Error('Voice VLAN requires a switchport.');
      if (m[1]) delete p.voiceVlan;
      else {
        const id = Number(m[2]);
        if (id < 1 || id > 4094 || !Number.isInteger(id)) throw new Error('Invalid VLAN.');
        p.voiceVlan = id;
      }
    },
  });
  r.register({
    pattern:
      /^(no )?switchport port-security(?: (maximum|violation|mac-address|aging time|aging type)(?: (.+))?)?$/i,
    syntax: [
      'switchport port-security',
      'switchport port-security maximum <count>',
      'switchport port-security violation shutdown',
      'switchport port-security violation restrict',
      'switchport port-security violation protect',
      'switchport port-security mac-address sticky',
      'switchport port-security mac-address <mac>',
      'switchport port-security aging time <minutes>',
      'switchport port-security aging type inactivity',
    ],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (
        d.type !== 'switch' ||
        p.mode !== 'access' ||
        p.logical ||
        p.aggregate ||
        p.channel ||
        p.vxlan ||
        p.tunnel
      )
        throw new Error('Port security requires a physical access switchport.');
      const v = (p.portSecurity ??= {
        enabled: false,
        maximum: 1,
        violation: 'shutdown',
        sticky: false,
        macs: [],
        stickyMacs: [],
        learned: [],
        violations: 0,
      });
      v.stickyMacs ??= [];
      const what = m[2]?.toLowerCase(),
        args = m[3]?.trim().split(/\s+/) ?? [];
      const parseMac = (value: string | undefined) => {
        const mac = value?.replace(/[.:-]/g, '').match(/../g)?.join(':').toLowerCase();
        if (!mac || !/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac)) throw new Error('Invalid secure MAC.');
        return mac;
      };
      if (!what) v.enabled = !m[1];
      else if (what === 'maximum') {
        const n = m[1] ? 1 : Number(args[0]);
        if (
          !Number.isInteger(n) ||
          n < 1 ||
          n > 1024 ||
          n < v.macs.length + v.stickyMacs.length + v.learned.length
        )
          throw new Error('Invalid secure MAC maximum.');
        v.maximum = n;
      } else if (what === 'violation') {
        const mode = m[1] ? 'shutdown' : args[0]?.toLowerCase();
        if (!['shutdown', 'restrict', 'protect'].includes(mode)) throw new Error('Invalid violation mode.');
        v.violation = mode as typeof v.violation;
      } else if (what === 'aging time') {
        const minutes = Number(args[0]);
        if (m[1]) delete v.aging;
        else if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
          throw new Error('% The aging time is 1-1440 minutes.');
        else v.aging = { minutes, type: v.aging?.type ?? 'absolute' };
        if (!v.aging) delete v.ages;
      } else if (what === 'aging type') {
        const type = m[1] ? 'absolute' : args[0]?.toLowerCase();
        if (type !== 'absolute' && type !== 'inactivity') throw new Error('Invalid aging type.');
        if (v.aging) v.aging.type = type;
        else if (type === 'inactivity') throw new Error('% Configure the aging time first.');
      } else if (args[0]?.toLowerCase() === 'sticky') {
        if (args[1]) {
          const mac = parseMac(args[1]);
          v.stickyMacs = [...v.stickyMacs.filter((a) => a !== mac), ...(m[1] ? [] : [mac])];
        } else {
          v.sticky = !m[1];
          // IOS converts the dynamic addresses to sticky ones, and back when sticky learning stops.
          if (m[1]) {
            v.learned = [...v.learned, ...v.stickyMacs];
            v.stickyMacs = [];
          } else {
            v.stickyMacs = [...v.stickyMacs, ...v.learned];
            v.learned = [];
            delete v.ages;
          }
        }
      } else {
        const mac = parseMac(args[0]);
        v.macs = [...v.macs.filter((a) => a !== mac), ...(m[1] ? [] : [mac])];
      }
      if (v.macs.length + v.stickyMacs.length + v.learned.length > v.maximum)
        throw new Error('Secure MAC maximum exceeded.');
    },
  });
  r.register({
    pattern: /^clear port-security (all|configured|dynamic|sticky)(?: interface (\S+))?$/i,
    syntax: [
      'clear port-security all',
      'clear port-security dynamic',
      'clear port-security sticky',
      'clear port-security configured',
    ],
    modes: ['privileged'],
    run: (m, _e, d) => {
      const kind = m[1].toLowerCase();
      const ports = d.interfaces.filter(
        (p) => p.portSecurity && (!m[2] || p.name.toLowerCase() === interfaceName(m[2]).toLowerCase())
      );
      if (m[2] && !ports.length) throw new Error('Invalid interface.');
      for (const p of ports) {
        const v = p.portSecurity!;
        if (kind === 'all' || kind === 'dynamic') {
          v.learned = [];
          delete v.ages;
        }
        if (kind === 'all' || kind === 'sticky') v.stickyMacs = [];
        if (kind === 'all' || kind === 'configured') v.macs = [];
        d.macTable = d.macTable.filter((entry) => entry.port !== p.id);
      }
    },
  });
  r.register({
    pattern: /^show port-security(?: (interface (\S+)|address))?$/i,
    syntax: ['show port-security', 'show port-security interface <interface>', 'show port-security address'],
    modes: ALL_MODES,
    run: (m, e, d) => {
      const secured = d.interfaces.filter((p) => p.portSecurity);
      const total = (p: NetworkInterface) =>
        p.portSecurity!.macs.length +
        (p.portSecurity!.stickyMacs?.length ?? 0) +
        p.portSecurity!.learned.length;
      const footer = [
        'Total Addresses in System (excluding one mac per port)     : ' +
          secured.reduce((n, p) => n + Math.max(0, total(p) - 1), 0),
        'Max Addresses limit in System (excluding one mac per port) : 4096',
      ];
      if (m[2]) {
        const p = d.interfaces.find((x) => x.name.toLowerCase() === interfaceName(m[2]).toLowerCase());
        if (!p) throw new Error('Invalid interface.');
        const v = p.portSecurity,
          up = !!v?.enabled && interfaceOperational(e.state, d, p);
        return [
          'Port Security              : ' + (v?.enabled ? 'Enabled' : 'Disabled'),
          'Port Status                : ' +
            (p.errDisabled?.reason === 'psecure-violation'
              ? 'Secure-shutdown'
              : up
                ? 'Secure-up'
                : 'Secure-down'),
          'Violation Mode             : ' + title(v?.violation ?? 'shutdown'),
          'Aging Time                 : ' + (v?.aging?.minutes ?? 0) + ' mins',
          'Aging Type                 : ' + title(v?.aging?.type ?? 'absolute'),
          'SecureStatic Address Aging : Disabled',
          'Maximum MAC Addresses      : ' + (v?.maximum ?? 1),
          'Total MAC Addresses        : ' + (v ? total(p) : 0),
          'Configured MAC Addresses   : ' + (v?.macs.length ?? 0),
          'Sticky MAC Addresses       : ' + (v?.stickyMacs?.length ?? 0),
          'Last Source Address:Vlan   : ' + (v?.lastSource ?? '0000.0000.0000:0'),
          'Security Violation Count   : ' + (v?.violations ?? 0),
        ].join('\n');
      }
      if (m[1]) {
        const now = e.state.clock;
        const rows = secured.flatMap((p) => {
          const v = p.portSecurity!,
            vlan = String(p.accessVlan).padStart(4);
          const row = (mac: string, type: string, remaining = '-') =>
            `${vlan}    ${dottedMac(mac)}    ${type.padEnd(30)}${p.name.padEnd(8)}${remaining.padStart(6)}`;
          return [
            ...v.macs.map((mac) => row(mac, 'SecureConfigured')),
            ...(v.stickyMacs ?? []).map((mac) => row(mac, 'SecureSticky')),
            ...v.learned.map((mac) => {
              const at = v.aging && v.ages?.find((a) => a.mac === mac)?.at;
              return row(
                mac,
                'SecureDynamic',
                at === undefined || !v.aging
                  ? '-'
                  : String(Math.max(0, Math.ceil((at + v.aging.minutes * 60000 - now) / 60000)))
              );
            }),
          ];
        });
        return [
          '               Secure Mac Address Table',
          '-----------------------------------------------------------------------------',
          'Vlan    Mac Address       Type                          Ports   Remaining Age',
          '                                                                   (mins)',
          '----    -----------       ----                          -----   -------------',
          ...rows,
          '-----------------------------------------------------------------------------',
          ...footer,
        ].join('\n');
      }
      return [
        'Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action',
        '                (Count)       (Count)          (Count)',
        '---------------------------------------------------------------------------',
        ...secured
          .filter((p) => p.portSecurity!.enabled)
          .map(
            (p) =>
              p.name.padStart(11) +
              String(p.portSecurity!.maximum).padStart(15) +
              String(total(p)).padStart(13) +
              String(p.portSecurity!.violations).padStart(19) +
              title(p.portSecurity!.violation).padStart(17)
          ),
        '---------------------------------------------------------------------------',
        ...footer,
      ].join('\n');
    },
  });
}
const title = (word: string) => word[0].toUpperCase() + word.slice(1);
/** Voice VLAN and port security; IOS defaults (maximum 1, violation shutdown) are not shown. */
export function campusRunningConfig(d: Device) {
  return d.interfaces.flatMap((p) => {
    const v = p.portSecurity;
    return v || p.voiceVlan
      ? [
          'interface ' + p.name,
          ...(p.voiceVlan ? [' switchport voice vlan ' + p.voiceVlan] : []),
          ...(v
            ? [
                ...(v.enabled ? [' switchport port-security'] : []),
                ...(v.maximum !== 1 ? [' switchport port-security maximum ' + v.maximum] : []),
                ...(v.violation !== 'shutdown' ? [' switchport port-security violation ' + v.violation] : []),
                ...(v.aging ? [' switchport port-security aging time ' + v.aging.minutes] : []),
                ...(v.aging?.type === 'inactivity'
                  ? [' switchport port-security aging type inactivity']
                  : []),
                ...(v.sticky ? [' switchport port-security mac-address sticky'] : []),
                ...(v.stickyMacs ?? []).map(
                  (mac) => ' switchport port-security mac-address sticky ' + dottedMac(mac)
                ),
                ...v.macs.map((mac) => ' switchport port-security mac-address ' + dottedMac(mac)),
              ]
            : []),
          'exit',
        ]
      : [];
  });
}
