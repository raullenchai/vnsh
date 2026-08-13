import type { AccountEnv, AccountUser } from './accounts';

export const FREE_DOCUMENT_LIMIT = 100;
export const FREE_STORAGE_LIMIT = 1024 * 1024 * 1024;

export interface AccountUsage {
  documents: number;
  currentBytes: number;
  historyBytes: number;
  totalBytes: number;
  documentLimit: number;
  storageLimit: number;
}

export async function accountUsage(env: AccountEnv, userId: string): Promise<AccountUsage> {
  const row = await env.ACCOUNTS.prepare(
    `SELECT COUNT(*) AS documents,
            COALESCE(SUM(size), 0) AS currentBytes,
            COALESCE(SUM(history_size), 0) AS historyBytes
       FROM documents WHERE user_id=?`,
  ).bind(userId).first<{ documents: number; currentBytes: number; historyBytes: number }>();
  const currentBytes = Number(row?.currentBytes || 0);
  const historyBytes = Number(row?.historyBytes || 0);
  return {
    documents: Number(row?.documents || 0),
    currentBytes,
    historyBytes,
    totalBytes: currentBytes + historyBytes,
    documentLimit: FREE_DOCUMENT_LIMIT,
    storageLimit: FREE_STORAGE_LIMIT,
  };
}

export async function canCreateDocument(
  env: AccountEnv,
  user: AccountUser,
  bytes: number,
): Promise<{ allowed: boolean; usage: AccountUsage }> {
  const usage = await accountUsage(env, user.id);
  return {
    allowed:
      usage.documents < usage.documentLimit &&
      usage.totalBytes + bytes <= usage.storageLimit,
    usage,
  };
}

export async function canArchiveVersion(
  env: AccountEnv,
  ownerId: string,
  bytes: number,
): Promise<{ allowed: boolean; usage: AccountUsage }> {
  const usage = await accountUsage(env, ownerId);
  return { allowed: usage.totalBytes + bytes <= usage.storageLimit, usage };
}

export function quotaResponse(usage: AccountUsage): Response {
  return Response.json(
    {
      error: 'ACCOUNT_QUOTA_EXCEEDED',
      message: 'Free preview storage is full. Delete a saved document or an older version and retry.',
      usage,
    },
    { status: 403, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } },
  );
}
