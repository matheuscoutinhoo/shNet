import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  addDrawing,
  addCanvasItem,
  canvasPosition,
  moveCanvasItem,
  validateSnapshot,
} from '@shlab/engine';
describe('desenhos e comentários ancorados', () => {
  it('persiste traços sem alterar tráfego e rejeita geometria inválida', () => {
    const e = new SimulationEngine();
    const item = addDrawing(e, [
      { x: -20, y: 10 },
      { x: 50, y: 65 },
      { x: 110, y: 35 },
    ]);
    expect(item.position).toEqual({ x: -20, y: 10 });
    expect(item.points![1]).toEqual({ x: 70, y: 55 });
    const restored = new SimulationEngine(validateSnapshot(JSON.parse(JSON.stringify(e.snapshot()))));
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(restored.state.queue).toHaveLength(0);
    const bad = e.snapshot();
    bad.canvasItems![0].points![1].x = 4999;
    expect(() => validateSnapshot(bad)).toThrow(/desenho/);
    expect(() =>
      addDrawing(e, [
        { x: 0, y: 0 },
        { x: 6000, y: 10 },
      ])
    ).toThrow();
  });
  it('comentários acompanham equipamento/enlace e exclusão remove somente suas âncoras', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('pc', { x: 10, y: 20 }),
      b = e.addDevice('server', { x: 210, y: 20 });
    const link = e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    const input = {
      kind: 'comment',
      text: 'Investigar',
      position: { x: 5, y: 8 },
      width: 200,
      height: 100,
      color: 'rose',
    };
    const device = addCanvasItem(e, { ...input, anchor: { kind: 'device', target: a.id } });
    const cable = addCanvasItem(e, { ...input, anchor: { kind: 'link', target: link.id } });
    moveCanvasItem(e, a.id, { x: 50, y: 70 });
    expect(canvasPosition(e.state, device)).toEqual({ x: 55, y: 78 });
    expect(canvasPosition(e.state, cable)).toEqual({ x: 135, y: 53 });
    moveCanvasItem(e, device.id, { x: 60, y: 80 });
    expect(device.position).toEqual({ x: 10, y: 10 });
    expect(() => addCanvasItem(e, { ...input, anchor: { kind: 'device', target: 'missing' } })).toThrow(
      /âncora/
    );
    e.removeLink(link.id);
    expect(e.state.canvasItems).toHaveLength(1);
    e.removeDevice(a.id);
    expect(e.state.canvasItems).toHaveLength(0);
    expect(e.state.devices).toHaveLength(1);
    validateSnapshot(e.snapshot());
  });
});
