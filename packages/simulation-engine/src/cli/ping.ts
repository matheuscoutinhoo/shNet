import type { SimulationEngine } from '../core/engine';
import { ipv4Schema, type Device, type Probe } from '../model';
import { ALL_MODES, type CommandRegistry } from './registry';
import { interfaceName } from './operational';
import { terminalIdentity } from './device-commands';

type Result = { status: Probe['status']; rtt?: number; responder?: string };

/** Runs the simulation until done() holds or the virtual deadline passes (IOS waits per echo). */
function waitFor(e: SimulationEngine, done: () => boolean, timeoutMs: number, lost?: () => boolean) {
  const deadline = e.state.clock + timeoutMs;
  let steps = 0,
    checkedAt = e.state.clock;
  while (!done() && e.state.queue.length && e.state.queue[0].at <= deadline && steps++ < 500000) {
    e.step(false);
    // A lost echo is reported without simulating the rest of the timeout.
    if (lost && e.state.clock - checkedAt >= 100 && !done()) {
      checkedAt = e.state.clock;
      if (lost()) return;
    }
  }
  if (!done() && (!lost || !lost()) && e.state.clock < deadline)
    e.advanceTo(deadline, 500000, undefined, false);
}

/** Whether anything in the simulation still carries traffic of this probe (frames, ARP or QoS queues). */
function inFlight(e: SimulationEngine, probeId: string) {
  const needle = JSON.stringify(probeId);
  const carries = (value: unknown) => value !== undefined && JSON.stringify(value).includes(needle);
  if (e.state.queue.some((q) => q.action.kind !== 'probe-timeout' && carries(q.action))) return true;
  return e.state.devices.some(
    (d) =>
      (d.pending.length && carries(d.pending)) ||
      (d.fragmentPending?.length && carries(d.fragmentPending)) ||
      (d.reassemblies?.length && carries(d.reassemblies)) ||
      d.interfaces.some((p) => p.qos?.queues.length && carries(p.qos.queues))
  );
}

function echo(
  e: SimulationEngine,
  d: Device,
  target: string,
  options: { ttl?: number; vrf?: string; bytes?: number; df?: boolean; source?: string; timeoutMs: number }
): Result {
  const id = e.ping(
    d.id,
    target,
    options.ttl ?? 64,
    options.vrf,
    options.bytes ?? 100,
    !!options.df,
    options.source
  );
  const probe = () => e.state.probes.find((p) => p.id === id);
  waitFor(
    e,
    () => probe()?.status !== 'pending',
    options.timeoutMs,
    () => !inFlight(e, id)
  );
  const p = probe();
  if (!p || p.status === 'pending') return { status: 'timeout' };
  return {
    status: p.status,
    ...(p.rtt !== undefined ? { rtt: p.rtt } : {}),
    ...(p.responder ? { responder: p.responder } : {}),
  };
}

/** Lab hostnames map to their first address; other names are resolved with the device's DNS servers. */
function resolveTarget(e: SimulationEngine, d: Device, target: string) {
  if (ipv4Schema.safeParse(target).success) return { address: target };
  const host = e.state.devices
    .find((v) => v.hostname.toLowerCase() === target.toLowerCase())
    ?.interfaces.find((i) => i.ip)?.ip;
  if (host) return { address: host };
  const id = e.lookupDns(d.id, target, 'A');
  const query = () =>
    d.dnsQueries?.find((q) => q.id === id) ?? e.device(d.id).dnsQueries?.find((q) => q.id === id);
  waitFor(e, () => query()?.status !== 'pending', 10000);
  const address = query()?.answers.find((record) => record.type === 'A')?.value;
  if (!address) throw new Error('Unrecognized host or address, or protocol not running.');
  return { address, translated: `Translating "${target}"...domain server [OK]` };
}

const symbol = (r: Result) =>
  r.status === 'success' ? '!' : r.status === 'unreachable' ? 'U' : r.status === 'time-exceeded' ? '&' : '.';
const round = (n: number) => Math.max(1, Math.round(n));

