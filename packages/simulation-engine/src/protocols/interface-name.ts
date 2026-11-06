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
