/** IOS default VLAN names ("VLAN0010"). */
export const defaultVlanName = (id: number) => 'VLAN' + String(id).padStart(4, '0');
/** IOS uses full interface names in routing output and log messages. */
export function longInterfaceName(name: string) {
  return name
    .replace(/^Gi(?=\d)/, 'GigabitEthernet')
    .replace(/^Te(?=\d)/, 'TenGigabitEthernet')
    .replace(/^Fo(?=\d)/, 'FortyGigabitEthernet')
    .replace(/^Hu(?=\d)/, 'HundredGigE')
    .replace(/^Fa(?=\d)/, 'FastEthernet')
    .replace(/^Se(?=\d)/, 'Serial')
    .replace(/^Po(?=\d)/, 'Port-channel');
}
// Interface types: the IOS keyword, other accepted spellings and the prefix of the simulator's names.
const TYPES: { long: string; aliases: string[]; prefix: string }[] = [
  { long: 'GigabitEthernet', aliases: ['gi'], prefix: 'Gi' },
  { long: 'TenGigabitEthernet', aliases: ['te'], prefix: 'Te' },
  { long: 'FortyGigabitEthernet', aliases: ['fo'], prefix: 'Fo' },
  { long: 'HundredGigE', aliases: ['hu', 'hundredgigabitethernet'], prefix: 'Hu' },
  { long: 'FastEthernet', aliases: ['fa'], prefix: 'Fa' },
  { long: 'Ethernet', aliases: ['eth'], prefix: 'Eth' },
  { long: 'Serial', aliases: ['se'], prefix: 'Se' },
  { long: 'Port-channel', aliases: ['po'], prefix: 'Port-channel' },
  { long: 'Loopback', aliases: ['lo'], prefix: 'Loopback' },
  { long: 'Vlan', aliases: ['vl'], prefix: 'Vlan' },
  { long: 'Tunnel', aliases: ['tu'], prefix: 'Tunnel' },
];
/**
 * The simulator name of an interface typed the IOS way: any unambiguous abbreviation of the type
 * ("g0/1", "gig 0/1", "GigabitEthernet0/1", "po1", "lo0", "vl10") gives "Gi0/1", "Port-channel1"...
 * Ambiguous or unknown types ("t0/1", "f0/1") are returned unchanged.
 */
export function canonicalInterfaceName(input: string) {
  const compact = input.replace(/\s/g, ''),
    match = /^([a-z][a-z-]*?)(\d.*)$/i.exec(compact);
  if (!match) return compact;
  const word = match[1].toLowerCase();
  const exact = TYPES.filter((t) => t.aliases.includes(word) || t.prefix.toLowerCase() === word);
  const candidates = exact.length ? exact : TYPES.filter((t) => t.long.toLowerCase().startsWith(word));
  return candidates.length === 1 ? candidates[0].prefix + match[2] : compact;
}
/** The interface an IOS command names, in any accepted spelling. */
export function findInterface<T extends { name: string }>(d: { interfaces: T[] }, name: string | undefined) {
  if (!name) return undefined;
  const wanted = canonicalInterfaceName(name).toLowerCase(),
    literal = name.replace(/\s/g, '').toLowerCase();
  return (
    d.interfaces.find((p) => p.name.toLowerCase() === wanted) ??
    d.interfaces.find((p) => p.name.toLowerCase() === literal)
  );
}
/** Whether two configured interface references name the same interface. */
export function sameInterface(a: string, b: string) {
  return canonicalInterfaceName(a).toLowerCase() === canonicalInterfaceName(b).toLowerCase();
}
/** Abbreviated names of summary tables (show etherchannel summary, show interfaces status). */
export function shortInterfaceName(name: string) {
  return name
    .replace(/^GigabitEthernet(?=\d)/, 'Gi')
    .replace(/^TenGigabitEthernet(?=\d)/, 'Te')
    .replace(/^FortyGigabitEthernet(?=\d)/, 'Fo')
    .replace(/^HundredGigE(?=\d)/, 'Hu')
    .replace(/^FastEthernet(?=\d)/, 'Fa')
    .replace(/^Serial(?=\d)/, 'Se')
    .replace(/^Port-channel(?=\d)/, 'Po');
}
/** IOS MAC address notation: aabb.ccdd.eeff. */
export function dottedMac(mac: string) {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.slice(0, 4) + '.' + hex.slice(4, 8) + '.' + hex.slice(8, 12);
}
