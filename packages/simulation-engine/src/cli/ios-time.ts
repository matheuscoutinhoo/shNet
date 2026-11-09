/**
 * IOS console/syslog timestamps for the simulated clock. Without NTP an IOS device counts from
 * its boot calendar (Mar 1) and marks the time as not authoritative with a leading "*".
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BOOT_CALENDAR = Date.UTC(2026, 2, 1);
export function iosTimestamp(clockMs: number, authoritative = false) {
  const t = new Date(BOOT_CALENDAR + Math.max(0, Math.floor(clockMs)));
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    (authoritative ? '' : '*') +
    MONTHS[t.getUTCMonth()] +
    ' ' +
    String(t.getUTCDate()).padStart(2, ' ') +
    ' ' +
    two(t.getUTCHours()) +
    ':' +
    two(t.getUTCMinutes()) +
    ':' +
    two(t.getUTCSeconds()) +
    '.' +
    String(t.getUTCMilliseconds()).padStart(3, '0')
  );
}
/** A syslog line as IOS prints it on the console: "*Mar  1 00:01:05.123: %SYS-5-RELOAD: ...". */
export function iosLogLine(clockMs: number, mnemonic: string, text: string) {
  return iosTimestamp(clockMs) + ': %' + mnemonic + ': ' + text;
}
