// [COMP:api/channel-paste-promotion] — the central large-paste intercept the
// channel pipeline runs before a turn is classified, persisted, or fed to the
// model (large-content-artifacts §Phase 3.2, decision D6). A giant text paste
// over any messaging channel is promoted to a durable workspace_files artifact;
// the rewritten `messageText` + `userContentBlocks` carry the manifest + head
// excerpt in place of the blob — reaching BOTH the persisted row and the LLM
// turn (the pipeline re-reads the user row from the DB before the query loop).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContentBlock } from '@use-brian/core'
import type { ArtifactPromoter } from '../../files/artifact-promote.js'
import type { ResolvedTurnScope } from '../../context-scope/resolve-turn-scope.js'
import { connectorExposureAllowed } from '../../context-scope/connector-exposure.js'
import {
  resolveConnectorTurnScopeForChannelTurn,
  connectorToolsAllowedForChannelTurn,
  promoteChannelPaste,
} from '../channel-pipeline.js'

// estimateStringTokens ≈ ceil(asciiChars / 4); the paste threshold is 8,000
// tokens, so ~40K ASCII chars clears it comfortably. Distinctive head + tail
// markers let us assert the blob's tail is gone from the rewritten turn while
// the 800-char head excerpt survives.
const BLOB = `HEAD_${'x'.repeat(40_000)}_TAIL_MARKER`
const TINY = 'quick question, nothing large here'

function makePromoter(): ArtifactPromoter {
  return vi.fn(async (input) => ({
    fileId: 'file_abc123',
    path: `${input.pathPrefix ?? '/uploads/chat'}/2026-07-05-paste.txt`,
    status: 'ready' as const,
    segmentCount: 7,
    truncated: false,
  }))
}

const base = {
  workspaceId: 'ws_1',
  actingUserId: 'u_1',
  assistantId: 'a_1',
  channelType: 'telegram',
}

function textOf(block: ContentBlock): string {
  return (block as { type: 'text'; text: string }).text
}

