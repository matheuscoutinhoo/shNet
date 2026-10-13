const databaseName = 'shlab-pending-scenario-results';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('results', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function pendingResults<T>(project: string): Promise<T[]> {
  const db = await database();
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction('results', 'readonly'),
        request = tx.objectStore('results').getAll();
      request.onsuccess = () =>
        resolve(request.result.filter((x) => x.project === project).map((x) => x.row));
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function storePendingResult(project: string, row: { id: string }) {
  if (new TextEncoder().encode(JSON.stringify(row)).length > 2 * 1024 * 1024)
    throw new Error('Resultado local excede 2 MiB; exporte o ensaio.');
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('results', 'readwrite'),
        store = tx.objectStore('results');
      const request = store.getAll();
      request.onsuccess = () => {
        const key = project + '/' + row.id;
        const rows = request.result.filter((x) => x.key !== key);
        const bytes = new TextEncoder().encode(JSON.stringify(row)).length;
        const total = rows.reduce(
          (n, x) => n + (x.bytes ?? new TextEncoder().encode(JSON.stringify(x.row)).length),
          bytes
        );
        if (
          rows.filter((x) => x.project === project).length >= 50 ||
          rows.length >= 200 ||
          total > 32 * 1024 * 1024
        ) {
          reject(
            new Error(
              'Limite local de resultados atingido (50 por laboratório, 200/32 MiB no total). Salve ou exporte os pendentes.'
            )
          );
          tx.abort();
          return;
        }
        store.put({ key, project, row, bytes });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function removePendingResult(project: string, id: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('results', 'readwrite');
      tx.objectStore('results').delete(project + '/' + id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
