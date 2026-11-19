import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import type { CampaignReadPort, CampaignServicePort } from '../types.js'
import { createCampaignTools } from '../tools.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ASSISTANT_ID = '00000000-0000-4000-8000-000000000003'
const SESSION_ID = '00000000-0000-4000-8000-000000000004'

function context(): ToolContext {
  return {
    userId: USER_ID,
    assistantId: ASSISTANT_ID,
    sessionId: SESSION_ID,
    appId: ASSISTANT_ID,
    channelType: 'web',
    channelId: 'campaign-test',
    workspaceId: WORKSPACE_ID,
    activeCapabilities: new Set(['feed', 'home_app:feed:read', 'home_app:feed:write']),
    abortSignal: new AbortController().signal,
  }
}

const reads: CampaignReadPort = {
  listCampaigns: vi.fn(async () => []),
  getCampaign: vi.fn(async () => null),
  listLinks: vi.fn(async () => []),
  getTrackingSetup: vi.fn(async () => ({ state: 'not_installed' })),
  getResults: vi.fn(async () => ({ state: 'empty' })),
  getAttribution: vi.fn(async () => ({ conversions: [] })),
  previewAudience: vi.fn(async () => ({ eligible: 0, excluded: 0 })),
  previewEmail: vi.fn(async () => ({ html: '<p>Example</p>', text: 'Example' })),
}

describe('[COMP:campaigns/contracts] Brian and UI share campaign commands', () => {
  it('exposes the locked operation vocabulary under Feed capabilities', () => {
    const tools = createCampaignTools({ reads, service: { execute: vi.fn() } as never })
    expect(Object.keys(tools)).toEqual([
      'listCampaigns', 'getCampaign', 'saveCampaign', 'archiveCampaign', 'attachCampaignContent',
      'createCampaignLink', 'listCampaignLinks', 'getCampaignTrackingSetup', 'verifyCampaignTracking',
      'getCampaignResults', 'getCampaignAttribution', 'previewCampaignAudience', 'previewCampaignEmail',
      'sendCampaignTest', 'prepareCampaignDispatch', 'scheduleCampaignDispatch',
      'pauseCampaignDispatch', 'cancelCampaignDispatch',
    ])
    expect(Object.values(tools).every(tool => tool.requiresCapability === 'feed')).toBe(true)
    expect(tools.getCampaignResults.isReadOnly).toBe(true)
    expect(tools.prepareCampaignDispatch.requiresConfirmation).toBe(true)
  })

  it('forwards the same typed save command used by REST/UI', async () => {
    const execute = vi.fn<CampaignServicePort['execute']>(async (_context, request) => ({
      idempotencyKey: request.idempotencyKey,
      fingerprint: 'f'.repeat(64),
      replayed: false,
      result: { campaign: { id: 'fixture' } },
    }))
    const tools = createCampaignTools({ reads, service: { execute } })
    const result = await tools.saveCampaign.execute({
      idempotency_key: 'save-example-campaign',
      name: 'Example launch',
      objective: 'Collect verified enquiries',
      timezone: 'UTC',
      primaryConversion: 'enquiry_submitted',
    }, context())
    expect(result).toMatchObject({ data: { campaign: { id: 'fixture' } } })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), {
      idempotencyKey: 'save-example-campaign',
      command: expect.objectContaining({ kind: 'save_campaign', name: 'Example launch' }),
    })
  })

  it('keeps audience sending disabled when canonical authority has not enabled it', async () => {
    const execute = vi.fn<CampaignServicePort['execute']>()
    const tools = createCampaignTools({ reads, service: { execute } })
    const output = await tools.scheduleCampaignDispatch.execute({
      idempotency_key: 'schedule-example',
      dispatch_id: crypto.randomUUID(),
      scheduled_at: '2026-10-01T10:00:00.000Z',
    }, context())
    expect(output).toMatchObject({ isError: true, data: { error: 'internal' } })
  })
})
