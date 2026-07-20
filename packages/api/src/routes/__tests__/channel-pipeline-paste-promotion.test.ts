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
import { promoteChannelPaste } from '../channel-pipeline.js'

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
