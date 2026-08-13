import { canArchiveVersion, canCreateDocument, quotaResponse } from './account-usage';
import { currentUser, type AccountEnv, type AccountUser } from './accounts';
import { isTooLarge, readCapped } from './workspace-storage';
import { ownedWorkspace } from './workspaces';

const MAX_ARTIFACT_SIZE = 25 * 1024 * 1024;
const ARTIFACT_PREFIX = 'a/';
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

type ArtifactInput = {
  title?: unknown;
  summary?: unknown;
  artifactType?: unknown;
  content?: unknown;
  contentType?: unknown;
  changeSummary?: unknown;
  sourceRef?: unknown;
  evidence?: unknown;
  harness?: unknown;
  model?: unknown;
  workspaceId?: unknown;
};

type ArtifactRow = {
  id: string;
  owner_id: string;
  title: string;
  summary: string | null;
  artifact_type: string;
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
  workspace_id: string | null;
  workspace_name?: string;
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
    summary: row.summary,
    artifactType: row.artifact_type,
    contentType: row.content_type,
    status: row.status,
    visibility: row.visibility,
    version: row.current_version,
    size: row.current_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspace: { id: row.workspace_id, name: row.workspace_name || 'Personal' },
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

function shortString(value: unknown, field: string, limit: number): string | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > limit) {
    return jsonError(`INVALID_${field.toUpperCase()}`, `${field} must be a string of at most ${limit} characters`, 400);
  }
  return value.trim();
}

