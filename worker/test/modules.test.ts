import { describe, expect, it, vi } from 'vitest';
import { getClientAgent, getClientRef, trackEvent } from '../src/analytics';
import { isTooLarge, readCapped, workspaceHistoryKey } from '../src/workspace-storage';

describe('extracted Worker modules', () => {
  it('constrains analytics labels and marks initialized projects anonymously', () => {
    const writeDataPoint = vi.fn();
    const request = new Request('https://vnsh.dev/api/workspace', {
      headers: {
        'X-Vnsh-Agent': ' Cursor Agent / Personal Project! ',
        'X-Vnsh-Client': 'cli-npm/2.7.0',
        'X-Vnsh-Project': '1',
      },
    });
    expect(getClientAgent(request)).toBe('cursor-agent-personal-project');
    expect(getClientRef('unexpected')).toBe('direct');
    trackEvent({ VNSH_ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset },
      'workspace_create', request);
    expect(writeDataPoint.mock.calls[0][0].blobs[8]).toBe('initialized');
  });

  it('keeps analytics failures off the request path', () => {
    const dataset = { writeDataPoint: () => { throw new Error('quota'); } } as unknown as AnalyticsEngineDataset;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => trackEvent({ VNSH_ANALYTICS: dataset }, 'read', new Request('https://vnsh.dev')))
      .not.toThrow();
  });

  it('caps unknown-length streams and preserves deterministic history keys', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    await expect(readCapped(stream, 2)).rejects.toSatisfy(isTooLarge);
    expect(workspaceHistoryKey('AbCdEf123456', 7)).toBe('wh/AbCdEf123456/0000000007');
  });
});