function iosPing(
  e: SimulationEngine,
  d: Device,
  target: string,
  o: { vrf?: string; repeat: number; size: number; timeout: number; source?: string; df: boolean }
) {
  const { address, translated } = resolveTarget(e, d, target);
  const port = o.source ? sourcePort(d, o.source) : undefined;
  const results: Result[] = [];
  for (let i = 0; i < o.repeat; i++)
    results.push(
      echo(e, d, address, { vrf: o.vrf, bytes: o.size, df: o.df, source: port, timeoutMs: o.timeout * 1000 })
    );
  const ok = results.filter((r) => r.status === 'success'),
    rtts = ok.map((r) => r.rtt ?? 0);
  return [
    ...(translated ? [translated] : []),
    'Type escape sequence to abort.',
    `Sending ${o.repeat}, ${o.size}-byte ICMP Echos to ${address}, timeout is ${o.timeout} seconds:`,
    ...(port ? [`Packet sent with a source address of ${d.interfaces.find((p) => p.id === port)!.ip}`] : []),
    results.map(symbol).join(''),
    `Success rate is ${Math.floor((ok.length * 100) / o.repeat)} percent (${ok.length}/${o.repeat})` +
      (ok.length
        ? `, round-trip min/avg/max = ${round(Math.min(...rtts))}/${round(rtts.reduce((a, b) => a + b, 0) / rtts.length)}/${round(Math.max(...rtts))} ms`
        : ''),
  ].join('\n');
}

function hostPing(e: SimulationEngine, d: Device, target: string, count: number, size: number) {
  const { address } = resolveTarget(e, d, target);
  const results = Array.from({ length: count }, () =>
    echo(e, d, address, { bytes: size + 28, timeoutMs: 4000 })
  );
  const ok = results.filter((r) => r.status === 'success'),
    rtts = ok.map((r) => round(r.rtt ?? 0));
  return [
    `Pinging ${address} with ${size} bytes of data:`,
    ...results.map((r) =>
      r.status === 'success'
        ? `Reply from ${address}: bytes=${size} time=${round(r.rtt ?? 0)}ms`
        : r.status === 'unreachable'
          ? `Reply from ${r.responder ?? address}: Destination host unreachable.`
          : r.status === 'time-exceeded'
            ? `Reply from ${r.responder ?? address}: TTL expired in transit.`
            : 'Request timed out.'
    ),
    '',
    `Ping statistics for ${address}:`,
    `    Packets: Sent = ${count}, Received = ${ok.length}, Lost = ${count - ok.length} (${Math.round(((count - ok.length) * 100) / count)}% loss),`,
    ...(ok.length
      ? [
          'Approximate round trip times in milli-seconds:',
          `    Minimum = ${Math.min(...rtts)}ms, Maximum = ${Math.max(...rtts)}ms, Average = ${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)}ms`,
        ]
      : []),
  ].join('\n');
}

function sourcePort(d: Device, source: string) {
  const port = ipv4Schema.safeParse(source).success
    ? d.interfaces.find((p) => p.ip === source)
    : d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(source).toLowerCase());
  if (!port?.ip) throw new Error('Invalid source address- IP address not on any of our up interfaces');
  return port.id;
}

// Traceroute stops after this many consecutive silent hops to bound simulated time.
const SILENT_HOPS = 3;
function trace(e: SimulationEngine, d: Device, address: string, vrf?: string) {
  const hops: { ttl: number; results: Result[] }[] = [];
  let silent = 0;
  for (let ttl = 1; ttl <= 30; ttl++) {
    const results = [0, 1, 2].map(() => echo(e, d, address, { ttl, vrf, timeoutMs: 3000 }));
    hops.push({ ttl, results });
    silent = results.every((r) => r.status === 'timeout') ? silent + 1 : 0;
    if (silent >= SILENT_HOPS || results.some((r) => r.status === 'success' || r.status === 'unreachable'))
      break;
  }
  return { hops, stopped: silent >= SILENT_HOPS };
}