describe('[COMP:api/channel-paste-promotion] Channel paste promotion', () => {
  beforeEach(() => {
    // The mismatch / failure paths log — keep the suite output clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('promotes an over-threshold paste and rewrites both the classifier text and the content blocks', async () => {
    const promoter = makePromoter()
    // Telegram shape: an attachment-context prefix precedes the raw paste in
    // both messageText and the single text content block.
    const prefix = '<attached_file>notes.txt</attached_file>\n'
    const messageText = prefix + BLOB
    const userContentBlocks: ContentBlock[] = [{ type: 'text', text: messageText }]

    const result = await promoteChannelPaste({
      ...base,
      rawUserText: BLOB,
      messageText,
      userContentBlocks,
      artifactPromoter: promoter,
    })

    expect(promoter).toHaveBeenCalledTimes(1)
    // Classifier/preflight text: prefix preserved, blob gone, manifest present.
    expect(result.messageText.startsWith(prefix)).toBe(true)
    expect(result.messageText).toContain('[Pasted text (')
    expect(result.messageText).toContain('file_abc123')
    expect(result.messageText).not.toContain('_TAIL_MARKER')
    expect(result.messageText.length).toBeLessThan(messageText.length)
    // The model-facing / persisted block carries the identical replacement.
    expect(textOf(result.userContentBlocks[0])).toBe(result.messageText)
    expect(textOf(result.userContentBlocks[0])).not.toContain('_TAIL_MARKER')
  })

  it('rewrites only the text block that ends with the paste, leaving other blocks (e.g. images) intact', async () => {
    const promoter = makePromoter()
    // Slack/Discord shape: an image block alongside the raw-paste text block.
    const imageBlock: ContentBlock = { type: 'image', mimeType: 'image/png', data: 'AAAA' }
    const textBlock: ContentBlock = { type: 'text', text: BLOB }
    const userContentBlocks: ContentBlock[] = [imageBlock, textBlock]

    const result = await promoteChannelPaste({
      ...base,
      channelType: 'slack',
      rawUserText: BLOB,
      messageText: BLOB,
      userContentBlocks,
      artifactPromoter: promoter,
    })

    expect(promoter).toHaveBeenCalledTimes(1)
    expect(result.userContentBlocks[0]).toBe(imageBlock) // image untouched (same ref)
    expect(textOf(result.userContentBlocks[1])).toContain('file_abc123')
    expect(textOf(result.userContentBlocks[1])).not.toContain('_TAIL_MARKER')
  })

  it('keeps the original when the raw paste is not the tail of messageText (unspliceable shape)', async () => {
    const promoter = makePromoter()
    const messageText = `${BLOB}\n\n[edited suffix the adapter appended]`
    const userContentBlocks: ContentBlock[] = [{ type: 'text', text: messageText }]

    const result = await promoteChannelPaste({
      ...base,
      rawUserText: BLOB,
      messageText,
      userContentBlocks,
      artifactPromoter: promoter,
    })

    // Splicing would corrupt the turn, so we never promote and never rewrite.
    expect(promoter).not.toHaveBeenCalled()
    expect(result.messageText).toBe(messageText)
    expect(result.userContentBlocks).toBe(userContentBlocks)
  })

  it('leaves a below-threshold paste untouched (promoter never called)', async () => {
    const promoter = makePromoter()
    const userContentBlocks: ContentBlock[] = [{ type: 'text', text: TINY }]

    const result = await promoteChannelPaste({
      ...base,
      rawUserText: TINY,
      messageText: TINY,
      userContentBlocks,
      artifactPromoter: promoter,
    })

    expect(promoter).not.toHaveBeenCalled()
    expect(result.messageText).toBe(TINY)
    expect(result.userContentBlocks).toBe(userContentBlocks)
  })

  it('is a no-op when no artifactPromoter is wired', async () => {
    const userContentBlocks: ContentBlock[] = [{ type: 'text', text: BLOB }]

    const result = await promoteChannelPaste({
      ...base,
      rawUserText: BLOB,
      messageText: BLOB,
      userContentBlocks,
      artifactPromoter: null,
    })

    expect(result.messageText).toBe(BLOB)
    expect(result.userContentBlocks).toBe(userContentBlocks)
  })

  it('is a no-op when the assistant has no workspace', async () => {
    const promoter = makePromoter()
    const userContentBlocks: ContentBlock[] = [{ type: 'text', text: BLOB }]

    const result = await promoteChannelPaste({
      ...base,
      workspaceId: null,
      rawUserText: BLOB,
      messageText: BLOB,
      userContentBlocks,
      artifactPromoter: promoter,
    })

    expect(promoter).not.toHaveBeenCalled()
    expect(result.messageText).toBe(BLOB)
    expect(result.userContentBlocks).toBe(userContentBlocks)
  })

  it('keeps the original when promotion fails (returns null) — a paste is never lost', async () => {
    const promoter = vi.fn(async () => null) as unknown as ArtifactPromoter
    const userContentBlocks: ContentBlock[] = [{ type: 'text', text: BLOB }]

    const result = await promoteChannelPaste({
      ...base,
      rawUserText: BLOB,
      messageText: BLOB,
      userContentBlocks,
      artifactPromoter: promoter,
    })

    expect(promoter).toHaveBeenCalledTimes(1)
    expect(result.messageText).toBe(BLOB)
    expect(result.userContentBlocks).toBe(userContentBlocks)
  })
})

