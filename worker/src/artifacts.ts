import { canArchiveVersion, canCreateDocument, quotaResponse } from './account-usage';
import { currentUser, type AccountEnv, type AccountUser } from './accounts';
import { isTooLarge, readCapped } from './workspace-storage';

const MAX_ARTIFACT_SIZE = 25 * 1024 * 1024;
const ARTIFACT_PREFIX = 'a/';
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

type ArtifactInput = {
  title?: unknown;
  content?: unknown;
  contentType?: unknown;
  changeSummary?: unknown;
};

type ArtifactRow = {
  id: string;
  owner_id: string;
  title: string;
  content_type: string;
  status: string;
  visibility: string;
  current_version: number;
  current_object_key: string;
  current_size: number;
  history_size: number;
  history_versions: number;
  created_at: string;
  updated_at: string;
};

function jsonError(error: string, message: string, status: number): Response {
  return Response.json({ error, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function capabilities(user: AccountUser): string[] {
  return user.sessionKind === 'browser'
    ? ['read', 'update', 'request_review', 'approve', 'publish', 'manage_access', 'delete']
    : ['read', 'update', 'request_review'];
}

function present(row: ArtifactRow, user: AccountUser) {
  return {
    id: row.id,
    title: row.title,
    contentType: row.content_type,
    status: row.status,
    visibility: row.visibility,
    version: row.current_version,
    size: row.current_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    capabilities: capabilities(user),
  };
}

async function parseInput(request: Request): Promise<ArtifactInput | Response> {
  if (!request.body) return jsonError('EMPTY_BODY', 'A JSON request body is required', 400);
  try {
    const bytes = await readCapped(request.body, MAX_ARTIFACT_SIZE);
    return JSON.parse(dec.decode(bytes)) as ArtifactInput;
  } catch (error) {
    if (isTooLarge(error)) return jsonError('PAYLOAD_TOO_LARGE', 'Maximum Artifact request size is 25MB', 413);
    return jsonError('INVALID_JSON', 'Request body must be valid UTF-8 JSON', 400);
  }
}

function validated(input: ArtifactInput, creating: boolean):
  | { title?: string; content: string; contentType?: string; changeSummary?: string }
  | Response {
  if (creating && (typeof input.title !== 'string' || !input.title.trim())) {
    return jsonError('INVALID_TITLE', 'title is required', 400);
  }
  if (typeof input.title === 'string' && (input.title.trim().length < 1 || input.title.trim().length > 200)) {
    return jsonError('INVALID_TITLE', 'title must be between 1 and 200 characters', 400);
  }
  if (typeof input.content !== 'string') return jsonError('INVALID_CONTENT', 'content must be a string', 400);
  if (input.contentType !== undefined &&
      (typeof input.contentType !== 'string' || input.contentType.length > 120 || !/^[\w.+-]+\/[\w.+-]+(?:;\s*charset=utf-8)?$/i.test(input.contentType))) {
    return jsonError('INVALID_CONTENT_TYPE', 'contentType must be a valid media type', 400);
  }
  if (input.changeSummary !== undefined &&
      (typeof input.changeSummary !== 'string' || input.changeSummary.length > 1000)) {
    return jsonError('INVALID_CHANGE_SUMMARY', 'changeSummary must be at most 1000 characters', 400);
  }
  return {
    ...(typeof input.title === 'string' ? { title: input.title.trim() } : {}),
    content: input.content,
    ...(typeof input.contentType === 'string' ? { contentType: input.contentType } : {}),
    ...(typeof input.changeSummary === 'string' ? { changeSummary: input.changeSummary.trim() } : {}),
  };
}

function authorKind(user: AccountUser): 'human' | 'agent' {
  return user.sessionKind === 'browser' ? 'human' : 'agent';
}

async function ownedArtifact(env: AccountEnv, id: string, userId: string): Promise<ArtifactRow | null> {
  return env.ACCOUNTS.prepare('SELECT * FROM artifacts WHERE id=? AND owner_id=?')
    .bind(id, userId).first<ArtifactRow>();
}

async function createArtifact(request: Request, env: AccountEnv, user: AccountUser): Promise<Response> {
  const parsed = await parseInput(request);
  if (parsed instanceof Response) return parsed;
  const input = validated(parsed, true);
  if (input instanceof Response) return input;
  const bytes = enc.encode(input.content);
  if (bytes.byteLength > MAX_ARTIFACT_SIZE) return jsonError('PAYLOAD_TOO_LARGE', 'Maximum Artifact content size is 25MB', 413);
  const quota = await canCreateDocument(env, user, bytes.byteLength);
  if (!quota.allowed) return quotaResponse(quota.usage);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const objectKey = `${ARTIFACT_PREFIX}${id}/versions/1-${crypto.randomUUID()}`;
  await env.VNSH_STORE.put(objectKey, bytes, { httpMetadata: { contentType: input.contentType || 'text/html; charset=utf-8' } });
  try {
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare('INSERT INTO artifacts(id,owner_id,title,content_type,status,visibility,current_version,current_object_key,current_size,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, user.id, input.title, input.contentType || 'text/html; charset=utf-8', 'draft', 'private', 1, objectKey, bytes.byteLength, now, now),
      env.ACCOUNTS.prepare('INSERT INTO artifact_versions(artifact_id,version,object_key,size,author_principal_id,author_kind,change_summary,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind(id, 1, objectKey, bytes.byteLength, user.sessionId, authorKind(user), input.changeSummary || 'Initial version', now),
      env.ACCOUNTS.prepare('INSERT INTO artifact_access(artifact_id,principal_type,principal_id,role,created_at) VALUES(?,?,?,?,?)')
        .bind(id, 'user', user.id, 'owner', now),
    ]);
  } catch (error) {
    await env.VNSH_STORE.delete(objectKey);
    console.error('Failed to index account Artifact:', error);
    return jsonError('STORAGE_ERROR', 'Failed to create Artifact', 500);
  }
  const row = await ownedArtifact(env, id, user.id);
  return Response.json({ artifact: present(row!, user) }, { status: 201, headers: { ETag: '"1"', 'Cache-Control': 'no-store' } });
}

async function listArtifacts(env: AccountEnv, user: AccountUser): Promise<Response> {
  const result = await env.ACCOUNTS.prepare('SELECT * FROM artifacts WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100')
    .bind(user.id).all<ArtifactRow>();
  return Response.json({ artifacts: result.results.map((row) => present(row, user)) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function getArtifact(id: string, env: AccountEnv, user: AccountUser): Promise<Response> {
  const row = await ownedArtifact(env, id, user.id);
  if (!row) return jsonError('NOT_FOUND', 'Artifact not found', 404);
  const object = await env.VNSH_STORE.get(row.current_object_key);
  if (!object) return jsonError('STORAGE_ERROR', 'Artifact content is temporarily unavailable', 503);
  const content = await object.text();
  return Response.json({ artifact: present(row, user), content }, { headers: { ETag: `"${row.current_version}"`, 'Cache-Control': 'private, no-store' } });
}

function claimedVersion(request: Request): number | Response {
  const value = request.headers.get('If-Match');
  if (!value) return jsonError('PRECONDITION_REQUIRED', 'If-Match with the current Artifact version is required', 428);
  const normalized = value.trim().replace(/^W\//i, '').replace(/"/g, '');
  if (!/^\d+$/.test(normalized)) return jsonError('INVALID_IF_MATCH', 'If-Match must contain a numeric Artifact version', 400);
  return Number(normalized);
}

async function updateArtifact(id: string, request: Request, env: AccountEnv, user: AccountUser): Promise<Response> {
  const expected = claimedVersion(request);
  if (expected instanceof Response) return expected;
  const current = await ownedArtifact(env, id, user.id);
  if (!current) return jsonError('NOT_FOUND', 'Artifact not found', 404);
  if (current.current_version !== expected) return jsonError('VERSION_CONFLICT', `Artifact is at version ${current.current_version}; re-read, merge and retry`, 412);
  const parsed = await parseInput(request);
  if (parsed instanceof Response) return parsed;
  const input = validated(parsed, false);
  if (input instanceof Response) return input;
  const bytes = enc.encode(input.content);
  if (bytes.byteLength > MAX_ARTIFACT_SIZE) return jsonError('PAYLOAD_TOO_LARGE', 'Maximum Artifact content size is 25MB', 413);
  const quota = await canArchiveVersion(env, user.id, bytes.byteLength);
  if (!quota.allowed) return quotaResponse(quota.usage);

  const next = expected + 1;
  const now = new Date().toISOString();
  const objectKey = `${ARTIFACT_PREFIX}${id}/versions/${next}-${crypto.randomUUID()}`;
  await env.VNSH_STORE.put(objectKey, bytes, { httpMetadata: { contentType: input.contentType || current.content_type } });
  try {
    const results = await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare(`INSERT INTO artifact_versions(artifact_id,version,object_key,size,author_principal_id,author_kind,change_summary,created_at)
        SELECT id,?,?,?,?,?,?,? FROM artifacts WHERE id=? AND owner_id=? AND current_version=?`)
        .bind(next, objectKey, bytes.byteLength, user.sessionId, authorKind(user), input.changeSummary || null, now, id, user.id, expected),
      env.ACCOUNTS.prepare(`UPDATE artifacts SET title=COALESCE(?,title),content_type=COALESCE(?,content_type),current_version=?,current_object_key=?,current_size=?,history_size=history_size+?,history_versions=history_versions+1,updated_at=?
        WHERE id=? AND owner_id=? AND current_version=?`)
        .bind(input.title || null, input.contentType || null, next, objectKey, bytes.byteLength, current.current_size, now, id, user.id, expected),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
      await env.VNSH_STORE.delete(objectKey);
      return jsonError('VERSION_CONFLICT', 'Artifact changed during this update; re-read, merge and retry', 412);
    }
  } catch (error) {
    await env.VNSH_STORE.delete(objectKey);
    console.error('Failed to advance account Artifact:', error);
    return jsonError('STORAGE_ERROR', 'Failed to update Artifact', 500);
  }
  const row = await ownedArtifact(env, id, user.id);
  return Response.json({ artifact: present(row!, user) }, { headers: { ETag: `"${next}"`, 'Cache-Control': 'no-store' } });
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function deleteArtifact(id: string, env: AccountEnv, user: AccountUser): Promise<Response> {
  if (user.sessionKind !== 'browser') return jsonError('HUMAN_REQUIRED', 'Only a signed-in human can delete an Artifact', 403);
  const row = await ownedArtifact(env, id, user.id);
  if (!row) return jsonError('NOT_FOUND', 'Artifact not found', 404);
  await deletePrefix(env.VNSH_STORE, `${ARTIFACT_PREFIX}${id}/`);
  await env.ACCOUNTS.prepare('DELETE FROM artifacts WHERE id=? AND owner_id=?').bind(id, user.id).run();
  return new Response(null, { status: 204 });
}

export async function handleArtifacts(request: Request, env: AccountEnv, url: URL): Promise<Response | null> {
  const collection = url.pathname === '/api/artifacts';
  const match = url.pathname.match(/^\/api\/artifacts\/([0-9a-f-]{36})$/i);
  if (!collection && !match) return null;
  const user = await currentUser(request, env);
  if (!user) return jsonError('UNAUTHORIZED', 'Sign in or connect an Agent token', 401);
  if (collection && request.method === 'GET') return listArtifacts(env, user);
  if (collection && request.method === 'POST') return createArtifact(request, env, user);
  if (match && request.method === 'GET') return getArtifact(match[1], env, user);
  if (match && request.method === 'PUT') return updateArtifact(match[1], request, env, user);
  if (match && request.method === 'DELETE') return deleteArtifact(match[1], env, user);
  return jsonError('METHOD_NOT_ALLOWED', collection ? 'Use GET or POST' : 'Use GET, PUT or DELETE', 405);
}