function iosTraceroute(e: SimulationEngine, d: Device, target: string, vrf?: string) {
  const { address, translated } = resolveTarget(e, d, target);
  const { hops, stopped } = trace(e, d, address, vrf);
  return [
    ...(translated ? [translated] : []),
    'Type escape sequence to abort.',
    `Tracing the route to ${address}`,
    'VRF info: (vrf in name/id, vrf out name/id)',
    ...hops.map(({ ttl, results }) => {
      const responder =
        results.find((r) => r.responder)?.responder ??
        (results.some((r) => r.status === 'success') ? address : undefined);
      const cells = results.map((r) =>
        r.status === 'timeout' ? '*' : r.status === 'unreachable' ? '!H' : round(r.rtt ?? 0) + ' msec'
      );
      return `${String(ttl).padStart(3)} ${responder ? responder + ' ' : ''}${cells.join(' ')}`;
    }),
    ...(stopped ? [`% Trace stopped after ${SILENT_HOPS} silent hops (simulator limit).`] : []),
  ].join('\n');
}

function hostTraceroute(e: SimulationEngine, d: Device, target: string) {
  const { address } = resolveTarget(e, d, target);
  const { hops, stopped } = trace(e, d, address);
  return [
    `Tracing route to ${address} over a maximum of 30 hops`,
    '',
    ...hops.map(({ ttl, results }) => {
      const responder =
        results.find((r) => r.responder)?.responder ??
        (results.some((r) => r.status === 'success') ? address : undefined);
      const cells = results.map((r) =>
        (r.status === 'timeout' ? '*' : round(r.rtt ?? 0) + ' ms').padStart(8)
      );
      return `${String(ttl).padStart(3)}${cells.join(' ')}  ${responder ?? 'Request timed out.'}`;
    }),
    '',
    stopped ? 'Trace stopped.' : 'Trace complete.',
  ].join('\n');
}

const OPTIONS = /^((?:\s+(?:repeat|size|timeout|source)\s+\S+|\s+df-bit|\s+df)*)$/i;
function pingOptions(text: string) {
  const o = { repeat: 5, size: 100, timeout: 2, source: undefined as string | undefined, df: false };
  const tokens = text.trim() ? text.trim().split(/\s+/) : [];
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i].toLowerCase();
    if (key === 'df' || key === 'df-bit') {
      o.df = true;
      continue;
    }
    const value = tokens[++i];
    if (key === 'source') o.source = value;
    else {
      const n = Number(value);
      const [min, max] = key === 'repeat' ? [1, 1000] : key === 'size' ? [36, 18024] : [0, 3600];
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}: use ${min}-${max}.`);
      o[key as 'repeat' | 'size' | 'timeout'] = n;
    }
  }
  if (o.repeat * Math.max(o.timeout, 1) > 600)
    throw new Error('Repeat × timeout is limited to 600 simulated seconds.');
  return o;
}

export function registerPingCommands(r: CommandRegistry) {
  r.register({
    pattern:
      /^ping (?:vrf ([\w-]{1,32}) )?([a-z0-9_.-]+)((?:\s+(?:repeat|size|timeout|source)\s+\S+|\s+df-bit|\s+df)*)$/i,
    syntax: [
      'ping <address>',
      'ping vrf <vrf> <address>',
      'ping <address> repeat <count>',
      'ping <address> size <bytes>',
      'ping <address> source <interface>',
      'ping <address> timeout <seconds>',
      'ping <address> df-bit',
    ],
    modes: ALL_MODES,
    run: (m, e, d) => {
      if (!OPTIONS.test(m[3])) throw new Error('Invalid input detected.');
      if (terminalIdentity(d).host && !m[1]) {
        const o = pingOptions(m[3]);
        return hostPing(e, d, m[2], m[3].trim() ? o.repeat : 4, m[3].includes('size') ? o.size - 28 : 32);
      }
      return iosPing(e, d, m[2], { ...pingOptions(m[3]), vrf: m[1] });
    },
  });
  r.register({
    pattern: /^(traceroute|tracert) (?:vrf ([\w-]{1,32}) )?([a-z0-9_.-]+)$/i,
    syntax: ['traceroute <address>', 'traceroute vrf <vrf> <address>'],
    modes: ALL_MODES,
    run: (m, e, d) =>
      terminalIdentity(d).host && !m[2] ? hostTraceroute(e, d, m[3]) : iosTraceroute(e, d, m[3], m[2]),
  });
}
