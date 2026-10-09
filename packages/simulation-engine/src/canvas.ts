import { canvasItemSchema, type Snapshot } from './model';
import type { SimulationEngine } from './core/engine';

export function addCanvasItem(engine: SimulationEngine, input: unknown) {
  const value = canvasItemSchema.omit({ id: true }).parse(input);
  if ((engine.state.canvasItems?.length ?? 0) >= 100) throw new Error('Limite de 100 anotações/regiões.');
  const item = { ...value, id: engine.id('canvas') };
  validateCanvas({ ...engine.state, canvasItems: [...(engine.state.canvasItems ?? []), item] });
  engine.state.canvasItems ??= [];
  engine.state.canvasItems.push(item);
  return item;
}
export function groupDevices(engine: SimulationEngine, ids: string[]) {
  const devices = engine.state.devices.filter((device) => ids.includes(device.id));
  if (devices.length < 2) throw new Error('Selecione pelo menos dois equipamentos.');
  if (engine.state.canvasItems?.some((item) => item.members?.some((id) => ids.includes(id))))
    throw new Error('Desagrupe os equipamentos antes de agrupá-los novamente.');
  const left = Math.min(...devices.map((device) => device.position.x)) - 30;
  const top = Math.min(...devices.map((device) => device.position.y)) - 50;
  return addCanvasItem(engine, {
    kind: 'group',
    text: 'Grupo',
    color: 'cyan',
    position: { x: left, y: top },
    width: Math.max(...devices.map((device) => device.position.x)) - left + 260,
    height: Math.max(...devices.map((device) => device.position.y)) - top + 160,
    members: devices.map((device) => device.id),
  });
}
export function moveCanvasItem(engine: SimulationEngine, id: string, position: { x: number; y: number }) {
  const annotation = engine.state.canvasItems?.find((item) => item.id === id);
  if (annotation) {
    const delta = { x: position.x - annotation.position.x, y: position.y - annotation.position.y };
    for (const device of engine.state.devices.filter((entry) => annotation.members?.includes(entry.id)))
      device.position = { x: device.position.x + delta.x, y: device.position.y + delta.y };
    const absolute = canvasPosition(engine.state, annotation);
    annotation.position = annotation.anchor
      ? {
          x: position.x - absolute.x + annotation.position.x,
          y: position.y - absolute.y + annotation.position.y,
        }
      : position;
  } else engine.device(id).position = position;
}
export function canvasPosition(snapshot: Snapshot, item: NonNullable<Snapshot['canvasItems']>[number]) {
  if (!item.anchor) return item.position;
  let base = snapshot.devices.find(
    (d) => item.anchor?.kind === 'device' && d.id === item.anchor.target
  )?.position;
  if (item.anchor.kind === 'link') {
    const link = snapshot.links.find((l) => l.id === item.anchor!.target);
    const a = snapshot.devices.find((d) => d.id === link?.a.device),
      b = snapshot.devices.find((d) => d.id === link?.b.device);
    if (a && b) base = { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 };
  }
  return base ? { x: base.x + item.position.x, y: base.y + item.position.y } : item.position;
}
export function addDrawing(engine: SimulationEngine, points: { x: number; y: number }[], color = 'blue') {
  if (points.length < 2 || points.length > 512) throw new Error('Desenho exige de 2 a 512 pontos.');
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return addCanvasItem(engine, {
    kind: 'drawing',
    text: 'Desenho',
    color,
    position: { x, y },
    width: Math.max(80, ...points.map((p) => p.x - x)),
    height: Math.max(40, ...points.map((p) => p.y - y)),
    points: points.map((p) => ({ x: p.x - x, y: p.y - y })),
  });
}
export function removeCanvasItem(engine: SimulationEngine, id: string, keepMembers = false) {
  const item = engine.state.canvasItems?.find((entry) => entry.id === id);
  if (item) {
    if (!keepMembers) for (const member of item.members ?? []) engine.removeDevice(member);
    engine.state.canvasItems = engine.state.canvasItems?.filter((entry) => entry.id !== id);
  } else engine.removeDevice(id);
}
export function validateCanvas(snapshot: Snapshot) {
  const ids = new Set(snapshot.devices.map((device) => device.id));
  const grouped = new Set<string>();
  for (const item of snapshot.canvasItems ?? []) {
    if (ids.has(item.id)) throw new Error('ID de objeto de canvas duplicado.');
    ids.add(item.id);
    if (item.kind !== 'group' && item.members?.length) throw new Error('Anotação não pode possuir membros.');
    if (
      (item.kind === 'drawing') !== !!item.points ||
      (item.points && item.points.some((p) => p.x > item.width || p.y > item.height))
    )
      throw new Error('Pontos incompatíveis com o desenho.');
    if (
      (item.kind === 'comment') !== !!item.anchor ||
      (item.anchor &&
        !(item.anchor.kind === 'device' ? snapshot.devices : snapshot.links).some(
          (v) => v.id === item.anchor!.target
        ))
    )
      throw new Error('Comentário exige uma âncora existente.');
    for (const id of item.members ?? []) {
      if (grouped.has(id) || !snapshot.devices.some((device) => device.id === id))
        throw new Error('Membro de grupo inválido ou duplicado.');
      grouped.add(id);
    }
  }
}
