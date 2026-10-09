import type { Snapshot, LabId } from '@shlab/engine';
export interface User {
  id: string;
  name: string;
  email: string;
  verified: boolean;
}
export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  favorite: boolean;
  updated_at: string;
  device_count: number;
  mode: 'free' | 'guided' | 'challenge';
  lab_id: LabId | null;
  passed?: number;
  total?: number;
  completed?: boolean;
}
export interface Project extends Omit<ProjectSummary, 'device_count'> {
  topology: Snapshot;
}
let csrfToken = '';
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const data: unknown =
    res.status === 204 ? null : res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  const object =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  if (!res.ok)
    throw new ApiError(
      typeof object?.message === 'string'
        ? object.message
        : 'Não foi possível concluir a ação (HTTP ' + res.status + ').',
      res.status
    );
  if (typeof object?.csrfToken === 'string') csrfToken = object.csrfToken;
  return data as T;
}
export function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[^a-z0-9_-]/gi, '-') + '.shlab.json';
  a.click();
  URL.revokeObjectURL(url);
}
