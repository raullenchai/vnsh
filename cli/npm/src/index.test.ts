import { afterEach, describe, expect, it, vi } from 'vitest';
import { read, readString, share } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('programmatic API', () => {
  it('shares and reads the same bytes through the public API', async () => {
    let encrypted: Uint8Array | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        encrypted = new Uint8Array(init.body as Uint8Array);
        return Response.json({ id: 'AbCdEf123456', expires: '2026-08-14T00:00:00.000Z' }, { status: 201 });
      }
      return new Response(encrypted, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = await share('portable context', { ttl: 2 });
    expect(url).toContain('/v/AbCdEf123456#');
    expect(fetchMock.mock.calls[0][0]).toBe('https://vnsh.dev/api/drop?ttl=2');
    expect(await readString(url)).toBe('portable context');
  });

  it.each([
    [404, 'Blob not found'],
    [410, 'Blob has expired'],
    [500, 'Failed to fetch blob'],
  ])('turns HTTP %i reads into actionable errors', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    const url = 'https://vnsh.dev/v/AbCdEf123456#k=' + '00'.repeat(32) + '&iv=' + '00'.repeat(16);
    await expect(read(url)).rejects.toThrow(message);
  });

  it('reports failed uploads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(share('nope')).rejects.toThrow('Upload failed: HTTP 503');
  });
});
