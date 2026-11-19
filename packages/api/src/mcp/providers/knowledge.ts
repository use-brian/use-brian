/**
 * Knowledge-base provider (M3 WP2).
 *
 * Read tools whenever the assistant has KB entries or sources; write tools
 * (`addKnowledgeEntry`, `updateKnowledgeEntry`) only on a surface that allows
 * KB writes, either through an explicit workflow step or through a matched
 * workspace capture rule whose destination is enabled and writable. Writes
 * stay closed-world: when gated they are neither activated nor searchable,
 * and the reason is recorded honestly in `unavailable`.
 *
 * See docs/architecture/features/knowledge-base.md (§Assistant direct edits,
 * §Workspace capture rules) and docs/architecture/integrations/mcp.md →
 * "Provider activation".
 */
import type { KnowledgeStoreInterface } from '@use-brian/core/knowledge/types.js'
import { createKnowledgeTools, type KnowledgeWriteCaptureRule } from '@use-brian/core/tools/base/knowledge.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { buildKnowledgeCapturePrompt, matchKnowledgeCaptureRules, type KnowledgeCaptureRuleStore } from '../../knowledge/capture-rules.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeBuiltTools, memoDescribe } from './describe.js'

export type MatchedCaptureRules = Awaited<ReturnType<KnowledgeCaptureRuleStore['listEnabledForWorkspace']>>

/**
 * Match the turn's capture text against the workspace's enabled capture rules.
 * Only interactive capture surfaces with capture text match; a lookup failure
 * fails closed (no write authorization), reads stay available.
 */
export async function matchTurnCaptureRules(params: {
  allowKnowledgeWrites: boolean
  knowledgeWriteAuthorization: 'capture' | 'workflow'
  assistantTeamId?: string | null
  knowledgeCaptureRuleStore?: KnowledgeCaptureRuleStore
  knowledgeCaptureText?: string
}): Promise<MatchedCaptureRules> {
  const { allowKnowledgeWrites, knowledgeWriteAuthorization, assistantTeamId, knowledgeCaptureRuleStore, knowledgeCaptureText } = params
  let matchedCaptureRules = [] as MatchedCaptureRules
  if (
    allowKnowledgeWrites
    && knowledgeWriteAuthorization === 'capture'
    && assistantTeamId
    && knowledgeCaptureRuleStore
    && knowledgeCaptureText?.trim()
  ) {
    try {
      const enabled = await knowledgeCaptureRuleStore.listEnabledForWorkspace(assistantTeamId)
      matchedCaptureRules = matchKnowledgeCaptureRules(enabled, knowledgeCaptureText)
    } catch (err) {
      // Authorization lookup fails closed. Reads remain available.
      console.error('[mcp-inject] knowledge capture-rule lookup failed:', err)
    }
  }
  return matchedCaptureRules
}

/** The knowledge lane: write authorization for this surface plus the turn's matched rules. */
export type KnowledgeLane = {
  allowKnowledgeWrites: boolean
  knowledgeWriteAuthorization: 'capture' | 'workflow'
  matchedCaptureRules: MatchedCaptureRules
}

