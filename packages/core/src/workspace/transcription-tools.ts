import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { WorkspaceTranscriptionPrefs } from '../media/transcription-prefs.js'

/**
 * Workspace transcription-preference tool for the assistant.
 *
 * One tool: `configureTranscriptionPreference`. The workspace preference
 * (`workspaces.transcription_prefs`, migration 332) has no settings-page UI —
 * the assistant IS the configuration surface, so a user can say "whenever a
 * transcript has Chinese, write it in Traditional characters" in chat and the
 * assistant persists it. Reads are open to any member; writes are
 * admin/owner-gated in the store setter, which returns a distinguishable
 * outcome the tool surfaces so the assistant can explain a rejection.
 *
 * See docs/architecture/platform/workspaces.md → "Transcription preferences"
 * and docs/architecture/media/transcription.md → "Language & script
 * preferences".
 */

export type WorkspaceTranscriptionPrefsPort = {
  get(workspaceId: string): Promise<WorkspaceTranscriptionPrefs>
  set(
    userId: string,
    workspaceId: string,
    patch: {
      languageCode?: string | null
      chineseScript?: 'traditional' | 'simplified' | null
    },
  ): Promise<
    | { ok: true; prefs: WorkspaceTranscriptionPrefs }
    | { ok: false; reason: 'not_admin' | 'not_found'; message: string }
  >
}

export function createTranscriptionPrefTools(store: WorkspaceTranscriptionPrefsPort): {
  configureTranscriptionPreference: Tool
} {
  const configureTranscriptionPreference = buildTool({
    name: 'configureTranscriptionPreference',
    description:
      "Read or change how this workspace's recordings are transcribed. Call with no arguments to see the current preference. " +
      "To change it: `chineseScript` ('traditional' | 'simplified') normalizes any Chinese in future transcripts to that script, whatever language the rest of the audio is in — the right setting for a team that speaks mostly English but wants any Chinese written in Traditional characters (English and other languages are never altered). " +
      "`languageCode` (an ISO 639 code like 'en', 'yue', 'zh') forces the speech-recognition language on providers that accept a hint — leave it unset for multi-language teams, because forcing one language hurts recognition of the others. " +
      "Pass 'auto' for either field to clear it back to the default. " +
      'Changing the preference requires the workspace admin or owner role (reading it does not). Applies to recordings processed from now on; existing transcripts are not rewritten.',
    inputSchema: z.object({
      chineseScript: z
        .enum(['traditional', 'simplified', 'auto'])
        .optional()
        .describe("Chinese script for future transcripts; 'auto' clears the preference."),
      languageCode: z
        .string()
        .regex(/^([a-z]{2,3}|auto)$/, "an ISO 639 code like 'en' or 'yue', or 'auto' to clear")
        .optional()
        .describe("Forced recognition language (ISO 639); 'auto' clears the hint."),
    }),
    isConcurrencySafe: false,
    async execute(input, context) {
      if (!context.workspaceId) {
        return {
          data: 'This assistant is not bound to a workspace, so there is no transcription preference to configure here.',
          isError: true,
        }
      }

      const wantsWrite = input.chineseScript !== undefined || input.languageCode !== undefined
      if (!wantsWrite) {
        const prefs = await store.get(context.workspaceId)
        return {
          data: {
            prefs,
            note:
              Object.keys(prefs).length === 0
                ? 'No preference set — transcription uses provider defaults (auto-detected language, provider-native script).'
                : undefined,
          },
        }
      }

      const patch: {
        languageCode?: string | null
        chineseScript?: 'traditional' | 'simplified' | null
      } = {}
      if (input.chineseScript !== undefined) {
        patch.chineseScript = input.chineseScript === 'auto' ? null : input.chineseScript
      }
      if (input.languageCode !== undefined) {
        patch.languageCode = input.languageCode === 'auto' ? null : input.languageCode
      }

      const result = await store.set(context.userId, context.workspaceId, patch)
      if (!result.ok) {
        return { data: result.message, isError: true }
      }
      return {
        data: {
          prefs: result.prefs,
          note: 'Saved. Applies to recordings processed from now on; existing transcripts are unchanged.',
        },
      }
    },
  })

  return { configureTranscriptionPreference }
}
