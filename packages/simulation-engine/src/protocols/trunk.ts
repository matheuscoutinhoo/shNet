import type { Device, NetworkInterface } from '../model';

type Trunk = Pick<NetworkInterface, 'allowedVlans' | 'allVlansAllowed'>;
/** IOS default "switchport trunk allowed vlan all"; an explicit allowed list takes precedence. */
export const allVlansAllowed = (p: Trunk) => !!p.allVlansAllowed && !p.allowedVlans.length;
export const trunkAllows = (p: Trunk, vlan: number) => p.allowedVlans.includes(vlan) || allVlansAllowed(p);
/** The VLANs a trunk carries on this device: all of its VLANs by default. */
export const trunkVlans = (d: Device, p: Trunk) =>
  allVlansAllowed(p) ? d.vlans.map((v) => v.id) : p.allowedVlans;
/** IOS VLAN list notation: 1,10,20-30. */
export function vlanRangeText(ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b),
    parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? sorted[i] + '-' + sorted[j] : String(sorted[i]));
    i = j;
  }
  return parts.join(',');
}
