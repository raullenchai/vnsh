import { currentUser, type AccountEnv, type AccountUser } from './accounts';
import { isTooLarge, readCapped } from './workspace-storage';

export type WorkspaceRow = {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  is_default: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function error(code: string, message: string, status: number): Response {
  return Response.json({ error: code, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function formError(message: string): Response {
  return new Response(null, { status: 303, headers: { Location: `/?workspace_error=${encodeURIComponent(message)}` } });
}

function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workspace';
}

export async function ensurePersonalWorkspace(env: AccountEnv, userId: string): Promise<WorkspaceRow> {
  const existing = await env.ACCOUNTS.prepare('SELECT * FROM workspaces WHERE owner_id=? AND is_default=1')
    .bind(userId).first<WorkspaceRow>();
  if (existing) return existing;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.ACCOUNTS.prepare(`INSERT INTO workspaces(id,owner_id,name,slug,is_default,created_at,updated_at)
    VALUES(?,?,?,?,1,?,?) ON CONFLICT(owner_id) WHERE is_default=1 DO NOTHING`)
    .bind(id, userId, 'Personal', 'personal', now, now).run();
  return (await env.ACCOUNTS.prepare('SELECT * FROM workspaces WHERE owner_id=? AND is_default=1')
    .bind(userId).first<WorkspaceRow>())!;
}

export async function ownedWorkspace(env: AccountEnv, userId: string, id?: string | null): Promise<WorkspaceRow | null> {
  if (!id) return ensurePersonalWorkspace(env, userId);
  return env.ACCOUNTS.prepare('SELECT * FROM workspaces WHERE id=? AND owner_id=? AND archived_at IS NULL')
    .bind(id, userId).first<WorkspaceRow>();
}

function present(row: WorkspaceRow, artifactCount = 0) {
  return { id: row.id, name: row.name, slug: row.slug, isDefault: Boolean(row.is_default), artifactCount, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function list(env: AccountEnv, user: AccountUser): Promise<Response> {
  await ensurePersonalWorkspace(env, user.id);
  const rows = await env.ACCOUNTS.prepare(`SELECT w.*,COUNT(a.id) AS artifact_count FROM workspaces w
    LEFT JOIN artifacts a ON a.workspace_id=w.id WHERE w.owner_id=? AND w.archived_at IS NULL
    GROUP BY w.id ORDER BY w.is_default DESC,w.updated_at DESC`).bind(user.id).all<WorkspaceRow & { artifact_count: number }>();
  return Response.json({ workspaces: rows.results.map((row) => present(row, Number(row.artifact_count))) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function create(request: Request, env: AccountEnv, user: AccountUser): Promise<Response> {
  if (user.sessionKind !== 'browser') return error('HUMAN_REQUIRED', 'Only a signed-in human can create a Workspace', 403);
  let name = '';
  try {
    if (!request.body) return error('EMPTY_BODY', 'A Workspace name is required', 400);
    const raw = new TextDecoder().decode(await readCapped(request.body, 4096));
    if ((request.headers.get('Content-Type') || '').includes('application/json')) {
      const body = JSON.parse(raw) as { name?: unknown };
      name = typeof body.name === 'string' ? body.name.trim() : '';
    } else {
      name = String(new URLSearchParams(raw).get('name') || '').trim();
    }
  } catch (cause) {
    if (isTooLarge(cause)) return error('PAYLOAD_TOO_LARGE', 'Workspace request must be at most 4KB', 413);
    return error('INVALID_BODY', 'Workspace request body is invalid', 400);
  }
  const isJson = (request.headers.get('Content-Type') || '').includes('application/json');
  if (!name || name.length > 80) return isJson
    ? error('INVALID_NAME', 'Workspace name must be between 1 and 80 characters', 400)
    : formError('Enter a Workspace name between 1 and 80 characters.');
  const duplicate = await env.ACCOUNTS.prepare('SELECT id FROM workspaces WHERE owner_id=? AND archived_at IS NULL AND lower(name)=lower(?)')
    .bind(user.id, name).first<{ id: string }>();
  if (duplicate) return isJson
    ? error('WORKSPACE_EXISTS', 'A Workspace with this name already exists', 409)
    : formError(`“${name}” already exists. Choose a different name.`);
  const count = await env.ACCOUNTS.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE owner_id=? AND archived_at IS NULL')
    .bind(user.id).first<{ count: number }>();
  if (Number(count?.count || 0) >= 20) return error('WORKSPACE_LIMIT', 'Free preview supports up to 20 Workspaces', 403);
  const base = slugify(name);
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const row: WorkspaceRow = { id: crypto.randomUUID(), owner_id: user.id, name, slug: attempt ? `${base}-${attempt + 1}` : base, is_default: 0, archived_at: null, created_at: now, updated_at: now };
    try {
      await env.ACCOUNTS.prepare('INSERT INTO workspaces(id,owner_id,name,slug,is_default,created_at,updated_at) VALUES(?,?,?,?,0,?,?)')
        .bind(row.id, row.owner_id, row.name, row.slug, now, now).run();
      if (!isJson) return new Response(null, { status: 303, headers: { Location: `/?workspace=${row.id}` } });
      return Response.json({ workspace: present(row) }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    } catch (cause) {
      if (attempt === 4) { console.error('Failed to create Workspace', cause); return error('CREATE_FAILED', 'Could not create Workspace', 500); }
    }
  }
  return error('CREATE_FAILED', 'Could not create Workspace', 500);
}

export async function handleWorkspaces(request: Request, env: AccountEnv, url: URL): Promise<Response | null> {
  const api = url.pathname === '/api/workspaces';
  const form = url.pathname === '/workspaces';
  if (!api && !form) return null;
  const user = await currentUser(request, env);
  if (!user) return error('UNAUTHORIZED', 'Sign in or connect an Agent token', 401);
  if (api && request.method === 'GET') return list(env, user);
  if ((api || form) && request.method === 'POST') return create(request, env, user);
  return error('METHOD_NOT_ALLOWED', 'Use GET or POST', 405);
}
