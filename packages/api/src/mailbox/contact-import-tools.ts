/**
 * Explicit, preview-first recovery of historical mailbox senders into CRM.
 * Archive sync remains archive-only; this is the user-controlled bridge.
 *
 * [COMP:tools/mailbox-contact-import]
 */

import { z } from 'zod'
import { buildTool, type AccessContext, type CrmStore, type Tool, type ToolContext } from '@use-brian/core'
import {
  listMailboxContactImportCandidates,
  type MailboxContactCandidate,
} from '../db/mailbox-contact-store.js'

const IMPORT_BATCH_MAX = 100

export type MailboxContactImportDeps = {
  crm: CrmStore
  listCandidates?: typeof listMailboxContactImportCandidates
}

let globalDeps: MailboxContactImportDeps | null = null

export function setGlobalMailboxContactImportDeps(deps: MailboxContactImportDeps | null): void {
  globalDeps = deps
}

export function getGlobalMailboxContactImportDeps(): MailboxContactImportDeps | null {
  return globalDeps
}

function accessFor(context: ToolContext, workspaceId: string): AccessContext {
  return {
    workspaceId,
    userId: context.userId,
    assistantId: context.assistantId,
    assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance,
    compartments: context.compartments,
  }
}

export function createMailboxContactImportTools(opts: {
  ownerUserId: string
  instanceId: string
  accountEmail: string
  deps: MailboxContactImportDeps
}): Tool[] {
  const list = opts.deps.listCandidates ?? listMailboxContactImportCandidates
  const candidatesFor = async (context: ToolContext) => {
    const workspaceId = context.workspaceId
    if (!workspaceId) return null
    return list({
      ownerUserId: opts.ownerUserId,
      instanceId: opts.instanceId,
      accountEmail: opts.accountEmail,
      access: accessFor(context, workspaceId),
    })
  }
  const preview = buildTool({
    name: 'previewMailboxContactImport',
    description:
      `Preview people who have sent mail to ${opts.accountEmail} and are missing from the current workspace CRM. ` +
      'This reads synced envelope metadata only, excludes the connected account and machine/no-reply senders, and does not need embeddings. Use it before importMailboxContacts.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    requiresCapability: 'crm',
    async execute(_input, context) {
      const result = await candidatesFor(context)
      if (!result) return { data: 'Mailbox contacts can only be imported inside a workspace.', isError: true }
      return {
        data: {
          missingContacts: result.candidates.length,
          nextBatch: Math.min(result.candidates.length, IMPORT_BATCH_MAX),
          scanCapped: result.scanCapped,
          sample: result.candidates.slice(0, 20),
          note: result.candidates.length > IMPORT_BATCH_MAX
            ? `Import runs in batches of ${IMPORT_BATCH_MAX}; repeat preview and import until no contacts remain.`
            : 'Only names and normalized email addresses will be imported; message bodies stay in the personal mailbox archive.',
        },
      }
    },
  })

  const importTool = buildTool({
    name: 'importMailboxContacts',
    description:
      `Import up to ${IMPORT_BATCH_MAX} missing people from ${opts.accountEmail}'s synced sender envelopes into the current workspace CRM. ` +
      'Always call previewMailboxContactImport first. The operation is idempotent by normalized email and can be repeated until the preview is empty.',
    inputSchema: z.object({}),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: true,
    allowPersistentApproval: false,
    requiresCapability: 'crm',
    async describeConfirmation(_input, context) {
      const result = await candidatesFor(context)
      if (!result) return ['No contacts will be imported outside a workspace.']
      const batch = result.candidates.slice(0, IMPORT_BATCH_MAX)
      return [
        `Import ${batch.length} mailbox sender${batch.length === 1 ? '' : 's'} into CRM`,
        `Source: ${opts.accountEmail} synced envelope metadata`,
        'Fields: display name and normalized email only (no message bodies)',
        ...batch.slice(0, 10).map((candidate) => `• ${candidate.name} <${candidate.email}>`),
        ...(batch.length > 10 ? [`• and ${batch.length - 10} more`] : []),
      ]
    },
    async execute(_input, context) {
      const workspaceId = context.workspaceId
      const result = await candidatesFor(context)
      if (!workspaceId || !result) {
        return { data: 'Mailbox contacts can only be imported inside a workspace.', isError: true }
      }
      const batch = result.candidates.slice(0, IMPORT_BATCH_MAX)
      const access = accessFor(context, workspaceId)
      const imported: MailboxContactCandidate[] = []
      const failed: Array<{ email: string; reason: string }> = []
      for (const candidate of batch) {
        try {
          await opts.deps.crm.createContact({
            userId: context.userId,
            workspaceId,
            name: candidate.name,
            email: candidate.email,
            tags: ['email-import'],
            source: 'user',
            sourceSessionId: context.sessionId,
            createdByAssistantId: context.assistantId,
            access,
          })
          imported.push(candidate)
        } catch (err) {
          failed.push({ email: candidate.email, reason: err instanceof Error ? err.message : String(err) })
        }
      }
      return {
        data: {
          imported: imported.length,
          failed,
          remainingAtPreview: Math.max(0, result.candidates.length - batch.length),
          note: result.candidates.length > batch.length
            ? 'Repeat previewMailboxContactImport, then confirm another import batch.'
            : 'Mailbox contact recovery is complete for the currently synced archive.',
        },
        ...(failed.length > 0 && imported.length === 0 ? { isError: true } : {}),
      }
    },
  })

  return [preview, importTool]
}
