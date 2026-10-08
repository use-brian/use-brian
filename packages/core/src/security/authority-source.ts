import { z } from 'zod'

/** Host-owned source facts. A ceiling alone cannot recreate these after restart. */
export const WorkflowAuthoritySourceSchema = z.object({
    version: z.literal(1), kind: z.literal('workflow'), invocationId: z.string().uuid(),
    runId: z.string().uuid(), workspaceId: z.string().uuid(), authorityUserId: z.string().uuid(),
    executingAssistantId: z.string().uuid(), contextGroupId: z.string().uuid().nullable(), contextProjectId: z.string().uuid().nullable(),
    authorityFingerprint: z.string().regex(/^[a-f0-9]{64}$/), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    persistedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()
export const AuthoritySourceSchema = z.discriminatedUnion('kind', [
  WorkflowAuthoritySourceSchema,
  z.object({ version: z.literal(1), kind: z.literal('invocation'), invocationId: z.string().uuid() }).strict(),
  z.object({
    version: z.literal(1), kind: z.literal('session'), invocationId: z.string().uuid(),
    id: z.string().min(1), assistantId: z.string().min(1), userId: z.string().min(1),
    executingAssistantId: z.string().min(1), authorityUserId: z.string().min(1), workspaceId: z.string().min(1),
    contextGroupId: z.string().nullable(), contextProjectId: z.string().nullable(),
    contextLockedAt: z.string().datetime(),
    visibility: z.literal('owner'), mode: z.null(),
    effectiveClearance: z.enum(['public', 'internal', 'confidential']).nullable(),
    contextCompartments: z.array(z.string()),
    memberMode: z.enum(['enforce', 'assistant', 'member', 'external']),
    ignoreSessionBinding: z.boolean(), systemRead: z.boolean(),
  }).strict(),
])
export type AuthoritySource = z.infer<typeof AuthoritySourceSchema>
