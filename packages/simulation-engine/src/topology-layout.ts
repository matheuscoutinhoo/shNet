import { validateSnapshot } from './core/validation';
import type { Snapshot } from './model';
/** Graph order on a bounded grid. Keep grouped nodes and RF coordinates intact. */
export function layoutTopology(input: Snapshot) {
  const snapshot = validateSnapshot(input),
    nodes = new Map(snapshot.devices.map((d) => [d.id, d]));
  const adjacent = new Map(snapshot.devices.map((d) => [d.id, new Set<string>()]));
  for (const link of snapshot.links) {
    adjacent.get(link.a.device)!.add(link.b.device);
    adjacent.get(link.b.device)!.add(link.a.device);
  }
  const pinned = new Set(snapshot.canvasItems?.flatMap((item) => item.members ?? []) ?? []);
  const radios = snapshot.devices.filter((d) => d.wireless || d.mesh);
  if (radios.some((d) => !d.physicalPosition)) radios.forEach((d) => pinned.add(d.id));
  const candidates = snapshot.devices
    .filter((d) => !pinned.has(d.id))
    .sort(
      (a, b) =>
        adjacent.get(b.id)!.size - adjacent.get(a.id)!.size ||
        a.hostname.localeCompare(b.hostname, 'en') ||
        a.id.localeCompare(b.id, 'en')
    );
  const visited = new Set<string>(),
    ordered: string[] = [];
  for (const root of candidates) {
    if (visited.has(root.id)) continue;
    const queue = [root.id];
    visited.add(root.id);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      ordered.push(id);
      for (const peer of [...adjacent.get(id)!].sort())
        if (!pinned.has(peer) && !visited.has(peer)) {
          visited.add(peer);
          queue.push(peer);
        }
    }
  }
  const occupied = snapshot.devices
    .filter((d) => pinned.has(d.id))
    .map((d) => ({ x: d.position.x, y: d.position.y, width: 320, height: 260 }));
  occupied.push(
    ...(snapshot.canvasItems ?? [])
      .filter((item) => item.kind === 'group')
      .map((item) => ({ ...item.position, width: item.width, height: item.height }))
  );
  const columns = Math.max(1, Math.min(20, Math.ceil(Math.sqrt(ordered.length))));
  let cell = 0;
  for (const id of ordered) {
    let position: { x: number; y: number };
    do {
      position = { x: 80 + (cell % columns) * 420, y: 80 + Math.floor(cell / columns) * 340 };
      cell++;
      if (position.y > 98000)
        throw new Error(
          'Sem espaço para organizar preservando os grupos. Reorganize os grupos antes de tentar novamente.'
        );
    } while (
      occupied.some(
        (box) =>
          position.x < box.x + box.width + 40 &&
          position.x + 320 > box.x - 40 &&
          position.y < box.y + box.height + 40 &&
          position.y + 260 > box.y - 40
      )
    );
    nodes.get(id)!.position = position;
  }
  return { snapshot: validateSnapshot(snapshot), moved: ordered.length, preserved: pinned.size };
}
