import type { Snapshot } from '@shlab/engine';
export interface ProjectDraft {
  key: string;
  project: string;
  owner: string;
  session: string;
  name: string;
  revision: number;
  editVersion: number;
  updatedAt: number;
  topology: Snapshot;
  bytes: number;
}
const databaseName = 'shlab-project-drafts';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' });
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Armazenamento local bloqueado por outra aba.'));
    };
  });
}
export async function projectDrafts(owner: string, project?: string): Promise<ProjectDraft[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
      request.onsuccess = () =>
        resolve(
          request.result
            .filter(
              (d: ProjectDraft) => d.owner === owner && (project === undefined || d.project === project)
            )
            .sort((a: ProjectDraft, b: ProjectDraft) => b.updatedAt - a.updatedAt)
        );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function storeProjectDraft(input: Omit<ProjectDraft, 'key' | 'bytes'>) {
  const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  if (bytes > 16 * 1024 * 1024) throw new Error('Rascunho excede 16 MiB. Exporte a topologia.');
  const key = input.owner + '/' + input.project + '/' + input.session;
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite'),
        store = tx.objectStore('drafts');
      const read = store.getAll();
      read.onsuccess = () => {
        const other = read.result.filter((d: ProjectDraft) => d.key !== key);
        if (
          other.length >= 30 ||
          other.reduce(
            (n: number, d: ProjectDraft) =>
              n +
              (Number.isFinite(d.bytes) && d.bytes > 0
                ? d.bytes
                : new TextEncoder().encode(JSON.stringify(d)).length),
            bytes
          ) >
            64 * 1024 * 1024
        ) {
          reject(
            new Error(
              'Limite de rascunhos locais atingido (30/64 MiB). Recupere, exporte ou descarte os antigos.'
            )
          );
          tx.abort();
          return;
        }
        store.put({ ...input, key, bytes });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Falha ao gravar o rascunho local.'));
    });
    return key;
  } finally {
    db.close();
  }
}
export async function removeProjectDraft(key: string, maxVersion = Infinity) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite'),
        store = tx.objectStore('drafts');
      const read = store.get(key);
      read.onsuccess = () => {
        if (read.result && read.result.editVersion <= maxVersion) store.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Falha ao remover o rascunho.'));
    });
  } finally {
    db.close();
  }
}
