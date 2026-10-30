import { validateSnapshot } from './core/validation';
import type { SimulationEngine } from './core/engine';
import type { CanvasItem, Device, Snapshot } from './model';

const CELL = { width: 250, height: 170 },
  PADDING = { x: 30, top: 70, bottom: 30 },
  GAP = 140,
  ROW_DEVICES = 6,
  MAX_MEMBERS = 200,
  MAX_ITEMS = 100;
const colors: CanvasItem['color'][] = ['cyan', 'lime', 'blue', 'rose'];

/** Site code from a hostname such as HQ-CORE-1 or BR01_RTR. Hosts without a separator have no site. */
export function siteOf(hostname: string) {
  const parts = hostname.split(/[-_.]/).filter(Boolean);
  return parts.length > 1 ? parts[0].toUpperCase() : undefined;
}
/** Routers first, then L3 switches, access switches and endpoints. */
export function deviceTier(d: Device) {
  if (d.type === 'router') return 0;
  if (d.type === 'switch') return d.ipRouting ? 1 : 2;
  return 3;
}
function tiers(devices: Device[]) {
  const rows: Device[][] = [];
  for (const d of [...devices].sort(
    (a, b) => deviceTier(a) - deviceTier(b) || a.hostname.localeCompare(b.hostname, 'en', { numeric: true })
  )) {
    const tier = deviceTier(d);
    const last = rows.at(-1);
    if (last && deviceTier(last[0]) === tier && last.length < ROW_DEVICES) last.push(d);
    else rows.push([d]);
  }
  return rows;
}
/**
 * Creates one canvas group per hostname site prefix and arranges each site by tier.
 * Devices already inside a group and radios without a physical position keep their place.
 */
export function groupBySite(input: Snapshot) {
  const snapshot = validateSnapshot(input);
  const items = snapshot.canvasItems ?? [];
  const pinned = new Set(items.flatMap((item) => item.members ?? []));
  const radios = snapshot.devices.filter((d) => d.wireless || d.mesh);
  if (radios.some((d) => !d.physicalPosition)) radios.forEach((d) => pinned.add(d.id));
  const sites = new Map<string, Device[]>();
  for (const d of snapshot.devices) {
    const site = pinned.has(d.id) ? undefined : siteOf(d.hostname);
    if (site) sites.set(site, [...(sites.get(site) ?? []), d]);
  }
  const blocks: { name: string; devices: Device[] }[] = [];
  for (const [name, devices] of [...sites].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
    if (devices.length < 2) continue;
    for (let start = 0, part = 1; start < devices.length; start += MAX_MEMBERS, part++)
      blocks.push({
        name: devices.length > MAX_MEMBERS ? name + ' (' + part + ')' : name,
        devices: devices.slice(start, start + MAX_MEMBERS),
      });
  }
  if (!blocks.length)
    throw new Error('Nenhum site encontrado. Use nomes como SITE-EQUIPAMENTO (ex.: HQ-CORE-1).');
  if (items.length + blocks.length > MAX_ITEMS)
    throw new Error(
      'Limite de ' +
        MAX_ITEMS +
        ' anotações/regiões: ' +
        blocks.length +
        ' sites exigem mais espaço no canvas.'
    );
  // Start below every existing annotation and pinned device so nothing overlaps; anchored
  // comments are relative to their target and move with it.
  let top = 80;
  for (const item of items) if (!item.anchor) top = Math.max(top, item.position.y + item.height + GAP);
  for (const d of snapshot.devices)
    if (pinned.has(d.id)) top = Math.max(top, d.position.y + CELL.height + GAP);
  const columns = Math.max(1, Math.ceil(Math.sqrt(blocks.length)));
  let x = 80,
    rowHeight = 0;
  const grouped = new Set<string>();
  blocks.forEach((block, index) => {
    if (index && index % columns === 0) {
      top += rowHeight + GAP;
      x = 80;
      rowHeight = 0;
    }
    const rows = tiers(block.devices);
    const width = PADDING.x * 2 + Math.max(...rows.map((row) => row.length)) * CELL.width;
    const height = PADDING.top + PADDING.bottom + rows.length * CELL.height;
    rows.forEach((row, r) =>
      row.forEach((d, c) => {
        d.position = { x: x + PADDING.x + c * CELL.width, y: top + PADDING.top + r * CELL.height };
        grouped.add(d.id);
      })
    );
    let suffix = items.length;
    while (
      snapshot.devices.some((d) => d.id === 'site-' + suffix) ||
      items.some((i) => i.id === 'site-' + suffix)
    )
      suffix++;
    items.push({
      id: 'site-' + suffix,
      kind: 'group',
      text: 'Site ' + block.name,
      color: colors[index % colors.length],
      position: { x, y: top },
      width: Math.min(5000, width),
      height: Math.min(5000, height),
      members: block.devices.map((d) => d.id),
    });
    x += width + GAP;
    rowHeight = Math.max(rowHeight, height);
  });
  top += rowHeight + GAP;
  const loose = snapshot.devices.filter((d) => !grouped.has(d.id) && !pinned.has(d.id));
  tiers(loose).forEach((row, r) =>
    row.forEach((d, c) => (d.position = { x: 80 + c * CELL.width, y: top + r * CELL.height }))
  );
  snapshot.canvasItems = items;
  return { snapshot: validateSnapshot(snapshot), groups: blocks.length, grouped: grouped.size };
}
/** Collapse or expand one group, or every group when no id is given. */
export function setGroupsCollapsed(engine: SimulationEngine, collapsed: boolean, id?: string) {
  const groups = (engine.state.canvasItems ?? []).filter(
    (item) => item.kind === 'group' && (id === undefined || item.id === id)
  );
  if (id !== undefined && !groups.length) throw new Error('Grupo não encontrado.');
  for (const group of groups) {
    if (collapsed) group.collapsed = true;
    else delete group.collapsed;
  }
  return groups.length;
}
/** Device id → collapsed group id, for projections that hide grouped members. */
export function collapsedMembers(snapshot: Snapshot) {
  const hidden = new Map<string, string>();
  for (const item of snapshot.canvasItems ?? [])
    if (item.kind === 'group' && item.collapsed)
      for (const member of item.members ?? []) hidden.set(member, item.id);
  return hidden;
}
