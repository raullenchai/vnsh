export interface AccountEnv {
  ACCOUNTS: D1Database;
  EMAIL?: SendEmail;
  VNSH_STORE: R2Bucket;
}

export interface AccountUser { id: string; email: string; tier: string }

const COOKIE = 'vnsh_session';
const enc = new TextEncoder();
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hash(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))));
}

function cookieValue(request: Request): string | null {
  const match = request.headers.get('Cookie')?.match(/(?:^|;\s*)vnsh_session=([^;]+)/);
  return match ? match[1] : null;
}

export async function currentUser(request: Request, env: AccountEnv): Promise<AccountUser | null> {
  const bearer = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const raw = bearer || cookieValue(request);
  if (!raw || raw.length > 256) return null;
  return env.ACCOUNTS.prepare(`SELECT u.id, u.email, u.tier FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
    .bind(await hash(raw), new Date().toISOString()).first<AccountUser>();
}

const page = (body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>vnsh account</title><style>body{font:16px system-ui;max-width:760px;margin:8vh auto;padding:24px;color:#18212f}input,button{font:inherit;padding:10px}input{width:min(420px,90%)}li{margin:12px 0}code{font-size:13px}</style>${body}`;
const htmlHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export async function handleAccount(request: Request, env: AccountEnv, url: URL): Promise<Response> {
  if (url.pathname === '/api/account/documents' && request.method === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    const docs = await env.ACCOUNTS.prepare('SELECT id,kind,visibility,size,version,created_at,updated_at FROM documents WHERE user_id=? ORDER BY updated_at DESC LIMIT 200').bind(user.id).all();
    return Response.json({ user, documents: docs.results }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/api/account/token' && request.method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    const raw = token(); const now = new Date().toISOString();
    await env.ACCOUNTS.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
      .bind(await hash(raw), user.id, new Date(Date.now() + 365 * 86400_000).toISOString(), now).run();
    return new Response(page(`<h1>CLI / agent token</h1><p>Copy this now. It is shown once.</p><pre>${raw}</pre><p><code>export VNSH_TOKEN='${raw}'</code></p><a href="/">Back to account</a>`), { headers: htmlHeaders });
  }
  const deletion = url.pathname.match(/^\/api\/account\/documents\/([0-9A-Za-z]{12})$/);
  if (deletion && request.method === 'DELETE') {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    const owned = await env.ACCOUNTS.prepare('SELECT id FROM documents WHERE id=? AND user_id=?').bind(deletion[1], user.id).first();
    if (!owned) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    await env.VNSH_STORE.delete(`w/${deletion[1]}`);
    await env.ACCOUNTS.prepare('DELETE FROM documents WHERE id=? AND user_id=?').bind(deletion[1], user.id).run();
    return new Response(null, { status: 204 });
  }
  const formDeletion = url.pathname.match(/^\/documents\/([0-9A-Za-z]{12})\/delete$/);
  if (formDeletion && request.method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return new Response(null, { status: 302, headers: { Location: '/' } });
    const owned = await env.ACCOUNTS.prepare('SELECT id FROM documents WHERE id=? AND user_id=?').bind(formDeletion[1], user.id).first();
    if (owned) {
      await env.VNSH_STORE.delete(`w/${formDeletion[1]}`);
      await env.ACCOUNTS.prepare('DELETE FROM documents WHERE id=? AND user_id=?').bind(formDeletion[1], user.id).run();
    }
    return new Response(null, { status: 302, headers: { Location: '/' } });
  }
  if (url.pathname === '/api/auth/request' && request.method === 'POST') {
    if (!env.EMAIL) return Response.json({ error: 'EMAIL_NOT_CONFIGURED' }, { status: 501 });
    const data = await request.formData();
    const email = String(data.get('email') || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: 'INVALID_EMAIL' }, { status: 400 });
    const raw = token(); const now = new Date(); const expires = new Date(now.getTime() + 15 * 60_000);
    await env.ACCOUNTS.prepare('INSERT INTO magic_links(token_hash,email,expires_at,created_at) VALUES(?,?,?,?)')
      .bind(await hash(raw), email, expires.toISOString(), now.toISOString()).run();
    const link = `https://account.vnsh.dev/auth/callback?token=${encodeURIComponent(raw)}`;
    try {
      await env.EMAIL.send({ to: email, from: { email: 'login@vnsh.dev', name: 'vnsh' }, subject: 'Sign in to vnsh', text: `Sign in to vnsh: ${link}\n\nThis link expires in 15 minutes.`, html: `<p><a href="${link}">Sign in to vnsh</a></p><p>This link expires in 15 minutes.</p>` });
    } catch (error) {
      await env.ACCOUNTS.prepare('DELETE FROM magic_links WHERE token_hash=?').bind(await hash(raw)).run();
      console.error('Failed to send sign-in email:', error);
      return Response.json({ error: 'EMAIL_SEND_FAILED' }, { status: 502 });
    }
    return new Response(page('<h1>Check your email</h1><p>The sign-in link expires in 15 minutes.</p>'), { headers: htmlHeaders });
  }
  if (url.pathname === '/auth/callback' && request.method === 'GET') {
    const raw = url.searchParams.get('token') || ''; const now = new Date().toISOString(); const h = await hash(raw);
    const link = await env.ACCOUNTS.prepare('SELECT email FROM magic_links WHERE token_hash=? AND used_at IS NULL AND expires_at>?').bind(h, now).first<{email:string}>();
    if (!link) return new Response(page('<h1>Link expired</h1><a href="/">Try again</a>'), { status: 400, headers: { 'Content-Type': 'text/html' } });
    const id = crypto.randomUUID();
    const consumed = await env.ACCOUNTS.prepare('UPDATE magic_links SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?')
      .bind(now, h, now).run();
    if (consumed.meta.changes !== 1) return new Response(page('<h1>Link expired</h1><a href="/">Try again</a>'), { status: 400, headers: htmlHeaders });
    await env.ACCOUNTS.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING').bind(id, link.email, now).run();
    const user = await env.ACCOUNTS.prepare('SELECT id FROM users WHERE email=?').bind(link.email).first<{id:string}>();
    const session = token(); const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
    await env.ACCOUNTS.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await hash(session), user!.id, expires, now).run();
    return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': `${COOKIE}=${session}; Domain=.vnsh.dev; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` } });
  }
  if (url.pathname === '/logout' && request.method === 'POST') {
    const raw = cookieValue(request); if (raw) await env.ACCOUNTS.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await hash(raw)).run();
    return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': `${COOKIE}=; Domain=.vnsh.dev; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
  }
  const user = await currentUser(request, env);
  if (!user) return new Response(page('<h1>vnsh account</h1><p>Signed-in workspaces and artifacts are kept until you delete them.</p><form method="post" action="/api/auth/request"><input type="email" name="email" required placeholder="you@example.com"><button>Send magic link</button></form>'), { headers: htmlHeaders });
  const docs = await env.ACCOUNTS.prepare('SELECT id,kind,visibility,size,version,created_at,updated_at FROM documents WHERE user_id=? ORDER BY updated_at DESC LIMIT 200').bind(user.id).all();
  const items = docs.results.map((d: any) => `<li>${esc(d.kind)} <code>${esc(d.id)}</code> · v${Number(d.version)} · ${Number(d.size)} bytes <form style="display:inline" method="post" action="/documents/${esc(d.id)}/delete"><button>Delete</button></form></li>`).join('');
  return new Response(page(`<h1>Your vnsh</h1><p>${esc(user.email)} · free preview · permanent storage</p><p>Keep each document link: its decryption key stays in the URL and is never stored in your account.</p><ul>${items || '<li>No saved documents yet.</li>'}</ul><form method="post" action="/api/account/token"><button>Create CLI / agent token</button></form><form method="post" action="/logout"><button>Sign out</button></form>`), { headers: htmlHeaders });
}
