export const WORKSPACE_PREFIX = 'w/';
export const WORKSPACE_HISTORY_PREFIX = 'wh/';
export const WORKSPACE_HISTORY_LIMIT = 20;

export function workspaceHistoryKey(id: string, version: number): string {
  return `${WORKSPACE_HISTORY_PREFIX}${id}/${String(version).padStart(10, '0')}`;
}

export async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) throw new Error('PAYLOAD_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function isTooLarge(err: unknown): boolean {
  return err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE';
}

export async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function archiveWorkspaceVersion(
  id: string,
  version: number,
  head: R2Object,
  bucket: R2Bucket,
  isPublic: boolean,
): Promise<boolean> {
  const current = await bucket.get(WORKSPACE_PREFIX + id, {
    onlyIf: { etagMatches: head.etag },
  });
  if (!current || !('body' in current)) return false;
  const md = head.customMetadata || {};
  await bucket.put(workspaceHistoryKey(id, version), current.body, {
    customMetadata: {
      workspaceId: id,
      version: String(version),
      archivedAt: new Date().toISOString(),
      ...(md.createdAt ? { createdAt: md.createdAt } : {}),
      ...(md.expiresAt ? { expiresAt: md.expiresAt } : {}),
      ...(md.permanent === '1' ? { permanent: '1', ownerId: md.ownerId || md.ownerid || '' } : {}),
      ...(isPublic ? { public: '1' } : {}),
    },
  });
  return true;
}

export async function pruneWorkspaceHistory(
  id: string,
  currentVersion: number,
  bucket: R2Bucket,
): Promise<R2Object[]> {
  const oldestKept = Math.max(1, currentVersion - WORKSPACE_HISTORY_LIMIT + 1);
  const page = await bucket.list({ prefix: `${WORKSPACE_HISTORY_PREFIX}${id}/`, limit: 1000 });
  const stale = page.objects.filter((object) => {
    const version = Number(object.key.slice(object.key.lastIndexOf('/') + 1));
    return Number.isInteger(version) && version < oldestKept;
  });
  if (stale.length) await bucket.delete(stale.map((object) => object.key));
  return stale;
}
