import type { Device } from '../model';

/**
 * Lays out running-config the way IOS prints it, which is also the order startup-config is
 * replayed in at boot. Features contribute their own lines, but each interface is printed once
 * with all of its sub-commands, after the global definitions it may reference (VRFs, VLANs,
 * class/policy-maps, AAA) and before the global commands that need interface addresses
 * (tunnels, IPv6 static routes) and the routing processes.
 */
interface Unit {
  header: string;
  children: string[];
  exit: boolean;
}
// Global lines that can only be applied once the interfaces have their addresses.
const NEEDS_INTERFACES =
  /^(?:(?:no )?ipv6 route |tunnel configure |no tunnel |(?:no )?service tunnel |sdwan |no sdwan |(?:no )?service sdwan|vxlan configure |(?:no )?service vxlan |no vxlan )/;
// Interface sub-commands whose simulator form references another interface's address or route.
const NEEDS_ALL_INTERFACES =
  /^ (?:dot1x configure|supplicant configure|authentication (?:port-control|periodic|timer)|dot1x pae) /;
function units(lines: string[]) {
  const out: Unit[] = [];
  let open = false;
  for (const line of lines) {
    if (line === 'exit') {
      if (out.length) out[out.length - 1].exit = true;
      open = false;
    } else if (line.startsWith(' ') && open && out.length) out[out.length - 1].children.push(line);
    else {
      out.push({ header: line, children: [], exit: false });
      open = true;
    }
  }
  // An interface block closed with an indented "exit" is merged into another block, where the
  // stray "exit" would leave interface mode early.
  for (const u of out)
    if (u.header.startsWith('interface ') && u.children.at(-1)?.trim() === 'exit') {
      u.children.pop();
      u.exit = true;
    }
  return out;
}
const emit = (list: Unit[]) => list.flatMap((u) => [u.header, ...u.children, ...(u.exit ? ['exit'] : [])]);
const isInterface = (u: Unit) => u.header.startsWith('interface ');
export function composeRunningConfig(d: Device, head: string[], main: string[], tail: string[]) {
  const late: Unit[] = [];
  const mainUnits = units(main);
  const blocks = new Map(mainUnits.filter(isInterface).map((u) => [u.header, u]));
  const merge = (list: Unit[], moveGlobals: boolean) => {
    const kept: Unit[] = [],
      moved: Unit[] = [];
    for (const u of list) {
      if (!isInterface(u)) {
        (moveGlobals && NEEDS_INTERFACES.test(u.header) ? moved : kept).push(u);
        continue;
      }
      const deferred = u.children.filter((line) => NEEDS_ALL_INTERFACES.test(line)),
        now = u.children.filter((line) => !NEEDS_ALL_INTERFACES.test(line));
      if (deferred.length) late.push({ header: u.header, children: deferred, exit: true });
      const target = blocks.get(u.header);
      if (target) {
        target.children.push(...now);
        target.exit ||= u.exit;
      } else if (now.length || !deferred.length) {
        const block = { ...u, children: now };
        mainUnits.push(block);
        blocks.set(u.header, block);
      }
    }
    return { kept, moved };
  };
  const before = merge(units(head), true),
    after = merge(units(tail), false);
  // Tunnel/VXLAN interfaces exist only once their global definition has been applied; static
  // routes may point at any interface, so they follow all of them.
  const created = new Set(d.interfaces.filter((p) => p.tunnel || p.vxlan).map((p) => 'interface ' + p.name));
  const route = (u: Unit) => /^(?:no )?ipv6 route /.test(u.header);
  return [
    ...emit(before.kept),
    ...emit(mainUnits.filter((u) => !created.has(u.header))),
    ...emit(before.moved.filter((u) => !route(u))),
    ...emit(mainUnits.filter((u) => created.has(u.header))),
    ...emit(before.moved.filter(route)),
    ...emit(after.kept),
    ...emit(late),
  ];
}
