/** Metadata comparison only; never a field/record grant. [COMP:api/policy-epoch] */
import { z } from 'zod'
import { query } from '../db/client.js'
import { AuthorityChangedError } from './authority-lease.js'

const identitySchema = z.object({ workspaceId: z.string().uuid(), principalId: z.string().uuid(), assistantId: z.string().uuid() }).strict()
type PolicyIdentity = z.infer<typeof identitySchema>
const revision = z.string().regex(/^(0|[1-9][0-9]*)$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const snapshotSchema = identitySchema.extend({
  version: z.literal(1), workspaceRevision: revision, contractRevision: revision,
  timedState: fingerprint,
  modules: z.array(z.object({
    moduleKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/), contractVersion: z.string().min(1).max(128),
    configurationRevision: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/).nullable(), ports: fingerprint,
  }).strict()).superRefine((modules, ctx) => {
    if (modules.some((module, index) => index > 0 && modules[index - 1].moduleKey >= module.moduleKey)) {
      ctx.addIssue({ code: 'custom', message: 'Noncanonical module order' })
    }
  }),
}).strict()

async function readPolicyEpochSystem(identity: PolicyIdentity): Promise<unknown> {
  // Owner connection reads only canonical policy metadata through a private port.
  // No GUC identity replacement or owner-backed business-data admission occurs.
  return (await query<{ snapshot: unknown }>('SELECT public.read_application_policy_epoch($1,$2,$3) AS snapshot',
    [identity.workspaceId, identity.principalId, identity.assistantId])).rows[0]?.snapshot
}

/** Pin before resolving trusted ceilings; compare again after construction and on every lease boundary. */
export async function pinPolicyEpoch(identity: PolicyIdentity,
  read: (identity: PolicyIdentity) => Promise<unknown> = readPolicyEpochSystem): Promise<() => Promise<boolean>> {
  const parsedIdentity = identitySchema.safeParse(identity)
  if (!parsedIdentity.success) throw new AuthorityChangedError()
  const expected = Object.freeze(parsedIdentity.data)
  async function snapshot(): Promise<string | null> {
    const parsed = snapshotSchema.safeParse(await read(expected))
    if (!parsed.success || parsed.data.workspaceId !== expected.workspaceId || parsed.data.principalId !== expected.principalId
      || parsed.data.assistantId !== expected.assistantId) return null
    return JSON.stringify(parsed.data)
  }
  let initial: string | null
  try { initial = await snapshot() } catch { throw new AuthorityChangedError() }
  if (!initial) throw new AuthorityChangedError()
  let invalid = false
  return async () => {
    if (invalid) return false
    try { if (await snapshot() !== initial) invalid = true } catch { invalid = true }
    // Another validator's refusal cannot be overwritten after an await.
    return !invalid
  }
}
