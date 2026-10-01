import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/runtime-public-config', () => ({ publicRuntimeConfig: () => ({ apiUrl: 'https://api.test' }) }));
vi.mock('@/lib/auth-fetch', () => ({ authFetch: vi.fn() }));
vi.mock('@/lib/display-api-url', () => ({ DISPLAY_API_URL: 'https://api.test' }));
vi.mock('@use-brian/shared/builtin-connectors', () => ({ OFFICIAL_CONNECTOR_TOOLS: [] }));
import { authFetch } from '@/lib/auth-fetch';
import { listWorkspaceChannelOptions } from '../api/workflow';

const fetch = vi.mocked(authFetch);
const web = { id: 'session-uuid', channelType: 'web', displayName: 'My workflow chat' };
const integration = { channelType: 'slack', displayName: 'Slack', status: 'active', integrationStatus: 'active', integrationId: 'integration-uuid' };
beforeEach(() => vi.resetAllMocks());

describe('workflow editor channel options', () => {
  it('the editor loads these options and saves their id/channel without rewriting web identities', () => {
    const editor = readFileSync(new URL('../../components/workflow/event-trigger-fields.tsx', import.meta.url), 'utf8');
    expect(editor).toContain('listWorkspaceChannelOptions(workspaceId)');
    expect(editor).toContain('if (opt) onChange(opt.id, opt.channelType)');
    expect(editor).toContain('channelIntegrationId: id,');
  });
  it('combines authorized session UUIDs and active integrations without changing source identity', async () => {
    fetch.mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('/channels')
      ? { channels: [integration, { ...integration, integrationId: 'revoked', status: 'revoked' }] }
      : { sources: [web] }), { status: 200 }));
    expect(await listWorkspaceChannelOptions('workspace')).toEqual([
      { id: 'integration-uuid', channelType: 'slack', displayName: 'Slack' }, web,
    ]);
    expect(fetch).toHaveBeenCalledWith('https://api.test/api/sessions/incoming-event-sources?workspaceId=workspace');
  });

  it('offers web chats even when there are no integrations or the integration request fails', async () => {
    fetch.mockImplementation(async (url) => {
      if (String(url).includes('/channels')) throw new Error('unavailable');
      return new Response(JSON.stringify({ sources: [web] }));
    });
    expect(await listWorkspaceChannelOptions('workspace')).toEqual([web]);
  });

  it('does not expose web sources when their authorization request is denied', async () => {
    fetch.mockImplementation(async (url) => String(url).includes('/channels')
      ? new Response(JSON.stringify({ channels: [integration] }))
      : new Response('{}', { status: 403 }));
    expect(await listWorkspaceChannelOptions('workspace')).toEqual([
      { id: 'integration-uuid', channelType: 'slack', displayName: 'Slack' },
    ]);
  });
});
