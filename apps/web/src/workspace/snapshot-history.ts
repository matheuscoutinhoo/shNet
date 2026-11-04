import type { Snapshot } from '@shlab/engine';
// Lazy entries come from terminal marks and are materialized only when undone or redone.
type Entry = { snapshot?: Snapshot; load?: () => Snapshot; bytes: number; order: number };
export class SnapshotHistory {
  private undo: Entry[] = [];
  private redo: Entry[] = [];
  private order = 0;
  constructor(
    private maxCount = 30,
    private maxBytes = 64 * 1024 * 1024
  ) {}
  get canUndo() {
    return this.undo.length > 0;
  }
  get canRedo() {
    return this.redo.length > 0;
  }
  get bytes() {
    return [...this.undo, ...this.redo].reduce((n, e) => n + e.bytes, 0);
  }
  clear() {
    this.undo = [];
    this.redo = [];
  }
  private entry(snapshot: Snapshot): Entry {
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    if (bytes > this.maxBytes)
      throw new Error('Topologia excede o limite do histórico. Exporte e reduza a captura antes de editar.');
    return { snapshot, bytes, order: ++this.order };
  }
  private trim() {
    while (this.undo.length + this.redo.length > this.maxCount || this.bytes > this.maxBytes) {
      const stack =
        !this.redo.length || (this.undo.length && this.undo[0].order < this.redo[0].order)
          ? this.undo
          : this.redo;
      stack.shift();
    }
  }
  checkpoint(snapshot: Snapshot) {
    const entry = this.entry(snapshot);
    this.redo = [];
    this.undo.push(entry);
    this.trim();
  }
  checkpointLazy(load: () => Snapshot, bytes: number) {
    this.redo = [];
    this.undo.push({ load, bytes, order: ++this.order });
    this.trim();
  }
  restore(direction: 'undo' | 'redo', current: Snapshot) {
    const source = direction === 'undo' ? this.undo : this.redo,
      target = direction === 'undo' ? this.redo : this.undo;
    if (!source.length) return;
    const entry = this.entry(current),
      previous = source.pop()!;
    target.push(entry);
    this.trim();
    return previous.snapshot ?? previous.load!();
  }
}
