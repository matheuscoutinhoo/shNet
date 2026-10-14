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
  user_id?: string;
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
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ApiError(
      'Não foi possível contatar o servidor em até 30 segundos. Seu trabalho pode ser recuperado pelo rascunho local.',
      0
    );
  }
  let data: unknown = null;
  try {
    if (res.status !== 204 && res.headers.get('content-type')?.includes('json')) data = await res.json();
  } catch {
    throw new ApiError(
      'O servidor retornou uma resposta incompleta. Tente novamente; suas alterações continuam locais.',
      res.ok ? 502 : res.status
    );
  }
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
  if (res.status !== 204 && !res.headers.get('content-type')?.includes('json'))
    throw new ApiError('O servidor retornou um formato inesperado. Tente novamente.', 502);
  if (typeof object?.csrfToken === 'string') csrfToken = object.csrfToken;
  return data as T;
}
export function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[^a-z0-9_-]/gi, '-') + '.shlab.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
