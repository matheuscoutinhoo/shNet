// PostgreSQL jsonb rejects U+0000 even when JSON escapes it. Preserve the entire
// JSON value in a versioned envelope only when its serialized text contains that
// escape. Base64 also preserves literal backslashes and all UTF-8 characters.
const encoding = 'shlab-json-utf8-base64-v1';
export function databaseJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (!json.includes('\\u0000')) return json;
  const devices = (value as { devices?: unknown[] } | null)?.devices;
  return JSON.stringify({
    __shlabJsonEncoding: encoding,
    data: Buffer.from(json, 'utf8').toString('base64'),
    deviceCount: Array.isArray(devices) ? devices.length : null,
  });
}
export function decodeDatabaseJson(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const stored = value as Record<string, unknown>;
  if (
    stored.__shlabJsonEncoding !== encoding ||
    typeof stored.data !== 'string' ||
    Object.keys(stored).length !== 3 ||
    !Object.hasOwn(stored, 'deviceCount')
  )
    return value;
  const bytes = Buffer.from(stored.data, 'base64');
  if (bytes.toString('base64') !== stored.data) throw new Error('Envelope JSON do banco inválido.');
  return JSON.parse(bytes.toString('utf8'));
}
export function decodeDatabaseRows<T>(rows: T[]): T[] {
  return rows.map(
    (row) =>
      Object.fromEntries(
        Object.entries(row as Record<string, unknown>).map(([column, value]) => [
          column,
          decodeDatabaseJson(value),
        ])
      ) as T
  );
}
