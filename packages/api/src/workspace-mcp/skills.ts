import { workspaceMcpContextBinding } from './contexts.js'
/** Governed native skills with connection-bound activation. [COMP:api/workspace-mcp] */
import type { ToolContext } from '@use-brian/core'
import { queryWithRLS } from '../db/client.js'
import { injectSkills } from '../routes/route-helpers.js'

export async function injectWorkspaceMcpSkills(context: ToolContext, options: Parameters<typeof injectSkills>[0]) {
  const identity = context.executionContext?.identity
  if (identity?.kind !== 'programmatic' || !['brain_key', 'assistant_key', 'oauth_token'].includes(identity.principal.kind)) {
    throw new Error('workspace_mcp_authority_required')
  }
  const column = identity.principal.kind === 'brain_key' ? 'brain_key_id' : identity.principal.kind === 'oauth_token' ? 'oauth_authorization_id' : 'api_key_id'
  const keyId = identity.principal.credentialId
  const { selectionId } = workspaceMcpContextBinding(context)
  const activated = new Set<string>()
  if (context.sessionPersisted) {
    const row = (await queryWithRLS<{ activated_skill_slugs: string[] }>(context.userId,
      `SELECT activated_skill_slugs FROM workspace_mcp_contexts WHERE ${column}=$1 AND selection_id=$2 AND NOT invalidated`, [keyId, selectionId])).rows[0]
    for (const slug of row?.activated_skill_slugs ?? []) activated.add(slug)
  }
  await injectSkills({ ...options, activatedSkillSlugs: activated, executionContext: context.executionContext, scopeAccumulator: context.scopeAccumulator, exposeListingTool: true })
  const activate = options.tools.get('useSkill')
  if (activate && context.sessionPersisted) options.tools.set(activate.name, { ...activate,
    async execute(input, invocation) {
      const result = await activate.execute(input, invocation)
      if (!result.isError) {
        await invocation.authority!.assertCurrent()
        const saved = await queryWithRLS(context.userId,
          `UPDATE workspace_mcp_contexts SET activated_skill_slugs=$2,updated_at=now()
           WHERE ${column}=$1 AND selection_id=$3 AND NOT invalidated RETURNING id`, [keyId, [...activated], selectionId])
        if (!saved.rowCount) throw new Error('workspace_mcp_context_unavailable')
      }
      return result
    },
  })
}
