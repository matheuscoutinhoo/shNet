import type { Device } from '../model';
import { longInterfaceName } from '../protocols/interface-name';

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

/** IOS XE release the simulated routers and switches report. */
export const IOS_VERSION = '17.12';
const LINE = /^line (con|aux|vty) (\d+)(?: (\d+))?$/;
const LINE_ORDER = ['con', 'aux', 'vty'];
// Free text and simulator JSON keep their exact spelling.
const LITERAL = /^\s*(?:description |remark |\d+ remark |alias |snmp-server (?:location|contact) )|\{"/;
const BANNER = /^banner (?:motd|login|exec|incoming) \^C/;
/**
 * The composed configuration as IOS prints it: "!" between blocks instead of "exit", full
 * interface names, the version line first, every console/VTY line block last and "end".
 */
export function iosConfigText(d: Device, composed: string[]) {
  const names = new Map(
    d.interfaces.map((p) => [p.name, longInterfaceName(p.name)] as const).filter(([a, b]) => a !== b)
  );
  const expand = (line: string) =>
    names.size && !LITERAL.test(line)
      ? line.replace(
          /(^|[\s,])([A-Z][A-Za-z-]*\d+(?:\/\d+)*(?:\.\d+)?)(?=$|[\s,])/g,
          (all, before: string, name: string) => before + (names.get(name) ?? name)
        )
      : line;
  // Top-level commands with their sub-commands; banner text is kept verbatim.
  const blocks: { header: string; children: string[]; text?: boolean }[] = [];
  for (let i = 0; i < composed.length; i++) {
    const line = composed[i];
    if (line === 'exit') continue;
    // Sub-mode exits are implicit in IOS output (the next sibling or a top-level line closes them).
    if (/^ +exit$/.test(line) && blocks.length && !blocks.at(-1)!.text) continue;
    if (BANNER.test(line)) {
      const text = [line];
      let closed = line.slice(line.indexOf('^C') + 2).includes('^C');
      while (!closed && i + 1 < composed.length) {
        text.push(composed[++i]);
        closed = composed[i].includes('^C');
      }
      blocks.push({ header: text[0], children: text.slice(1), text: true });
    } else if (line.startsWith(' ') && blocks.length && !blocks.at(-1)!.text)
      blocks.at(-1)!.children.push(expand(line));
    else blocks.push({ header: expand(line), children: [] });
  }
  // IOS always shows the console and VTY lines (and the AUX port of routers), configured or not.
  const lines = blocks.filter((b) => LINE.test(b.header));
  const has = (kind: string, first: number) =>
    lines.some((b) => {
      const m = LINE.exec(b.header)!;
      return m[1] === kind && Number(m[2]) <= first && first <= Number(m[3] ?? m[2]);
    });
  if (['router', 'switch'].includes(d.type)) {
    const defaults: [string, number, number][] = [
      ['con', 0, 0],
      ...(d.type === 'router' ? ([['aux', 0, 0]] as [string, number, number][]) : []),
      ['vty', 0, 4],
      ...(d.type === 'switch' ? ([['vty', 5, 15]] as [string, number, number][]) : []),
    ];
    for (const [kind, first, last] of defaults)
      if (!has(kind, first))
        lines.push({ header: `line ${kind} ${first}${last !== first ? ' ' + last : ''}`, children: [] });
  }
  const order = (header: string) => {
    const m = LINE.exec(header)!;
    return LINE_ORDER.indexOf(m[1]) * 100 + Number(m[2]);
  };
  lines.sort((a, b) => order(a.header) - order(b.header));
  const out = ['!', 'version ' + IOS_VERSION, '!'];
  const separate = () => {
    if (out.at(-1) !== '!') out.push('!');
  };
  for (const b of blocks.filter((b) => !LINE.test(b.header))) {
    const block = b.children.length > 0 || /^(?:interface|router) /.test(b.header);
    if (block) separate();
    out.push(b.header, ...b.children);
    if (block) separate();
  }
  separate();
  for (const b of lines) out.push(b.header, ...b.children);
  separate();
  out.push('end');
  return out;
}
/** "show running-config": IOS reports the size of the text it is about to print. */
export function withConfigHeader(body: string) {
  return `Building configuration...\n\nCurrent configuration : ${new TextEncoder().encode(body).length + 1} bytes\n${body}`;
}
/** The configuration text without the "Building configuration..." header. */
export function configBody(text: string) {
  return text.replace(/^Building configuration\.\.\.\n\nCurrent configuration : \d+ bytes\n/, '');
}
