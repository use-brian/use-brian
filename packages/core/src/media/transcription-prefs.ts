/**
 * Workspace transcription preferences — the shape stored in
 * `workspaces.transcription_prefs` (migration 332) and threaded through the
 * recording pipeline.
 *
 * `languageCode` is an ISO 639 hint forced onto transcription providers that
 * accept one (Scribe's `language_code`); unset = provider auto-detect, the
 * right default for multi-language workspaces. `chineseScript` is a
 * post-transcription script normalization (see `chinese-script.ts`) applied
 * provider-independently — the lever for "main language is English, but any
 * Chinese must be Traditional".
 *
 * Spec: docs/architecture/media/transcription.md §"Language & script
 * preferences".
 */

import { z } from 'zod'
import type { ChineseScript } from './chinese-script.js'

export const transcriptionPrefsSchema = z.object({
  /** ISO 639-1/-3 code, e.g. 'en', 'zh', 'yue'. */
  languageCode: z
    .string()
    .regex(/^[a-z]{2,3}$/, 'languageCode must be an ISO 639 code like "en" or "yue"')
    .optional(),
  chineseScript: z.enum(['traditional', 'simplified']).optional(),
})

export type WorkspaceTranscriptionPrefs = {
  languageCode?: string
  chineseScript?: ChineseScript
}

/**
 * Tolerant read-side parse for the JSONB column: unknown/invalid content
 * yields `{}` (provider-default behavior) rather than throwing — a malformed
 * preference must never block a recording. Unknown keys are dropped.
 */
export function parseTranscriptionPrefs(raw: unknown): WorkspaceTranscriptionPrefs {
  const parsed = transcriptionPrefsSchema.safeParse(raw)
  if (!parsed.success) return {}
  const prefs: WorkspaceTranscriptionPrefs = {}
  if (parsed.data.languageCode) prefs.languageCode = parsed.data.languageCode
  if (parsed.data.chineseScript) prefs.chineseScript = parsed.data.chineseScript
  return prefs
}
