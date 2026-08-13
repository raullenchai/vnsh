export interface AnalyticsEnv {
  VNSH_ANALYTICS?: AnalyticsEngineDataset;
}

export type TrackedEvent =
  | 'upload' | 'read' | 'workspace_create' | 'workspace_read'
  | 'workspace_update' | 'workspace_restore' | 'workspace_conflict'
  | 'workspace_renew' | 'page_view' | 'prompt_seen' | 'prompt_copy';

const BEACON_EVENTS: readonly TrackedEvent[] = ['page_view', 'prompt_seen', 'prompt_copy'];
const REFERRERS = ['w', 'home', 'direct'] as const;

export function getClientAgent(request: Request): string {
  const raw = request.headers.get('X-Vnsh-Agent') || '';
  const clean = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean ? clean.slice(0, 32) : 'unknown';
}

function getClientSource(request: Request): string {
  const source = (request.headers.get('X-Vnsh-Client') || '').split('/')[0];
  return ['cli', 'cli-npm', 'mcp', 'extension', 'web', 'pipe'].includes(source)
    ? source : 'unknown';
}

function getClientVersion(request: Request): string {
  const version = (request.headers.get('X-Vnsh-Client') || '').split('/')[1] || '';
  return version.replace(/[^0-9A-Za-z.\-]/g, '').slice(0, 24);
}

export function getClientRef(value: string | null): string {
  const ref = (value || '').toLowerCase();
  return (REFERRERS as readonly string[]).includes(ref) ? ref : 'direct';
}

interface EventDimensions {
  workspaceId?: string;
  agent?: string;
  ref?: string;
  visibility?: string;
  retention?: string;
}

export function trackEvent(
  env: AnalyticsEnv,
  event: TrackedEvent,
  request: Request,
  dims: EventDimensions = {},
): void {
  if (!env.VNSH_ANALYTICS) return;
  try {
    env.VNSH_ANALYTICS.writeDataPoint({
      // Append-only slot layout. blob9 measures the vn init experiment without
      // collecting a project name or path.
      blobs: [event, getClientSource(request), dims.workspaceId || '', dims.agent || '',
        dims.ref || '', dims.visibility || '', getClientVersion(request), dims.retention || '',
        request.headers.get('X-Vnsh-Project') === '1' ? 'initialized' : ''],
      doubles: [1],
      indexes: [event],
    });
  } catch (err) {
    console.error('Analytics write failed:', err);
  }
}

export async function handleEvent(
  request: Request,
  env: AnalyticsEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const noContent = new Response(null, { status: 204, headers: corsHeaders });
  try {
    const body = (await request.json()) as { event?: string; ref?: string };
    const event = body?.event as TrackedEvent;
    if (!BEACON_EVENTS.includes(event)) return noContent;
    trackEvent(env, event, request, { ref: getClientRef(body?.ref ?? null) });
  } catch {
    // Metrics are best-effort and never affect the user-visible request.
  }
  return noContent;
}
