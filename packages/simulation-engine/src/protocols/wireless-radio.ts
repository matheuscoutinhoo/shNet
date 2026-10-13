import type { Device, Frame, Link, Snapshot } from '../model';

export function radioDistance(a: Device, b: Device) {
  if (a.physicalPosition && b.physicalPosition)
    return Math.max(
      1,
      Math.hypot(a.physicalPosition.x - b.physicalPosition.x, a.physicalPosition.y - b.physicalPosition.y)
    );
  return Math.max(1, Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) / 4);
}
export function rfObstacleLoss(s: Snapshot, a: Device, b: Device) {
  if (!a.physicalPosition || !b.physicalPosition) return 0;
  const p = a.physicalPosition,
    q = b.physicalPosition;
  const cross = (x: { x: number; y: number }, y: { x: number; y: number }) => x.x * y.y - x.y * y.x;
  const r = { x: q.x - p.x, y: q.y - p.y };
  let loss = 0;
  for (const wall of s.rfObstacles ?? []) {
    const t = { x: wall.b.x - wall.a.x, y: wall.b.y - wall.a.y },
      offset = { x: wall.a.x - p.x, y: wall.a.y - p.y },
      den = cross(r, t);
    if (Math.abs(den) < 1e-9) continue;
    const u = cross(offset, t) / den,
      v = cross(offset, r) / den;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) loss += wall.lossDb;
  }
  return loss;
}
function signal(a: Device, b: Device, s: Snapshot) {
  const x = a.wireless!,
    y = b.wireless!;
  return (
    Math.min(x.txPower, y.txPower) -
    40 -
    30 * Math.log10(radioDistance(a, b)) -
    (x.band === '5' ? 7 : 0) -
    Math.max(x.attenuation, y.attenuation) -
    rfObstacleLoss(s, a, b)
  );
}
export function wirelessMetrics(s: Snapshot, l: Link) {
  const a = s.devices.find((d) => d.id === l.a.device)!,
    b = s.devices.find((d) => d.id === l.b.device)!,
    x = a.wireless!,
    y = b.wireless!;
  const rssi = signal(a, b, s);
  let interference = 0;
  const receiver = x.role === 'client' ? a : b;
  for (const ap of s.devices) {
    const w = ap.wireless;
    if (
      !w ||
      w.role !== 'ap' ||
      !w.enabled ||
      !ap.power ||
      ap.id === a.id ||
      ap.id === b.id ||
      (l.cable === 'mesh' && ap.mesh?.meshId === a.mesh?.meshId) ||
      w.band !== x.band
    )
      continue;
    const overlap =
      x.band === '2.4'
        ? Math.max(0, 1 - Math.abs(w.channel - x.channel) / 5)
        : Number(w.channel === x.channel);
    if (overlap > 0 && signal(ap, receiver, s) > -85) interference += overlap * 6;
  }
  const noise = Math.max(x.noise, y.noise) + interference,
    snr = rssi - noise,
    loss = Math.min(0.85, Math.max(0, (30 - snr) / 60) + Math.min(0.4, interference / 40));
  return {
    distance: radioDistance(a, b),
    rssi,
    noise,
    snr,
    interference,
    loss,
    latency: 2 + interference / 3,
    speed: snr > 30 ? 1000 : 100,
    operational:
      l.up &&
      a.power &&
      b.power &&
      x.enabled &&
      y.enabled &&
      a.interfaces.find((p) => p.id === l.a.port)?.adminUp === true &&
      b.interfaces.find((p) => p.id === l.b.port)?.adminUp === true &&
      x.band === y.band &&
      x.channel === y.channel &&
      rssi >= -85 &&
      snr >= 10,
  };
}
export function wirelessAssociated(s: Snapshot, l: Link) {
  const a = s.devices.find((d) => d.id === l.a.device)!,
    b = s.devices.find((d) => d.id === l.b.device)!,
    ap = a.wireless?.role === 'ap' ? a : b,
    client = ap === a ? b : a;
  const w = client.wireless,
    p = ap.wireless?.peers.find((p) => p.mac === client.interfaces.find((p) => p.id === w?.port)?.mac);
  return !!(
    w?.phase === 'associated' &&
    w.association?.bssid === ap.interfaces.find((p) => p.id === ap.wireless?.port)?.mac &&
    p?.phase === 'associated' &&
    p.token === w.association?.token &&
    wirelessMetrics(s, l).operational
  );
}
export function wirelessTargets(s: Snapshot, d: Device, frame: Frame) {
  const w = d.wireless;
  if (!w?.enabled) return [];
  return s.links
    .filter(
      (l) =>
        l.cable === 'wireless' &&
        [l.a, l.b].some((p) => p.device === d.id) &&
        wirelessMetrics(s, l).operational
    )
    .filter((l) => {
      const remote = s.devices.find((p) => p.id === (l.a.device === d.id ? l.b.device : l.a.device))!,
        mac = remote.interfaces.find((p) => p.id === remote.wireless?.port)!.mac;
      if (frame.wifi) return frame.dst === 'ff:ff:ff:ff:ff:ff' || frame.dst === mac;
      if (!wirelessAssociated(s, l)) return false;
      return (
        w.role === 'client' ||
        (mac !== frame.src &&
          (frame.dst === 'ff:ff:ff:ff:ff:ff' ||
            frame.dst.startsWith('33:33:') ||
            frame.dst.startsWith('01:') ||
            frame.dst === mac))
      );
    });
}

export function radioCoverage(d: Device) {
  const w = d.wireless;
  if (!w) return 0;
  const threshold = Math.max(-85, w.noise + 10);
  return Math.min(
    300,
    Math.max(1, 10 ** ((w.txPower - 40 - (w.band === '5' ? 7 : 0) - w.attenuation - threshold) / 30))
  );
}
