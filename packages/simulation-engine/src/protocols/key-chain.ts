import type { Device } from '../model';
import type { KeyChainKey } from './key-chain-model';
export const keyChainTime = (d: Device, clock: number) => clock + (d.networkClock?.offsetMs ?? 0);
export function keyValid(key: KeyChainKey, kind: 'send' | 'accept', at: number) {
  const life = kind === 'send' ? key.sendLifetime : key.acceptLifetime;
  return !!key.keyString && (!life || (at >= life.startAt && (life.endAt === undefined || at < life.endAt)));
}
/** Multiple overlapping receive keys permit rollover; the lowest valid send ID is deterministic. */
export function keyChainKeys(d: Device, name: string, kind: 'send' | 'accept', clock: number, maxId = 255) {
  return (d.keyChains?.find((c) => c.name === name)?.keys ?? [])
    .filter((k) => k.id <= maxId && keyValid(k, kind, keyChainTime(d, clock)))
    .sort((a, b) => a.id - b.id);
}
export function keyChainBoundary(d: Device, name: string, clock: number) {
  const now = keyChainTime(d, clock),
    offset = now - clock;
  const values = (d.keyChains?.find((c) => c.name === name)?.keys ?? [])
    .flatMap((k) => [
      k.sendLifetime?.startAt,
      k.sendLifetime?.endAt,
      k.acceptLifetime?.startAt,
      k.acceptLifetime?.endAt,
    ])
    .filter((at): at is number => at !== undefined && at > now);
  return values.length ? Math.min(...values) - offset : undefined;
}
export function validateKeyChains(d: Device) {
  const chains = d.keyChains ?? [];
  if (
    new Set(chains.map((c) => c.name)).size !== chains.length ||
    chains.some(
      (c) =>
        new Set(c.keys.map((k) => k.id)).size !== c.keys.length ||
        c.keys.some((k) =>
          [k.sendLifetime, k.acceptLifetime].some((l) => l?.endAt !== undefined && l.endAt <= l.startAt)
        )
    )
  )
    throw new Error('Invalid key-chain identifier or lifetime.');
}
