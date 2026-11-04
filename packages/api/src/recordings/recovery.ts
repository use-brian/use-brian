/** [COMP:recordings/recovery] Fresh source derivation, never release held output. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { actorFromContext, buildTool, type AccessContext } from '@use-brian/core'
import { readAdmissionPolicy } from '../workspace-access/admission-policy-read.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { buildAccessPredicate, mutationActorAccess } from '../db/access-predicate.js'
import { getRecording } from '../db/recordings-store.js'
import { admitRecordingIntakeParent, readRecordingIntakeParent, recordingIntakeTransaction, type RecordingIntakeAuthority } from '../db/recording-intake-admission.js'

export type RecordingRecovery = {
  recordingId: string
  replacementId: string | null
  title: string
  mime: string
}

export function isRecordingRecoveryUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: string }).code
  return code === 'scope_operation_denied' || code === 'access_policy_conflict' || code === '42501'
    || ['recording_recovery_unavailable', 'recording_intake_source_unavailable', 'recording_intake_source_changed'].includes(error.message)
}

/** Each hop is authorized anew. The old record is a locator, never content. */
export async function recordingRecovery(
  authority: RecordingIntakeAuthority, workspaceId: string, recordingId: string, prepare = false,
): Promise<RecordingRecovery> {
  return recordingIntakeTransaction(authority, async client => {
    let currentId = recordingId
    const seen = new Set<string>()
    for (let depth = 0; depth < 16; depth++) {
      if (seen.has(currentId)) throw new Error('recording_recovery_unavailable')
      seen.add(currentId)
      const { rows } = await client.query<{ file_id: string; replacement_id: string | null }>(
        'SELECT * FROM read_recording_recovery_source($1,$2)', [workspaceId, currentId],
      )
      const source = rows[0]
      if (!source) throw new Error('recording_recovery_unavailable')
      const parent = await readRecordingIntakeParent(client, authority, workspaceId, source.file_id)
      const describe = (replacementId: string | null): RecordingRecovery => ({
        recordingId, replacementId, title: parent.name, mime: parent.mime,
      })
      if (source.replacement_id) {
        // Read through the caller's ordinary recording permissions. A held
        // replacement may itself need recovery; never expose its old metadata.
        const access = mutationActorAccess(authority.actorUserId, workspaceId, authority.access)
        const predicate = buildAccessPredicate(access, { alias: 'r', startIdx: 3 })
        // Reuse this transaction's client: opening a second pool connection
        // while holding the workspace lock can deadlock concurrent retries.
        const replacement = (await client.query<{ id: string }>(
          `SELECT r.id FROM recordings r WHERE r.id=$1 AND r.workspace_id=$2 AND ${predicate.sql}`,
          [source.replacement_id, workspaceId, ...predicate.params],
        )).rows[0]
        if (replacement) return describe(replacement.id)
        currentId = source.replacement_id
        continue
      }
      if (!prepare) return describe(null)
      const scope = await admitRecordingIntakeParent(client, authority, workspaceId, parent)
      // Match createRecording's Episode publication admission as well as its
      // source-read admission; recovery is not a policy override.
      const policy = await readAdmissionPolicy(client, workspaceId)
      if (policy?.setupState === 'ready') await admitWorkspaceResource(client, workspaceId, authority.actorUserId, {
        writerKind: 'episode', rowVisibility: scope, visibility: scope.userId ? 'private' : 'workspace', sensitivity: scope.sensitivity,
        inherited: { ...scope, visibility: scope.userId ? 'private' : 'workspace' }, inheritedAuthority: 'read',
      })
      const result = await client.query<{ id: string }>(
        'SELECT recover_file_recording($1::jsonb,$2::uuid,$3::uuid) AS id',
        [JSON.stringify(parent), currentId, randomUUID()],
      )
      return describe(result.rows[0].id)
    }
    throw new Error('recording_recovery_unavailable')
  })
}

/** Authenticated page operations follow the same replacement as the UI.
 * Public shares deliberately keep their separate original-source resolver. */
export async function resolveCurrentRecordingId(authority: RecordingIntakeAuthority, workspaceId: string, recordingId: string): Promise<string | null> {
  const current = await getRecording(authority.access ?? authority.actorUserId, recordingId)
  if (current) return current.workspaceId === workspaceId ? current.id : null
  try { return (await recordingRecovery(authority, workspaceId, recordingId)).replacementId }
  catch (error) { if (isRecordingRecoveryUnavailable(error)) return null; throw error }
}

export function createRecoverRecordingTool() {
  return buildTool({
    name: 'recoverRecording',
    description: 'Prepare recovery of a failed, held recording from its unchanged stored audio, without uploading again. ' +
      'Pass the recordingId from its page. Preserves the failed record and returns a fresh replacement recordingId. ' +
      'Does not transcribe or spend credits. Use the returned id with the native recording processing flow after the user confirms. ' +
      'Changed or inaccessible sources, review holds, active jobs and existing transcripts cannot be recovered this way.',
    inputSchema: z.object({ recordingId: z.string().uuid() }),
    isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: true, timeoutMs: 30_000,
    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor.error, isError: true }
      try {
        const result = await recordingRecovery({ actorUserId: actor.userId, access: actor as AccessContext }, actor.workspaceId, input.recordingId, true)
        return { data: { ...result, status: 'prepared', nextStep: 'Confirm processing of the replacement recording. No transcription has started.' } }
      } catch (error) {
        if (!isRecordingRecoveryUnavailable(error)) throw error
        return { data: 'Recording recovery is unavailable. The source must still be readable and unchanged, with no active job, transcript or review hold. Check source access and recording status; repeating the same request will not repair a restricted source.', isError: true }
      }
    },
  })
}
