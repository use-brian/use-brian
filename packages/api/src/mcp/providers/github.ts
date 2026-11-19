/**
 * GitHub provider (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyPolicyOrSkip`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { createGitHubTools } from '@use-brian/core/tools/base/github.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { AssistantConnectorStore } from '../../db/assistant-connector-store.js'
import { gateToolsOnActionGrants } from '../../safety/assert-action-allowed.js'
import { wrapToolsWithHealthProbe, type HealthReporter } from '../connector-health.js'
import { searchRepositories, getRepository, listIssues, getIssue, listPullRequests, getPullRequest, createIssue, createIssueComment, getFileContents, createOrUpdateFile } from '../../github/client.js'
import { applyPolicyOrSkip, injectInstanceVariants } from '../activation.js'
import type { ConnectorInstanceRef } from '../tool-names.js'
import { notConnectedNotice } from './notices.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes, laneUnavailable, type BuiltinLane } from './lanes.js'

// ── Built-in GitHub connector ────────────────────────────────

async function collectGitHubTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /**
   * Optional credential-source override (Stage 5 of the team-connector
   * promotion). When provided, replaces the default
   * `connectorStore.getCredentials(userId, 'github')` lookup. Lets the
   * caller drive injection from a team-native `connector_instance` row
   * whose credentials don't live in `mcp_connectors`.
   */
  credsOverride?: () => Promise<string | null>,
  /**
   * Additional connected GitHub instances (multi-account). The primary
   * (oldest) instance is served by the canonical tools above; each of these
   * gets a label-qualified variant set bound to its own PAT via
   * `resolveInstanceCreds`. Only passed on the personal base load.
   */
  extraInstances?: ConnectorInstanceRef[],
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
  /**
   * Call-time liveness probe (migration 294). When set, the built tools are
   * wrapped so a 401/403 flips the backing connector_instance to `auth_failed`
   * (and a success resets it). `instanceId` overrides the resolved primary id —
   * needed on the team-native / grant paths whose synthetic connector array
   * carries no id. See mcp/connector-health.ts.
   */
  healthProbe?: { report: HealthReporter; instanceId?: string | null },
  /** Per-assistant write-grant gate — see `gateToolsOnActionGrants`. */
  assistantConnectorGrantsStore?: import('../../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
): Promise<void> {
  const github = connectors.find((c) => c.connectorId === 'github' && c.connected)
  const githubEnabled = github && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'github'))

  if (!github) {
    unavailable?.push(notConnectedNotice('GitHub', 'repositories, issues, and pull requests'))
    return
  }

  // Build the GitHub tool set bound to a given PAT source. Reused for the
  // primary instance and (renamed) for each extra account.
  function buildTools(getPat: () => Promise<string>, governanceId: string = 'github'): Tool[] {
    return gateToolsOnActionGrants(createGitHubTools({
      searchRepositories: async (params) => searchRepositories(await getPat(), params),
      getRepository: async (owner, repo) => getRepository(await getPat(), owner, repo),
      listIssues: async (owner, repo, params) => listIssues(await getPat(), owner, repo, params),
      getIssue: async (owner, repo, issueNumber) => getIssue(await getPat(), owner, repo, issueNumber),
      listPullRequests: async (owner, repo, params) => listPullRequests(await getPat(), owner, repo, params),
      getPullRequest: async (owner, repo, pullNumber) => getPullRequest(await getPat(), owner, repo, pullNumber),
      createIssue: async (owner, repo, params) => createIssue(await getPat(), owner, repo, params),
      createIssueComment: async (owner, repo, issueNumber, body) => createIssueComment(await getPat(), owner, repo, issueNumber, body),
      getFileContents: async (owner, repo, path, ref) => getFileContents(await getPat(), owner, repo, path, ref),
      createOrUpdateFile: async (owner, repo, params) => createOrUpdateFile(await getPat(), owner, repo, params),
    }), 'github', assistantConnectorGrantsStore, assistantId, governanceId)
  }

  async function getPat(): Promise<string> {
    if (credsOverride) {
      const pat = await credsOverride()
      if (!pat) throw new Error('GitHub not connected (team-native override returned no creds)')
      return pat
    }
    const creds = await connectorStore.getCredentials(userId, 'github')
    if (!creds) throw new Error('GitHub not connected')
    return creds.client_secret
  }

  const primaryInstanceId = healthProbe?.instanceId ?? (github as { id?: string }).id ?? null
  try {
    if (githubEnabled) {
      const built = buildTools(getPat)
      const ghTools = healthProbe && primaryInstanceId
        ? wrapToolsWithHealthProbe(built, primaryInstanceId, healthProbe.report)
        : built

      for (const tool of ghTools) {
        if (await applyPolicyOrSkip(tool, 'github', settingsStore, assistantId, userId, unavailable) === 'include') {
          tools.set(tool.name, tool)
        }
      }
    }

    // Extra GitHub accounts → label-qualified variant tool sets.
    if (extraInstances?.length && resolveInstanceCreds) {
      await injectInstanceVariants({
        provider: 'github',
        extras: extraInstances,
        settingsStore, assistantId, userId, assistantConnectorStore, tools,
        buildToolsForInstance: (inst, governanceId) => {
          const variant = buildTools(async () => {
            const pat = await resolveInstanceCreds(inst.id)
            if (!pat) throw new Error(`GitHub instance ${inst.id} has no credentials`)
            return pat
          }, governanceId)
          return healthProbe ? wrapToolsWithHealthProbe(variant, inst.id, healthProbe.report) : variant
        },
      })
    }

    console.debug(`[mcp-inject] GitHub: injected tools${extraInstances?.length ? ` (+${extraInstances.length} extra account(s))` : ''}`)
  } catch (err) {
    console.error('[mcp-inject] GitHub injection failed:', err)
  }
}

// ── Provider module ───────────────────────────────────────────

/** One GitHub lane: the personal base load, a member-exposure grant, or a workspace-owned row. */
export type GitHubLane = BuiltinLane<{ connectorId: string; connected: boolean; url?: string | null }> & {
  credsOverride?: () => Promise<string | null>
  extraInstances?: ConnectorInstanceRef[]
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>
  healthProbe?: { report: HealthReporter; instanceId?: string | null }
}

export async function activateGitHubLane(ctx: ProviderActivationContext, lane: GitHubLane): Promise<Tool[]> {
  const tools = new Map<string, Tool>()
  await collectGitHubTools(
    lane.connectors, ctx.stores.connectorStore, lane.settingsStore, lane.userId, ctx.assistantId,
    ctx.stores.assistantConnectorStore, tools, laneUnavailable(ctx, lane), lane.credsOverride,
    lane.extraInstances, lane.resolveInstanceCreds, lane.healthProbe, ctx.stores.assistantConnectorGrantsStore,
  )
  return [...tools.values()]
}

export const githubProvider: ProviderModule<readonly GitHubLane[]> = {
  family: 'github',
  describe: memoDescribe(() => describeFactoryTools('github', { github: () => createGitHubTools(inertPort('github')) })),
  activate: (ctx, lanes) => runLanes(lanes, (lane) => activateGitHubLane(ctx, lane)),
}
