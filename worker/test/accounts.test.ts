import { beforeAll, describe, expect, it } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  applyD1Migrations,
} from "cloudflare:test";
import worker from "../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    ACCOUNTS: D1Database;
  }
}

async function call(request: Request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

beforeAll(async () => {
  await applyD1Migrations(env.ACCOUNTS, [
    {
      name: "0001_accounts.sql",
      queries: [
        "CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT UNIQUE,tier TEXT DEFAULT 'free',created_at TEXT)",
        "CREATE TABLE sessions (token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at TEXT,created_at TEXT,id TEXT UNIQUE,kind TEXT,label TEXT,last_used_at TEXT)",
        "CREATE TABLE documents (id TEXT PRIMARY KEY,user_id TEXT,kind TEXT,visibility TEXT,size INTEGER,version INTEGER,created_at TEXT,updated_at TEXT,plaintext_name TEXT,history_size INTEGER NOT NULL DEFAULT 0,history_versions INTEGER NOT NULL DEFAULT 0)",
        "CREATE TABLE magic_links (token_hash TEXT PRIMARY KEY,email TEXT,expires_at TEXT,used_at TEXT,created_at TEXT)",
        "CREATE TABLE device_logins (code TEXT PRIMARY KEY,secret_hash TEXT UNIQUE,user_id TEXT,expires_at TEXT,approved_at TEXT,consumed_at TEXT,created_at TEXT)",
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY,owner_id TEXT,name TEXT,slug TEXT,is_default INTEGER DEFAULT 0,archived_at TEXT,created_at TEXT,updated_at TEXT,UNIQUE(owner_id,slug))",
        "CREATE UNIQUE INDEX workspaces_one_default ON workspaces(owner_id) WHERE is_default=1",
        "CREATE TABLE artifacts (id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,summary TEXT,artifact_type TEXT DEFAULT 'document',content_type TEXT,status TEXT,visibility TEXT,current_version INTEGER,current_object_key TEXT,current_size INTEGER,history_size INTEGER NOT NULL DEFAULT 0,history_versions INTEGER NOT NULL DEFAULT 0,workspace_id TEXT,created_at TEXT,updated_at TEXT)",
      ],
    },
  ]);
});

