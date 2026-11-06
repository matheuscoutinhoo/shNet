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