function validated(input: ArtifactInput, creating: boolean):
  | { title?: string; summary?: string; artifactType?: string; content: string; contentType?: string; changeSummary?: string; sourceRef?: string; evidence: string[]; harness?: string; model?: string }
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
  const summary = shortString(input.summary, 'summary', 500);
  if (summary instanceof Response) return summary;
  const sourceRef = shortString(input.sourceRef, 'source_ref', 1000);
  if (sourceRef instanceof Response) return sourceRef;
  const harness = shortString(input.harness, 'harness', 120);
  if (harness instanceof Response) return harness;
  const model = shortString(input.model, 'model', 120);
  if (model instanceof Response) return model;
  const artifactType = input.artifactType === undefined ? undefined : String(input.artifactType);
  if (artifactType !== undefined && !['document', 'report', 'code', 'app', 'handoff'].includes(artifactType)) {
    return jsonError('INVALID_ARTIFACT_TYPE', 'artifactType must be document, report, code, app, or handoff', 400);
  }
  if (input.evidence !== undefined &&
      (!Array.isArray(input.evidence) || input.evidence.length > 20 || input.evidence.some((item) => typeof item !== 'string' || item.length > 1000))) {
    return jsonError('INVALID_EVIDENCE', 'evidence must be an array of at most 20 strings, each at most 1000 characters', 400);
  }
  return {
    ...(typeof input.title === 'string' ? { title: input.title.trim() } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(artifactType !== undefined ? { artifactType } : {}),
    content: input.content,
    ...(typeof input.contentType === 'string' ? { contentType: input.contentType } : {}),
    ...(typeof input.changeSummary === 'string' ? { changeSummary: input.changeSummary.trim() } : {}),
    ...(sourceRef !== undefined ? { sourceRef } : {}),
    evidence: (input.evidence as string[] | undefined) || [],
    ...(harness !== undefined ? { harness } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function authorKind(user: AccountUser): 'human' | 'agent' {
  return user.sessionKind === 'browser' ? 'human' : 'agent';
}

async function ownedArtifact(env: AccountEnv, id: string, userId: string): Promise<ArtifactRow | null> {
  return env.ACCOUNTS.prepare(`SELECT a.*,w.name AS workspace_name FROM artifacts a
    LEFT JOIN workspaces w ON w.id=a.workspace_id WHERE a.id=? AND a.owner_id=?`)
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
  if (parsed.workspaceId !== undefined && typeof parsed.workspaceId !== 'string') {
    return jsonError('INVALID_WORKSPACE', 'workspaceId must be a string', 400);
  }
  const workspace = await ownedWorkspace(env, user.id, typeof parsed.workspaceId === 'string' ? parsed.workspaceId : null);
  if (!workspace) return jsonError('WORKSPACE_NOT_FOUND', 'Workspace not found', 404);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const objectKey = `${ARTIFACT_PREFIX}${id}/versions/1-${crypto.randomUUID()}`;
  await env.VNSH_STORE.put(objectKey, bytes, { httpMetadata: { contentType: input.contentType || 'text/html; charset=utf-8' } });
  try {
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare('INSERT INTO artifacts(id,owner_id,title,summary,artifact_type,content_type,status,visibility,current_version,current_object_key,current_size,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, user.id, input.title, input.summary || null, input.artifactType || 'document', input.contentType || 'text/html; charset=utf-8', 'draft', 'private', 1, objectKey, bytes.byteLength, workspace.id, now, now),
      env.ACCOUNTS.prepare('INSERT INTO artifact_versions(artifact_id,version,object_key,size,author_principal_id,author_kind,change_summary,source_ref,evidence_json,client_harness,client_model,content_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, 1, objectKey, bytes.byteLength, user.sessionId, authorKind(user), input.changeSummary || 'Initial version', input.sourceRef || null, JSON.stringify(input.evidence), input.harness || null, input.model || null, input.contentType || 'text/html; charset=utf-8', now),
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

async function listArtifacts(request: Request, env: AccountEnv, user: AccountUser): Promise<Response> {
  const workspaceId = new URL(request.url).searchParams.get('workspace');
  if (workspaceId && !(await ownedWorkspace(env, user.id, workspaceId))) return jsonError('WORKSPACE_NOT_FOUND', 'Workspace not found', 404);
  const result = await env.ACCOUNTS.prepare(`SELECT a.*,w.name AS workspace_name FROM artifacts a
    LEFT JOIN workspaces w ON w.id=a.workspace_id WHERE a.owner_id=? AND (? IS NULL OR a.workspace_id=?) ORDER BY a.updated_at DESC LIMIT 100`)
    .bind(user.id, workspaceId, workspaceId).all<ArtifactRow>();
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

const artifactHtmlHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const renderedContentHeaders = (contentType: string) => ({
  'Content-Type': contentType,
  'Cache-Control': 'private, no-store',
  // CSP sandbox gives this response a unique opaque origin even though its URL
  // is on account.vnsh.dev. User HTML cannot see account cookies or storage,
  // navigate the parent, submit forms, run scripts, or contact the network.
  'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, nosnippet',
});

async function artifactContent(id: string, request: Request, env: AccountEnv, user: AccountUser): Promise<Response> {
  const artifact = await ownedArtifact(env, id, user.id);
  if (!artifact) return jsonError('NOT_FOUND', 'Artifact not found', 404);
  const requested = new URL(request.url).searchParams.get('version');
  let objectKey = artifact.current_object_key;
  let contentType = artifact.content_type;
  let version = artifact.current_version;
  if (requested !== null) {
    if (!/^\d+$/.test(requested)) return jsonError('INVALID_VERSION', 'version must be a positive integer', 400);
    version = Number(requested);
    const historical = await env.ACCOUNTS.prepare('SELECT object_key,content_type FROM artifact_versions WHERE artifact_id=? AND version=?')
      .bind(id, version).first<{ object_key: string; content_type: string | null }>();
    if (!historical) return jsonError('NOT_FOUND', 'Artifact version not found', 404);
    objectKey = historical.object_key;
    contentType = historical.content_type || contentType;
  }
  const object = await env.VNSH_STORE.get(objectKey);
  if (!object) return jsonError('STORAGE_ERROR', 'Artifact content is temporarily unavailable', 503);
  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: { ...renderedContentHeaders(contentType), ETag: `"${version}"` },
  });
}

async function artifactPage(id: string, request: Request, env: AccountEnv, user: AccountUser): Promise<Response> {
  if (user.sessionKind !== 'browser') return jsonError('HUMAN_REQUIRED', 'Open the Artifact in an authenticated browser session', 403);
  const artifact = await ownedArtifact(env, id, user.id);
  if (!artifact) return new Response('<h1>Artifact not found</h1>', { status: 404, headers: artifactHtmlHeaders });
  const versions = await env.ACCOUNTS.prepare(`SELECT version,author_kind,change_summary,created_at FROM artifact_versions
    WHERE artifact_id=? ORDER BY version DESC LIMIT 100`).bind(id).all<{ version: number; author_kind: string; change_summary: string | null; created_at: string }>();
  const selectedRaw = new URL(request.url).searchParams.get('version');
  const selected = selectedRaw && /^\d+$/.test(selectedRaw) && versions.results.some((v) => v.version === Number(selectedRaw))
    ? Number(selectedRaw) : artifact.current_version;
  const history = versions.results.map((version) =>
    `<a class="version ${version.version === selected ? 'selected' : ''}" href="/artifacts/${esc(id)}?version=${version.version}"><b>v${version.version}</b><span>${esc(version.change_summary || 'No change summary')}</span><small>${esc(version.author_kind)} · ${esc(new Date(version.created_at).toLocaleString('en-US', { timeZone: 'UTC' }))} UTC</small></a>`).join('');
  const statusClass = artifact.status === 'approved' ? 'approved' : artifact.status === 'in_review' ? 'review' : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(artifact.title)} · vnsh</title><style>
  :root{--bg:#edf1ef;--panel:#fff;--ink:#14201c;--muted:#6d7a74;--line:#dce4e0;--green:#10b981;--dark:#0b1712}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--bg);font:14px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.bar{height:68px;padding:0 22px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px}.back{color:var(--muted);text-decoration:none;font-size:20px}.title{min-width:0}.title h1{font-size:16px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.title p{margin:3px 0 0;color:var(--muted);font-size:11px}.actions{margin-left:auto;display:flex;align-items:center;gap:8px}.pill{padding:5px 8px;border-radius:99px;background:#eef2f0;color:#506059;font:700 10px ui-monospace,monospace}.pill.review{background:#fff4dc;color:#9a5b00}.pill.approved{background:#e4f8ef;color:#087a58}button{border:1px solid var(--line);border-radius:8px;background:#fff;color:#b42318;padding:8px 10px;font-weight:650;cursor:pointer}.layout{height:calc(100vh - 68px);display:grid;grid-template-columns:1fr 280px;gap:14px;padding:14px}.frame{width:100%;height:100%;border:1px solid #cad5cf;border-radius:12px;background:#fff;box-shadow:0 10px 35px rgba(16,35,26,.08)}aside{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;overflow:auto}aside h2{font-size:13px;margin:0 0 12px}.meta{color:var(--muted);font-size:12px;padding-bottom:15px;border-bottom:1px solid var(--line);margin-bottom:15px}.version{display:block;text-decoration:none;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:10px;margin:8px 0}.version.selected{border-color:var(--green);background:#ecfaf4}.version b,.version span,.version small{display:block}.version span{font-size:11px;margin:3px 0}.version small{color:var(--muted);font-size:9px}details{margin-top:22px}summary{cursor:pointer;color:#9b2c23;font-size:12px}@media(max-width:760px){.layout{display:block;height:auto}.frame{height:70vh}aside{margin-top:12px}.title p{display:none}.bar{padding:0 12px}.actions .pill{display:none}}
  </style></head><body><header class="bar"><a class="back" href="/">←</a><div class="title"><h1>${esc(artifact.title)}</h1><p>${esc(artifact.artifact_type)} · v${selected}${selected !== artifact.current_version ? ` of ${artifact.current_version}` : ''} · ${esc(artifact.summary || 'No summary yet')}</p></div><div class="actions"><span class="pill ${statusClass}">${esc(artifact.status.replace('_', ' '))}</span></div></header><main class="layout"><iframe class="frame" title="Artifact content" sandbox src="/artifacts/${esc(id)}/content?version=${selected}"></iframe><aside><h2>Version history</h2><div class="meta">Authenticated account content · rendered in a network-disabled opaque sandbox.</div>${history}<details><summary>Delete Artifact…</summary><form method="post" action="/artifacts/${esc(id)}/delete"><button>Delete permanently</button></form></details></aside></main></body></html>`;
  return new Response(request.method === 'HEAD' ? null : html, { headers: artifactHtmlHeaders });
}

async function listVersions(id: string, env: AccountEnv, user: AccountUser): Promise<Response> {
  const artifact = await ownedArtifact(env, id, user.id);
  if (!artifact) return jsonError('NOT_FOUND', 'Artifact not found', 404);
  const result = await env.ACCOUNTS.prepare(`SELECT version,size,author_principal_id,author_kind,change_summary,source_ref,evidence_json,client_harness,client_model,created_at
    FROM artifact_versions WHERE artifact_id=? ORDER BY version DESC LIMIT 100`).bind(id).all<{
      version: number; size: number; author_principal_id: string; author_kind: string; change_summary: string | null;
      source_ref: string | null; evidence_json: string; client_harness: string | null; client_model: string | null; created_at: string;
    }>();
  return Response.json({
    artifact: present(artifact, user),
    versions: result.results.map((version) => ({
      version: version.version,
      size: version.size,
      author: { kind: version.author_kind, principalId: version.author_principal_id },
      changeSummary: version.change_summary,
      sourceRef: version.source_ref,
      evidence: JSON.parse(version.evidence_json || '[]'),
      clientAnnotations: { harness: version.client_harness, model: version.client_model, verified: false },
      createdAt: version.created_at,
    })),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
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
      env.ACCOUNTS.prepare(`INSERT INTO artifact_versions(artifact_id,version,object_key,size,author_principal_id,author_kind,change_summary,source_ref,evidence_json,client_harness,client_model,content_type,created_at)
        SELECT id,?,?,?,?,?,?,?,?,?,?,?,? FROM artifacts WHERE id=? AND owner_id=? AND current_version=?`)
        .bind(next, objectKey, bytes.byteLength, user.sessionId, authorKind(user), input.changeSummary || null, input.sourceRef || null, JSON.stringify(input.evidence), input.harness || null, input.model || null, input.contentType || current.content_type, now, id, user.id, expected),
      env.ACCOUNTS.prepare(`UPDATE artifacts SET title=COALESCE(?,title),summary=COALESCE(?,summary),artifact_type=COALESCE(?,artifact_type),content_type=COALESCE(?,content_type),current_version=?,current_object_key=?,current_size=?,history_size=history_size+?,history_versions=history_versions+1,updated_at=?
        WHERE id=? AND owner_id=? AND current_version=?`)
        .bind(input.title || null, input.summary ?? null, input.artifactType || null, input.contentType || null, next, objectKey, bytes.byteLength, current.current_size, now, id, user.id, expected),
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
  const versions = url.pathname.match(/^\/api\/artifacts\/([0-9a-f-]{36})\/versions$/i);
  const page = url.pathname.match(/^\/artifacts\/([0-9a-f-]{36})$/i);
  const content = url.pathname.match(/^\/artifacts\/([0-9a-f-]{36})\/content$/i);
  const formDelete = url.pathname.match(/^\/artifacts\/([0-9a-f-]{36})\/delete$/i);
  if (!collection && !match && !versions && !page && !content && !formDelete) return null;
  const user = await currentUser(request, env);
  if (!user) return jsonError('UNAUTHORIZED', 'Sign in or connect an Agent token', 401);
  if (collection && request.method === 'GET') return listArtifacts(request, env, user);
  if (collection && request.method === 'POST') return createArtifact(request, env, user);
  if (versions && request.method === 'GET') return listVersions(versions[1], env, user);
  if (versions) return jsonError('METHOD_NOT_ALLOWED', 'Use GET to list Artifact versions', 405);
  if (page && (request.method === 'GET' || request.method === 'HEAD')) return artifactPage(page[1], request, env, user);
  if (content && (request.method === 'GET' || request.method === 'HEAD')) return artifactContent(content[1], request, env, user);
  if (formDelete && request.method === 'POST') {
    const deleted = await deleteArtifact(formDelete[1], env, user);
    if (deleted.status !== 204) return deleted;
    return new Response(null, { status: 303, headers: { Location: '/' } });
  }
  if (match && request.method === 'GET') return getArtifact(match[1], env, user);
  if (match && request.method === 'PUT') return updateArtifact(match[1], request, env, user);
  if (match && request.method === 'DELETE') return deleteArtifact(match[1], env, user);
  return jsonError('METHOD_NOT_ALLOWED', collection ? 'Use GET or POST' : 'Use GET, PUT or DELETE', 405);
}
