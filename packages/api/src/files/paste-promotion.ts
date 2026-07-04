// [COMP:files/paste-promotion] — giant pastes become artifacts, not context
// (large-content-artifacts §Phase 3.1, decisions D1 + D6).
//
// A pasted message body over the threshold is materialized into a durable
// workspace_files artifact (chunked + retrievable) and the TURN carries a
// short replacement: a note + the first lines + the artifact manifest. The
// session persists the REPLACED text — the original is durable in the
// artifact; storing the blob would re-feed every later turn and re-mint an
// artifact on retry/regenerate.
//
// The threshold is deliberately HIGHER than the 5,000-token attach-inline
// gate: an attachment is already a file, but a paste is conversational text —
// re-routing it should fire only when it clearly cannot live in context.
// CJK-aware (estimateStringTokens). No opt-outs in v1 (documented limitation).

import { estimateStringTokens } from '@sidanclaw/core'
import type { ArtifactPromoter } from './artifact-promote.js'
import { renderArtifactManifest } from './artifact-manifest.js'

/** ~32K ASCII chars / ~8K CJK chars. */
export const PASTE_PROMOTION_THRESHOLD_TOKENS = 8000
/** How much of the paste stays inline as the head excerpt. */
export const PASTE_HEAD_EXCERPT_CHARS = 800

export type PastePromotionResult = {
  /** What the turn carries instead of the paste (note + excerpt + manifest). */
  replaced: string
  fileId: string
  path: string
}

/** Cheap gate — callers can skip the async path entirely. */
export function shouldPromotePaste(text: string, thresholdTokens = PASTE_PROMOTION_THRESHOLD_TOKENS): boolean {
  return estimateStringTokens(text) > thresholdTokens
}

/**
 * Promote an over-threshold paste. Returns null (caller keeps the original
 * text) below the threshold or on any promotion failure — a paste is never
 * lost to a failed promotion.
 */
export async function promotePastedText(input: {
  text: string
  workspaceId: string
  actingUserId: string
  assistantId?: string | null
  promote: ArtifactPromoter
  thresholdTokens?: number
}): Promise<PastePromotionResult | null> {
  const text = input.text
  if (!shouldPromotePaste(text, input.thresholdTokens)) return null

  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
  const promoted = await input.promote({
    fileName: `paste-${stamp}.txt`,
    mime: 'text/plain',
    bytes: Buffer.from(text, 'utf8'),
    parsedText: text,
    workspaceId: input.workspaceId,
    actingUserId: input.actingUserId,
    assistantId: input.assistantId ?? null,
    pathPrefix: '/uploads/pastes',
  })
  if (!promoted) return null

  const manifest = renderArtifactManifest({
    fileId: promoted.fileId,
    fileName: `paste-${stamp}.txt`,
    mime: 'text/plain',
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    charLength: text.length,
    segmentCount: promoted.segmentCount,
    status: promoted.status,
    truncated: promoted.truncated,
  })
  const replaced = [
    `[Pasted text (${text.length.toLocaleString('en-US')} characters) was saved to the workspace file "${promoted.path}". First lines:]`,
    text.slice(0, PASTE_HEAD_EXCERPT_CHARS),
    '',
    manifest,
  ].join('\n')
  return { replaced, fileId: promoted.fileId, path: promoted.path }
}
