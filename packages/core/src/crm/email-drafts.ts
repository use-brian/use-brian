import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/agent-runtime/tools/types.js'
import { idOrPathShape } from '../workspace-files/tool-helpers.js'

/**
 * Canonical workspace email drafts created during live assistant iteration.
 * These records are artifacts only: they carry no provider or send authority.
 *
 * Spec: docs/architecture/features/crm.md -> "Chat-authored drafts".
 * [COMP:crm/email-drafts]
 */

export type CrmEmailDraftStatus = 'draft' | 'discarded'

export type CrmEmailDraft = {
  id: string
  workspaceId: string
  status: CrmEmailDraftStatus
  revision: number
  from: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  attachments: string[]
  createdByUserId: string | null
  createdByAssistantId: string | null
  sourceSessionId: string | null
  createdAt: Date
  updatedAt: Date
}

export type CrmEmailDraftStore = {
  saveRevision(params: {
    userId: string
    workspaceId: string
    assistantId: string
    sessionId: string
    draftId?: string | null
    from?: string | null
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    body: string
    attachments?: string[]
  }): Promise<CrmEmailDraft | null>
  getById(params: {
    userId: string
    workspaceId: string
    draftId: string
  }): Promise<CrmEmailDraft | null>
  getActiveForSession(params: {
    userId: string
    workspaceId: string
    sessionId: string
  }): Promise<CrmEmailDraft | null>
  list(params: {
    userId: string
    workspaceId: string
    limit?: number
  }): Promise<CrmEmailDraft[]>
}

const draftIdSchema = z.string().uuid()
const addressSchema = z.string().trim().min(1).max(1000)
const recipientsSchema = z.array(addressSchema).max(100)
const attachmentsSchema = z.array(idOrPathShape).max(10)

function workspaceError() {
  return {
    data: 'Email drafts require a workspace. This assistant is not attached to one.',
    isError: true as const,
  }
}

function publicDraft(row: CrmEmailDraft) {
  return {
    draft_id: row.id,
    status: row.status,
    revision: row.revision,
    from: row.from,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    body: row.body,
    attachments: row.attachments,
    crm_path: `/w/${row.workspaceId}/crm?review=email&draft=${row.id}`,
    updated_at: row.updatedAt.toISOString(),
  }
}

export { formatActiveEmailDraftContext, buildEmailDraftAnchorPrompt } from '../context/email-draft.js'

export function createCrmEmailDraftTools(store: CrmEmailDraftStore): {
  saveEmailDraft: Tool
  getEmailDraft: Tool
  listEmailDrafts: Tool
} {
  const saveEmailDraft = buildTool({
    name: 'saveEmailDraft',
    requiresCapability: 'crm',
    description:
      'Save the COMPLETE current email draft as a durable CRM artifact before presenting, reproducing, or revising it. Include the entire envelope, body, and Brain-file attachment list on every call, never only the changed passage or newly added file. Without draft_id, the current conversation draft is revised when one exists; start_new=true deliberately starts a separate draft. Returns a stable CRM path and immutable revision number. This never resolves attachment bytes, creates a provider draft, creates an approval, or sends email.',
    inputSchema: z.object({
      draft_id: draftIdSchema.optional().describe('Existing canonical draft UUID. Omit to revise the active conversation draft.'),
      start_new: z.boolean().optional().describe('True only when deliberately starting a different email. Cannot be combined with draft_id.'),
      from: addressSchema.optional().describe('Complete sender display/address when known.'),
      to: recipientsSchema.describe('Complete To recipient list, preserving display names and addresses. Pass [] while no recipient is set.'),
      cc: recipientsSchema.optional().describe('Complete Cc list. Pass [] when the current draft has none.'),
      bcc: recipientsSchema.optional().describe('Complete Bcc list. Pass [] when the current draft has none.'),
      subject: z.string().max(1000).describe('Complete current subject, including an intentionally blank subject.'),
      body: z.string().min(1).max(100_000).describe('Complete current email body. Never pass a delta or shortened preview.'),
      attachments: attachmentsSchema.optional().describe(
        'Complete Brain-file attachment list. Each entry is a workspace file id or absolute path from file search/save. Pass [] when the draft has no attachments. These refs are saved with the draft but bytes are resolved only by a later email send tool.',
      ),
    }).refine((input) => !(input.start_new && input.draft_id), {
      message: 'start_new cannot be combined with draft_id',
    }),
    isReadOnly: false,
    isConcurrencySafe: false,
    async execute(input, context) {
      if (!context.workspaceId) return workspaceError()
      let draftId = input.draft_id ?? null
      if (!draftId && !input.start_new) {
        const active = await store.getActiveForSession({
          userId: context.userId,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
        })
        draftId = active?.id ?? null
      }
      const row = await store.saveRevision({
        userId: context.userId,
        workspaceId: context.workspaceId,
        assistantId: context.assistantId,
        sessionId: context.sessionId,
        draftId,
        from: input.from ?? null,
        to: input.to,
        cc: input.cc ?? [],
        bcc: input.bcc ?? [],
        subject: input.subject,
        body: input.body,
        attachments: input.attachments ?? [],
      })
      if (!row) {
        return {
          data: 'The requested email draft was not found in this workspace or is no longer active. Use listEmailDrafts, or set start_new=true for a different email.',
          isError: true,
        }
      }
      return { data: publicDraft(row) }
    },
  })

  const getEmailDraft = buildTool({
    name: 'getEmailDraft',
    requiresCapability: 'crm',
    description:
      'Read the exact complete canonical CRM email draft. Omit draft_id to read this conversation\'s active draft. Use this instead of reconstructing text from chat history or a shortened reply quote.',
    inputSchema: z.object({
      draft_id: draftIdSchema.optional(),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) return workspaceError()
      const row = input.draft_id
        ? await store.getById({
            userId: context.userId,
            workspaceId: context.workspaceId,
            draftId: input.draft_id,
          })
        : await store.getActiveForSession({
            userId: context.userId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
          })
      return row
        ? { data: publicDraft(row) }
        : { data: 'No matching canonical email draft is available.', isError: true }
    },
  })

  const listEmailDrafts = buildTool({
    name: 'listEmailDrafts',
    requiresCapability: 'crm',
    description:
      'List current canonical CRM email draft summaries in this workspace. Bodies are omitted; call getEmailDraft with the returned draft_id for exact text.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) return workspaceError()
      const rows = await store.list({
        userId: context.userId,
        workspaceId: context.workspaceId,
        limit: input.limit ?? 25,
      })
      return {
        data: rows.map((row) => ({
          draft_id: row.id,
          revision: row.revision,
          to: row.to,
          subject: row.subject,
          attachment_count: row.attachments.length,
          crm_path: `/w/${row.workspaceId}/crm?review=email&draft=${row.id}`,
          updated_at: row.updatedAt.toISOString(),
        })),
      }
    },
  })

  return { saveEmailDraft, getEmailDraft, listEmailDrafts }
}
