import type { ReactNode } from 'react';
export default function Link({ children, href }: { children: ReactNode; href: string }) { return <a href={href}>{children}</a>; }
export const fixture = { restored: false, fail: false, pending: false };
export const requests: { method: string; path: string; body: unknown }[] = [];
export const candidate = { sessionId: 'original-session', snapshotToken: 'reviewed-snapshot', conversationId: 'group:topic:7', assistantId: 'assistant', assistantName: 'Planning assistant', title: 'Weekly team planning', messageCount: 42, skippedMessageCount: 8, sensitivity: 'internal', compartments: ['planning'], projectId: null, projectName: null };
export async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const path = new URL(input, location.origin).pathname;
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ method, path, body });
  if (path.endsWith('/legacy-recovery')) {
    if (method === 'GET') return Response.json({ candidates: fixture.restored ? [] : [candidate] });
    if (fixture.pending) await new Promise(resolve => setTimeout(resolve, 800));
    if (fixture.fail) return Response.json({ error: 'recovery_stale' }, { status: 409 });
    fixture.restored = true;
    return Response.json({ sessionId: 'recovered-session', policyId: 'policy', revision: 1 });
  }
  if (path.endsWith('/recordings')) return Response.json({ ownership: 'needs_confirmation', recordings: [] });
  if (path.includes('/projects')) return Response.json({ projects: [] });
  return Response.json({});
}
export function useRouter() { return { push() {}, replace() {}, prefetch() {} }; }
export async function getValidAccessToken() { return 'synthetic-local-fixture'; }