describe('[COMP:api/telegram-byo-route] External guest connector access', () => {
  const projectId = '11111111-1111-4111-8111-111111111111'
  const dataTurnScope = {
    access: { workspaceId: 'workspace-1', userId: 'guest-1', assistantId: 'assistant-1', assistantKind: 'standard',
      clearance: 'public', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['assistant-1'] },
    effectiveCompartments: [],
    effectiveProjectIds: [],
    writeCompartments: [], writeProjectIds: [], activeTeam: null, activeProject: null,
  } as unknown as ResolvedTurnScope
  const assistantTurnScope = {
    access: { ...dataTurnScope.access, clearance: 'confidential', compartments: ['team:sales'], mutationCompartments: ['team:sales'], projectIds: [projectId] },
    effectiveCompartments: ['team:sales'],
    effectiveProjectIds: [projectId],
    writeCompartments: ['team:sales'], writeProjectIds: [projectId], activeTeam: null, activeProject: null,
  } as unknown as ResolvedTurnScope
  const scopeInput = {
    dataTurnScope,
    userId: 'guest-1',
    assistant: {
      id: 'assistant-1',
      workspaceId: 'workspace-1',
      kind: 'standard' as const,
      clearance: 'confidential' as const,
      compartments: ['team:sales'],
      projectScopeMode: 'assigned' as const,
    },
    workspaceId: 'workspace-1',
    session: { contextGroupId: null, contextProjectId: null },
  }

  it('keeps connectors available for ordinary channel turns', () => {
    expect(connectorToolsAllowedForChannelTurn(false, undefined)).toBe(true)
  })

  it('keeps connectors disabled for an external guest by default', () => {
    expect(connectorToolsAllowedForChannelTurn(true, undefined)).toBe(false)
    expect(connectorToolsAllowedForChannelTurn(true, false)).toBe(false)
  })

  it('enables connectors only after the explicit guest opt-in', () => {
    expect(connectorToolsAllowedForChannelTurn(true, true)).toBe(true)
  })

  it('keeps the narrower sender data scope and resolves the native floor even without assistant mode', async () => {
    const resolveScope = vi.fn().mockResolvedValue(dataTurnScope)

    const resolved = await resolveConnectorTurnScopeForChannelTurn({
      ...scopeInput,
      useAssistantConnectorAuthority: false,
    }, resolveScope)

    expect(resolved).toEqual(dataTurnScope)
    expect(resolveScope).toHaveBeenCalledWith(expect.objectContaining({ memberMode: 'member', userId: 'guest-1' }))
  })

  it('never widens a guest data ceiling through the legacy assistant connector switch', async () => {
    const resolveScope = vi.fn().mockResolvedValue(assistantTurnScope)

    const resolved = await resolveConnectorTurnScopeForChannelTurn({
      ...scopeInput,
      useAssistantConnectorAuthority: true,
    }, resolveScope)

    expect(resolved.access).toEqual(dataTurnScope.access)
    expect(resolveScope).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'guest-1',
      workspaceId: 'workspace-1',
      memberMode: 'member',
      session: scopeInput.session,
    }))

    const calendarGrant = {
      provider: 'gcal',
      compartments: ['team:sales'],
      projectIds: [projectId],
    }
    expect(connectorExposureAllowed(dataTurnScope, calendarGrant)).toBe(false)
    expect(connectorExposureAllowed(resolved, calendarGrant)).toBe(false)
  })
  it('preserves a real member and assistant finite Department/Project intersection', async () => {
    const resolved = await resolveConnectorTurnScopeForChannelTurn({ ...scopeInput, dataTurnScope: assistantTurnScope,
      useAssistantConnectorAuthority: true }, vi.fn().mockResolvedValue(assistantTurnScope))
    expect(connectorExposureAllowed(resolved, { compartments: ['team:sales'], projectIds: [projectId] })).toBe(true)
    expect(connectorExposureAllowed(resolved, { compartments: ['team:other'], projectIds: [projectId] })).toBe(false)
    expect(connectorExposureAllowed(resolved, { compartments: ['team:sales'], projectIds: ['other'] })).toBe(false)
  })
  it('withholds protected room/assistant scope from a sender outside its Department', async () => {
    const broadRoom = { ...assistantTurnScope, access: { ...assistantTurnScope.access, compartments: null, mutationCompartments: null, projectIds: null },
      effectiveCompartments: null, effectiveProjectIds: null }
    const resolved = await resolveConnectorTurnScopeForChannelTurn({ ...scopeInput, dataTurnScope: broadRoom,
      useAssistantConnectorAuthority: false }, vi.fn().mockResolvedValue(dataTurnScope))
    expect(resolved.effectiveCompartments).toEqual([]); expect(resolved.effectiveProjectIds).toEqual([])
    expect(resolved.writeCompartments).toEqual([]); expect(resolved.writeProjectIds).toEqual([])
    expect(connectorExposureAllowed(resolved, { compartments: ['team:sales'], projectIds: [] })).toBe(false)
  })
  it('refuses a substituted actor/assistant or missing native membership instead of using assistant authority', async () => {
    for (const access of [{ ...dataTurnScope.access, userId: 'owner' }, { ...dataTurnScope.access, assistantId: 'other' }]) {
      await expect(resolveConnectorTurnScopeForChannelTurn({ ...scopeInput, useAssistantConnectorAuthority: true },
        vi.fn().mockResolvedValue({ ...dataTurnScope, access }))).rejects.toThrow('connector_actor_mismatch')
    }
    await expect(resolveConnectorTurnScopeForChannelTurn({ ...scopeInput, useAssistantConnectorAuthority: true },
      vi.fn().mockRejectedValue(new Error('authority_unavailable')))).rejects.toThrow('authority_unavailable')
  })
})
