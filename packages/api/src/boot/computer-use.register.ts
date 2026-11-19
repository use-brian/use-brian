/**
 * Browser relay, sandbox orchestration, computer-use and agent capability tools.
 *
 * Boot register module registerComputerUse: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`ComputerUseScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import type { TokenUsage } from '@use-brian/agent-runtime/providers/types.js'
import { scopeEvidenceFromRows } from '@use-brian/agent-runtime/security/context-scope.js'
import { type Sensitivity, minSensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'
import { sanitize as sanitizeAnalytics } from '@use-brian/core/analytics/logger.js'
import { createBrowserAuthBroker } from '@use-brian/core/sandbox/browser-auth-broker.js'
import type { BlockApprovalsPort } from '@use-brian/core/sandbox/browser-skills.js'
import { createBuFallbackTool } from '@use-brian/core/sandbox/bu-fallback.js'
import { createCloudBrowserProvider } from '@use-brian/core/sandbox/cloud-browser-provider.js'
import { createComputeTools } from '@use-brian/core/sandbox/compute-tools.js'
import { createLocalBrowserProvider } from '@use-brian/core/sandbox/local-browser-provider.js'
import {
  createSandboxMeter,
  createInMemorySpendAccumulator,
  resolveUnattendedComputerUse,
} from '@use-brian/core/sandbox/metering.js'
import {
  createInMemorySandboxTaskStore,
  DEFAULT_SESSION_BUDGET_USD,
  type SandboxOrchestrator,
  createSandboxOrchestrator,
  looksLikeLoginWall,
  registrableSiteOf,
} from '@use-brian/core/sandbox/orchestrator.js'
import {
  type ProtectedFillScope,
  createProtectedFillService,
} from '@use-brian/core/sandbox/protected-fill.js'
import { createE2bCloudProvider } from '@use-brian/core/sandbox/providers/e2b/index.js'
import type { E2bRuntime } from '@use-brian/core/sandbox/providers/e2b/runtime.js'
import { createSkillRunnerTools } from '@use-brian/core/sandbox/skill-runner.js'
import {
  type ComputerToolPolicy,
  type CreateComputerToolsOptions,
  createComputerTools,
} from '@use-brian/core/sandbox/tools.js'
import type { SandboxProvider } from '@use-brian/core/sandbox/types.js'
import { ctxFor as workspaceFilesCtxFor } from '@use-brian/core/workspace-files/tool-helpers.js'
import { prepareBrowserDownload, type BrowserDownload } from '../sandbox/download-publication.js'
import { resolveBrowserTaskExecutionAuthority } from '../sandbox/task-execution-authority.js'
import {
  assertLocalTaskExecutionAuthority, createLocalTaskAdmission,
} from '../sandbox/local-task-authority.js'
import { createBrowserTaskDiscard } from '../sandbox/task-discard.js'
import {
  resolveHumanBrowserProfileDepartmentRead, resolveBrowserProfileDepartmentRead,
} from '../sandbox/profile-authority.js'
import { previewCrmDestination } from '../crm-operations/creation-destination.js'
import { getWorkspacePlan } from '../db/workspace-store.js'
import { createBrowserFileBridge } from '../sandbox/browser-files.js'
import {
  relayExtensionStatus, supportsProtectedFill, createRelayCommandTransport,
} from '../sandbox/relay-transport.js'
import { createProtectedCrmSource } from '../sandbox/protected-fill-crm.js'
import { getEntityById as getProtectedFillEntity } from '../db/entities-store.js'
import { resolveWorkspaceViewpoint as protectedFillViewpoint } from '../db/workspace-viewpoint.js'
import { OFFICIAL_CONNECTOR_TOOLS, APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import { listAccessibleAssistants } from '../db/users.js'
import { createBrowserSkillsStore } from '../db/browser-skills-store.js'
import { createInMemoryLocalComputerTaskStore } from '../routes/computer.js'
import { readBrowserSendApprovalStatus } from '../db/pending-approvals-store.js'
import { reviewOnCreate } from '../approval-review/resolution.js'
import { createControlPlaneReader } from '../agent-surface/control-plane-reader.js'
import { buildAgentToolset } from '../agent-surface/toolset.js'
import { deliverToChannel } from '../inter-assistant/deliver.js'
import { query } from '../db/client.js'
import { createBrowserAgentUsageRecorder } from '../browser-agent-metering.js'
import { lazyAdapter } from '@use-brian/agent-runtime/tools/lazy-implementation.js'
import type { ComputerUseScope } from './scope.js'

export function registerComputerUse(scope: ComputerUseScope) {
  const {
    ports, env, externalCredentialPool, bootGeminiCredential, bootAnthropicCredential,
    bootDashscopeCredential, dashscopeBaseUrl, analytics, integrationStore, usageStore,
    connectorInstanceStore, workspaceSkillStore, customLlmNetworkPolicy, connectorGrantStore, workspaceStore,
    workerManager, resolveBackgroundRuntime, allTools, mcpSettingsStore, pendingApprovalsStore, filesApi,
    capabilityStore, apiKeyStore, workspaceSkillEnablementStore, creditGate, brainKeyStore,
  } = scope
  // ── Computer use (browser tool surface) ──
  // docs/architecture/engine/computer-use.md §3-§4: five discrete browser
  // tools over the BrowserProvider seam. Local mode drives the user's own
  // Chrome through the browser-relay (BROWSER_RELAY_URL/SECRET; unset →
  // honest not_configured errors). The cloud backend arrives with the
  // SandboxProvider phase and stays not_configured here. Governance mirrors
  // the files pattern: L1/L2 strictest-wins policy over mcp_tool_settings
  // (serverName='computer'), metadata-only analytics audit, and the
  // in-tool send gate + autonomous-path block (§8).
  // BROWSER_RELAY_URL resolution: an explicit value always wins (prod upserts
  // it via the BROWSER_RELAY_URL secret in deploy-browser-relay.sh). In local
  // dev it defaults to the relay's own PORT default (8080), so a My-Browser
  // e2e test only needs BROWSER_RELAY_SECRET set. NEVER defaulted outside
  // development: prod keeps BROWSER_RELAY_SECRET set while the URL secret stays
  // absent until the relay is deployed, and a stray localhost default there
  // would flip the `URL && SECRET` gate true against a dead relay.
  const browserRelayUrl =
    env.BROWSER_RELAY_URL ||
    (env.NODE_ENV === 'development' ? 'http://localhost:8080' : undefined)
  const localComputerTasks = createInMemoryLocalComputerTaskStore()
  const protectedFillEnabled = env.PROTECTED_BROWSER_FILL_SINGLE_INSTANCE === 'true' &&
    Boolean(browserRelayUrl && env.BROWSER_RELAY_SECRET && ports.browserProfileStore)
  const protectedExtensionOrigins = new Set((env.PROTECTED_BROWSER_FILL_EXTENSION_ORIGINS ?? '')
    .split(',').map(origin => origin.trim()).filter(origin => /^chrome-extension:\/\/[a-p]{32}$/.test(origin)))
  const authorizeProtectedIdentity = async (scope: Pick<ProtectedFillScope, 'userId' | 'workspaceId' | 'browserProfileId'>) => {
    const profile = await ports.browserProfileStore?.get(scope.browserProfileId)
    return Boolean(profile && profile.ownerUserId === scope.userId && profile.workspaceId === scope.workspaceId &&
      await workspaceStore.getMembership(scope.userId, scope.workspaceId))
  }
  const protectedBrowserSupported = async (userId: string, browserProfileId: string) => {
    if (!browserRelayUrl || !env.BROWSER_RELAY_SECRET) return false
    const status = await relayExtensionStatus({ relayUrl: browserRelayUrl, relaySecret: env.BROWSER_RELAY_SECRET,
      userId, browserProfileId })
    return supportsProtectedFill(status, protectedExtensionOrigins)
  }
  const authorizeProtectedFill = async (scope: ProtectedFillScope) => {
    if (!await authorizeProtectedIdentity(scope) || !await protectedBrowserSupported(scope.userId, scope.browserProfileId)) return false
    const task = localComputerTasks.getActiveBySession(scope.sessionId)
    if (task) { try { await assertLocalTaskExecutionAuthority(task) } catch { return false } }
    return Boolean(task && task.userId === scope.userId && task.workspaceId === scope.workspaceId &&
      task.taskId === scope.taskId && task.profileId === scope.browserProfileId && task.destinationOrigin === scope.destinationOrigin)
  }
  const protectedFill = protectedFillEnabled && protectedExtensionOrigins.size > 0
    ? createProtectedFillService({
        authorize: authorizeProtectedFill,
        // Cleanup remains possible after idle task retirement; exact lock identity is still checked by the authority.
        authorizeCompletion: authorizeProtectedIdentity,
        authorizeRecovery: authorizeProtectedIdentity,
        ...createProtectedCrmSource({ viewpoint: protectedFillViewpoint, entity: getProtectedFillEntity }),
      }) : null
  const browserRelayTransport =
    browserRelayUrl && env.BROWSER_RELAY_SECRET
      ? createRelayCommandTransport({
          relayUrl: browserRelayUrl,
          relaySecret: env.BROWSER_RELAY_SECRET,
          protectedFill,
          resolveLocalControlMode: async (browserProfileId) =>
            (await ports.browserProfileStore?.get(browserProfileId))?.localControlMode ?? 'task_tabs',
        })
      : null
  // Cloud mode (§5): E2B behind the SandboxProvider seam. providers/e2b is
  // the only E2B-SDK importer; everything here talks to the interface.
  // Browser Use fallback + Jev TYPE_TEXT helper. Prefer an OpenAI-compatible
  // key (Gemini, then DashScope) so one scoped credential serves both. An
  // Anthropic-only deploy still has Browser Use fallback, while Jev safely
  // hands off if it needs generated field text before acting.
  const browserAnthropicKey = bootAnthropicCredential?.secret ?? env.ANTHROPIC_API_KEY
  const browserGeminiKey = bootGeminiCredential?.secret ?? env.GEMINI_API_KEY
  const browserDashscopeKey = bootDashscopeCredential?.secret ?? env.DASHSCOPE_API_KEY
  const browserUseLlm = browserGeminiKey
    ? {
          apiKeyEnvName: 'GOOGLE_API_KEY' as const,
          apiKey: browserGeminiKey,
          model: env.BROWSER_USE_MODEL || 'gemini-3.6-flash',
          providerKeySource: 'platform' as const,
        }
    : browserDashscopeKey
      ? {
            apiKeyEnvName: 'OPENAI_API_KEY' as const,
            apiKey: browserDashscopeKey,
            baseUrl: dashscopeBaseUrl,
            model: env.BROWSER_USE_MODEL || 'qwen3.5-flash',
            useVision: false,
            providerKeySource: 'platform' as const,
          }
      : browserAnthropicKey
        ? {
            apiKeyEnvName: 'ANTHROPIC_API_KEY' as const,
            apiKey: browserAnthropicKey,
            model: env.BROWSER_USE_MODEL || 'claude-haiku-4-5-20251001',
            providerKeySource: 'platform' as const,
          }
        : undefined
  const e2bRuntimeOptions = env.E2B_API_KEY ? { apiKey: env.E2B_API_KEY, defaultTemplateId: env.E2B_TEMPLATE_ID } : null
  const sandboxProvider: SandboxProvider | null = e2bRuntimeOptions
    ? createE2bCloudProvider(
        // The E2B SDK (the runtime module is its only importer) loads when the
        // first sandbox is created or reconnected, not at boot (M4 step 5).
        lazyAdapter<E2bRuntime, 'create' | 'connect'>('The cloud sandbox runtime (E2B)', async () => {
          const { createE2bRuntime } = await import('@use-brian/core/sandbox/providers/e2b/runtime.js')
          return createE2bRuntime(e2bRuntimeOptions)
        }, ['create', 'connect']),
        // Hosted credential pools resolve the browser-use identity at the
        // beginning of each exploration below. Do not retain the boot-time
        // lease here: a disabled, expired, or exhausted key must not remain
        // usable through a long-lived sandbox provider instance.
        {
          ...(env.TYPESAFE_API_KEY
            ? {
                jevUltrafast: {
                  apiKey: env.TYPESAFE_API_KEY,
                  model: env.JEV_ULTRAFAST_MODEL || 'jev-1.13.0',
                },
              }
            : {}),
          ...(!externalCredentialPool && browserUseLlm ? { browserUse: browserUseLlm } : {}),
        },
      )
    : null
  // The §4.9 meter: all three COGS lines record through the usage spine, and
  // the per-session dollar cap accumulates on the task row. Barrier 2 rides
  // meteringActive(): no usage store → unattended can never enable.
  const sandboxTaskStoreImpl = ports.sandboxTaskStore ?? createInMemorySandboxTaskStore()
  const sandboxMeter = createSandboxMeter({
    usageStore: usageStore ?? null,
    addSpend: sandboxTaskStoreImpl.addSpend
      ? sandboxTaskStoreImpl.addSpend.bind(sandboxTaskStoreImpl)
      : createInMemorySpendAccumulator(DEFAULT_SESSION_BUDGET_USD).addSpend,
  })
  const unattendedComputerUse = () =>
    resolveUnattendedComputerUse({
      flagEnabled: env.COMPUTER_USE_UNATTENDED_ENABLED === true,
      meter: sandboxMeter,
    })
  const sandboxOrchestrator: SandboxOrchestrator | null = sandboxProvider
    ? createSandboxOrchestrator({
        provider: sandboxProvider,
        taskStore: sandboxTaskStoreImpl,
        resolveExecutionAuthority: resolveBrowserTaskExecutionAuthority,
        meter: sandboxMeter,
        vault: ports.browserSessionVault ?? null,
        profileStore: ports.browserProfileStore ?? null,
        budget: {
          // The workspace credit-cap gate (§4.9): a blocked workspace cannot
          // start a cloud computer task. Mirrors the goals-driver pattern —
          // plan resolved system-side, transient gate errors fail OPEN (the
          // per-session dollar cap + fuse remain as backstops).
          checkCreditBudget: creditGate
            ? async (browseCtx) => {
                let status: string
                try {
                  const plan = await getWorkspacePlan(browseCtx.workspaceId)
                  status = (await creditGate(browseCtx.workspaceId, plan)).status
                } catch (err) {
                  console.error('[computer] credit gate check failed, allowing:', err)
                  return
                }
                if (status === 'blocked') {
                  throw new Error(
                    'This workspace is out of credit for the current period, so a cloud browser task cannot start. Upgrade the plan or wait for the period to reset.',
                  )
                }
              }
            : undefined,
        },
        // Downloads auto-pull into workspace_files (§4.12) — scoped by the
        // TASK's workspace, resolved above the provider seam.
        saveDownload: filesApi
          ? async (dlCtx, file) => {
              const publication = await prepareBrowserDownload(filesApi!, dlCtx.task,
                () => sandboxTaskStoreImpl.getActiveBySession(dlCtx.sessionId), dlCtx.authority!,
                (expected, operation) => sandboxTaskStoreImpl.withPublication(expected, operation))
              await publication.writeBytes({ ...file, name: file.path.split('/').pop() || 'download', mime: 'application/octet-stream' })
            }
          : undefined,
      })
    : null
  const browserAuthBroker =
    sandboxProvider && sandboxOrchestrator && ports.browserCredentialStore
      ? createBrowserAuthBroker({
          provider: sandboxProvider,
          orchestrator: sandboxOrchestrator,
          credentials: ports.browserCredentialStore,
        })
      : null
  const cloudBrowserBinding = sandboxOrchestrator
    ? {
        ...sandboxOrchestrator.binding,
        recoverLogin: browserAuthBroker
          ? async (
              browseCtx: Parameters<typeof sandboxOrchestrator.binding.resolve>[0],
              navigation: { requestedUrl: string; currentUrl: string },
            ) => {
              if (!browseCtx.profileId || !looksLikeLoginWall(navigation.currentUrl)) {
                return { retry: false }
              }
              const site = registrableSiteOf(navigation.requestedUrl)
              if (!site) return { retry: false }
              const refreshed = await browserAuthBroker.authenticate({
                authority: browseCtx.authority,
                executionAuthority: browseCtx.executionAuthority,
                sourceAuthority: browseCtx.sourceAuthority,
                inputScope: browseCtx.inputScope,
                userId: browseCtx.userId,
                workspaceId: browseCtx.workspaceId,
                profileId: browseCtx.profileId,
                site,
              })
              if (refreshed.kind !== 'authenticated') return { retry: false }
              // The dead task has already had `injectedSite` cleared by the
              // orchestrator's login-wall probe, so failure teardown cannot
              // overwrite the freshly brokered vault bundle. The cloud
              // adapter now resolves a new task and injects that bundle.
              await sandboxOrchestrator.completeTask(browseCtx.sessionId, 'failed', browseCtx.authority)
              return {
                retry: true,
                afterRetry: async (currentUrl: string) => {
                  if (!looksLikeLoginWall(currentUrl)) return
                  await browseCtx.authority?.assertCurrent()
                  await ports.browserCredentialStore?.recordResult({
                    userId: browseCtx.userId,
                    workspaceId: browseCtx.workspaceId,
                    profileId: browseCtx.profileId!,
                    credentialId: refreshed.credentialId,
                    version: refreshed.credentialVersion,
                    result: 'failure',
                    failureCode: 'login_rejected',
                  })
                },
              }
            }
          : undefined,
      }
    : null
  const COMPUTER_CONNECTOR_ID = 'computer'
  const computerToolDefaults = new Map(
    (OFFICIAL_CONNECTOR_TOOLS[COMPUTER_CONNECTOR_ID] ?? []).map((t) => [t.name, t.defaultPolicy]),
  )
  const COMPUTER_POLICY_STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 }
  const resolveComputerToolPolicy = async (
    toolName: string,
    context: { userId: string; assistantId: string },
  ): Promise<ComputerToolPolicy> => {
    const fallback = (computerToolDefaults.get(toolName) ?? 'allow') as ComputerToolPolicy
    const [l1, l2] = await Promise.all([
      mcpSettingsStore.getPolicy({
        assistantId: APP_LEVEL_ASSISTANT_ID, userId: context.userId,
        serverName: COMPUTER_CONNECTOR_ID, toolName,
      }),
      mcpSettingsStore.getPolicy({
        assistantId: context.assistantId, userId: context.userId,
        serverName: COMPUTER_CONNECTOR_ID, toolName,
      }),
    ])
    const a = (l1?.policy as ComputerToolPolicy) ?? fallback
    const b = (l2?.policy as ComputerToolPolicy) ?? fallback
    return (COMPUTER_POLICY_STRICTNESS[a] ?? 0) >= (COMPUTER_POLICY_STRICTNESS[b] ?? 0) ? a : b
  }
  // The acting assistant's clearance for the profile gate (R2-4) — resolved
  // from the assistant row, defensively 'public' (lowest → most restrictive
  // profile access) on any lookup failure.
  const getAssistantClearance = async (assistantId: string): Promise<Sensitivity> => {
    try {
      const res = await query<{ clearance: string | null }>(
        `SELECT clearance FROM assistants WHERE id = $1`,
        [assistantId],
      )
      const c = res.rows[0]?.clearance
      return c === 'public' || c === 'internal' || c === 'confidential' ? c : 'confidential'
    } catch {
      return 'public'
    }
  }
  const localBrowserProvider = createLocalBrowserProvider({
    transport: browserRelayTransport,
    admit: createLocalTaskAdmission({ profiles: ports.browserProfileStore, tasks: localComputerTasks,
      resolveHumanRead: resolveHumanBrowserProfileDepartmentRead }),
    onDestination: (ctx, origin) => {
      if (!ctx.profileId || protectedFill?.isLocked({ userId: ctx.userId, browserProfileId: ctx.profileId })) return
      localComputerTasks.touch(ctx, origin ? new URL(origin).hostname : undefined, origin)
    },
  })
  const discardBrowserTask = createBrowserTaskDiscard({ localTasks: localComputerTasks,
    orchestrator: sandboxOrchestrator, transport: browserRelayTransport,
    getWorkspaceRole: (userId, workspaceId) => workspaceStore.getRole(userId, workspaceId) })
  // One publication admission for every sandbox byte write: browser downloads and compute artifacts.
  // `profileId: undefined` publishes from whichever profile (if any) the active cloud task holds.
  const prepareSandboxPublication = filesApi ? (async (ctx, selection) => {
      const current = async () => selection.backend === 'local' ? localComputerTasks.getActiveBySession(ctx.sessionId)
        : sandboxTaskStoreImpl.getActiveBySession(ctx.sessionId)
      const task = await current()
      if (!task || task.userId !== ctx.userId || task.workspaceId !== ctx.workspaceId || (selection.profileId !== undefined && task.profileId !== selection.profileId)
        || task.executionAuthority?.assistantId !== ctx.assistantId) throw new Error('Browser task is unavailable for this download.')
      const authority = {
        async assertCurrent() {
          await ctx.authority?.assertCurrent()
          if (selection.backend === 'local') {
            const local = localComputerTasks.getActiveBySession(ctx.sessionId)
            if (!local || local.taskId !== task.taskId) throw new Error('Browser task changed.')
            await assertLocalTaskExecutionAuthority(local)
          } else {
            const cloud = await sandboxTaskStoreImpl.getActiveBySession(ctx.sessionId)
            if (!cloud || cloud.taskId !== task.taskId || !sandboxOrchestrator) throw new Error('Browser task changed.')
            await sandboxOrchestrator.assertTaskAuthority(cloud)
          }
        },
        async execute<T>(operation: () => Promise<T>) { await this.assertCurrent(); const result = await operation(); await this.assertCurrent(); return result },
      }
      const publication = await prepareBrowserDownload(filesApi!, task, current, authority,
        (expected, operation) => selection.backend === 'local'
          ? localComputerTasks.withPublication(expected, operation) : sandboxTaskStoreImpl.withPublication(expected, operation))
      return { taskId: publication.taskId, assertCurrent: publication.assertCurrent, async writeBytes(file: BrowserDownload) {
        const saved = await publication.writeBytes(file)
        ctx.scopeAccumulator?.note(scopeEvidenceFromRows([saved]))
        return { fileId: saved.id, path: saved.path }
      } }
    }) satisfies NonNullable<CreateComputerToolsOptions['files']>['prepareWrite'] : null
  const computerTools = createComputerTools({
    discardTask: (ctx, sessionId) => discardBrowserTask({ userId: ctx.userId, workspaceId: ctx.workspaceId!, sessionId }),
    files: filesApi && prepareSandboxPublication ? createBrowserFileBridge(filesApi, getAssistantClearance, prepareSandboxPublication) : null,
    protectedFill: protectedFill ? {
      blocked: (ctx, profileId) => protectedFill.isSessionLocked(ctx.userId, ctx.sessionId) ||
        Boolean(profileId && protectedFill.isLocked({ userId: ctx.userId, browserProfileId: profileId })),
      scope: async (ctx, profileId, destinationOrigin) => {
        const task = localComputerTasks.getActiveBySession(ctx.sessionId)
        if (!task || !ctx.workspaceId) return null
        const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
          taskId: task.taskId, browserProfileId: profileId, destinationOrigin }
        return await authorizeProtectedFill(scope) ? scope : null
      },
    } : undefined,
    local: localBrowserProvider,
    cloud: createCloudBrowserProvider({
      provider: sandboxProvider,
      binding: cloudBrowserBinding,
    }),
    cloudAvailable: () => sandboxProvider !== null,
    // Browser profiles (R2-4/R2-10): the closed store when the platform
    // wires it; OSS boots browse identity-less.
    profiles: ports.browserProfileStore
      ? {
          store: ports.browserProfileStore,
          vault: ports.browserSessionVault ?? null,
          assistantClearance: (toolCtx) => getAssistantClearance(toolCtx.assistantId),
          departmentRead: resolveBrowserProfileDepartmentRead,
        }
      : null,
    // Channel escalate-to-web (§4.8): a cloud login wall surfaces a deep link
    // into the Take-Over live view for this chat session.
    takeoverLinkFor: (toolCtx) =>
      toolCtx.workspaceId
        ? `${(env.AUTHED_APP_URL ?? env.APP_URL).replace(/\/$/, '')}/w/${toolCtx.workspaceId}/computer/${toolCtx.sessionId}`
        : null,
    onCloudLoginWall: sandboxOrchestrator
      ? async (toolCtx) => sandboxOrchestrator.pauseForTakeover(toolCtx.sessionId)
      : undefined,
    // Proactive live-view hand-off (§5): when a cloud browse starts, push the
    // Take-Over link to the user's channel out-of-band, before any work.
    // Channels drop mid-turn model text and have no live chip, so the model
    // relaying the link cannot reach them — deliverToChannel persists to the
    // session AND pushes to telegram/slack/whatsapp/feishu (web is persist-only; the
    // live chip covers realtime there). The tool only fires this on
    // interactive sessions (never headless/autonomous).
    onCloudSessionStarted: async (toolCtx, { takeoverUrl }) => {
      await deliverToChannel({
        assistantId: toolCtx.assistantId,
        userId: toolCtx.userId,
        text: `🖥️ I've opened a live browser to work on this. You can watch it live or take over (for example, to sign in) here: ${takeoverUrl}`,
        sessionId: toolCtx.sessionId,
        channelType: toolCtx.channelType,
        channelId: toolCtx.channelId,
        integrationStore: integrationStore ?? undefined,
        defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
        waConnectorUrl: env.WA_CONNECTOR_URL,
        waConnectorSecret: env.WA_CONNECTOR_SECRET,
      })
    },
    resolvePolicy: resolveComputerToolPolicy,
    // Barrier 2 (§4.9): the flag alone cannot enable unattended computer-use
    // — resolveUnattendedComputerUse also requires live metering, so a
    // metering-absent boot stays attended-only no matter the env.
    unattendedEnabled: unattendedComputerUse,
    // R2-8: unattended is paid-gated on top of Barrier 2.
    getWorkspacePlan,
    onEvent: (evt, ctx) => {
      if (evt.backend === 'local' && evt.ok) {
        localComputerTasks.touch({ ...ctx, profileId: evt.profileId ?? null }, evt.host)
        void sandboxOrchestrator?.completeTask(
          ctx.sessionId, 'completed', ctx.executionContext?.security.authority ?? ctx.authority,
        ).catch(() => {})
      } else if (evt.backend === 'cloud' && evt.ok) {
        localComputerTasks.complete(ctx.sessionId)
      }
      analytics.logEvent({
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        sessionId: ctx.sessionId,
        channelType: ctx.channelType,
        eventName: 'browser_action',
        metadata: {
          op: sanitizeAnalytics(evt.op),
          backend: sanitizeAnalytics(evt.backend),
          host: sanitizeAnalytics(evt.host ?? ''),
          ok: evt.ok,
          ...(evt.code ? { code: sanitizeAnalytics(evt.code) } : {}),
          // Per-action context cost. Numbers, not strings — sanitizeAnalytics
          // is for free text, and these must stay numeric for the admin
          // aggregate to SUM them. The local backend books no usage_tracking
          // row of its own, so this is the ONLY per-action cost signal it has.
          ...(evt.resultChars !== undefined ? { result_chars: evt.resultChars } : {}),
          ...(evt.resultTokens !== undefined ? { result_tokens: evt.resultTokens } : {}),
        },
      })
    },
  })
  allTools.set('browserNavigate', computerTools.browserNavigate)
  allTools.set('browserOpenTab', computerTools.browserOpenTab)
  allTools.set('browserListTabs', computerTools.browserListTabs)
  allTools.set('browserSwitchTab', computerTools.browserSwitchTab)
  allTools.set('browserCloseTab', computerTools.browserCloseTab)
  allTools.set('browserDiscardTask', computerTools.browserDiscardTask)
  allTools.set('browserSnapshot', computerTools.browserSnapshot)
  allTools.set('browserClick', computerTools.browserClick)
  allTools.set('browserType', computerTools.browserType)
  if (protectedFill) allTools.set('browserFillReference', computerTools.browserFillReference)
  allTools.set('browserFillForm', computerTools.browserFillForm)
  allTools.set('browserDownloads', computerTools.browserDownloads)
  allTools.set('browserReadDownload', computerTools.browserReadDownload)
  allTools.set('browserUploadFile', computerTools.browserUploadFile)
  allTools.set('browserCurrentUrl', computerTools.browserCurrentUrl)
  // Research read-browse (computer-use.md §12): browserReadPage is
  // deliberately NOT in allTools — interactive turns have the full flat
  // tools, and the standard preflight's cheap read-only pass must never be
  // able to spin up a sandbox. It reaches exactly one surface: research
  // workers, via the manager's post-sandbox-registration injection seam
  // (the WorkerManager itself was built from a pre-sandbox tool snapshot).
  workerManager.setResearchBrowseTools(
    new Map([['browserReadPage', computerTools.browserReadPage]]),
  )

  // Isolated Python + the workspace-scoped file-bridge (§4.7, §4.12). The
  // files port wraps FilesApi so every byte movement stays under workspace
  // RLS; the workspace id always comes from the ToolContext, never input.
  const computeTools = createComputeTools({
    provider: sandboxProvider,
    binding: sandboxOrchestrator?.binding ?? null,
    files: filesApi
      ? {
          // Loads read as the turn principal and record the file's protection before the sandbox
          // sees it; saves publish through the sandbox task's retained input envelope.
          readBytes: async (fctx, fileIdOrPath) => {
            const res = await filesApi!.readBytes(workspaceFilesCtxFor({ ...fctx,
              clearance: minSensitivity(fctx.clearance ?? 'confidential', await getAssistantClearance(fctx.assistantId)) }), fileIdOrPath)
            if (!res.ok) return null
            fctx.scopeAccumulator?.note(scopeEvidenceFromRows([res.value.file]))
            return {
              bytes: new Uint8Array(res.value.bytes),
              name: res.value.file.path.split('/').pop() || res.value.file.path,
            }
          },
          writeBytes: async (fctx, params) => {
            if (!prepareSandboxPublication) throw new Error('Workspace file publication is unavailable.')
            const publication = await prepareSandboxPublication(fctx, { backend: 'cloud', profileId: undefined })
            const name = params.path.split('/').pop() || 'artifact'
            return publication.writeBytes({ path: params.path, name: params.title ?? name, mime: 'application/octet-stream',
              bytes: params.bytes, origin: 'compute-artifact' })
          },
        }
      : null,
    getWorkspacePlan,
    resolvePolicy: resolveComputerToolPolicy,
    unattendedEnabled: unattendedComputerUse,
    onEvent: (evt, ctx) => {
      analytics.logEvent({
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        sessionId: ctx.sessionId,
        channelType: ctx.channelType,
        eventName: 'computer_compute',
        metadata: {
          kind: sanitizeAnalytics(evt.type),
          ok: evt.ok,
          ...(evt.detail !== undefined ? { detail: evt.detail } : {}),
        },
      })
    },
  })
  allTools.set('runPython', computeTools.runPython)
  allTools.set('loadFromWorkspace', computeTools.loadFromWorkspace)
  allTools.set('saveToWorkspace', computeTools.saveToWorkspace)

  // Logic-blocks (R2-5/R2-9/R2-10): reviewed browsing code in brain, run
  // through the governed runner whose terminal sends hit the same
  // grant/approval/verb-ceiling gate the browser tools use. The approvals
  // bridge parks un-granted sends as kind='browser_skill_send' rows and
  // writes 'auto_approved' AUDIT rows for grant-satisfied ones (R2-2).
  const browserSkillsStore = createBrowserSkillsStore()
  const blockApprovals: BlockApprovalsPort = {
    async createSendApproval(p) {
      const row = await pendingApprovalsStore.createBrowserSkillSend({
        workspaceId: p.workspaceId,
        approverUserId: p.approverUserId,
        sessionId: p.sessionId ?? null,
        payload: p.payload as unknown as Record<string, unknown>,
        expiresAt: p.expiresAt ? new Date(p.expiresAt) : null,
      })
      // An explicitly assigned reviewer may resolve it; the runner's poll consumes the receipt.
      void reviewOnCreate(row)
      return { id: row.id }
    },
    async getStatus(id) {
      return readBrowserSendApprovalStatus(pendingApprovalsStore, id)
    },
    async expire(id) {
      await pendingApprovalsStore.expireById(id)
    },
    async recordAutoApproved(p) {
      await pendingApprovalsStore.createBrowserSkillAudit({
        workspaceId: p.workspaceId,
        approverUserId: p.approverUserId,
        sessionId: p.sessionId ?? null,
        grantId: p.grantId,
        payload: p.payload as unknown as Record<string, unknown>,
      })
    },
  }
  const skillRunnerTools = createSkillRunnerTools({
    provider: sandboxProvider,
    local: localBrowserProvider,
    binding: sandboxOrchestrator?.binding ?? null,
    skills: browserSkillsStore,
    grants: ports.browserSkillGrantStore ?? null,
    approvals: blockApprovals,
    profiles: ports.browserProfileStore
      ? {
          store: ports.browserProfileStore,
          vault: ports.browserSessionVault ?? null,
          assistantClearance: (toolCtx) => getAssistantClearance(toolCtx.assistantId),
          departmentRead: resolveBrowserProfileDepartmentRead,
          // Same authority-safe list as the human department picker: only departments this person holds.
          departmentNames: async (toolCtx) => toolCtx.workspaceId
            ? new Map((await previewCrmDestination(toolCtx.userId, toolCtx.workspaceId).catch(() => ({ departments: [] }))).departments.map(row => [row.id, row.name] as const))
            : new Map(),
        }
      : null,
    resolvePolicy: resolveComputerToolPolicy,
    unattendedEnabled: unattendedComputerUse,
    getWorkspacePlan,
    getSessionTrace: computerTools.getSessionTrace,
    clearSessionTrace: computerTools.clearSessionTrace,
    onEvent: (evt, ctx) => {
      analytics.logEvent({
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        sessionId: ctx.sessionId,
        channelType: ctx.channelType,
        eventName: 'browser_skill_run',
        metadata: {
          skill: sanitizeAnalytics(evt.skill),
          site: sanitizeAnalytics(evt.site),
          rehearsal: evt.rehearsal,
          ok: evt.ok,
          sends: evt.sends,
          autoApproved: evt.autoApproved,
          queued: evt.queued,
          denied: evt.denied,
        },
      })
    },
  })
  allTools.set('runBrowserSkill', skillRunnerTools.runBrowserSkill)
  allTools.set('saveBrowserSkill', skillRunnerTools.saveBrowserSkill)
  allTools.set('listBrowserSkills', skillRunnerTools.listBrowserSkills)
  allTools.set('listBrowserProfiles', skillRunnerTools.listBrowserProfiles)
  allTools.set('classifyBrowserProfileDepartment', skillRunnerTools.classifyBrowserProfileDepartment)

  // The watched agentic fallback (R2-1/R2-7): browser-use for novel flows,
  // cloud-only, always self-healing into a draft logic-block (R2-5).
  const buFallback = createBuFallbackTool({
    provider: sandboxProvider,
    binding: sandboxOrchestrator?.binding ?? null,
    skills: browserSkillsStore,
    profiles: ports.browserProfileStore
      ? {
          store: ports.browserProfileStore,
          vault: ports.browserSessionVault ?? null,
          assistantClearance: (toolCtx) => getAssistantClearance(toolCtx.assistantId),
          departmentRead: resolveBrowserProfileDepartmentRead,
        }
      : null,
    resolvePolicy: resolveComputerToolPolicy,
    unattendedEnabled: unattendedComputerUse,
    getWorkspacePlan,
    // Hosted custom fetches enforce public-only DNS/IP checks per request.
    // E2B cannot reuse that host-side transport, so do not bypass it by
    // handing a hosted endpoint directly to the sandbox process.
    resolveLlm: customLlmNetworkPolicy === 'private-network' || externalCredentialPool
      ? async (workspaceId) => {
          if (customLlmNetworkPolicy === 'private-network') {
            const custom = (await resolveBackgroundRuntime(workspaceId))?.browserUse ?? null
            if (custom) return custom
          }
          if (!externalCredentialPool) return null

          const gemini = await externalCredentialPool.resolve('gemini', env.GEMINI_API_KEY)
          if (gemini) {
            return {
              apiKeyEnvName: 'GOOGLE_API_KEY' as const,
              apiKey: gemini.secret,
              model: env.BROWSER_USE_MODEL || 'gemini-3.6-flash',
              providerKeySource: 'platform' as const,
              recordSpend: async (model: string, usage: TokenUsage) => {
                await gemini.recordSpend(calculateCost(model, usage))
              },
            }
          }
          const dashscope = await externalCredentialPool.resolve('dashscope', env.DASHSCOPE_API_KEY)
          if (dashscope) {
            return {
              apiKeyEnvName: 'OPENAI_API_KEY' as const,
              apiKey: dashscope.secret,
              baseUrl: dashscopeBaseUrl,
              model: env.BROWSER_USE_MODEL || 'qwen3.5-flash',
              useVision: false,
              providerKeySource: 'platform' as const,
              recordSpend: async (model: string, usage: TokenUsage) => {
                await dashscope.recordSpend(calculateCost(model, usage))
              },
            }
          }
          const anthropic = await externalCredentialPool.resolve('anthropic', env.ANTHROPIC_API_KEY)
          if (anthropic) {
            return {
              apiKeyEnvName: 'ANTHROPIC_API_KEY' as const,
              apiKey: anthropic.secret,
              model: env.BROWSER_USE_MODEL || 'claude-haiku-4-5-20251001',
              providerKeySource: 'platform' as const,
            }
          }
          return null
        }
      : undefined,
    onUsage: createBrowserAgentUsageRecorder(usageStore),
    onEvent: (evt, ctx) => {
      analytics.logEvent({
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        sessionId: ctx.sessionId,
        channelType: ctx.channelType,
        eventName: 'browser_explore',
        metadata: {
          site: sanitizeAnalytics(evt.site),
          steps: evt.steps,
          distilled: evt.distilled,
          ok: evt.ok,
          backend: sanitizeAnalytics(evt.backend ?? 'unavailable'),
          fallback: evt.fallback,
          ...(evt.skillName ? { skill: sanitizeAnalytics(evt.skillName) } : {}),
        },
      })
    },
  })
  allTools.set('browserExplore', buFallback.browserExplore)

  // ── Agent capability toolset ──
  const agentControlPlaneReader = createControlPlaneReader({
    capabilityStore,
    connectorInstanceStore,
    connectorGrantStore,
    workspaceSkillStore,
    channelIntegrationStore: integrationStore ?? undefined,
  })
  const resolveAgentApprover = async (ctx: { channelType: string; channelId: string; userId: string }) => {
    try {
      if (ctx.channelType === 'programmatic') {
        const key = await brainKeyStore.getByIdSystem(ctx.channelId)
        if (key?.createdBy) return key.createdBy
      } else if (ctx.channelType === 'assistant_mcp' || ctx.channelType === 'api') {
        const key = await apiKeyStore.getByIdSystem(ctx.channelId)
        if (key?.createdBy) return key.createdBy
      }
    } catch { /* fall through to the owner */ }
    return ctx.userId
  }
  const agentToolset = buildAgentToolset({
    allTools,
    controlPlaneReader: agentControlPlaneReader,
    approvalsStore: pendingApprovalsStore,
    writeToolDeps: {
      enablementStore: workspaceSkillEnablementStore,
      workspaceSkillStore,
      listWorkspaceAssistants: async (userId, workspaceId) =>
        (await listAccessibleAssistants(userId, workspaceId)).map((a) => ({
          id: a.id,
          name: a.name,
        })),
      mcpSettingsStore,
      connectorInstanceStore,
      connectorGrantStore,
      appOrigin: env.AUTHED_APP_URL ?? env.APP_URL,
      resolveApprover: resolveAgentApprover,
    },
  })
  for (const [name, tool] of agentToolset.reads) if (!allTools.has(name)) allTools.set(name, tool)
  for (const [name, tool] of agentToolset.writes) if (!allTools.has(name)) allTools.set(name, tool)

  return {
    browserRelayUrl, protectedExtensionOrigins, protectedBrowserSupported, localComputerTasks, protectedFill,
    sandboxProvider, sandboxOrchestrator, browserAuthBroker, discardBrowserTask, getAssistantClearance,
    localBrowserProvider, computerTools, browserSkillsStore, agentToolset,
  } as const
}
