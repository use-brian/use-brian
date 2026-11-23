/**
 * Shopify provider (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyToolPolicies`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import type { CachedFile } from '@use-brian/core/files/types.js'
import { createShopifyTools } from '@use-brian/core/tools/base/shopify.js'
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
import { createShopifyTokenManager, isManagedShopifyTokens, unpackShopifyTokens, packShopifyTokens, getShop as getShopifyShop, listProducts as listShopifyProducts, getProduct as getShopifyProduct, listOrders as listShopifyOrders, getOrder as getShopifyOrder, searchCustomers as searchShopifyCustomers, getCustomer as getShopifyCustomer, previewCustomerSegment as previewShopifyCustomerSegment, createCustomerSegment as createShopifyCustomerSegment, getInventoryLevels as getShopifyInventoryLevels, listCollections as listShopifyCollections, listDraftOrders as listShopifyDraftOrders, listDiscounts as listShopifyDiscounts, listAbandonedCheckouts as listShopifyAbandonedCheckouts, getPayoutsSummary as getShopifyPayoutsSummary, listDisputes as listShopifyDisputes, listContent as listShopifyContent, fetchOrdersRange as fetchShopifyOrdersRange, storefrontFunnel as shopifyStorefrontFunnelQuery, runShopifyqlQuery, updateProduct as updateShopifyProduct, createProduct as createShopifyProduct, createDraftOrder as createShopifyDraftOrder, sendDraftOrderInvoice as sendShopifyDraftOrderInvoice, addTags as addShopifyTags, updateCustomer as updateShopifyCustomer, setInventoryQuantity as setShopifyInventoryQuantity, createFulfillment as createShopifyFulfillment, createDiscountCode as createShopifyDiscountCode, createContent as createShopifyContent, cancelOrder as cancelShopifyOrder, refundOrder as refundShopifyOrder, completeDraftOrder as completeShopifyDraftOrder, addProductImage as addShopifyProductImage, setVariantPrice as setShopifyVariantPrice, publishProduct as publishShopifyProduct, setProductMetafields as setShopifyProductMetafields, setProductOptions as setShopifyProductOptions, listThemes as listShopifyThemes, listProductTemplates as listShopifyProductTemplates, readProductTemplate as readShopifyProductTemplate, createProductTemplate as createShopifyProductTemplate, setProductTemplate as setShopifyProductTemplate } from '../../shopify/client.js'
import { getConnectorConfig } from '../../connector-config.js'
import { applyToolPolicies, injectInstanceVariants } from '../activation.js'
import type { ConnectorInstanceRef } from '../tool-names.js'
import { notConnectedNotice } from './notices.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes, laneUnavailable, type BuiltinLane } from './lanes.js'

// ── Built-in Shopify connector ─────────────────────────────
// Store reads + safe v1 writes (docs/architecture/integrations/shopify.md).
// Credentials are a per-shop tuple: pasted `shpat_` tokens are static; OAuth
// tokens are expiring with a ROTATING refresh token, so like Fathom each
// account gets its own token manager whose persist is bound to that
// instance's row (persist-before-use — a lost persist bricks the connection).

async function collectShopifyTools(
  connectors: Array<{ connectorId: string; connected: boolean; url?: string | null }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  unavailable?: string[],
  /** See `collectGitHubTools` — same role. Returns the encoded ShopifyTokens JSON blob. */
  credsOverride?: () => Promise<string | null>,
  /** Persistence override for grant/team-native rows; defaults to the user-scoped connectorStore. */
  persistOverride?: (encoded: string) => Promise<void>,
  /** Additional connected Shopify instances (multi-store). See `collectGitHubTools`. */
  extraInstances?: ConnectorInstanceRef[],
  /** Load an extra instance's encoded token tuple. */
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
  /** Persist a rotated token tuple back to an extra instance. */
  persistInstanceCreds?: (instanceId: string, clientId: string, secret: string) => Promise<void>,
  /** Call-time liveness probe (migration 294). See `collectGitHubTools`. */
  healthProbe?: { report: HealthReporter; instanceId?: string | null },
  /** Per-assistant write-grant gate — see `gateToolsOnActionGrants`. */
  assistantConnectorGrantsStore?: import('../../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
  /** Workspace-file reader for `shopifyAddProductImage`. Absent → the tool reports it honestly. */
  filesApi?: FilesApi,
  /** Upload-cache reader, so a just-attached photo can be promoted on the fly. */
  readCachedFile?: (id: string, ctx: AccessContext) => Promise<CachedFile | null>,
  rotationStore?: import('../../db/connector-instance-store.js').ConnectorInstanceStore,
): Promise<void> {
  const shopify = connectors.find((c) => c.connectorId === 'shopify' && c.connected)
  const shopifyEnabled = shopify && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'shopify'))

  if (!shopify) {
    unavailable?.push(notConnectedNotice('Shopify', 'store products, orders, customers, and inventory'))
    return
  }

  async function loadEncodedTokens(): Promise<string | null> {
    if (credsOverride) return credsOverride()
    const creds = await connectorStore.getCredentials(userId, 'shopify')
    return creds?.client_secret ?? null
  }

  async function persistEncoded(encoded: string): Promise<void> {
    if (persistOverride) {
      await persistOverride(encoded)
      return
    }
    await connectorStore.upsert(userId, {
      connectorId: 'shopify',
      name: 'Shopify',
      connected: true,
      credentials: { client_id: 'shopify_oauth', client_secret: encoded },
    })
  }

  // A real store owns ALL refresh decisions. Never hand its result to the
  // legacy manager: verification/publication may have consumed the leeway.
  function makeTokenManager(
    load: () => Promise<string | null>,
    persist: (encoded: string) => Promise<void>,
    instanceId?: string | null,
  ) {
    if (rotationStore?.refreshShopifyCredentialsSystem) {
      return {
        async getAuth() {
          if (!instanceId) throw new Error('connector_rotation_instance_required')
          const credentials = await rotationStore.refreshShopifyCredentialsSystem!(instanceId)
          const tokens = credentials?.type === 'oauth' ? unpackShopifyTokens(credentials.client_secret) : null
          if (!tokens) throw new Error('connector_rotation_reconnect_required')
          if (isManagedShopifyTokens(tokens) && !(Date.parse(tokens.expiresAt!) - Date.now() > 60000)) {
            throw new Error('connector_rotation_reconnect_required')
          }
          return { accessToken: tokens.accessToken, shopDomain: tokens.shopDomain }
        },
      }
    }
    return createShopifyTokenManager({
      getAppConfig: () => getConnectorConfig('shopify'),
      store: {
        async getTokens() {
          const encoded = await load()
          return encoded ? unpackShopifyTokens(encoded) : null
        },
        async persistTokens(tokens) {
          await persist(packShopifyTokens(tokens))
        },
      },
    })
  }

  function buildTools(
    tm: ReturnType<typeof makeTokenManager>,
    governanceId: string = 'shopify',
  ): Tool[] {
    return gateToolsOnActionGrants(createShopifyTools({
      getShop: async () => getShopifyShop(await tm.getAuth()),
      listProducts: async (params) => listShopifyProducts(await tm.getAuth(), params),
      getProduct: async (productId) => getShopifyProduct(await tm.getAuth(), productId),
      listOrders: async (params) => listShopifyOrders(await tm.getAuth(), params),
      getOrder: async (orderId) => getShopifyOrder(await tm.getAuth(), orderId),
      searchCustomers: async (params) => searchShopifyCustomers(await tm.getAuth(), params),
      getCustomer: async (customerId) => getShopifyCustomer(await tm.getAuth(), customerId),
      previewCustomerSegment: async (params) => previewShopifyCustomerSegment(await tm.getAuth(), params),
      getInventoryLevels: async (params) => getShopifyInventoryLevels(await tm.getAuth(), params),
      listCollections: async (params) => listShopifyCollections(await tm.getAuth(), params),
      listDraftOrders: async (params) => listShopifyDraftOrders(await tm.getAuth(), params),
      listDiscounts: async (params) => listShopifyDiscounts(await tm.getAuth(), params),
      listAbandonedCheckouts: async (params) => listShopifyAbandonedCheckouts(await tm.getAuth(), params),
      getPayoutsSummary: async (params) => getShopifyPayoutsSummary(await tm.getAuth(), params),
      listDisputes: async (params) => listShopifyDisputes(await tm.getAuth(), params),
      listContent: async (params) => listShopifyContent(await tm.getAuth(), params),
      fetchOrdersRange: async (params) => fetchShopifyOrdersRange(await tm.getAuth(), params),
      storefrontFunnel: async (params) => shopifyStorefrontFunnelQuery(await tm.getAuth(), params),
      runAnalyticsQuery: async (q) => runShopifyqlQuery(await tm.getAuth(), q),
      updateProduct: async (params) => updateShopifyProduct(await tm.getAuth(), params),
      createProduct: async (params) => createShopifyProduct(await tm.getAuth(), params),
      createDraftOrder: async (params) => createShopifyDraftOrder(await tm.getAuth(), params),
      sendDraftOrderInvoice: async (draftOrderId) => sendShopifyDraftOrderInvoice(await tm.getAuth(), draftOrderId),
      addTags: async (resource, resourceId, tags) => addShopifyTags(await tm.getAuth(), resource, resourceId, tags),
      updateCustomer: async (params) => updateShopifyCustomer(await tm.getAuth(), params),
      createCustomerSegment: async (params) => createShopifyCustomerSegment(await tm.getAuth(), params),
      setInventoryQuantity: async (params) => setShopifyInventoryQuantity(await tm.getAuth(), params),
      createFulfillment: async (params) => createShopifyFulfillment(await tm.getAuth(), params),
      createDiscountCode: async (params) => createShopifyDiscountCode(await tm.getAuth(), params),
      createContent: async (params) => createShopifyContent(await tm.getAuth(), params),
      cancelOrder: async (params) => cancelShopifyOrder(await tm.getAuth(), params),
      refundOrder: async (params) => refundShopifyOrder(await tm.getAuth(), params),
      completeDraftOrder: async (params) => completeShopifyDraftOrder(await tm.getAuth(), params),
      addProductImage: async (params) => addShopifyProductImage(await tm.getAuth(), params),
      setVariantPrice: async (params) => setShopifyVariantPrice(await tm.getAuth(), params),
      publishProduct: async (params) => publishShopifyProduct(await tm.getAuth(), params),
      setProductMetafields: async (params) => setShopifyProductMetafields(await tm.getAuth(), params),
      setProductOptions: async (params) => setShopifyProductOptions(await tm.getAuth(), params),
      listThemes: async () => listShopifyThemes(await tm.getAuth()),
      listProductTemplates: async (params) => listShopifyProductTemplates(await tm.getAuth(), params),
      readProductTemplate: async (params) => readShopifyProductTemplate(await tm.getAuth(), params),
      createProductTemplate: async (params) => createShopifyProductTemplate(await tm.getAuth(), params),
      setProductTemplate: async (params) => setShopifyProductTemplate(await tm.getAuth(), params),
    }, {
      readFileBytes: filesApi
        ? async (context, idOrPath) => {
            const gate = workspaceFilesGate(context.workspaceId)
            if (gate) return { error: gate.data }
            const ctx = workspaceFilesCtxFor(context)
            let res = await filesApi.readBytes(ctx, idOrPath)

            // A miss here is almost always a chat-attachment id: the owner
            // attached the photo and the model passed that id straight through,
            // because that is the id in front of it. Promote it rather than
            // bouncing the request back for a bookkeeping step nobody asked
            // for. `readCachedFile` gates on the same access predicate, so this
            // cannot reach another workspace's upload.
            if (!res.ok && res.error.kind === 'not_found' && readCachedFile) {
              // AccessContext, not FilesContext: the cache read is gated by
              // the universal access predicate, which requires a concrete
              // assistant rather than the optional one FilesContext carries.
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
                // A failed promotion (quota, most likely) is reported, not
                // skipped: uploading to Shopify anyway would leave the brain
                // silently missing a file the owner believes was kept.
                if (!promoted.ok) return { error: workspaceFilesErrorMessage(promoted.error) }
                res = await filesApi.readBytes(ctx, promoted.value.id)
              }
            }

            // Still missing: say which step is absent rather than relaying a
            // bare "not found", which reads as a wrong reference and sends the
            // model hunting for another id.
            if (!res.ok) return { error: workspaceFilesErrorMessage(res.error), notFound: res.error.kind === 'not_found' }
            return {
              bytes: res.value.bytes,
              fileName: res.value.file.name,
              mimeType: res.value.file.mime,
            }
          }
        : undefined,
    }), 'shopify', assistantConnectorGrantsStore, assistantId, governanceId)
  }

  const primaryInstanceId = healthProbe?.instanceId ?? (shopify as { id?: string }).id ?? null
  try {
    if (shopifyEnabled) {
      const built = buildTools(makeTokenManager(loadEncodedTokens, persistEncoded, primaryInstanceId))
      const shopifyTools = healthProbe && primaryInstanceId
        ? wrapToolsWithHealthProbe(built, primaryInstanceId, healthProbe.report)
        : built

      for (const tool of await applyToolPolicies(shopifyTools, 'shopify', settingsStore, assistantId, userId, unavailable)) {
        tools.set(tool.name, tool)
      }
    }

    // Extra stores → label-qualified variant tool sets, each with its own
    // token manager bound to its own instance row.
    if (extraInstances?.length && resolveInstanceCreds && persistInstanceCreds) {
      await injectInstanceVariants({
        provider: 'shopify',
        extras: extraInstances,
        settingsStore, assistantId, userId, assistantConnectorStore, tools,
        buildToolsForInstance: (inst, governanceId) => {
          const variant = buildTools(makeTokenManager(
            () => resolveInstanceCreds(inst.id),
            (encoded) => persistInstanceCreds(inst.id, 'shopify_oauth', encoded), inst.id,
          ), governanceId)
          return healthProbe ? wrapToolsWithHealthProbe(variant, inst.id, healthProbe.report) : variant
        },
      })
    }

    console.debug(`[mcp-inject] Shopify: injected tools${extraInstances?.length ? ` (+${extraInstances.length} extra store(s))` : ''}`)
  } catch (err) {
    console.error('[mcp-inject] Shopify injection failed:', err)
  }
}

