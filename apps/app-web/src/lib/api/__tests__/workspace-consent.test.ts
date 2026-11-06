import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth-fetch', () => ({ getAccessToken: () => 'fictional-native-token' }));
vi.mock('@/lib/runtime-public-config', () => ({ publicRuntimeConfig: () => ({ apiUrl: 'http://localhost:4100', primaryAuthUrl: 'http://localhost:3005' }) }));
import { fetchWorkspaceConsent, decideWorkspaceConsent, workspaceConsentSignInUrl } from '../workspace-consent';
const assistantId = '11111111-1111-4111-8111-111111111111', workspaceId = '22222222-2222-4222-8222-222222222222';
const review = { clientName: 'Fictional application', clientUri: null, scope: 'read_write' as const,
  workspaces: [{ id: workspaceId, name: 'Fictional workspace' }], workspaceAccessAvailable: true };
describe('[COMP:app-web/workspace-consent] resource-bound native consent', () => {
  beforeEach(() => { fetch.mockReset(); vi.stubGlobal('fetch', fetch); });
  it.each([undefined, assistantId])('submits explicit workspace access to the exact resource %s', async id => {
    const payload = { ...review, ...(id ? { assistantId: id, workspaceAccessRequired: true } : {}) };
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(payload))).mockResolvedValueOnce(new Response(JSON.stringify({ redirectUrl: 'https://client.example/callback?code=fictional' })));
    const current = await fetchWorkspaceConsent('signed', id);
    const route = id ? `/api/v1/assistants/${id}/oauth/consent` : '/api/brain/oauth/consent';
    expect(fetch.mock.calls[0][0]).toBe(`http://localhost:4100${route}?req=signed`);
    await decideWorkspaceConsent('signed', id, current, { workspaceId, decision: 'allow', grantedScope: 'read', workspaceAccess: true });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ req: 'signed', workspaceId, decision: 'allow', grantedScope: 'read', workspaceAccess: true });
  });
  it('refuses foreign assistant, workspace, broader scope and missing explicit assistant consent', async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...review, assistantId: workspaceId, workspaceAccessRequired: true })));
    await expect(fetchWorkspaceConsent('signed', assistantId)).rejects.toThrow();
    const input = { workspaceId, decision: 'allow' as const, grantedScope: 'read_write' as const, workspaceAccess: true };
    await expect(decideWorkspaceConsent('signed', undefined, review, { ...input, workspaceId: assistantId })).rejects.toThrow();
    await expect(decideWorkspaceConsent('signed', undefined, { ...review, scope: 'read' }, input)).rejects.toThrow();
    await expect(decideWorkspaceConsent('signed', assistantId, { ...review, assistantId, workspaceAccessRequired: true }, { ...input, workspaceAccess: false })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves the resource through sign-in and retries no failed consent write', async () => {
    const login = new URL(workspaceConsentSignInUrl('signed?request', assistantId, 'http://localhost:3003/oauth/authorize?next=https://outside.example'));
    const next = new URL(login.searchParams.get('next')!);
    expect(next.origin).toBe('http://localhost:3003'); expect(next.searchParams.get('assistant')).toBe(assistantId);
    expect(next.searchParams.get('req')).toBe('signed?request'); expect(next.searchParams.has('next')).toBe(false);
    fetch.mockRejectedValueOnce(Error('lost response'));
    await expect(decideWorkspaceConsent('signed', undefined, review, { workspaceId, decision: 'deny', grantedScope: 'read', workspaceAccess: false })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
