#!/usr/bin/env node
/**
 * Print the funnel from Analytics Engine.
 *
 * Exists because /api/stats needs an API token with Account Analytics Read, and
 * minting one is a dashboard action. Querying does not: an existing `wrangler
 * login` session can already read the SQL API, so the numbers are available
 * without anyone creating a credential first. The endpoint is still the right
 * thing for remote or scripted access; this is for looking.
 *
 *   npm run stats           # last 14 days
 *   npm run stats -- 30     # last 30 days
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ACCOUNT_ID = 'f25478810829faf5ccc86f4ed9a96ef1';
const ACCOUNTS_DB_ID = '75cdfa36-d2e4-4489-ab8e-8fb06c0dfcd6';
const DATASET = 'vnsh_events';
const DAYS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 14;

// Prefer an explicit token; otherwise borrow the wrangler OAuth session. The
// paths differ per platform and wrangler has moved them before, so try the
// known ones rather than assuming one.
function resolveToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const candidates = [
    join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
    join(homedir(), '.config/.wrangler/config/default.toml'),
    join(homedir(), '.wrangler/config/default.toml'),
  ];
  for (const path of candidates) {
    try {
      const match = readFileSync(path, 'utf-8').match(/^oauth_token\s*=\s*"([^"]+)"/m);
      if (match?.[1]) return match[1];
    } catch {
      // Not this path; keep looking.
    }
  }
  return null;
}

const token = resolveToken();
if (!token) {
  console.error('No credential. Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN.');
  process.exit(1);
}

async function query(sql) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: sql },
  );
  const text = await response.text();
  if (!response.ok) {
    // An expired OAuth session is the common case and says nothing useful on
    // its own, so name the fix rather than printing the raw error.
    if (response.status === 401 || response.status === 403) {
      console.error('Credential rejected. `npx wrangler login` refreshes it.');
      process.exit(1);
    }
    console.error(`Query failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
    process.exit(1);
  }
  return JSON.parse(text).data ?? [];
}

async function d1Query(sql) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${ACCOUNTS_DB_ID}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    },
  );
  const body = await response.json();
  if (!response.ok || !body.success) {
    console.error(`D1 metrics query failed (HTTP ${response.status}).`);
    process.exit(1);
  }
  return body.result?.[0]?.results ?? [];
}

const WINDOW = `timestamp > NOW() - INTERVAL '${DAYS}' DAY`;
const n = (row) => Number(row.n);

const [funnel, sources, refs, agents, visibility, retention, workspaceActivity, daily, accounts] = await Promise.all([
  query(`SELECT blob1 AS k, sum(_sample_interval) AS n FROM ${DATASET}
         WHERE ${WINDOW} GROUP BY blob1 ORDER BY n DESC FORMAT JSON`),
  query(`SELECT blob2 AS k, sum(_sample_interval) AS n FROM ${DATASET}
         WHERE ${WINDOW} AND blob1 LIKE 'workspace%' GROUP BY blob2 ORDER BY n DESC FORMAT JSON`),
  query(`SELECT blob5 AS k, sum(_sample_interval) AS n FROM ${DATASET}
         WHERE ${WINDOW} AND blob1 = 'workspace_create' GROUP BY blob5 ORDER BY n DESC FORMAT JSON`),
  query(`SELECT blob4 AS k, sum(_sample_interval) AS n FROM ${DATASET}
         WHERE ${WINDOW} AND blob4 != '' GROUP BY blob4 ORDER BY n DESC FORMAT JSON`),
  // The SQL API is a ClickHouse subset without concat(), so the two columns are
  // fetched separately and joined here.
  query(`SELECT blob1 AS k, blob6 AS v, sum(_sample_interval) AS n FROM ${DATASET}
         WHERE ${WINDOW} AND blob6 != '' GROUP BY blob1, blob6 ORDER BY n DESC FORMAT JSON`),
  query(`SELECT blob8 AS k, sum(_sample_interval) AS n FROM ${DATASET}
         WHERE ${WINDOW} AND blob1 = 'workspace_create' AND blob8 != '' GROUP BY blob8 ORDER BY n DESC FORMAT JSON`),
  query(`SELECT blob3 AS workspace, blob4 AS agent, blob1 AS event, sum(_sample_interval) AS n
         FROM ${DATASET} WHERE ${WINDOW} AND blob3 != '' AND blob1 LIKE 'workspace%'
         GROUP BY workspace, agent, event FORMAT JSON`),
  query(`SELECT toDate(timestamp) AS d, blob1 AS k, sum(_sample_interval) AS n FROM ${DATASET}
         WHERE ${WINDOW} GROUP BY d, blob1 ORDER BY d DESC FORMAT JSON`),
  d1Query(`SELECT
    (SELECT count(*) FROM users) AS users,
    (SELECT count(*) FROM documents) AS documents,
    (SELECT count(DISTINCT user_id) FROM documents) AS users_with_documents,
    (SELECT count(*) FROM documents WHERE version > 1) AS edited_documents,
    (SELECT count(*) FROM sessions WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS active_sessions`),
]);

const total = Object.fromEntries(funnel.map((r) => [r.k, n(r)]));
const table = (rows, label) => {
  console.log(`\n${label}`);
  if (!rows.length) return console.log('  (nothing)');
  // Width from the content, so a long label cannot push the counts out of line.
  const width = Math.max(22, ...rows.map((r) => (r.k || '(unset)').length + 2));
  for (const r of rows) console.log(`  ${(r.k || '(unset)').padEnd(width)}${String(n(r)).padStart(7)}`);
};

console.log(`vnsh — last ${DAYS} days\n`);
console.log('funnel');
// Ordered as the journey runs, not by size: a stage that never fires is the
// thing worth seeing, and sorting by count buries a zero at the bottom.
for (const stage of ['page_view', 'prompt_seen', 'prompt_copy', 'workspace_create', 'workspace_update', 'workspace_restore', 'workspace_conflict', 'workspace_read']) {
  const count = total[stage] ?? 0;
  console.log(`  ${stage.padEnd(22)}${String(count).padStart(7)}${count === 0 ? '   <- never fired' : ''}`);
}

// Two ratios, because they answer different questions. A low reach rate is a
// placement problem; a low take rate with healthy reach is an offer problem.
const views = total.page_view ?? 0;
const seen = total.prompt_seen ?? 0;
const copies = total.prompt_copy ?? 0;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
if (views) {
  console.log(`\n  reached the CTA (view -> seen): ${pct(seen, views)}`);
  console.log(`  took it        (seen -> copy): ${pct(copies, seen)}`);
}

// Only populated from 2026-07-29 onward; rows written before that carry no
// visibility, which is why this reads lower than the totals above.
table(
  visibility.map((r) => ({ k: `${r.k} / ${r.v}`, n: r.n })),
  'public vs encrypted (since the dimension was added)',
);
table(sources, 'workspace events by client');
table(refs, 'workspace_create by referrer');
table(agents, 'agents seen (X-Vnsh-Agent)');
table(retention, 'new workspaces by retention (populated after accounts metrics deployment)');

const workspaces = new Map();
for (const row of workspaceActivity) {
  if (!workspaces.has(row.workspace)) workspaces.set(row.workspace, { agents: new Set(), events: {} });
  const workspace = workspaces.get(row.workspace);
  // "unknown" is the absence of an MCP initialize identity, not an agent.
  // Counting it would turn one named agent plus anonymous HTTP traffic into a
  // false multi-agent workspace.
  if (row.agent && row.agent !== 'unknown') workspace.agents.add(row.agent);
  workspace.events[row.event] = (workspace.events[row.event] ?? 0) + n(row);
}
const multiAgent = [...workspaces.values()].filter((workspace) => workspace.agents.size > 1).length;
const agentAttributed = [...workspaces.values()].filter((workspace) => workspace.agents.size > 0).length;
const updates = total.workspace_update ?? 0;
const conflicts = total.workspace_conflict ?? 0;
console.log('\nproduct decision signals');
console.log(`  workspaces with agent identity ${String(agentAttributed).padStart(7)}`);
console.log(`  touched by >1 distinct agent   ${String(multiAgent).padStart(7)}  (${pct(multiAgent, agentAttributed)})`);
console.log(`  write conflict rate            ${String(conflicts).padStart(7)}  (${pct(conflicts, updates + conflicts)})`);
const account = accounts[0] || {};
console.log(`  accounts                       ${String(account.users ?? 0).padStart(7)}`);
console.log(`  accounts with saved documents  ${String(account.users_with_documents ?? 0).padStart(7)}`);
console.log(`  permanent documents            ${String(account.documents ?? 0).padStart(7)}`);
console.log(`  edited permanent documents     ${String(account.edited_documents ?? 0).padStart(7)}`);
console.log(`  active sessions/tokens         ${String(account.active_sessions ?? 0).padStart(7)}`);

console.log('\nby day');
const byDay = new Map();
for (const row of daily) {
  if (!byDay.has(row.d)) byDay.set(row.d, {});
  byDay.get(row.d)[row.k] = n(row);
}
console.log(`  ${'date'.padEnd(12)}${'views'.padStart(7)}${'copies'.padStart(8)}${'create'.padStart(8)}${'read'.padStart(7)}`);
for (const [day, v] of byDay) {
  console.log(
    `  ${day.padEnd(12)}${String(v.page_view ?? 0).padStart(7)}${String(v.prompt_copy ?? 0).padStart(8)}` +
      `${String(v.workspace_create ?? 0).padStart(8)}${String(v.workspace_read ?? 0).padStart(7)}`,
  );
}
console.log('');
