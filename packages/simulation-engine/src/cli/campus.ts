import type { Device } from '../model';
import { dhcpSnoopingConfigSchema } from '../protocols/dhcp-snooping-model';
import { CONFIG_MODES, ALL_MODES, currentPort, type CommandRegistry } from './registry';
import { interfaceName } from './operational';
import { configureUdld } from '../protocols/udld';
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
    pattern: /^(no )?switchport port-security(?: (maximum|violation|mac-address)(?: (.+))?)?$/i,
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
        learned: [],
        violations: 0,
      });
      if (!m[2]) v.enabled = !m[1];
      else if (m[2].toLowerCase() === 'maximum') {
        const n = m[1] ? 1 : Number(m[3]);
        if (!Number.isInteger(n) || n < 1 || n > 1024 || n < v.macs.length + v.learned.length)
          throw new Error('Invalid secure MAC maximum.');
        v.maximum = n;
      } else if (m[2].toLowerCase() === 'violation') {
        const mode = m[1] ? 'shutdown' : m[3].toLowerCase();
        if (!['shutdown', 'restrict', 'protect'].includes(mode)) throw new Error('Invalid violation mode.');
        v.violation = mode as typeof v.violation;
      } else if (m[3]?.toLowerCase() === 'sticky') v.sticky = !m[1];
      else {
        const mac = m[3]?.replace(/[.:-]/g, '').match(/../g)?.join(':').toLowerCase();
        if (!mac || !/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac)) throw new Error('Invalid secure MAC.');
        v.macs = [...v.macs.filter((a) => a !== mac), ...(m[1] ? [] : [mac])];
        if (v.macs.length > v.maximum) throw new Error('Secure MAC maximum exceeded.');
      }
    },
  });
  r.register({
    pattern: /^show port-security(?: interface (\S+))?$/i,
    modes: ALL_MODES,
    run: (m, _e, d) => {
      const ports = d.interfaces.filter(
        (p) => !m[1] || p.name.toLowerCase() === interfaceName(m[1]).toLowerCase()
      );
      if (!ports.length) throw new Error('Invalid interface.');
      return (
        ports
          .filter((p) => p.portSecurity)
          .map(
            (p) =>
              `${p.name}: ${p.errDisabled ? 'secure-shutdown' : 'secure-up'}, maximum ${p.portSecurity!.maximum}, violations ${p.portSecurity!.violations}\n${[...p.portSecurity!.macs, ...p.portSecurity!.learned].join('\n')}`
          )
          .join('\n') || 'Port security is not configured.'
      );
    },
  });
}
export function campusRunningConfig(d: Device) {
  return d.interfaces.flatMap((p) =>
    p.portSecurity || p.voiceVlan
      ? [
          'interface ' + p.name,
          ...(p.voiceVlan ? [' switchport voice vlan ' + p.voiceVlan] : []),
          ...(p.portSecurity
            ? [
                (p.portSecurity.enabled ? ' ' : ' no ') + 'switchport port-security',
                ' switchport port-security maximum ' + p.portSecurity.maximum,
                ' switchport port-security violation ' + p.portSecurity.violation,
                ...(p.portSecurity.sticky ? [' switchport port-security mac-address sticky'] : []),
                ...p.portSecurity.macs.map((mac) => ' switchport port-security mac-address ' + mac),
              ]
            : []),
          'exit',
        ]
      : []
  );
}
