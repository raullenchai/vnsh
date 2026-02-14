import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadBlob, downloadBlob } from '../src/lib/api';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uploadBlob', () => {
  it('uploads ciphertext and returns id + expires', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'abc123', expires: '2026-02-15T00:00:00Z' }),
    });

    const data = new ArrayBuffer(16);
    const result = await uploadBlob(data, 24, 'https://test.vnsh.dev');

    expect(result.id).toBe('abc123');
    expect(result.expires).toBe('2026-02-15T00:00:00Z');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.vnsh.dev/api/drop?ttl=24',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('omits ttl param when not provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'xyz', expires: '' }),
    });

    await uploadBlob(new ArrayBuffer(8), undefined, 'https://test.vnsh.dev');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.vnsh.dev/api/drop',
      expect.anything(),
    );
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(uploadBlob(new ArrayBuffer(8), 24, 'https://test.vnsh.dev'))
      .rejects.toThrow('Upload failed: 500 Internal Server Error');
  });
});

describe('downloadBlob', () => {
  it('downloads and returns data + expires header', async () => {
    const buffer = new ArrayBuffer(32);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map([['X-Opaque-Expires', '2026-02-15T12:00:00Z']]),
      arrayBuffer: async () => buffer,
    });

    // Mock headers.get
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name === 'X-Opaque-Expires' ? '2026-02-15T12:00:00Z' : null },
      arrayBuffer: async () => buffer,
    });

    const result = await downloadBlob('abc123', 'https://test.vnsh.dev');
    expect(result.data).toBe(buffer);
    expect(result.expires).toBe('2026-02-15T12:00:00Z');
  });

  it('throws "Blob not found" on 404', async () => {
    mockFetch.mockResolvedValueOnce({ status: 404, ok: false });

    await expect(downloadBlob('missing', 'https://test.vnsh.dev'))
      .rejects.toThrow('Blob not found');
  });

  it('throws "Blob has expired" on 410', async () => {
    mockFetch.mockResolvedValueOnce({ status: 410, ok: false });

    await expect(downloadBlob('expired', 'https://test.vnsh.dev'))
      .rejects.toThrow('Blob has expired');
  });

  it('throws "Payment required" on 402', async () => {
    mockFetch.mockResolvedValueOnce({ status: 402, ok: false });

    await expect(downloadBlob('paywall', 'https://test.vnsh.dev'))
      .rejects.toThrow('Payment required');
  });

  it('throws on other non-ok status', async () => {
    mockFetch.mockResolvedValueOnce({ status: 503, ok: false });

    await expect(downloadBlob('error', 'https://test.vnsh.dev'))
      .rejects.toThrow('Download failed: 503');
  });
});
