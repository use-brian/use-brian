/**
 * WordPress managed-content provider (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyPolicyOrSkip`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import type { CachedFile } from '@use-brian/core/files/types.js'
import { createWordPressTools } from '@use-brian/core/tools/base/wordpress.js'
import type { FilesApi } from '@use-brian/core/workspace-files/api.js'
import { promoteCachedFile } from '@use-brian/core/workspace-files/promote.js'
import { ctxFor as workspaceFilesCtxFor, errorMessage as workspaceFilesErrorMessage, workspaceGate as workspaceFilesGate } from '@use-brian/core/workspace-files/tool-helpers.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { AssistantConnectorStore } from '../../db/assistant-connector-store.js'
import { gateToolsOnActionGrants } from '../../safety/assert-action-allowed.js'
import { wrapToolsWithHealthProbe, type HealthReporter } from '../connector-health.js'
import { createWordPressApi, unpackWordPressCredentials, type WordPressCredentials } from '../../wordpress/client.js'
import { applyPolicyOrSkip, injectInstanceVariants } from '../activation.js'
import type { ConnectorInstanceRef } from '../tool-names.js'
import { notConnectedNotice, expiredCredentialsNotice } from './notices.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes, laneUnavailable, type BuiltinLane } from './lanes.js'

// ── Built-in WordPress managed-content connector ────────────
// Three fixed tools over the OSS Use Brian Bridge. The bridge's registered
// page/slot catalog is the write boundary; credentials are a static WordPress
// Application Password tuple, one independently-bound tuple per site.

async function collectWordPressTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /** Exact-instance credential override for a grant/team-native overlay. */
  credsOverride?: () => Promise<string | null>,
  /** Additional connected WordPress sites for the personal base load. */
  extraInstances?: ConnectorInstanceRef[],
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
  healthProbe?: { report: HealthReporter; instanceId?: string | null },
  assistantConnectorGrantsStore?: import('../../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
  filesApi?: FilesApi,
  readCachedFile?: (id: string, ctx: AccessContext) => Promise<CachedFile | null>,
): Promise<void> {
  const wordpress = connectors.find((c) => c.connectorId === 'wordpress' && c.connected)
  const wordpressEnabled = wordpress && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'wordpress'))

  if (!wordpress) {
    unavailable?.push(notConnectedNotice('WordPress', 'managed page text and images'))
    return
  }

  const primaryCredentials = async (): Promise<string | null> => {
    if (credsOverride) return credsOverride()
    return (await connectorStore.getCredentials(userId, 'wordpress'))?.client_secret ?? null
  }

  const resolveTuple = async (load: () => Promise<string | null>): Promise<WordPressCredentials> => {
    const encoded = await load()
    const tuple = encoded ? unpackWordPressCredentials(encoded) : null
    if (!tuple) throw new Error('WordPress connector credentials are missing or invalid')
    return tuple
  }

  function buildTools(
    load: () => Promise<string | null>,
    governanceId: string = 'wordpress',
  ): Tool[] {
    const withApi = async <T>(call: (api: ReturnType<typeof createWordPressApi>) => Promise<T>): Promise<T> => {
      return call(createWordPressApi(await resolveTuple(load)))
    }
    return gateToolsOnActionGrants(createWordPressTools({
      getManagedPage: (page) => withApi((api) => api.getManagedPage(page)),
      updatePageText: (params) => withApi((api) => api.updatePageText(params)),
      replacePageImage: (params) => withApi((api) => api.replacePageImage(params)),
    }, {
      readFileBytes: filesApi
        ? async (context, idOrPath) => {
            const gate = workspaceFilesGate(context.workspaceId)
            if (gate) return { error: gate.data }
            const ctx = workspaceFilesCtxFor(context)
            let result = await filesApi.readBytes(ctx, idOrPath)
            if (!result.ok && result.error.kind === 'not_found' && readCachedFile) {
              const cached = await readCachedFile(idOrPath, {
                workspaceId: context.workspaceId!,
                userId: context.userId,
                assistantId: context.assistantId,
                assistantKind: context.assistantKind ?? 'standard',
                clearance: context.clearance,
                compartments: context.compartments,
              })
              if (cached) {
                const promoted = await promoteCachedFile(filesApi, ctx, cached)
                if (!promoted.ok) return { error: workspaceFilesErrorMessage(promoted.error) }
                result = await filesApi.readBytes(ctx, promoted.value.id)
              }
            }
            if (!result.ok) {
              return {
                error: workspaceFilesErrorMessage(result.error),
                notFound: result.error.kind === 'not_found',
              }
            }
            return {
              bytes: result.value.bytes,
              fileName: result.value.file.name,
              mimeType: result.value.file.mime,
            }
          }
        : undefined,
    }), 'wordpress', assistantConnectorGrantsStore, assistantId, governanceId)
  }

  const primaryInstanceId = healthProbe?.instanceId ?? (wordpress as { id?: string }).id ?? null
  try {
    if (wordpressEnabled) {
      const encoded = await primaryCredentials()
      if (!encoded || !unpackWordPressCredentials(encoded)) {
        unavailable?.push(expiredCredentialsNotice('WordPress'))
      } else {
        const built = buildTools(primaryCredentials)
        const wordpressTools = healthProbe && primaryInstanceId
          ? wrapToolsWithHealthProbe(built, primaryInstanceId, healthProbe.report)
          : built
        for (const tool of wordpressTools) {
          if (await applyPolicyOrSkip(tool, 'wordpress', settingsStore, assistantId, userId, unavailable) === 'include') {
            tools.set(tool.name, tool)
          }
        }
      }
    }

    if (extraInstances?.length && resolveInstanceCreds) {
      await injectInstanceVariants({
        provider: 'wordpress',
        extras: extraInstances,
        settingsStore, assistantId, userId, assistantConnectorStore, tools,
        buildToolsForInstance: (instance, governanceId) => {
          const variant = buildTools(() => resolveInstanceCreds(instance.id), governanceId)
          return healthProbe ? wrapToolsWithHealthProbe(variant, instance.id, healthProbe.report) : variant
        },
      })
    }

    console.debug(`[mcp-inject] WordPress: injected tools${extraInstances?.length ? ` (+${extraInstances.length} extra site(s))` : ''}`)
  } catch (err) {
    console.error('[mcp-inject] WordPress injection failed:', err)
  }
}

