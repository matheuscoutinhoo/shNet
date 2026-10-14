import { Worker } from 'node:worker_threads';
import { validateSnapshot } from '@shlab/engine/runtime';
import type { Snapshot } from '@shlab/engine';
const failure = (statusCode: number, publicMessage: string) =>
  Object.assign(new Error(publicMessage), { statusCode, publicMessage });
interface Task {
  id: number;
  value: unknown;
  bytes: number;
  resolve: (value: Snapshot) => void;
  reject: (error: Error) => void;
}
interface Slot {
  worker: Worker;
  task?: Task;
  timeout?: NodeJS.Timeout;
}
class ValidationPool {
  private queue: Task[] = [];
  private slots: Slot[] = [];
  private bytes = 0;
  private sequence = 0;
  private closed = false;
  validate(value: unknown): Promise<Snapshot> {
    if (this.closed) return Promise.reject(failure(503, 'Servidor reiniciando. Tente salvar novamente.'));
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value) ?? '');
    } catch {
      return Promise.reject(failure(400, 'Topologia inválida: formato não serializável.'));
    }
    if (
      bytes <= 1048576 &&
      (!value ||
        typeof value !== 'object' ||
        !('devices' in value) ||
        !Array.isArray(value.devices) ||
        value.devices.length <= 200)
    ) {
      try {
        return Promise.resolve(validateSnapshot(value));
      } catch {
        return Promise.reject(
          failure(400, 'Topologia inválida: verifique interfaces, cabos e configurações')
        );
      }
    }
    if (
      this.queue.length + this.slots.filter((s) => s.task).length >= 32 ||
      this.bytes + bytes > 128 * 1048576
    )
      return Promise.reject(
        failure(503, 'Validação ocupada. Seu trabalho pode ser salvo novamente em alguns segundos.')
      );
    this.bytes += bytes;
    return new Promise<Snapshot>((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, value, bytes, resolve, reject });
      this.dispatch();
    });
  }
  private spawn() {
    const worker = new Worker(new URL('./topology-validation-worker.mjs', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 },
    });
    const slot: Slot = { worker };
    this.slots.push(slot);
    worker.on('message', (message: { id: number; snapshot?: Snapshot; invalid?: boolean }) => {
      if (slot.task?.id !== message.id) return;
      const task = slot.task;
      this.release(slot);
      if (message.snapshot) task.resolve(message.snapshot);
      else task.reject(failure(400, 'Topologia inválida: verifique interfaces, cabos e configurações'));
      this.dispatch();
    });
    const broken = () => {
      if (!this.slots.includes(slot)) return;
      const task = slot.task;
      this.release(slot);
      this.slots = this.slots.filter((s) => s !== slot);
      task?.reject(failure(503, 'A validação foi interrompida. Seu trabalho pode ser salvo novamente.'));
      void worker.terminate();
      this.dispatch();
    };
    worker.on('error', broken);
    worker.on('exit', broken);
    worker.unref();
    return slot;
  }
  private release(slot: Slot) {
    clearTimeout(slot.timeout);
    slot.timeout = undefined;
    if (slot.task) this.bytes -= slot.task.bytes;
    slot.task = undefined;
    slot.worker.unref();
  }
  private dispatch() {
    if (this.closed) return;
    while (this.queue.length) {
      const slot = this.slots.find((s) => !s.task) ?? (this.slots.length < 2 ? this.spawn() : undefined);
      if (!slot) return;
      slot.task = this.queue.shift()!;
      slot.worker.ref();
      slot.timeout = setTimeout(() => {
        const task = slot.task;
        this.release(slot);
        this.slots = this.slots.filter((s) => s !== slot);
        task?.reject(failure(503, 'A validação excedeu o limite. Exporte seu trabalho e tente novamente.'));
        void slot.worker.terminate();
        this.dispatch();
      }, 30000);
      slot.worker.postMessage({ id: slot.task.id, value: slot.task.value });
    }
  }
  async close() {
    this.closed = true;
    for (const task of this.queue) task.reject(failure(503, 'Servidor reiniciando. Tente salvar novamente.'));
    this.queue = [];
    for (const slot of this.slots) {
      slot.task?.reject(failure(503, 'Servidor reiniciando. Tente salvar novamente.'));
      this.release(slot);
    }
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
    this.slots = [];
    this.bytes = 0;
  }
}
let shared: { pool: ValidationPool; references: number } | undefined;
export function acquireTopologyValidator() {
  const current = (shared ??= { pool: new ValidationPool(), references: 0 });
  current.references++;
  let released = false;
  return {
    validate: (value: unknown) => current.pool.validate(value),
    close: async () => {
      if (released) return;
      released = true;
      if (--current.references === 0) {
        if (shared === current) shared = undefined;
        await current.pool.close();
      }
    },
  };
}
