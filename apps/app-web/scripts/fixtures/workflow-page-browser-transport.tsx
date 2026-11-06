import type { AnchorHTMLAttributes } from 'react';
import type { WorkflowFull } from '@/lib/api/workflow';

// Synthetic transport and Next router boundary; production page/components stay real.
export const requests: Array<{ path: string; method: string }> = [];
export const fixture = {
  consent: 'empty',
  workflow: {
    id: 'fictional-workflow', workspaceId: 'fictional-workspace', createdBy: 'fictional-user',
    name: 'Website enquiry notifications', description: 'Notify the sales team when a new enquiry is recorded.',
    enabled: true, lifecycleState: 'active', trigger: { kind: 'event', event: { sources: [{ kind: 'host', event: 'crm.submission.created' }] } },
    definition: { startStepId: 'read', steps: [
      { id: 'read', type: 'tool_call', description: 'Read the enquiry', toolName: 'getCrmSubmission', arguments: { id: '{{trigger.id}}' } },
      { id: 'notify', type: 'assistant_call', description: 'Notify the sales team', target: { assistantId: 'primary' }, prompt: 'Summarize the enquiry for the sales team.',
        deliver: { channelType: 'telegram', channelId: '-100000000001', channelIntegrationId: 'fictional-integration' } },
    ] },
    contextGroupId: null, contextProjectId: null, webhookSlug: null, webhookSecret: null,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
  } as unknown as WorkflowFull,
};
export const useRouter = () => ({ push() {}, replace() {}, prefetch() {}, back() {} });
export const usePathname = () => '/w/fictional-workspace/workflow/fictional-workflow';
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({ workspaceId: 'fictional-workspace' });
export default function Link({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a href={href} {...props} />; }
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const path = new URL(url, location.origin).pathname;
  const method = init.method || 'GET';
  requests.push({ path, method });
  const json = (value: unknown) => Response.json(value);
  if (path.endsWith('/publication-consents')) {
    if (fixture.consent === 'hang') return new Promise(() => {});
    if (fixture.consent === 'error') return new Response(null, { status: 503 });
    return json({ canManage: true, workflowUpdatedAt: fixture.workflow.updatedAt, consentVersion: '1', eligibleStepIds: fixture.consent === 'eligible' ? ['notify'] : [], consents: [] });
  }
  if (path.endsWith('/fictional-workflow') && method === 'PATCH') {
    fixture.workflow = { ...fixture.workflow, ...JSON.parse(String(init.body)), updatedAt: new Date().toISOString() };
    return json(fixture.workflow);
  }
  if (path.endsWith('/fictional-workflow')) return json(fixture.workflow);
  if (path.endsWith('/runs')) return json({ runs: [{ id: 'fictional-run', status: 'completed', startedAt: '2026-11-04T01:00:00Z', finishedAt: '2026-11-04T01:00:02Z' }] });
  if (path.endsWith('/intake')) return json({ configured: false, enabled: false, revision: 0 });
  if (path.endsWith('/intake-proposals')) return json({ proposals: [] });
  if (path.endsWith('/groups')) return json({ groups: [] });
  if (path.endsWith('/projects')) return json({ projects: [] });
  if (path.endsWith('/assignments')) return json({ assignments: [] });
  if (path.endsWith('/members')) return json({ members: [] });
  if (path.endsWith('/assistants')) return json({ assistants: [] });
  if (path.endsWith('/skills')) return json({ skills: [] });
  if (path.endsWith('/views')) return json({ views: [] });
  if (path.endsWith('/custom-page-templates')) return json({ templates: [] });
  if (path.endsWith('/connectors')) return json({ connectors: [] });
  if (path.endsWith('/channel-destinations')) return json({ destinations: [] });
  if (path.endsWith('/channel-options')) return json({ channels: [] });
  if (path.endsWith('/slack-channels')) return json({ channels: [] });
  if (path.endsWith('/picker-preferences')) return json({});
  return json({ destinations: [], channels: [], views: [], templates: [], members: [], skills: [] });
}
export const getAccessToken = () => 'fixture-token';
export const isAuthRedirectInFlight = () => false;
export const refreshUserCookie = async () => {};
export const getValidAccessToken = async () => 'fixture-token';

export class AuthRefreshUnavailableError extends TypeError {}
