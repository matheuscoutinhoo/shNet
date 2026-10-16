import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../apps/web/src/api';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bounded API cooldown recovery', () => {
  it('waits Retry-After before repeating a GET, preserving one deadline and request identity', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ message: 'limited' }, 429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(json({ id: 'project' }));
    vi.stubGlobal('fetch', fetcher);
    const request = api('/projects/id');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await request).toEqual({ id: 'project' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toBe(fetcher.mock.calls[1][1]);
    expect(fetcher.mock.calls[1][1].credentials).toBe('same-origin');
  });
  it('caps retries at two and returns the real error if throttling persists', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockImplementation(async () => json({ message: 'limited' }, 429, { 'Retry-After': '0' }));
    vi.stubGlobal('fetch', fetcher);
    const result = api('/projects').catch((e) => e);
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toMatchObject({ status: 429, message: 'limited' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not repeat POST, PUT, PATCH or DELETE after a 429', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () => json({ message: 'limited' }, 429, { 'Retry-After': '1' }));
    vi.stubGlobal('fetch', fetcher);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      await expect(api('/projects', { method, body: { name: 'one action' } })).rejects.toMatchObject({
        status: 429,
      });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('leaves missing, malformed and long cooldowns as explicit errors', async () => {
    const values = [undefined, '-1', 'NaN', '1e3', '4', '999999999999999999999999999'];
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const value of values) {
      fetcher.mockResolvedValueOnce(
        json({ message: 'limited' }, 429, value === undefined ? {} : { 'Retry-After': value })
      );
      await expect(api('/projects')).rejects.toMatchObject({ status: 429 });
    }
    expect(fetcher).toHaveBeenCalledTimes(values.length);
  });
  it('honors the HTTP-date form of Retry-After', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'Retry-After': 'Fri, 16 Oct 2026 12:00:02 GMT' }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const request = api('/projects');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await request).toEqual({ ok: true });
  });
  it('cancels a pending cooldown when the shared deadline expires', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 429, { 'Retry-After': '3' }));
    vi.stubGlobal('fetch', fetcher);
    const result = api('/projects').catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    const error = await result;
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.status).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry other HTTP failures and still rejects incomplete JSON responses', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ message: 'expired' }, 401))
      .mockResolvedValueOnce(new Response('{', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api('/projects')).rejects.toMatchObject({ status: 401 });
    await expect(api('/projects')).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves CSRF handling and non-JSON validation after a successful retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(json({ csrfToken: 'test-csrf' }))
      .mockResolvedValueOnce(new Response('html'));
    vi.stubGlobal('fetch', fetcher);
    const request = api('/auth/me');
    await vi.advanceTimersByTimeAsync(100);
    await request;
    await expect(api('/projects')).rejects.toMatchObject({ status: 502 });
    expect(fetcher.mock.calls[2][1].headers['X-CSRF-Token']).toBe('test-csrf');
  });
});