export async function activateKnowledgeLane(
  ctx: ProviderActivationContext,
  lane: KnowledgeLane,
): Promise<{ tools: Tool[]; knowledgeCapturePrompt?: string }> {
  const { assistantId, unavailable } = ctx
  const { knowledgeStore, knowledgeRepoWriter } = ctx.stores
  const actorIdentity = ctx.hosted.actorIdentity
  const { allowKnowledgeWrites, knowledgeWriteAuthorization, matchedCaptureRules } = lane
  const kbOut: Tool[] = []
  let knowledgeCapturePrompt: string | undefined
  if (knowledgeStore) {
    try {
      const hasEntries = await knowledgeStore.hasEntriesForAssistant(assistantId)
      const sources = await knowledgeStore.listSourcesForAssistant(assistantId)
      if (hasEntries || sources.length > 0 || matchedCaptureRules.some((rule) => rule.targetSourceId === null)) {
        const repoConnected = sources.length > 0

        // KB write exposure: GitHub sources require a cached push-capability
        // probe; local sources are writable through the filesystem writer.
        // The interactive-surface and writer-port gates apply to both.
        const writableSources = sources
          .filter((s) => s.sourceType === 'local' || s.writeAccess === true)
          .map((s) => ({ id: s.id, repo: s.repo, sourceType: s.sourceType }))

        const captureAuthorizations: KnowledgeWriteCaptureRule[] = []
        for (const rule of matchedCaptureRules) {
          if (rule.targetSourceId === null) {
            captureAuthorizations.push({
              id: rule.id,
              name: rule.name,
              instructions: rule.instructions,
              targetSourceId: null,
              targetLabel: 'Manual entries',
              pathPrefix: rule.pathPrefix,
              defaultSensitivity: rule.defaultSensitivity,
            })
            continue
          }
          const source = sources.find((candidate) => candidate.id === rule.targetSourceId)
          const writable = writableSources.find((candidate) => candidate.id === rule.targetSourceId)
          if (source && writable && knowledgeRepoWriter) {
            captureAuthorizations.push({
              id: rule.id,
              name: rule.name,
              instructions: rule.instructions,
              targetSourceId: rule.targetSourceId,
              targetLabel: source.repo,
              pathPrefix: rule.pathPrefix,
              defaultSensitivity: rule.defaultSensitivity,
            })
          } else {
            unavailable.push(
              source
                ? `knowledge capture category "${rule.name}" (its destination ${source.repo} is currently read-only)`
                : `knowledge capture category "${rule.name}" (its configured destination is not enabled for this assistant)`,
            )
          }
        }

        const workflowWriteEnabled =
          allowKnowledgeWrites
          && knowledgeWriteAuthorization === 'workflow'
          && (!repoConnected || (!!knowledgeRepoWriter && writableSources.length > 0))
        const captureWriteEnabled =
          allowKnowledgeWrites
          && knowledgeWriteAuthorization === 'capture'
          && captureAuthorizations.length > 0
        const writeEnabled = workflowWriteEnabled || captureWriteEnabled

        const kbTools = createKnowledgeTools(knowledgeStore, {
          repoConnected,
          allowWrites: writeEnabled,
          repoWriter: writeEnabled ? knowledgeRepoWriter : undefined,
          writableSources: writeEnabled ? writableSources : [],
          captureRules: captureWriteEnabled ? captureAuthorizations : [],
          requesterLabel: actorIdentity?.email ?? null,
        })
        for (const tool of kbTools) {
          kbOut.push(tool)
        }

        // Capability honesty: explain why source write-back is unavailable
        // instead of letting the model hunt for a tool that is not present.
        if (
          allowKnowledgeWrites
          && knowledgeWriteAuthorization === 'workflow'
          && repoConnected
          && !writeEnabled
        ) {
          const githubRepos = sources.filter((s) => s.sourceType !== 'local').map((s) => s.repo).join(', ')
          unavailable.push(
            !knowledgeRepoWriter
              ? 'knowledge base editing (source write-back is not configured on this server)'
              : githubRepos
                ? `knowledge base editing (the GitHub token backing ${githubRepos} is read-only — needs push permission; reconnect it with a read-write token in Studio → Connectors to enable assistant edits)`
                : 'knowledge base editing (no writable source is available)',
          )
        }

        if (captureWriteEnabled) {
          knowledgeCapturePrompt = buildKnowledgeCapturePrompt(
            matchedCaptureRules
              .filter((rule) => captureAuthorizations.some((authorization) => authorization.id === rule.id))
              .map((rule) => ({
                ...rule,
                targetLabel: captureAuthorizations.find((authorization) => authorization.id === rule.id)!.targetLabel,
              })),
          )
        }

        console.debug(`[mcp-inject] Knowledge: injected ${kbTools.length} tools (repo connected: ${repoConnected}, writable sources: ${writableSources.length}, writes: ${writeEnabled})`)
      }
    } catch (err) {
      console.error('[mcp-inject] Knowledge injection failed:', err)
    }
  }
  return { tools: kbOut, knowledgeCapturePrompt }
}

const inertKnowledgeStore = new Proxy({}, {
  get: () => async () => { throw new Error('Knowledge descriptors are inert; activate the provider to call a tool.') },
}) as unknown as KnowledgeStoreInterface

export const knowledgeProvider: ProviderModule<KnowledgeLane> = {
  family: 'knowledge',
  describe: memoDescribe(() => describeBuiltTools('knowledge', 'knowledge', createKnowledgeTools(inertKnowledgeStore, { allowWrites: true, repoConnected: false }))),
  activate: async (ctx, lane) => (await activateKnowledgeLane(ctx, lane)).tools,
}
