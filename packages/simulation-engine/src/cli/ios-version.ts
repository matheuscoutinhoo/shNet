import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { IOS_VERSION } from './running-config';

/** Hardware model and software image IOS reports for each simulated platform. */
export function iosPlatform(d: Device) {
  if (d.type === 'switch') {
    const model =
      d.profile === 'core'
        ? 'C9500-32C'
        : d.profile === 'distribution' || d.ipRouting
          ? 'C9500-24Y4C'
          : 'C9300-24P';
    return {
      model,
      family: 'Catalyst L3 Switch',
      image: `cat9k_iosxe.${IOS_VERSION}.04a.SPA.bin`,
      train: 'CAT9K_IOSXE',
    };
  }
  return {
    model: 'ISR4331/K9',
    family: 'ISR',
    image: `isr4300-universalk9.${IOS_VERSION}.04a.SPA.bin`,
    train: 'X86_64_LINUX_IOSD-UNIVERSALK9-M',
  };
}
/** "1 week, 2 days, 3 hours, 4 minutes" as IOS prints uptimes. */
export function iosUptime(ms: number) {
  let minutes = Math.floor(Math.max(0, ms) / 60000);
  const parts: string[] = [];
  for (const [unit, size] of [
    ['year', 525600],
    ['week', 10080],
    ['day', 1440],
    ['hour', 60],
  ] as const) {
    const n = Math.floor(minutes / size);
    minutes -= n * size;
    if (n || parts.length) parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`);
  }
  parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return parts.join(', ');
}
/** IOS XE "show version". */
export function showVersion(e: SimulationEngine, d: Device) {
  const p = iosPlatform(d),
    uptime = iosUptime(e.state.clock - (d.bootStartedAt ?? 0));
  const ethernet = d.interfaces.filter((i) => !i.logical && !i.loopback && i.media !== 'console');
  const count = (speed: number) =>
    ethernet.filter((i) => (speed === 1000 ? i.speed <= 1000 : i.speed === speed)).length;
  const kinds = [
    [1000, 'Gigabit Ethernet'],
    [10000, 'Ten Gigabit Ethernet'],
    [40000, 'Forty Gigabit Ethernet'],
    [100000, 'Hundred Gigabit Ethernet'],
  ] as const;
  return [
    `Cisco IOS XE Software, Version ${IOS_VERSION}.04a`,
    `Cisco IOS Software [Dublin], ${p.family} Software (${p.train}), Version ${IOS_VERSION}.4a, RELEASE SOFTWARE (fc1)`,
    'Technical Support: http://www.cisco.com/techsupport',
    'Copyright (c) 1986-2024 by Cisco Systems, Inc.',
    'Compiled Tue 13-Aug-24 10:12 by mcpre',
    '',
    'ROM: IOS-XE ROMMON',
    '',
    `${d.hostname} uptime is ${uptime}`,
    `Uptime for this control processor is ${uptime}`,
    d.bootStartedAt ? 'System returned to ROM by Reload Command' : 'System returned to ROM by PowerOn',
    `System image file is "flash:packages.conf"`,
    `Last reload reason: ${d.bootStartedAt ? 'Reload Command' : 'PowerOn'}`,
    '',
    `cisco ${p.model} (1RU) processor with 1795979K/6147K bytes of memory.`,
    'Processor board ID FDO' +
      d.id
        .replace(/[^0-9a-z]/gi, '')
        .slice(-8)
        .toUpperCase()
        .padStart(8, '0'),
    `${d.type === 'router' ? 'Router' : 'Switch'} operating mode: Autonomous`,
    ...kinds.flatMap(([speed, label]) => (count(speed) ? [`${count(speed)} ${label} interfaces`] : [])),
    '32768K bytes of non-volatile configuration memory.',
    '4194304K bytes of physical memory.',
    '7086079K bytes of flash memory at bootflash:.',
    '',
    'Configuration register is 0x2102',
  ].join('\n');
}