// ── Provider module ───────────────────────────────────────────

/** One Shopify lane. Attached bytes come from the executing surface and actor. */
export type ShopifyLane = BuiltinLane<{ connectorId: string; connected: boolean; url?: string | null }> & {
  credsOverride?: () => Promise<string | null>
  persistOverride?: (encoded: string) => Promise<void>
  extraInstances?: ConnectorInstanceRef[]
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>
  persistInstanceCreds?: (instanceId: string, clientId: string, secret: string) => Promise<void>
  healthProbe?: { report: HealthReporter; instanceId?: string | null }
}

export async function activateShopifyLane(ctx: ProviderActivationContext, lane: ShopifyLane): Promise<Tool[]> {
  const tools = new Map<string, Tool>()
  await collectShopifyTools(
    lane.connectors, ctx.stores.connectorStore, lane.settingsStore, lane.userId, ctx.assistantId,
    ctx.stores.assistantConnectorStore, tools, laneUnavailable(ctx, lane), lane.credsOverride,
    lane.persistOverride, lane.extraInstances, lane.resolveInstanceCreds, lane.persistInstanceCreds,
    lane.healthProbe, ctx.stores.assistantConnectorGrantsStore, ctx.attachments.filesApi,
    ctx.attachments.readCachedFile, ctx.stores.connectorInstanceStore,
  )
  return [...tools.values()]
}

export const shopifyProvider: ProviderModule<readonly ShopifyLane[]> = {
  family: 'shopify',
  describe: memoDescribe(() => describeFactoryTools('shopify', { shopify: () => createShopifyTools(inertPort('shopify'), { readFileBytes: inertPort('shopify files') }) })),
  activate: (ctx, lanes) => runLanes(lanes, (lane) => activateShopifyLane(ctx, lane)),
}
