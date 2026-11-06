/** Native workspace OAuth consent. [COMP:app-web/workspace-consent] */
import { z } from 'zod';
import { getAccessToken } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
const uuid = z.string().uuid();
const schema = z.object({ clientName: z.string().nullable(), clientUri: z.string().nullable(), scope: z.enum(['read','read_write']),
  workspaces: z.array(z.object({ id: uuid, name: z.string() })), workspaceAccessAvailable: z.boolean(), workspaceAccessRequired: z.boolean().optional(), assistantId: uuid.optional() });
export type WorkspaceConsentReview = z.infer<typeof schema>;
function endpoint(assistantId?: string) {
  return `${publicRuntimeConfig().apiUrl}${assistantId ? `/api/v1/assistants/${uuid.parse(assistantId)}/oauth` : '/api/brain/oauth'}/consent`;
}
function requestValue(req: string) { return z.string().min(1).max(16384).parse(req); }
async function send(url: string, init: RequestInit) {
  const token = getAccessToken();
  if (!token) throw Error('workspace_signin_required');
  const response = await fetch(url, { ...init, cache: 'no-store', redirect: 'error', headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (response.status === 401) throw Error('workspace_signin_required');
  if (!response.ok) throw Error('access_unavailable');
  return response;
}
export function workspaceConsentSignInUrl(req: string, assistantId?: string, current = window.location.href) {
  const raw = publicRuntimeConfig().primaryAuthUrl;
  if (!raw) throw Error('access_unavailable');
  const portal = new URL(raw);
  if (portal.username || portal.password || portal.pathname !== '/' || portal.search || portal.hash || portal.protocol !== 'https:' && !(portal.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(portal.hostname))) throw Error('access_unavailable');
  const next = new URL('/oauth/authorize', new URL(current).origin);
  next.searchParams.set('req', requestValue(req));
  if (assistantId) next.searchParams.set('assistant', uuid.parse(assistantId));
  const login = new URL('/login', portal); login.searchParams.set('next', next.toString()); return login.toString();
}
export async function fetchWorkspaceConsent(req: string, assistantId?: string, signal?: AbortSignal) {
  const response = await send(`${endpoint(assistantId)}?${new URLSearchParams({ req: requestValue(req) })}`, { signal });
  const review = schema.parse(await response.json());
  if (review.assistantId !== assistantId || assistantId && !review.workspaceAccessRequired) throw Error('access_unavailable');
  return review;
}
export async function decideWorkspaceConsent(req: string, assistantId: string | undefined, review: WorkspaceConsentReview,
  input: { workspaceId: string; decision: 'allow' | 'deny'; grantedScope: 'read' | 'read_write'; workspaceAccess: boolean }) {
  const current = schema.parse(review);
  if (current.assistantId !== assistantId || !current.workspaces.some(w => w.id === input.workspaceId)
    || current.scope === 'read' && input.grantedScope !== 'read'
    || input.decision === 'allow' && (current.workspaceAccessRequired && !input.workspaceAccess || input.workspaceAccess && !current.workspaceAccessAvailable)) throw Error('access_unavailable');
  const response = await send(endpoint(assistantId), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ req: requestValue(req), ...input }) });
  const { redirectUrl } = z.object({ redirectUrl: z.string().url() }).parse(await response.json());
  const url = new URL(redirectUrl);
  if (url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw Error('access_unavailable');
  return redirectUrl;
}