describe("accounts", () => {
  it("shows login and fails closed without email binding", async () => {
    const login = await call(new Request("https://account.vnsh.dev/"));
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain("Permanent library");
    expect(html).toContain("Two explicit modes");
    expect(html).toContain("Account Artifacts are readable by vnsh");
    expect(html).toContain("@media(max-width:760px)");
    const response = await call(
      new Request("https://account.vnsh.dev/api/auth/request", {
        method: "POST",
        body: new URLSearchParams({ email: "user@example.com" }),
      }),
    );
    expect(response.status).toBe(501);
  });

  it("keeps browser authority host-only and rejects cross-site mutations", async () => {
    const raw = "csrf-browser-session";
    const now = new Date().toISOString();
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare("INSERT INTO users VALUES(?,?,?,?)").bind("csrf-user", "csrf@example.com", "free", now),
      env.ACCOUNTS.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at,id,kind,label,last_used_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(await sha256(raw), "csrf-user", new Date(Date.now() + 60000).toISOString(), now, "csrf-session", "browser", "CSRF test", now),
    ]);
    const form = (origin?: string) => call(new Request("https://account.vnsh.dev/workspaces", {
      method: "POST",
      headers: { Cookie: `vnsh_session=${raw}`, "Content-Type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}) },
      body: "name=Security+Review",
    }));
    expect(await (await form("https://evil.example")).json()).toMatchObject({ error: "CROSS_SITE_REQUEST" });
    expect((await form()).status).toBe(403);
    expect((await form("https://account.vnsh.dev")).status).toBe(303);

    const magic = "host-only-magic-link";
    await env.ACCOUNTS.prepare("INSERT INTO magic_links(token_hash,email,expires_at,created_at) VALUES(?,?,?,?)")
      .bind(await sha256(magic), "cookie@example.com", new Date(Date.now() + 60000).toISOString(), now).run();
    const callback = await call(new Request(`https://account.vnsh.dev/auth/callback?token=${magic}`));
    const cookies = callback.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.includes("Domain=.vnsh.dev") && cookie.includes("Max-Age=0"))).toBe(true);
    const active = cookies.find((cookie) => cookie.includes("Max-Age=2592000"));
    expect(active).toContain("HttpOnly");
    expect(active).toContain("Secure");
    expect(active).toContain("SameSite=Lax");
    expect(active).not.toContain("Domain=");

    const migration = await call(new Request('https://account.vnsh.dev/', { headers: { Cookie: `vnsh_session=${raw}` } }));
    const migratedCookies = migration.headers.getSetCookie();
    expect(migratedCookies.some((cookie) => cookie.includes('Domain=.vnsh.dev') && cookie.includes('Max-Age=0'))).toBe(true);
    expect(migratedCookies.some((cookie) => cookie.startsWith(`vnsh_session=${raw};`) && !cookie.includes('Domain='))).toBe(true);
  });

  it("makes authenticated creates permanent and indexes artifacts", async () => {
    const raw = "session-token";
    const hash = await sha256(raw);
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare("INSERT INTO users VALUES(?,?,?,?)").bind(
        "u1",
        "u@example.com",
        "free",
        new Date().toISOString(),
      ),
      env.ACCOUNTS.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at,id,kind,label,last_used_at) VALUES(?,?,?,?,?,?,?,?)").bind(
        hash,
        "u1",
        new Date(Date.now() + 60000).toISOString(),
        new Date().toISOString(),
        "browser-session-1",
        "browser",
        "Test browser",
        new Date().toISOString(),
      ),
    ]);

    const deviceStart = await call(
      new Request("https://account.vnsh.dev/api/auth/device", {
        method: "POST",
      }),
    );
    expect(deviceStart.status).toBe(201);
    const device = await deviceStart.json<any>();
    expect(device.user_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(device.verification_uri).toContain(device.user_code);
    const poll = () =>
      call(
        new Request("https://account.vnsh.dev/api/auth/device/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: device.device_code }),
        }),
      );
    expect((await poll()).status).toBe(202);
    const approvalPage = await call(
      new Request(device.verification_uri, {
        headers: { Authorization: `Bearer ${raw}` },
      }),
    );
    expect(await approvalPage.text()).toContain("Approve this device?");
    const approval = await call(
      new Request("https://account.vnsh.dev/device/approve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ code: device.user_code }),
      }),
    );
    expect(await approval.text()).toContain("CLI connected.");
    const tokenResponse = await poll();
    expect(tokenResponse.status).toBe(200);
    const cliToken = (await tokenResponse.json<any>()).token;
    const me = await call(
      new Request("https://account.vnsh.dev/api/account/me", {
        headers: { Authorization: `Bearer ${cliToken}` },
      }),
    );
    expect(await me.json()).toMatchObject({ user: { email: "u@example.com" } });
    expect((await poll()).status).toBe(410);
    const revoked = await call(
      new Request("https://account.vnsh.dev/api/account/token/current", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cliToken}` },
      }),
    );
    expect(revoked.status).toBe(204);
    expect(
      (
        await call(
          new Request("https://account.vnsh.dev/api/account/me", {
            headers: { Authorization: `Bearer ${cliToken}` },
          }),
        )
      ).status,
    ).toBe(401);

    const writeToken = "b".repeat(64);
    const response = await call(
      new Request("https://vnsh.dev/api/workspace", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "X-Vnsh-Write-Hash": await sha256(writeToken),
          "X-Vnsh-Kind": "artifact",
        },
        body: "ciphertext",
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json<{
      id: string;
      permanent: boolean;
      expires?: string;
    }>();
    expect(body).toMatchObject({ permanent: true });
    expect(body.expires).toBeUndefined();
    const head = await env.VNSH_STORE.head(`w/${body.id}`);
    expect(head?.customMetadata?.permanent).toBe("1");
    expect(
      await env.ACCOUNTS.prepare("SELECT kind FROM documents WHERE id=?")
        .bind(body.id)
        .first(),
    ).toMatchObject({ kind: "artifact" });
    const artifactPage = await call(
      new Request(`https://vnsh.dev/artifact/${body.id}`, {
        headers: {
          Accept: "text/html",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        },
      }),
    );
    expect(artifactPage.status).toBe(200);
    expect(await artifactPage.text()).toContain("(?:w|artifact)");

    const update = await call(
      new Request(`https://vnsh.dev/api/workspace/${body.id}`, {
        method: "PUT",
        headers: {
          "X-Vnsh-Write": writeToken,
          "If-Match": '"1"',
        },
        body: "new ciphertext",
      }),
    );
    expect(await update.json()).toMatchObject({ version: 2, permanent: true });
    expect(
      await env.ACCOUNTS.prepare(
        "SELECT size,version,history_size,history_versions FROM documents WHERE id=?",
      )
        .bind(body.id)
        .first(),
    ).toMatchObject({ size: 14, version: 2, history_size: 10, history_versions: 1 });
    const updatedMetadata = (await env.VNSH_STORE.head(`w/${body.id}`))
      ?.customMetadata;
    expect(updatedMetadata).toMatchObject({ permanent: "1" });
    expect(updatedMetadata?.ownerId || updatedMetadata?.ownerid).toBe("u1");

    const renew = await call(
      new Request(`https://vnsh.dev/api/workspace/${body.id}/renew?ttl=1`, {
        method: "POST",
        headers: { "X-Vnsh-Write": writeToken },
      }),
    );
    expect(await renew.json()).toMatchObject({ version: 2, permanent: true });

    const listing = await call(
      new Request("https://account.vnsh.dev/api/account/documents", {
        headers: { Authorization: `Bearer ${raw}` },
      }),
    );
    expect((await listing.json<any>()).documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: body.id, kind: "artifact" }),
      ]),
    );

    const artifactId = "11111111-1111-4111-8111-111111111111";
    await env.ACCOUNTS.prepare("INSERT INTO workspaces(id,owner_id,name,slug,is_default,created_at,updated_at) VALUES('personal-u1','u1','Personal','personal',1,?,?)")
      .bind(new Date().toISOString(), new Date().toISOString()).run();
    const personal = await env.ACCOUNTS.prepare("SELECT id FROM workspaces WHERE owner_id='u1' AND is_default=1").first<{ id: string }>();
    await env.ACCOUNTS.prepare(`INSERT INTO artifacts(id,owner_id,title,summary,artifact_type,content_type,status,visibility,current_version,current_object_key,current_size,workspace_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(artifactId, "u1", "Agent handoff", "Ready for human review", "handoff", "text/html; charset=utf-8", "in_review", "private", 1, `a/${artifactId}/versions/1-test`, 0, personal!.id, new Date().toISOString(), new Date().toISOString()).run();

    const dashboard = await call(
      new Request("https://account.vnsh.dev/", {
        headers: { Authorization: `Bearer ${raw}` },
      }),
    );
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain("Work worth keeping.");
    expect(dashboardHtml).toContain("Artifacts");
    expect(dashboardHtml).toContain("Incognito Artifacts");
    expect(dashboardHtml).toContain("Agent handoff");
    expect(dashboardHtml).toContain("Ready for human review");
    expect(dashboardHtml).toContain(body.id);
    expect(dashboardHtml).toContain("Stored incl. history");
    expect(dashboardHtml).toContain("1 retained versions");
    expect(dashboardHtml).toContain("Confirm delete");
    expect(dashboardHtml).not.toContain("ciphertext");

    const usageResponse = await call(new Request("https://account.vnsh.dev/api/account/me", {
      headers: { Authorization: `Bearer ${raw}` },
    }));
    expect(await usageResponse.json<any>()).toMatchObject({
      usage: { documents: 2, currentBytes: 14, historyBytes: 10, totalBytes: 24,
        documentLimit: 100, storageLimit: 1073741824 },
    });

    const filtered = await call(new Request("https://account.vnsh.dev/?workspace=personal-u1&q=Agent", {
      headers: { Authorization: `Bearer ${raw}` },
    }));
    const filteredHtml = await filtered.text();
    expect(filteredHtml).toContain("Agent handoff");
    expect(filteredHtml).toContain('value="Agent"');
    expect(filteredHtml).toContain('name="workspace" value="personal-u1"');

    await env.ACCOUNTS.prepare("UPDATE documents SET size=? WHERE id=?")
      .bind(1024 * 1024 * 1024, body.id).run();
    const full = await call(new Request("https://vnsh.dev/api/workspace", {
      method: "POST",
      headers: { Authorization: `Bearer ${raw}`, "X-Vnsh-Write-Hash": await sha256(writeToken) },
      body: "one byte too many",
    }));
    expect(full.status).toBe(403);
    expect(await full.json<any>()).toMatchObject({ error: "ACCOUNT_QUOTA_EXCEEDED" });
    const fullUpdate = await call(new Request(`https://vnsh.dev/api/workspace/${body.id}`, {
      method: "PUT",
      headers: { "X-Vnsh-Write": writeToken, "If-Match": '"2"' },
      body: "would exceed quota",
    }));
    expect(fullUpdate.status).toBe(403);
    expect((await env.VNSH_STORE.head(`w/${body.id}`))?.customMetadata?.version).toBe("2");
    await env.ACCOUNTS.prepare("UPDATE documents SET size=? WHERE id=?").bind(14, body.id).run();

    const deleted = await call(
      new Request(`https://account.vnsh.dev/api/account/documents/${body.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${raw}` },
      }),
    );
    expect(deleted.status).toBe(204);
    expect(await env.VNSH_STORE.head(`w/${body.id}`)).toBeNull();
    expect(
      await env.ACCOUNTS.prepare("SELECT id FROM documents WHERE id=?")
        .bind(body.id)
        .first(),
    ).toBeNull();

    const tokenPage = await call(new Request("https://account.vnsh.dev/api/account/token", {
      method: "POST",
      headers: { Authorization: `Bearer ${raw}` },
      body: new URLSearchParams({ label: "Cursor laptop" }),
    }));
    expect(await tokenPage.text()).toContain("Cursor laptop");
    const sessions = await call(new Request("https://account.vnsh.dev/api/account/sessions", {
      headers: { Authorization: `Bearer ${raw}` },
    }));
    const sessionList = (await sessions.json<any>()).sessions;
    expect(sessionList).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Cursor laptop", kind: "token", current: false }),
      expect.objectContaining({ label: "Test browser", current: true }),
    ]));
    const tokenSession = sessionList.find((session: any) => session.label === "Cursor laptop");
    expect((await call(new Request(`https://account.vnsh.dev/api/account/sessions/${tokenSession.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${raw}` },
    }))).status).toBe(204);

    const permanent = await call(new Request("https://vnsh.dev/api/workspace", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${raw}`,
        "X-Vnsh-Write-Hash": await sha256(writeToken),
      },
      body: "account-v1",
    }));
    const permanentId = (await permanent.json<any>()).id;
    await (await call(new Request(`https://vnsh.dev/api/workspace/${permanentId}`, {
      method: "PUT",
      headers: { "X-Vnsh-Write": writeToken, "If-Match": '"1"' },
      body: "account-v2",
    }))).arrayBuffer();
    expect(await env.VNSH_STORE.head(`wh/${permanentId}/0000000001`)).not.toBeNull();

    const mismatch = await call(new Request("https://account.vnsh.dev/account/delete", {
      method: "POST",
      headers: { Authorization: `Bearer ${raw}` },
      body: new URLSearchParams({ email: "wrong@example.com" }),
    }));
    expect(mismatch.status).toBe(400);
    await mismatch.arrayBuffer();
    const accountDelete = await call(new Request("https://account.vnsh.dev/account/delete", {
      method: "POST",
      headers: { Authorization: `Bearer ${raw}` },
      body: new URLSearchParams({ email: "u@example.com" }),
    }));
    expect(accountDelete.status).toBe(302);
    await accountDelete.arrayBuffer();
    expect(await env.VNSH_STORE.head(`w/${permanentId}`)).toBeNull();
    expect(await env.VNSH_STORE.head(`wh/${permanentId}/0000000001`)).toBeNull();
    expect(await env.ACCOUNTS.prepare("SELECT id FROM users WHERE id='u1'").first()).toBeNull();
  });
});
