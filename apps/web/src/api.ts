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
function retryDelay(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : /^[A-Za-z]{3}, /.test(value)
      ? Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1000))
      : NaN;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 3 ? Math.max(100, seconds * 1000) : undefined;
}
function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    const signal = AbortSignal.timeout(30000);
    const request: RequestInit = {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal,
    };
    res = await fetch('/api' + path, request);
    // Only safe reads may be repeated. One shared deadline bounds fetches and
    // cooldowns; long/absent/invalid Retry-After remains an explicit error.
    for (let retry = 0; retry < 2 && request.method === 'GET' && res.status === 429; retry++) {
      const delay = retryDelay(res);
      if (delay === undefined) break;
      await res.body?.cancel();
      await waitForRetry(delay, signal);
      res = await fetch('/api' + path, request);
    }
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
