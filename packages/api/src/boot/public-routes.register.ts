/**
 * Public share, site, campaign tracking and public chat routes.
 *
 * Boot register module registerPublicRoutes: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`PublicRoutesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { LAYER_1_SYSTEM_PROMPT } from '@use-brian/core/system-prompt.js'
import { campaignTrackingRoutes } from '../routes/campaign-tracking.js'
import { campaignPublicEmailRoutes } from '../campaigns/public-email.js'
import { publishSessionEvent } from '../session-event-bus.js'
import { publicChatRoutes } from '../routes/public-chat.js'
import { lazyRoutes } from './lazy.js'
import type { PublicRoutesScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const publicShareRoutes = lazyRoutes(() => import('../routes/public-share.js'), 'publicShareRoutes')
const publicSiteRoutes = lazyRoutes(() => import('../routes/public-sites.js'), 'publicSiteRoutes')

export function registerPublicRoutes(scope: PublicRoutesScope) {
  const {
    ports, app, configuredProviders, provider, analytics, crmStore, usageStore, connectorInstanceStore,
    skillStore, resolveWorkspaceCustomLlm, connectorGrantStore, knowledgeStore, workspaceFilesStore,
    allTools, mcpSettingsStore, memoryStore, taskStore, workflowRunStore, workspaceDirectoryStore,
    sessionStateStore, filesApi, connectorStore, assistantConnectorStore, assistantConnectorGrantsStore,
    gdriveFilesStore, capabilityStore, episodicStore, filesBlobClient, pageGrantStore, pageDomainStore,
    chatLinkStore,
  } = scope
  app.use('/api', publicShareRoutes({
    pageGrantStore,
    taskStore,
    crmStore,
    workflowRunStore,
    workspaceDirectory: workspaceDirectoryStore,
    gcs: filesBlobClient,
    ...(ports.resolveRecordingReadClient
      ? { resolveRecordingReadClient: ports.resolveRecordingReadClient }
      : {}),
  }))

  // Custom-domain site render — PUBLIC, same containment as publicShareRoutes
  // (docs/architecture/features/custom-domains.md). MUST stay before the bare
  // `/api` requireAuth guards below.
  app.use('/api', publicSiteRoutes({
    pageDomainStore,
    taskStore,
    crmStore,
    workflowRunStore,
    workspaceDirectory: workspaceDirectoryStore,
    gcs: filesBlobClient,
    ...(ports.resolveRecordingReadClient
      ? { resolveRecordingReadClient: ports.resolveRecordingReadClient }
      : {}),
  }))

  // Native campaign redirects and collection are public, write-only
  // boundaries. Keep this exact root mount ahead of every broad `/api`
  // authentication guard so OSS and hosted editions share the same route
  // ordering. The router never accepts an arbitrary redirect destination.
  app.use(campaignTrackingRoutes())
  app.use(campaignPublicEmailRoutes())

  // Public chat link — anonymous browser chat behind a chat-link token
  // (`/c/<token>` in app-web). PUBLIC, same containment + mount slot as
  // publicShareRoutes above: MUST stay before the bare `/api` requireAuth
  // guards below. Reuses the public-API turn pipeline (public-turn.ts).
  // See docs/architecture/features/public-chat-link.md.
  app.use('/api', publicChatRoutes({
    provider,
    publishSessionEvent,
    resolveWorkspaceCustomLlm,
    configuredProviders,
    tools: allTools,
    systemPrompt: LAYER_1_SYSTEM_PROMPT,
    memoryStore,
    usageStore,
    knowledgeStore,
    capabilityStore,
    analytics,
    episodicStore,
    sessionStateStore,
    connectorStore,
    mcpSettingsStore,
    assistantConnectorStore,
    connectorGrantStore,
    connectorInstanceStore,
    gdriveFilesStore,
    filesApi: filesApi ?? undefined,
    assistantConnectorGrantsStore,
    engineHooks: ports.engineHooks,
    checkCreditBudget: ports.checkCreditBudget,
    chatLinkStore,
    // Ambient-context stores for the `assistant-full` scope this route opts
    // into (see public-chat.ts). The keyed public API above deliberately
    // omits them — it runs the thin `external-client` scope.
    workspaceFilesStore,
    skillStore,
  }))
}
