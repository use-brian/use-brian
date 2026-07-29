/**
 * `pdf-distillate-store.ts` — the distillate cache (migration 380).
 *
 * Full-page image distillation is the expensive half of reading a PDF on any
 * model without a native reader: ~7 vision calls and ~84k input tokens for a
 * 40-page report. The distillate — compact Markdown — is what actually rides
 * the conversation, so caching it turns a per-turn image re-bill into a
 * one-time cost that every later turn, surface, and teammate reads for free.
 *
 * Keyed by CONTENT HASH, not file id: the same PDF attached in web chat,
 * dropped into Telegram, and ingested to the brain is one document. Paired
 * with `config_key`, the fingerprint of everything that changes the output for
 * the same bytes (see `distillConfigKey` in core) — a width or model change
 * misses rather than serving stale output.
 *
 * System-only, RLS-open (`query()`): a row is a pure function of bytes plus
 * config and is only reachable by presenting the bytes' own SHA-256.
 *
 * [COMP:files/pdf-distillate-store]
 */

import { createHash } from 'node:crypto'
import { query } from './client.js'

export type PdfDistillateRow = {
  text: string
  model: string
  pageCount: number | null
  truncated: boolean
}

/** The cache key's content half. Exported so callers hash once and reuse. */
export function contentSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function getPdfDistillate(
  contentHash: string,
  configKey: string,
): Promise<PdfDistillateRow | null> {
  const { rows } = await query<PdfDistillateRow>(
    `SELECT text, model, page_count AS "pageCount", truncated
       FROM pdf_distillates
      WHERE content_sha256 = $1 AND config_key = $2`,
    [contentHash, configKey],
  )
  return rows[0] ?? null
}

/**
 * Idempotent by construction: two surfaces distilling the same document
 * concurrently both write, and `ON CONFLICT DO NOTHING` lets the loser proceed
 * with its own (identical-by-config) result rather than raising.
 */
export async function savePdfDistillate(input: {
  contentHash: string
  configKey: string
  text: string
  model: string
  usage?: unknown
  pageCount?: number | null
  truncated?: boolean
}): Promise<void> {
  await query(
    `INSERT INTO pdf_distillates
       (content_sha256, config_key, text, model, usage, page_count, truncated)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (content_sha256, config_key) DO NOTHING`,
    [
      input.contentHash,
      input.configKey,
      input.text,
      input.model,
      input.usage ? JSON.stringify(input.usage) : null,
      input.pageCount ?? null,
      input.truncated ?? false,
    ],
  )
}
