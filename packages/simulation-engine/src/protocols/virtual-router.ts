import type { Device, NetworkInterface, Snapshot } from '../model';
import { activeVrrpGroup } from './vrrp';
import { vrrpMac } from './vrrp-model';
import { activeHsrpGroup } from './hsrp';
import { hsrpMac } from './hsrp-model';
export function activeVirtualRouter(s: Snapshot, d: Device, p: NetworkInterface, vip?: string) {
  const vrrp = activeVrrpGroup(s, d, p, vip);
  if (vrrp) return { vip: vrrp.vip, mac: vrrpMac(vrrp.vrid) };
  const hsrp = activeHsrpGroup(s, d, p, vip);
  if (hsrp?.vip) return { vip: hsrp.vip, mac: hsrpMac(hsrp) };
}
