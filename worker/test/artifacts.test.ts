import { beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

declare module 'cloudflare:test' {
  interface ProvidedEnv { ACCOUNTS: D1Database }
}

async function call(request: Request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function addSession(raw: string, id: string, kind: 'browser' | 'token') {
  const now = new Date().toISOString();
  await env.ACCOUNTS.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at,id,kind,label,last_used_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(await sha256(raw), 'artifact-user', new Date(Date.now() + 60_000).toISOString(), now, id, kind, kind, now).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.ACCOUNTS, [
    { name: 'base.sql', queries: [
      "CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT UNIQUE,tier TEXT DEFAULT 'free',created_at TEXT)",
      "CREATE TABLE sessions (token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at TEXT,created_at TEXT,id TEXT UNIQUE,kind TEXT,label TEXT,last_used_at TEXT)",
      "CREATE TABLE documents (id TEXT PRIMARY KEY,user_id TEXT,kind TEXT,visibility TEXT,size INTEGER,version INTEGER,created_at TEXT,updated_at TEXT,plaintext_name TEXT,history_size INTEGER NOT NULL DEFAULT 0,history_versions INTEGER NOT NULL DEFAULT 0)",
      "CREATE TABLE magic_links (token_hash TEXT PRIMARY KEY,email TEXT,expires_at TEXT,used_at TEXT,created_at TEXT)",
      "CREATE TABLE device_logins (code TEXT PRIMARY KEY,secret_hash TEXT UNIQUE,user_id TEXT,expires_at TEXT,approved_at TEXT,consumed_at TEXT,created_at TEXT)",
    ] },
    { name: 'artifacts.sql', queries: [
      "CREATE TABLE artifacts (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,summary TEXT,artifact_type TEXT NOT NULL DEFAULT 'document',content_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',visibility TEXT NOT NULL DEFAULT 'private',current_version INTEGER NOT NULL DEFAULT 1,current_object_key TEXT NOT NULL,current_size INTEGER NOT NULL,history_size INTEGER NOT NULL DEFAULT 0,history_versions INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
      "CREATE TABLE artifact_versions (artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,version INTEGER NOT NULL,object_key TEXT NOT NULL UNIQUE,size INTEGER NOT NULL,author_principal_id TEXT NOT NULL,author_kind TEXT NOT NULL,change_summary TEXT,source_ref TEXT,evidence_json TEXT NOT NULL DEFAULT '[]',client_harness TEXT,client_model TEXT,content_type TEXT,created_at TEXT NOT NULL,PRIMARY KEY(artifact_id,version))",
      "CREATE TABLE artifact_access (artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,principal_type TEXT NOT NULL,principal_id TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(artifact_id,principal_type,principal_id))",
    ] },
  ]);
  await env.ACCOUNTS.prepare('INSERT INTO users VALUES(?,?,?,?)')
    .bind('artifact-user', 'artifacts@example.com', 'free', new Date().toISOString()).run();
  await addSession('human-token', 'human-session', 'browser');
  await addSession('agent-token', 'agent-session', 'token');
});