// ── Provider module ───────────────────────────────────────────

/** One WordPress lane. Attached bytes come from the executing surface and actor. */
export type WordPressLane = BuiltinLane<{ connectorId: string; connected: boolean; url?: string | null }> & {
  credsOverride?: () => Promise<string | null>
  extraInstances?: ConnectorInstanceRef[]
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>
  healthProbe?: { report: HealthReporter; instanceId?: string | null }
}

export async function activateWordPressLane(ctx: ProviderActivationContext, lane: WordPressLane): Promise<Tool[]> {
  const tools = new Map<string, Tool>()
  await collectWordPressTools(
    lane.connectors, ctx.stores.connectorStore, lane.settingsStore, lane.userId, ctx.assistantId,
    ctx.stores.assistantConnectorStore, tools, laneUnavailable(ctx, lane), lane.credsOverride,
    lane.extraInstances, lane.resolveInstanceCreds, lane.healthProbe, ctx.stores.assistantConnectorGrantsStore,
    ctx.attachments.filesApi, ctx.attachments.readCachedFile,
  )
  return [...tools.values()]
}

export const wordpressProvider: ProviderModule<readonly WordPressLane[]> = {
  family: 'wordpress',
  describe: memoDescribe(() => describeFactoryTools('wordpress', { wordpress: () => createWordPressTools(inertPort('wordpress'), { readFileBytes: inertPort('wordpress files') }) })),
  activate: (ctx, lanes) => runLanes(lanes, (lane) => activateWordPressLane(ctx, lane)),
}
