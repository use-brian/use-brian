import { describe, expect, it, vi } from 'vitest'
import { ChatTurnRefusal, chatTurnErrorEvent, customModelMediaRefusal, resolveWorkspaceTurnLlm } from '../chat.js'
import { CUSTOM_MODEL_IMAGE_REJECTION } from '../_channel-error-text.js'

describe('[COMP:api/chat-route] workspace provider precedence', () => {
  it('uses a valid custom endpoint without touching stale legacy BYO settings', async () => {
    const platformProvider = { name: 'platform' }
    const customProvider = { name: 'custom' }
    const resolveLegacyByoKey = vi.fn().mockRejectedValue(new Error('legacy decrypt failed'))
    const resolveWorkspaceCustomLlm = vi.fn().mockResolvedValue({
      provider: customProvider,
      selector: 'custom:profile-1',
      profileId: 'profile-1',
      modelTier: 'pro',
      providerKeySource: 'user',
      inputTokenLimit: 32000,
      maxTokens: 4000,
    })

    const result = await resolveWorkspaceTurnLlm({
      workspaceId: 'ws-1',
      requestedTier: 'pro',
      platformProvider: platformProvider as never,
      resolveWorkspaceCustomLlm: resolveWorkspaceCustomLlm as never,
      resolveLegacyByoKey,
      buildLegacyByoProvider: vi.fn() as never,
    })

    expect(result).toMatchObject({
      provider: customProvider,
      providerKeySource: 'user',
      usedLegacyByoKey: false,
    })
    expect(resolveLegacyByoKey).not.toHaveBeenCalled()
  })

  it('preserves fail-closed legacy decryption when no custom endpoint applies', async () => {
    const error = new Error('legacy decrypt failed')
    await expect(resolveWorkspaceTurnLlm({
      workspaceId: 'ws-1',
      requestedTier: 'pro',
      platformProvider: {} as never,
      resolveWorkspaceCustomLlm: vi.fn().mockResolvedValue(null) as never,
      resolveLegacyByoKey: vi.fn().mockRejectedValue(error),
      buildLegacyByoProvider: vi.fn() as never,
    })).rejects.toThrow(error)
  })
})

describe('[COMP:api/chat-route] post-SSE turn refusals', () => {
  // The chat route flushes `text/event-stream` headers a few lines into the
  // handler, so `res.status(...).json(...)` past that point is not a reply,
  // it is an ERR_HTTP_HEADERS_SENT throw that the outer catch flattens into
  // "Something went wrong". That is how a workspace whose tiers all route to
  // a text-only custom endpoint got a generic red banner instead of the one
  // sentence explaining why its screenshots were refused (2026-08-19).
  it('renders a refusal with its own code and sentence, not the generic banner', () => {
    const refusal = new ChatTurnRefusal('metered_at_cap', 'Add credits to use this model.', {
      usedCredits: 42,
    })
    expect(chatTurnErrorEvent(refusal)).toEqual({
      code: 'metered_at_cap',
      error: 'Add credits to use this model.',
      usedCredits: 42,
    })
  })

  it('still says nothing specific about an unknown crash', () => {
    expect(chatTurnErrorEvent(new Error('Cannot set headers after they are sent to the client')))
      .toEqual({ error: 'Something went wrong' })
    expect(chatTurnErrorEvent('not even an error')).toEqual({ error: 'Something went wrong' })
  })

  // A tier route captures every built-in in the model picker, so the old copy
  // ("choose a built-in model") named a recovery step that workspace does not
  // have. Only an explicit `custom:<id>` pick can be undone that way.
  it('points a tier-routed workspace at Settings rather than the model picker', () => {
    const viaTierRoute = customModelMediaRefusal(false)
    expect(viaTierRoute.code).toBe('custom_model_media_unsupported')
    expect(viaTierRoute.message).toMatch(/Settings > Models/)
    expect(viaTierRoute.message).not.toMatch(/choose a built-in model/)
    // One sentence across every surface: a channel turn reaches the endpoint
    // the same way (tier route) and must not learn a second wording.
    expect(viaTierRoute.message).toBe(CUSTOM_MODEL_IMAGE_REJECTION)
  })

  it('offers the model picker when the custom endpoint was picked for this turn', () => {
    expect(customModelMediaRefusal(true).message).toMatch(/choose a built-in model/)
  })

  // Every user-facing string in this file goes out verbatim over SSE.
  it('keeps em dashes out of the refusal copy', () => {
    for (const message of [
      customModelMediaRefusal(true).message,
      customModelMediaRefusal(false).message,
    ]) {
      expect(message).not.toContain('—')
    }
  })
})