describe('account Artifacts V1 contract', () => {
  it('requires account authentication', async () => {
    const response = await call(new Request('https://account.vnsh.dev/api/artifacts'));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('creates, lists and reads a permanent versioned Artifact', async () => {
    const created = await call(new Request('https://account.vnsh.dev/api/artifacts', {
      method: 'POST',
      headers: { Authorization: 'Bearer human-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Launch brief', summary: 'Human-readable release evidence', artifactType: 'report', content: '<h1>Ready</h1>', contentType: 'text/html; charset=utf-8', changeSummary: 'Initial evidence', sourceRef: 'https://github.com/raullenchai/vnsh/pull/66', evidence: ['Worker tests passed'], harness: 'Browser', model: 'none' }),
    }));
    expect(created.status).toBe(201);
    expect(created.headers.get('ETag')).toBe('"1"');
    const artifact = (await created.json<any>()).artifact;
    expect(artifact).toMatchObject({ title: 'Launch brief', summary: 'Human-readable release evidence', artifactType: 'report', status: 'draft', visibility: 'private', version: 1 });
    expect(artifact.capabilities).toContain('approve');
    expect(artifact.capabilities).toContain('publish');
    expect(artifact.id).toMatch(/^[0-9a-f-]{36}$/);

    const listed = await call(new Request('https://account.vnsh.dev/api/artifacts', { headers: { Authorization: 'Bearer human-token' } }));
    expect((await listed.json<any>()).artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ id: artifact.id })]));

    const read = await call(new Request(`https://account.vnsh.dev/api/artifacts/${artifact.id}`, { headers: { Authorization: 'Bearer agent-token' } }));
    expect(read.headers.get('ETag')).toBe('"1"');
    expect(await read.json<any>()).toMatchObject({ content: '<h1>Ready</h1>', artifact: { version: 1, capabilities: ['read', 'update', 'request_review'] } });
    expect(await env.ACCOUNTS.prepare('SELECT author_kind,change_summary FROM artifact_versions WHERE artifact_id=? AND version=1').bind(artifact.id).first())
      .toMatchObject({ author_kind: 'human', change_summary: 'Initial evidence' });

    const updated = await call(new Request(`https://account.vnsh.dev/api/artifacts/${artifact.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer agent-token', 'If-Match': 'W/"1"', 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'Production-verified release evidence', content: '<h1>Ready</h1><p>Smoke passed.</p>', contentType: 'text/plain; charset=utf-8', changeSummary: 'Added production proof', sourceRef: 'https://vnsh.dev', evidence: ['40/40 smoke checks'], harness: 'Codex CLI', model: 'GPT-5' }),
    }));
    expect(updated.status).toBe(200);
    expect(await updated.json<any>()).toMatchObject({ artifact: { version: 2, capabilities: ['read', 'update', 'request_review'] } });
    expect(await env.ACCOUNTS.prepare('SELECT author_kind,change_summary FROM artifact_versions WHERE artifact_id=? AND version=2').bind(artifact.id).first())
      .toMatchObject({ author_kind: 'agent', change_summary: 'Added production proof' });

    const history = await call(new Request(`https://account.vnsh.dev/api/artifacts/${artifact.id}/versions`, { headers: { Authorization: 'Bearer human-token' } }));
    expect(history.status).toBe(200);
    expect(await history.json<any>()).toMatchObject({
      artifact: { summary: 'Production-verified release evidence', artifactType: 'report', version: 2 },
      versions: [
        { version: 2, author: { kind: 'agent', principalId: 'agent-session' }, changeSummary: 'Added production proof', sourceRef: 'https://vnsh.dev', evidence: ['40/40 smoke checks'], clientAnnotations: { harness: 'Codex CLI', model: 'GPT-5', verified: false } },
        { version: 1, author: { kind: 'human', principalId: 'human-session' }, evidence: ['Worker tests passed'] },
      ],
    });

    const shell = await call(new Request(`https://account.vnsh.dev/artifacts/${artifact.id}?version=1`, { headers: { Authorization: 'Bearer human-token' } }));
    expect(shell.status).toBe(200);
    expect(shell.headers.get('Content-Security-Policy')).toContain("frame-src 'self'");
    expect(await shell.text()).toContain(`/artifacts/${artifact.id}/content?version=1`);

    const agentShell = await call(new Request(`https://account.vnsh.dev/artifacts/${artifact.id}`, { headers: { Authorization: 'Bearer agent-token' } }));
    expect(agentShell.status).toBe(403);
    expect(await agentShell.json()).toMatchObject({ error: 'HUMAN_REQUIRED' });

    const firstContent = await call(new Request(`https://account.vnsh.dev/artifacts/${artifact.id}/content?version=1`, { headers: { Authorization: 'Bearer human-token' } }));
    expect(firstContent.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(firstContent.headers.get('Content-Security-Policy')).toContain("sandbox; default-src 'none'");
    expect(await firstContent.text()).toBe('<h1>Ready</h1>');
    const currentContent = await call(new Request(`https://account.vnsh.dev/artifacts/${artifact.id}/content?version=2`, { headers: { Authorization: 'Bearer human-token' } }));
    expect(currentContent.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await currentContent.text()).toContain('Smoke passed.');
    const contentHead = await call(new Request(`https://account.vnsh.dev/artifacts/${artifact.id}/content`, { method: 'HEAD', headers: { Authorization: 'Bearer human-token' } }));
    expect(contentHead.status).toBe(200);
    expect(await contentHead.text()).toBe('');
    const invalidVersion = await call(new Request(`https://account.vnsh.dev/artifacts/${artifact.id}/content?version=banana`, { headers: { Authorization: 'Bearer human-token' } }));
    expect(invalidVersion.status).toBe(400);
    expect(await invalidVersion.json()).toMatchObject({ error: 'INVALID_VERSION' });
    const missingVersion = await call(new Request(`https://account.vnsh.dev/artifacts/${artifact.id}/content?version=99`, { headers: { Authorization: 'Bearer human-token' } }));
    expect(missingVersion.status).toBe(404);
    expect(await missingVersion.json()).toMatchObject({ error: 'NOT_FOUND' });

    const stale = await call(new Request(`https://account.vnsh.dev/api/artifacts/${artifact.id}`, {
      method: 'PUT', headers: { Authorization: 'Bearer agent-token', 'If-Match': '"1"' }, body: JSON.stringify({ content: 'stale' }),
    }));
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ error: 'VERSION_CONFLICT' });

    const agentDelete = await call(new Request(`https://account.vnsh.dev/api/artifacts/${artifact.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer agent-token' } }));
    expect(agentDelete.status).toBe(403);
    expect(await agentDelete.json()).toMatchObject({ error: 'HUMAN_REQUIRED' });

    const deleted = await call(new Request(`https://account.vnsh.dev/api/artifacts/${artifact.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer human-token' } }));
    expect(deleted.status).toBe(204);
    expect((await call(new Request(`https://account.vnsh.dev/api/artifacts/${artifact.id}`, { headers: { Authorization: 'Bearer human-token' } }))).status).toBe(404);
    expect((await env.VNSH_STORE.list({ prefix: `a/${artifact.id}/` })).objects).toHaveLength(0);
  });

  it('validates titles, media types, preconditions and methods', async () => {
    const invalid = await call(new Request('https://account.vnsh.dev/api/artifacts', {
      method: 'POST', headers: { Authorization: 'Bearer human-token' }, body: JSON.stringify({ title: '', content: 'x' }),
    }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'INVALID_TITLE' });
    expect((await call(new Request('https://account.vnsh.dev/api/artifacts', { method: 'DELETE', headers: { Authorization: 'Bearer human-token' } }))).status).toBe(405);
    const badEvidence = await call(new Request('https://account.vnsh.dev/api/artifacts', {
      method: 'POST', headers: { Authorization: 'Bearer human-token' }, body: JSON.stringify({ title: 'Bad', content: 'x', evidence: ['x'.repeat(1001)] }),
    }));
    expect(await badEvidence.json()).toMatchObject({ error: 'INVALID_EVIDENCE' });
  });
});
