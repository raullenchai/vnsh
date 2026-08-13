import { FREE_DOCUMENT_LIMIT, FREE_STORAGE_LIMIT, accountUsage } from './account-usage';

export interface AccountEnv {
  ACCOUNTS: D1Database;
  EMAIL?: SendEmail;
  VNSH_STORE: R2Bucket;
}

export interface AccountUser {
  id: string;
  email: string;
  tier: string;
  sessionId: string;
  sessionKind: string;
}

const COOKIE = "vnsh_session";
const enc = new TextEncoder();
const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function deviceCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function hash(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))),
  );
}

function cookieValue(request: Request): string | null {
  const match = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)vnsh_session=([^;]+)/);
  return match ? match[1] : null;
}

export async function currentUser(
  request: Request,
  env: AccountEnv,
): Promise<AccountUser | null> {
  const bearer = request.headers
    .get("Authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1];
  const raw = bearer || cookieValue(request);
  if (!raw || raw.length > 256) return null;
  const tokenHash = await hash(raw);
  const now = new Date();
  const user = await env.ACCOUNTS.prepare(
    `SELECT u.id, u.email, u.tier, s.id AS sessionId, s.kind AS sessionKind, s.last_used_at AS lastUsedAt
     FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,
  )
    .bind(tokenHash, now.toISOString())
    .first<AccountUser & { lastUsedAt?: string }>();
  if (user && (!user.lastUsedAt || now.getTime() - new Date(user.lastUsedAt).getTime() > 3600_000)) {
    await env.ACCOUNTS.prepare("UPDATE sessions SET last_used_at=? WHERE token_hash=?")
      .bind(now.toISOString(), tokenHash)
      .run();
  }
  return user;
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function deleteDocumentObjects(bucket: R2Bucket, id: string): Promise<void> {
  await bucket.delete(`w/${id}`);
  await deletePrefix(bucket, `wh/${id}/`);
  // Account Artifacts keep immutable versions under their own prefix. Older
  // permanent workspaces have no objects here, so this is safe during the
  // migration window where both document models appear in the same index.
  await deletePrefix(bucket, `a/${id}/`);
}

const page = (
  body: string,
  title = "Your library",
) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080a0e"><title>${esc(title)} · vnsh</title>
<style>
:root{color-scheme:dark;--bg:#080a0e;--panel:#10141b;--panel2:#151a23;--line:#262d39;--ink:#f1f4f8;--muted:#929dac;--dim:#687384;--green:#4ade80;--amber:#f0b54a;--red:#fb7185;--shadow:0 22px 70px rgba(0,0,0,.32)}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.55 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(900px 500px at 15% -10%,rgba(74,222,128,.1),transparent 60%),radial-gradient(700px 450px at 100% 0,rgba(240,181,74,.08),transparent 55%),var(--bg)}a{color:inherit}.shell{width:min(1120px,calc(100% - 40px));margin:auto}.topbar{height:72px;display:flex;align-items:center;border-bottom:1px solid rgba(255,255,255,.07)}.brand{font:700 19px ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:none;letter-spacing:-.05em}.brand i{color:var(--green);font-style:normal}.topnav{margin-left:auto;display:flex;align-items:center;gap:22px}.topnav a,.link-button{color:var(--muted);text-decoration:none;font-size:13px}.topnav a:hover,.link-button:hover{color:var(--ink)}
main{padding:68px 0 90px}.eyebrow{display:flex;align-items:center;gap:8px;color:var(--green);font:700 12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em}.eyebrow:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 14px currentColor}h1{font-size:clamp(34px,6vw,62px);letter-spacing:-.055em;line-height:1.02;margin:18px 0 14px;max-width:800px}h2{font-size:19px;letter-spacing:-.025em;margin:0}.lede{color:var(--muted);font-size:17px;max-width:660px;margin:0}.hero-row{display:flex;justify-content:space-between;align-items:flex-end;gap:32px}.identity{color:var(--muted);margin:10px 0 0}.identity strong{color:var(--ink)}
.stats{display:flex;border:1px solid var(--line);border-radius:14px;background:rgba(16,20,27,.72);overflow:hidden}.stat{padding:15px 22px;min-width:110px}.stat+.stat{border-left:1px solid var(--line)}.stat b{display:block;font-size:21px}.stat span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.09em}.notice{display:flex;gap:14px;margin:34px 0;padding:17px 19px;border:1px solid rgba(74,222,128,.22);border-radius:14px;background:rgba(74,222,128,.055);color:var(--muted)}.notice b{color:var(--ink)}.shield{color:var(--green);font-size:18px}.section-head{display:flex;justify-content:space-between;align-items:center;margin:42px 0 16px}.section-head span{color:var(--dim);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{position:relative;min-height:180px;padding:21px;border:1px solid var(--line);border-radius:17px;background:linear-gradient(145deg,rgba(21,26,35,.96),rgba(13,17,23,.96));box-shadow:0 1px 0 rgba(255,255,255,.025);transition:transform .15s,border-color .15s}.card:hover{transform:translateY(-2px);border-color:#394353}.card-top{display:flex;align-items:center;gap:10px}.badge{padding:4px 8px;border-radius:999px;background:rgba(240,181,74,.1);color:var(--amber);font:700 10px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.badge.workspace{color:#9aa8ff;background:rgba(120,135,255,.1)}.visibility{color:var(--dim);font-size:12px;margin-left:auto}.doc-id{font:600 16px ui-monospace,SFMono-Regular,Menlo,monospace;margin:26px 0 5px;letter-spacing:.02em}.doc-meta{color:var(--muted);font-size:13px}.card-foot{position:absolute;left:21px;right:21px;bottom:18px;display:flex;align-items:center}.kept{color:var(--green);font-size:12px}.danger{margin-left:auto}.danger summary{list-style:none;color:var(--dim);cursor:pointer;font-size:12px}.danger summary::-webkit-details-marker{display:none}.danger[open]{display:flex;align-items:center;gap:8px}.danger[open] summary{color:var(--red)}
.empty{grid-column:1/-1;text-align:center;padding:70px 24px;border:1px dashed #303846;border-radius:18px;background:rgba(16,20,27,.55)}.empty-mark{width:48px;height:48px;margin:0 auto 18px;display:grid;place-items:center;border:1px solid var(--line);border-radius:14px;color:var(--green);font:700 20px ui-monospace,monospace}.empty p{color:var(--muted);margin:8px 0 0}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:38px}.button,button{appearance:none;border:1px solid var(--line);border-radius:10px;background:#171d26;color:var(--ink);font:inherit;font-size:13px;font-weight:650;padding:10px 14px;cursor:pointer;text-decoration:none}.button:hover,button:hover{border-color:#465164;background:#1c2430}.button.primary{background:var(--ink);color:#090b0f;border-color:var(--ink)}.button.primary:hover{background:#dce2e9}.delete{padding:6px 9px;color:#fecdd3;border-color:rgba(251,113,133,.28);background:rgba(251,113,133,.08)}.link-button{background:none;border:0;padding:10px}
.artifact-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.artifact-card{display:block;min-height:210px;padding:21px;border:1px solid var(--line);border-radius:17px;background:linear-gradient(145deg,#18251f,#10171b);text-decoration:none;transition:transform .15s,border-color .15s}.artifact-card:hover{transform:translateY(-2px);border-color:#436352}.artifact-type{color:var(--green);font:700 10px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.11em}.artifact-card h3{font-size:19px;line-height:1.25;margin:28px 0 10px}.artifact-card p{color:var(--muted);font-size:13px;min-height:42px}.artifact-card footer{display:flex;justify-content:space-between;color:var(--dim);font-size:11px;margin-top:24px}.review-status{color:var(--amber)}.library-tools{display:flex;gap:8px;margin:18px 0}.library-tools input{margin:0;min-width:240px}.library-tools select{border:1px solid #323b49;border-radius:10px;background:#0c1016;color:var(--ink);padding:10px 12px}.mode-tabs{display:flex;gap:8px;margin-top:18px}.mode-tabs a{color:var(--muted);text-decoration:none;border:1px solid var(--line);padding:7px 10px;border-radius:999px;font-size:12px}.mode-tabs a.active{color:#061009;background:var(--green);border-color:var(--green)}
.workspace-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:28px 0 8px}.workspace-bar>a{color:var(--muted);text-decoration:none;border:1px solid var(--line);padding:8px 12px;border-radius:10px;font-size:12px}.workspace-bar>a.active{color:#071109;background:var(--green);border-color:var(--green)}.workspace-create{display:flex;gap:6px;margin-left:auto}.workspace-create input{width:180px;margin:0;padding:8px 10px}.workspace-create button{padding:8px 10px}
.auth-wrap{display:grid;grid-template-columns:1.05fr .95fr;gap:18px;align-items:stretch;max-width:940px;margin:30px auto 0}.auth-copy,.auth-card{border:1px solid var(--line);border-radius:22px;background:rgba(16,20,27,.82);box-shadow:var(--shadow)}.auth-copy{padding:48px;background:linear-gradient(145deg,rgba(74,222,128,.08),rgba(16,20,27,.9) 42%)}.auth-copy h1{font-size:46px}.auth-card{padding:42px;display:flex;flex-direction:column;justify-content:center}.auth-card h2{font-size:24px}.auth-card p{color:var(--muted)}label{display:block;color:var(--muted);font-size:12px;margin:22px 0 7px}input{width:100%;border:1px solid #323b49;border-radius:10px;background:#0c1016;color:var(--ink);font:15px inherit;padding:13px 14px;outline:none}input:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(74,222,128,.1)}.auth-card button{width:100%;margin-top:12px;background:var(--green);color:#071109;border-color:var(--green);font-weight:750}.fine{font-size:12px!important;color:var(--dim)!important;margin-top:18px!important}.token{padding:22px;border:1px solid rgba(240,181,74,.28);background:#0b0e13;border-radius:14px;overflow:auto;color:#ffe1a3;font:13px/1.7 ui-monospace,monospace;word-break:break-all}.footer{border-top:1px solid rgba(255,255,255,.07);padding:26px 0 40px;color:var(--dim);font-size:12px}
@media(max-width:760px){.shell{width:min(100% - 28px,1120px)}.topbar{height:62px}.topnav a:first-child{display:none}main{padding:42px 0 64px}.hero-row{display:block}.stats{margin-top:26px;width:100%}.stat{flex:1;min-width:0;padding:13px}.grid,.artifact-grid{grid-template-columns:1fr}.library-tools{display:block}.library-tools input,.library-tools select,.library-tools button{width:100%;margin:5px 0}.auth-wrap{grid-template-columns:1fr}.auth-copy{padding:30px}.auth-copy h1{font-size:38px}.auth-card{padding:28px}.notice{font-size:13px}}
</style></head><body><div class="shell"><header class="topbar"><a class="brand" href="https://vnsh.dev">vnsh<i>_</i></a><nav class="topnav"><a href="https://vnsh.dev">Create workspace</a><a href="https://vnsh.dev/llms.txt">Agent setup</a></nav></header>${body}<footer class="footer">Two explicit modes · Host-blind encrypted links or account-authorized Artifacts.</footer></div></body></html>`;
const htmlHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function handleAccount(
  request: Request,
  env: AccountEnv,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/api/account/me" && request.method === "GET") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const usage = await accountUsage(env, user.id);
    return Response.json(
      { user, usage },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    url.pathname === "/api/account/token/current" &&
    request.method === "DELETE"
  ) {
    const bearer = request.headers
      .get("Authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer || bearer.length > 256)
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const removed = await env.ACCOUNTS.prepare(
      "DELETE FROM sessions WHERE token_hash=?",
    )
      .bind(await hash(bearer))
      .run();
    return new Response(null, { status: removed.meta.changes ? 204 : 401 });
  }
  if (url.pathname === "/api/auth/device" && request.method === "POST") {
    const raw = token();
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
    let code = deviceCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await env.ACCOUNTS.prepare(
          "INSERT INTO device_logins(code,secret_hash,expires_at,created_at) VALUES(?,?,?,?)",
        )
          .bind(code, await hash(raw), expires, now.toISOString())
          .run();
        return Response.json(
          {
            device_code: raw,
            user_code: code,
            verification_uri: `${url.origin}/device?code=${code}`,
            expires_in: 600,
            interval: 2,
          },
          { status: 201, headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        if (attempt === 4) throw error;
        code = deviceCode();
      }
    }
  }
  if (url.pathname === "/api/auth/device/token" && request.method === "POST") {
    const input = (await request.json().catch(() => ({}))) as {
      device_code?: string;
    };
    if (!input.device_code || input.device_code.length > 256)
      return Response.json({ error: "INVALID_DEVICE_CODE" }, { status: 400 });
    const now = new Date().toISOString();
    const login = await env.ACCOUNTS.prepare(
      "SELECT code,user_id,expires_at,approved_at,consumed_at FROM device_logins WHERE secret_hash=?",
    )
      .bind(await hash(input.device_code))
      .first<any>();
    if (!login)
      return Response.json({ error: "INVALID_DEVICE_CODE" }, { status: 400 });
    if (login.consumed_at)
      return Response.json({ error: "DEVICE_CODE_USED" }, { status: 410 });
    if (login.expires_at <= now)
      return Response.json({ error: "DEVICE_CODE_EXPIRED" }, { status: 410 });
    if (!login.approved_at || !login.user_id)
      return Response.json(
        { error: "AUTHORIZATION_PENDING" },
        { status: 202, headers: { "Retry-After": "2" } },
      );
    const session = token();
    const exchanged = await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at,created_at,id,kind,label,last_used_at) SELECT ?,user_id,?,?,?,?,?,? FROM device_logins WHERE code=? AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at>?",
      ).bind(
        await hash(session),
        new Date(Date.now() + 365 * 86400_000).toISOString(),
        now,
        crypto.randomUUID(),
        "cli",
        "CLI device",
        now,
        login.code,
        now,
      ),
      env.ACCOUNTS.prepare(
        "UPDATE device_logins SET consumed_at=? WHERE code=? AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at>?",
      ).bind(now, login.code, now),
    ]);
    if (exchanged[0].meta.changes !== 1)
      return Response.json({ error: "DEVICE_CODE_USED" }, { status: 410 });
    return Response.json(
      { token: session, token_type: "Bearer", expires_in: 365 * 86400 },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (url.pathname === "/device" && request.method === "GET") {
    const code = (url.searchParams.get("code") || "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code))
      return new Response(
        page(
          '<main><div class="auth-card"><h1>Invalid device code.</h1><p>Return to the CLI and run <code>vn login</code> again.</p></div></main>',
          "Invalid device code",
        ),
        { status: 400, headers: htmlHeaders },
      );
    const pending = await env.ACCOUNTS.prepare(
      "SELECT expires_at,consumed_at FROM device_logins WHERE code=?",
    )
      .bind(code)
      .first<any>();
    if (
      !pending ||
      pending.consumed_at ||
      pending.expires_at <= new Date().toISOString()
    )
      return new Response(
        page(
          '<main><div class="auth-card"><h1>Device code expired.</h1><p>Return to the CLI and run <code>vn login</code> again.</p></div></main>',
          "Device code expired",
        ),
        { status: 410, headers: htmlHeaders },
      );
    const user = await currentUser(request, env);
    if (!user)
      return new Response(
        page(
          `<main><div class="auth-wrap"><section class="auth-copy"><div class="eyebrow">CLI sign in</div><h1>Connect this device.</h1><p class="lede">Confirm code <strong>${code}</strong> after signing in. The code expires in 10 minutes.</p></section><section class="auth-card"><h2>Sign in to continue</h2><form method="post" action="/api/auth/request"><input type="hidden" name="device" value="${code}"><label for="email">Email address</label><input id="email" type="email" name="email" autocomplete="email" required placeholder="you@example.com"><button>Send magic link →</button></form></section></div></main>`,
          "Connect CLI",
        ),
        { headers: htmlHeaders },
      );
    return new Response(
      page(
        `<main><div class="auth-card"><div class="eyebrow">CLI sign in</div><h1>Approve this device?</h1><p>Code <strong>${code}</strong> requested access to <strong>${esc(user.email)}</strong>.</p><p class="fine">Only approve if you just ran <code>vn login</code> on your own device.</p><form method="post" action="/device/approve"><input type="hidden" name="code" value="${code}"><button>Approve CLI →</button></form></div></main>`,
        "Approve CLI",
      ),
      { headers: htmlHeaders },
    );
  }
  if (url.pathname === "/device/approve" && request.method === "POST") {
    const user = await currentUser(request, env);
    if (!user)
      return new Response(null, { status: 302, headers: { Location: "/" } });
    const data = await request.formData();
    const code = String(data.get("code") || "").toUpperCase();
    const approved = await env.ACCOUNTS.prepare(
      "UPDATE device_logins SET user_id=?,approved_at=? WHERE code=? AND user_id IS NULL AND consumed_at IS NULL AND expires_at>?",
    )
      .bind(user.id, new Date().toISOString(), code, new Date().toISOString())
      .run();
    if (approved.meta.changes !== 1)
      return new Response(
        page(
          '<main><div class="auth-card"><h1>Could not approve this device.</h1><p>The request may have expired or already been used.</p></div></main>',
          "Approval failed",
        ),
        { status: 409, headers: htmlHeaders },
      );
    return new Response(
      page(
        '<main><div class="auth-card"><div class="empty-mark">✓</div><h1>CLI connected.</h1><p>You can close this tab and return to your terminal.</p></div></main>',
        "CLI connected",
      ),
      { headers: htmlHeaders },
    );
  }
  if (url.pathname === "/api/account/documents" && request.method === "GET") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const docs = await env.ACCOUNTS.prepare(
      "SELECT id,kind,visibility,size,version,history_size,history_versions,created_at,updated_at FROM documents WHERE user_id=? ORDER BY updated_at DESC LIMIT 200",
    )
      .bind(user.id)
      .all();
    return Response.json(
      { user, documents: docs.results },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (url.pathname === "/api/account/sessions" && request.method === "GET") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const sessions = await env.ACCOUNTS.prepare(
      "SELECT id,kind,label,created_at,last_used_at,expires_at FROM sessions WHERE user_id=? ORDER BY last_used_at DESC",
    ).bind(user.id).all();
    return Response.json(
      { sessions: sessions.results.map((session: any) => ({ ...session, current: session.id === user.sessionId })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const sessionDeletion = url.pathname.match(/^\/api\/account\/sessions\/([0-9a-f-]{16,64})$/);
  if (sessionDeletion && request.method === "DELETE") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const removed = await env.ACCOUNTS.prepare("DELETE FROM sessions WHERE id=? AND user_id=?")
      .bind(sessionDeletion[1], user.id).run();
    return new Response(null, { status: removed.meta.changes ? 204 : 404 });
  }
  if (url.pathname === "/api/account/token" && request.method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const raw = token();
    const now = new Date().toISOString();
    const input = await request.formData().catch(() => new FormData());
    const requestedLabel = String(input.get("label") || "CLI / agent token").trim();
    const label = (requestedLabel || "CLI / agent token").slice(0, 60);
    await env.ACCOUNTS.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at,id,kind,label,last_used_at) VALUES(?,?,?,?,?,?,?,?)",
    )
      .bind(
        await hash(raw),
        user.id,
        new Date(Date.now() + 365 * 86400_000).toISOString(),
        now,
        crypto.randomUUID(),
        "token",
        label,
        now,
      )
      .run();
    return new Response(
      page(
        `<main><div class="eyebrow">One-time secret</div><h1>Connect your tools.</h1><p class="lede">Copy this token now. For your safety, vnsh stores only its hash and cannot show it again.</p><div class="notice"><span class="shield">◇</span><div><b>${esc(label)}</b><br>This token makes new documents permanent; content encryption still happens locally.</div></div><pre class="token">${raw}</pre><pre class="token">export VNSH_TOKEN='${raw}'</pre><div class="actions"><a class="button primary" href="/">Back to library</a><a class="button" href="https://vnsh.dev/llms.txt">Set up an agent</a></div></main>`,
        "CLI / agent token",
      ),
      { headers: htmlHeaders },
    );
  }
  const deletion = url.pathname.match(
    /^\/api\/account\/documents\/([0-9A-Za-z]{12})$/,
  );
  if (deletion && request.method === "DELETE") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const owned = await env.ACCOUNTS.prepare(
      "SELECT id FROM documents WHERE id=? AND user_id=?",
    )
      .bind(deletion[1], user.id)
      .first();
    if (!owned) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    await deleteDocumentObjects(env.VNSH_STORE, deletion[1]);
    await env.ACCOUNTS.prepare("DELETE FROM documents WHERE id=? AND user_id=?")
      .bind(deletion[1], user.id)
      .run();
    return new Response(null, { status: 204 });
  }
  const formDeletion = url.pathname.match(
    /^\/documents\/([0-9A-Za-z]{12})\/delete$/,
  );
  if (formDeletion && request.method === "POST") {
    const user = await currentUser(request, env);
    if (!user)
      return new Response(null, { status: 302, headers: { Location: "/" } });
    const owned = await env.ACCOUNTS.prepare(
      "SELECT id FROM documents WHERE id=? AND user_id=?",
    )
      .bind(formDeletion[1], user.id)
      .first();
    if (owned) {
      await deleteDocumentObjects(env.VNSH_STORE, formDeletion[1]);
      await env.ACCOUNTS.prepare(
        "DELETE FROM documents WHERE id=? AND user_id=?",
      )
        .bind(formDeletion[1], user.id)
        .run();
    }
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }
  const sessionFormDeletion = url.pathname.match(/^\/sessions\/([0-9a-f-]{16,64})\/revoke$/);
  if (sessionFormDeletion && request.method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return new Response(null, { status: 302, headers: { Location: "/" } });
    await env.ACCOUNTS.prepare("DELETE FROM sessions WHERE id=? AND user_id=?")
      .bind(sessionFormDeletion[1], user.id).run();
    const revokedCurrent = sessionFormDeletion[1] === user.sessionId;
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        ...(revokedCurrent ? { "Set-Cookie": `${COOKIE}=; Domain=.vnsh.dev; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } : {}),
      },
    });
  }
  if (url.pathname === "/sessions/revoke-others" && request.method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return new Response(null, { status: 302, headers: { Location: "/" } });
    await env.ACCOUNTS.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?")
      .bind(user.id, user.sessionId).run();
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }
  if (url.pathname === "/account/delete" && request.method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return new Response(null, { status: 302, headers: { Location: "/" } });
    const form = await request.formData();
    if (String(form.get("email") || "").trim().toLowerCase() !== user.email.toLowerCase()) {
      return new Response(
        page('<main><div class="auth-card"><h1>Account not deleted.</h1><p>The confirmation email did not match.</p><a class="button" href="/">Back to library</a></div></main>', "Confirmation failed"),
        { status: 400, headers: htmlHeaders },
      );
    }
    const docs = await env.ACCOUNTS.prepare("SELECT id FROM documents WHERE user_id=?").bind(user.id).all<{ id: string }>();
    for (const document of docs.results) await deleteDocumentObjects(env.VNSH_STORE, document.id);
    const artifacts = await env.ACCOUNTS.prepare("SELECT id FROM artifacts WHERE owner_id=?").bind(user.id).all<{ id: string }>();
    for (const artifact of artifacts.results) await deletePrefix(env.VNSH_STORE, `a/${artifact.id}/`);
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare("DELETE FROM device_logins WHERE user_id=?").bind(user.id),
      env.ACCOUNTS.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id),
      env.ACCOUNTS.prepare("DELETE FROM documents WHERE user_id=?").bind(user.id),
      env.ACCOUNTS.prepare("DELETE FROM magic_links WHERE email=?").bind(user.email),
      env.ACCOUNTS.prepare("DELETE FROM users WHERE id=?").bind(user.id),
    ]);
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE}=; Domain=.vnsh.dev; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    });
  }
  if (url.pathname === "/api/auth/request" && request.method === "POST") {
    if (!env.EMAIL)
      return Response.json({ error: "EMAIL_NOT_CONFIGURED" }, { status: 501 });
    const data = await request.formData();
    const email = String(data.get("email") || "")
      .trim()
      .toLowerCase();
    const device = String(data.get("device") || "").toUpperCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return Response.json({ error: "INVALID_EMAIL" }, { status: 400 });
    const raw = token();
    const now = new Date();
    const expires = new Date(now.getTime() + 15 * 60_000);
    await env.ACCOUNTS.prepare(
      "INSERT INTO magic_links(token_hash,email,expires_at,created_at) VALUES(?,?,?,?)",
    )
      .bind(await hash(raw), email, expires.toISOString(), now.toISOString())
      .run();
    const deviceQuery = /^[A-HJ-NP-Z2-9]{8}$/.test(device)
      ? `&device=${encodeURIComponent(device)}`
      : "";
    const link = `${url.origin}/auth/callback?token=${encodeURIComponent(raw)}${deviceQuery}`;
    try {
      await env.EMAIL.send({
        to: email,
        from: { email: "login@vnsh.dev", name: "vnsh" },
        subject: "Sign in to vnsh",
        text: `Sign in to vnsh: ${link}\n\nThis link expires in 15 minutes.`,
          html: `<p><a href="${link.replace(/&/g, "&amp;")}">Sign in to vnsh</a></p><p>This link expires in 15 minutes.</p>`,
      });
    } catch (error) {
      await env.ACCOUNTS.prepare("DELETE FROM magic_links WHERE token_hash=?")
        .bind(await hash(raw))
        .run();
      console.error("Failed to send sign-in email:", error);
      return Response.json({ error: "EMAIL_SEND_FAILED" }, { status: 502 });
    }
    return new Response(
      page(
        '<main><div class="auth-wrap"><section class="auth-copy"><div class="eyebrow">Link sent</div><h1>Check your inbox.</h1><p class="lede">We sent a secure sign-in link. It expires in 15 minutes and works only once.</p></section><section class="auth-card"><div class="empty-mark">↗</div><h2>Open the email on this device</h2><p>You can close this tab after signing in. If it does not arrive, check spam or request another link.</p><a class="button" href="/">Use another email</a></section></div></main>',
        "Check your email",
      ),
      { headers: htmlHeaders },
    );
  }
  if (url.pathname === "/auth/callback" && request.method === "GET") {
    const raw = url.searchParams.get("token") || "";
    const now = new Date().toISOString();
    const h = await hash(raw);
    const link = await env.ACCOUNTS.prepare(
      "SELECT email FROM magic_links WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
    )
      .bind(h, now)
      .first<{ email: string }>();
    if (!link)
      return new Response(
        page(
          '<main><div class="auth-wrap"><section class="auth-copy"><div class="eyebrow">Sign-in stopped</div><h1>This link is no longer valid.</h1><p class="lede">Magic links expire after 15 minutes and can only be used once.</p></section><section class="auth-card"><h2>Request a fresh link</h2><p>No account data was changed.</p><a class="button primary" href="/">Back to sign in</a></section></div></main>',
          "Link expired",
        ),
        { status: 400, headers: htmlHeaders },
      );
    const id = crypto.randomUUID();
    const consumed = await env.ACCOUNTS.prepare(
      "UPDATE magic_links SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
    )
      .bind(now, h, now)
      .run();
    if (consumed.meta.changes !== 1)
      return new Response(
        page(
          '<main><div class="auth-card"><h1>Link already used.</h1><p>Request a new sign-in link to continue.</p><a class="button primary" href="/">Back to sign in</a></div></main>',
          "Link already used",
        ),
        { status: 400, headers: htmlHeaders },
      );
    await env.ACCOUNTS.prepare(
      "INSERT INTO users(id,email,created_at) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING",
    )
      .bind(id, link.email, now)
      .run();
    const user = await env.ACCOUNTS.prepare(
      "SELECT id FROM users WHERE email=?",
    )
      .bind(link.email)
      .first<{ id: string }>();
    await env.ACCOUNTS.prepare(`INSERT INTO workspaces(id,owner_id,name,slug,is_default,created_at,updated_at)
      SELECT ?,?,'Personal','personal',1,?,? WHERE NOT EXISTS(SELECT 1 FROM workspaces WHERE owner_id=? AND is_default=1)`)
      .bind(crypto.randomUUID(), user!.id, now, now, user!.id).run();
    const session = token();
    const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
    await env.ACCOUNTS.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at,id,kind,label,last_used_at) VALUES(?,?,?,?,?,?,?,?)",
    )
      .bind(await hash(session), user!.id, expires, now, crypto.randomUUID(), "browser", "Browser session", now)
      .run();
    const device = (url.searchParams.get("device") || "").toUpperCase();
    const location = /^[A-HJ-NP-Z2-9]{8}$/.test(device)
      ? `/device?code=${device}`
      : "/";
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        "Set-Cookie": `${COOKIE}=${session}; Domain=.vnsh.dev; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      },
    });
  }
  if (url.pathname === "/logout" && request.method === "POST") {
    const raw = cookieValue(request);
    if (raw)
      await env.ACCOUNTS.prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(await hash(raw))
        .run();
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE}=; Domain=.vnsh.dev; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    });
  }
  const user = await currentUser(request, env);
  if (!user)
    return new Response(
      page(
        '<main><div class="auth-wrap"><section class="auth-copy"><div class="eyebrow">Permanent library</div><h1>Your work should outlive the handoff.</h1><p class="lede">Keep work until you delete it, then choose the boundary that fits each handoff.</p><div class="notice"><span class="shield">◇</span><div><b>Two explicit modes.</b><br>Encrypted links stay host-blind with keys only in the URL. Account Artifacts are readable by vnsh so authorized Agents can discover and collaborate on them.</div></div></section><section class="auth-card"><h2>Sign in to vnsh</h2><p>No password. We will email you a secure, single-use link.</p><form method="post" action="/api/auth/request"><label for="email">Email address</label><input id="email" type="email" name="email" autocomplete="email" required placeholder="you@example.com"><button>Send magic link →</button></form><p class="fine">Free preview · Permanent storage · Delete anytime</p></section></div></main>',
        "Sign in",
      ),
      { headers: htmlHeaders },
    );
  const docs = await env.ACCOUNTS.prepare(
    "SELECT id,kind,visibility,size,version,history_size,history_versions,created_at,updated_at FROM documents WHERE user_id=? ORDER BY updated_at DESC LIMIT 200",
  )
    .bind(user.id)
    .all();
  let workspaces = await env.ACCOUNTS.prepare(`SELECT w.*,COUNT(a.id) AS artifact_count FROM workspaces w
    LEFT JOIN artifacts a ON a.workspace_id=w.id WHERE w.owner_id=? AND w.archived_at IS NULL
    GROUP BY w.id ORDER BY w.is_default DESC,w.updated_at DESC`).bind(user.id).all<any>();
  if (!workspaces.results.length) {
    const now = new Date().toISOString();
    await env.ACCOUNTS.prepare('INSERT INTO workspaces(id,owner_id,name,slug,is_default,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
      .bind(crypto.randomUUID(), user.id, 'Personal', 'personal', now, now).run();
    workspaces = await env.ACCOUNTS.prepare(`SELECT w.*,0 AS artifact_count FROM workspaces w WHERE w.owner_id=? ORDER BY w.is_default DESC`)
      .bind(user.id).all<any>();
  }
  const requestedWorkspace = url.searchParams.get("workspace");
  const selectedWorkspace = workspaces.results.find((workspace: any) => workspace.id === requestedWorkspace) || workspaces.results[0];
  const query = (url.searchParams.get("q") || "").trim().slice(0, 200);
  const artifacts = await env.ACCOUNTS.prepare(
    `SELECT id,title,summary,artifact_type,status,current_version,current_size,history_size,updated_at
       FROM artifacts WHERE owner_id=? AND workspace_id=? AND (?='' OR title LIKE ? OR summary LIKE ?)
       ORDER BY updated_at DESC LIMIT 100`,
  ).bind(user.id, selectedWorkspace.id, query, `%${query}%`, `%${query}%`).all();
  const artifactTotal = await env.ACCOUNTS.prepare(
    "SELECT COUNT(*) AS count FROM artifacts WHERE owner_id=?",
  ).bind(user.id).first<{ count: number }>();
  const sessions = await env.ACCOUNTS.prepare(
    "SELECT id,kind,label,created_at,last_used_at,expires_at FROM sessions WHERE user_id=? ORDER BY last_used_at DESC",
  ).bind(user.id).all();
  const formatBytes = (n: number) =>
    n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
  const cards = docs.results
    .map(
      (d: any) =>
        `<article class="card"><div class="card-top"><span class="badge ${d.kind === "workspace" ? "workspace" : ""}">${esc(d.kind)}</span><span class="visibility">${d.visibility === "public" ? "Public" : "Encrypted"}</span></div><div class="doc-id">${esc(d.id)}</div><div class="doc-meta">Version ${Number(d.version)} · ${formatBytes(Number(d.size))} current · ${Number(d.history_versions || 0)} retained versions (${formatBytes(Number(d.history_size || 0))}) · updated ${esc(new Date(String(d.updated_at)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }))}</div><div class="card-foot"><span class="kept">∞ kept permanently</span><details class="danger"><summary>Delete…</summary><form method="post" action="/documents/${esc(d.id)}/delete"><button class="delete">Confirm delete</button></form></details></div></article>`,
    )
    .join("");
  const artifactCount = docs.results.filter(
    (d: any) => d.kind === "artifact",
  ).length + Number(artifactTotal?.count || 0);
  const usage = await accountUsage(env, user.id);
  const artifactCards = artifacts.results.map((artifact: any) =>
    `<a class="artifact-card" href="/artifacts/${esc(artifact.id)}"><span class="artifact-type">${esc(artifact.artifact_type)}</span><h3>${esc(artifact.title)}</h3><p>${esc(artifact.summary || "No summary yet")}</p><footer><span class="${artifact.status === "in_review" ? "review-status" : ""}">${esc(artifact.status.replace("_", " "))} · v${Number(artifact.current_version)}</span><span>${esc(new Date(String(artifact.updated_at)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }))}</span></footer></a>`,
  ).join("");
  const workspaceNav = workspaces.results.map((workspace: any) =>
    `<a class="${workspace.id === selectedWorkspace.id ? "active" : ""}" href="/?workspace=${esc(workspace.id)}">${esc(workspace.name)} · ${Number(workspace.artifact_count || 0)}</a>`,
  ).join("");
  const sessionCards = sessions.results.map((session: any) =>
    `<article class="card"><div class="card-top"><span class="badge workspace">${esc(session.kind)}</span><span class="visibility">${session.id === user.sessionId ? "Current" : "Active"}</span></div><div class="doc-id">${esc(session.label)}</div><div class="doc-meta">Last used ${esc(new Date(String(session.last_used_at || session.created_at)).toLocaleString("en-US", { timeZone: "UTC" }))} UTC<br>Expires ${esc(new Date(String(session.expires_at)).toLocaleDateString("en-US", { timeZone: "UTC" }))}</div><div class="card-foot"><span class="kept">${session.id === user.sessionId ? "this session" : "authorized"}</span><form method="post" action="/sessions/${esc(session.id)}/revoke" style="margin-left:auto"><button class="delete">Revoke</button></form></div></article>`,
  ).join("");
  return new Response(
    page(
      `<main><div class="hero-row"><div><div class="eyebrow">${esc(selectedWorkspace.name)} Workspace</div><h1>Work worth keeping.</h1><p class="identity"><strong>${esc(user.email)}</strong> · Organize permanent Account Artifacts by project.</p></div><div class="stats"><div class="stat"><b>${usage.documents}/${FREE_DOCUMENT_LIMIT}</b><span>Documents</span></div><div class="stat"><b>${artifactCount}</b><span>Artifacts</span></div><div class="stat"><b>${formatBytes(usage.totalBytes)} / 1 GB</b><span>Stored incl. history</span></div></div></div><div class="workspace-bar">${workspaceNav}<form class="workspace-create" method="post" action="/workspaces"><input name="name" maxlength="80" placeholder="New Workspace" required><button>Create</button></form></div><div class="mode-tabs"><a class="active" href="/?workspace=${esc(selectedWorkspace.id)}">Account Artifacts</a><a href="#incognito">Incognito Artifacts</a></div><form class="library-tools" method="get" action="/"><input type="hidden" name="workspace" value="${esc(selectedWorkspace.id)}"><input name="q" value="${esc(query)}" placeholder="Search this Workspace"><button>Search</button></form><section class="artifact-grid">${artifactCards || '<div class="empty"><div class="empty-mark">◇</div><h2>No matching Artifacts</h2><p>Create through the Account Artifact API, or connect an Agent.</p><div class="actions" style="justify-content:center"><a class="button primary" href="https://vnsh.dev/llms.txt">Connect an Agent</a></div></div>'}</section><div id="incognito" class="section-head"><h2>Incognito Artifacts</h2><span>Host-blind · key stays in the URL</span></div><div class="notice"><span class="shield">◇</span><div><b>Two explicit modes.</b> Account Artifacts are permanent and organized in Workspaces. Incognito Artifacts are encrypted, temporary, and never readable by vnsh.</div></div><section class="grid">${cards || '<div class="empty"><h2>No saved Incognito Artifacts</h2><p>Quick encrypted sharing remains account-free.</p></div>'}</section><div class="section-head"><h2>Devices and tokens</h2><span>${sessions.results.length} active</span></div><section class="grid">${sessionCards}</section><div class="actions"><form method="post" action="/api/account/token"><input name="label" maxlength="60" placeholder="Token name (for example, Cursor laptop)" required><button class="button primary">Create CLI / agent token</button></form><form method="post" action="/sessions/revoke-others"><button>Revoke all other sessions</button></form><a class="button" href="https://vnsh.dev/llms.txt">Agent setup guide</a><form method="post" action="/logout"><button class="link-button">Sign out</button></form></div><div class="section-head"><h2>Delete account</h2><span>Permanent and irreversible</span></div><div class="notice"><span class="shield">!</span><div><b>Deletes every Workspace, Artifact, retained version, device and token.</b><form method="post" action="/account/delete"><label for="delete-email">Type ${esc(user.email)} to confirm</label><input id="delete-email" name="email" type="email" autocomplete="off" required><button class="delete">Delete account and all documents</button></form></div></div></main>`,
    ),
    { headers: htmlHeaders },
  );
}
