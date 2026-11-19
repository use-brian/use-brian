/**
 * The open boot composition (M4 step 6, D13/D14): `bootOpenApi` is a thin
 * composition root that calls ordered register modules. The order below IS
 * the route mount order and the worker start order, so changing it is a
 * deliberate, reviewed edit of this list, the composition root and
 * docs/architecture/platform/deployment.md -> "Boot composition" together.
 *
 * Spec: docs/architecture/platform/deployment.md -> "Boot composition".
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bootCompositionSource, bootRegisterOrder } from './composition-source.js'

const BOOT_DIR = new URL('../', import.meta.url)
const read = (file: string) => readFileSync(new URL(file, BOOT_DIR), 'utf8')

/** Composition order with each step's component tag. */
const STEPS: ReadonlyArray<readonly [step: string, tag: string]> = [
  ['overlay-seams', '[COMP:api/boot-overlay-seams]'],
  ['http', '[COMP:api/boot-http]'],
  ['runtime', '[COMP:api/boot-runtime]'],
  ['stores', '[COMP:api/boot-stores]'],
  ['providers', '[COMP:api/boot-providers]'],
  ['connectors', '[COMP:api/boot-connectors]'],
  ['auth', '[COMP:api/boot-auth]'],
  ['workspace', '[COMP:api/boot-workspace]'],
  ['tools', '[COMP:api/boot-tools]'],
  ['office-tools', '[COMP:api/boot-office-tools]'],
  ['capture', '[COMP:api/boot-capture]'],
  ['assistants', '[COMP:api/boot-assistants]'],
  ['workflow', '[COMP:api/boot-workflow]'],
  ['primitives', '[COMP:api/boot-primitives]'],
  ['files', '[COMP:api/boot-files]'],
  ['computer-use', '[COMP:api/boot-computer-use]'],
  ['chat-routes', '[COMP:api/boot-chat-routes]'],
  ['integration-routes', '[COMP:api/boot-integration-routes]'],
  ['session-routes', '[COMP:api/boot-session-routes]'],
  ['workspace-routes', '[COMP:api/boot-workspace-routes]'],
  ['public-routes', '[COMP:api/boot-public-routes]'],
  ['api-routes', '[COMP:api/boot-api-routes]'],
  ['office-routes', '[COMP:api/boot-office-routes]'],
  ['brain-routes', '[COMP:api/boot-brain-routes]'],
  ['workflow-events', '[COMP:api/boot-workflow-events]'],
  ['workers', '[COMP:api/boot-workers]'],
  ['learning-workers', '[COMP:api/boot-learning-workers]'],
  ['memory-workers', '[COMP:api/boot-memory-workers]'],
  ['recording-workers', '[COMP:api/boot-recording-workers]'],
  ['sync-workers', '[COMP:api/boot-sync-workers]'],
  ['boot-context', '[COMP:api/boot-context]'],
  ['channels', '[COMP:api/boot-channels]'],
  ['lifecycle', '[COMP:api/boot-lifecycle]'],
]

/**
 * Lazy bindings per step (boot/lazy.ts): router factories that load on their
 * mount's first request and worker factories that load on start().
 * docs/architecture/platform/deployment.md -> "Lazy routers and workers"
 * carries the same table; change both together.
 */
const LAZY: Readonly<Record<string, { routes?: readonly string[]; workers?: readonly string[] }>> = {
  'capture': { workers: ['createChatArchiveEnrichmentWorker'] },
  'files': { routes: ['localFilesTransferRoutes'] },
  'integration-routes': { routes: ['applicationPlatformRoutes', 'appsShopifyRoutes', 'brainMcpRoutes', 'crmIntegrationRoutes', 'externalServicesRoutes', 'learnJapaneseRoutes'] },
  'session-routes': { routes: ['accountAvatarPublicRoutes', 'accountRoutes', 'analyticsRoutes', 'campaignRoutes', 'connectorRoutes', 'contentIdeasRoutes', 'contentPlanRoutes', 'contentPlanningRoutes', 'docFilesRoutes', 'feedCollaborationRoutes', 'feedbackRoutes', 'fileRoutes', 'linkedinImportRoutes', 'openRecordingsRoutes', 'postWorkingCopiesRoutes', 'recordingInteractionRoutes', 'recordingLiveRoutes', 'recordingRecoveryRoutes', 'watchRecordingRoutes', 'workspaceIconPublicRoutes'] },
  'workspace-routes': { routes: ['assistantConnectorGrantsRoutes', 'assistantRoutes', 'brainKeysRoutes', 'browserExtensionAuthorityRoutes', 'browserExtensionRoutes', 'compartmentRoutes', 'computerRoutes', 'engineeringHistoryRoutes', 'externalAppCalendarRoutes', 'externalAppRecordsRoutes', 'externalApprovalSourceRoutes', 'invitationRoutes', 'memberConnectorInstanceRoutes', 'oauthAuthorizationsRoutes', 'programmaticCaptureRoutes', 'protectedBrowserFillRoutes', 'skillApprovalsRoutes', 'skillRoutes', 'workspaceConnectorInstanceRoutes', 'workspaceCustomLlmEndpointsRoutes', 'workspaceIconRoutes', 'workspaceLlmKeysRoutes'] },
  'public-routes': { routes: ['publicShareRoutes', 'publicSiteRoutes'] },
  'api-routes': { routes: ['approvalReviewRoutes', 'approvalsRoutes', 'brainStreamRoutes', 'briefRoutes', 'codexProviderRoutes', 'commentRoutes', 'contextScopeRoutes', 'crmIntakeRoutes', 'departmentRoutes', 'docEntitiesRoutes', 'docThemesRoutes', 'generateSynthesisRoutes', 'goalDefaultBudgetRoutes', 'goalsRoutes', 'inboxRoutes', 'internalLinkRoutes', 'liveWorkRoutes', 'modelMenuRoutes', 'pageActionsRoutes', 'researchRoutes', 'taskExecutionRoutes', 'teamspacesRoutes', 'viewsRoutes', 'workRoutes', 'workflowApprovalsRoutes', 'workflowWebhookRoutes', 'workspaceAccessRoutes', 'workspaceSearchRoutes'] },
  'office-routes': { routes: ['officeArtifactRoutes', 'officeCollaborationRoutes', 'officeConversationRoutes', 'officeImportRoutes', 'officeJobRoutes', 'officeLifecycleRoutes', 'officePdfSessionRoutes', 'officeReleaseRoutes', 'officeResourceRoutes', 'officeTemplateRoutes'] },
  'brain-routes': { routes: ['brainInboxRoutes', 'brainRoutes', 'brandRoutes', 'chatLinkRoutes', 'crmIntegrationCredentialRoutes', 'crmOperationsRoutes', 'crmRoutes', 'handleRoutes', 'homeDockRoutes', 'homeRoutes', 'knowledgeRoutes', 'memoryRoutes', 'taskGuardrailRoutes', 'workspaceKnowledgeRoutes', 'workspaceModuleRoutes'] },
  'workflow': { routes: ['externalApprovalRoutes'] },
  'workflow-events': { workers: ['createCampaignConversionOutboxWorker', 'createCrmEntitlementWorker', 'createCrmImportFileCleanupWorker', 'createCrmRetentionWorker'] },
  'workers': { workers: ['createCleanupWorker', 'createOrganizationUpgradeWorker', 'createSessionStateWorker', 'createSessionTitleWorker'] },
  'learning-workers': { workers: ['createFeedEditorialWorker', 'createPlaybookReflectionWorker', 'createSkillReviewWorker'] },
  'memory-workers': { workers: ['createGDriveCatalogWorker', 'createGDriveEnrichmentWorker', 'createLinkedInImportWorker'] },
  'recording-workers': { routes: ['chatArchiveExtractRoutes'], workers: ['createOpenRecordingProcessWorker', 'createRecordingAutoTitleWorker'] },
  'sync-workers': { routes: ['ingestRoutes'], workers: ['createExternalSinkRelay', 'createGoalStallReaper', 'createStuckSessionSweeper', 'createViewsPruneWorker'] },
  'channels': { routes: ['channelsRoutes', 'customChannelBridgeRoutes', 'discordRoutes', 'feishuNotificationRoutes', 'feishuRoutes', 'msteamsRoutes', 'slackLinkingRoutes', 'slackRoutes', 'telegramByoRoutes', 'telegramLinkingRoutes', 'wechatRoutes', 'whatsappByonRoutes', 'whatsappCloudRoutes', 'whatsappIngestAdminRoutes'] },
}

/** Steps that stay wholly eager: what one chat turn, sign-in and /health need. */
const EAGER_STEPS = ['http', 'auth', 'chat-routes'] as const

/**
 * Named eager mounts: statically imported and built at boot. Sessions and
 * public chat answer the turn; path-less and `/` mounts intercept every later
 * request; `workspaceRoutes` is published on BootContext as a Router.
 */
const EAGER_MOUNTS: ReadonlyArray<readonly [step: string, name: string, module: string]> = [
  ['session-routes', 'sessionRoutes', '../routes/sessions.js'],
  ['session-routes', 'sessionQuestionRoutes', '../routes/sessions-questions.js'],
  ['public-routes', 'publicChatRoutes', '../routes/public-chat.js'],
  ['public-routes', 'campaignTrackingRoutes', '../routes/campaign-tracking.js'],
  ['public-routes', 'campaignPublicEmailRoutes', '../campaigns/public-email.js'],
  ['integration-routes', 'oauthMetadataRoutes', '../brain-mcp/oauth/index.js'],
  ['integration-routes', 'connectorActorMetadataRoutes', '../application-platform/connector-actor-metadata.js'],
  ['api-routes', 'internalIngestRoutes', '../doc/internal-ingest-route.js'],
  ['api-routes', 'internalPageEventRoutes', '../doc/internal-page-event-route.js'],
  ['office-routes', 'internalOfficeCheckpointRoutes', '../routes/internal-office-checkpoint.js'],
  ['workspace-routes', 'workspaceRoutes', '../routes/workspaces.js'],
]

const LAZY_BINDING = /^const (\w+) = (lazyRoutes|lazyWorker)\(\(\) => import\('([^']+)'\), '(\w+)'(?:, '(\[[\w-]+\])')?\)$/gm

/** Modules a step imports as values (type-only imports elided, as at runtime). */
function staticValueImports(source: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of source.matchAll(/^import \{([^}]*)\} from '([^']+)'/gm)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim()
      if (name && !name.startsWith('type ')) out.set(name.split(/\s+as\s+/).pop()!, m[2])
    }
  }
  for (const m of source.matchAll(/^import (\w+)(?:, \{[^}]*\})? from '([^']+)'/gm)) out.set(m[1], m[2])
  return out
}

const CLOSED_OR_AGGREGATE = [
  /from '@use-brian\/core'/,
  /import\('@use-brian\/core'\)/,
  /from '@use-brian\/core\/dist\//,
  /from '@use-brian\/api-platform/,
  /from '@use-brian\/shared-server/,
]

describe('[COMP:api/boot] open composition root', () => {
  const boot = readFileSync(new URL('../../boot.ts', import.meta.url), 'utf8')
  const order = bootRegisterOrder(boot)

  it('calls every register module exactly once, in the documented order', () => {
    expect(order.map(([, file]) => file.replace(/\.register$/, ''))).toEqual(STEPS.map(([step]) => step))
    const onDisk = readdirSync(BOOT_DIR).filter((f) => f.endsWith('.register.ts')).map((f) => f.replace(/\.register\.ts$/, '')).sort()
    expect(onDisk).toEqual(STEPS.map(([step]) => step).sort())
  })

  it('keeps only the root seams inline: no route mount or worker construction in boot.ts', () => {
    const body = boot.slice(boot.indexOf('export async function bootOpenApi('))
    expect(body).not.toMatch(/\bapp\.(use|get|post|put|patch|delete)\(/)
    expect(body).not.toMatch(/\.start\(\)/)
    // The four seams that stay in the root, in order.
    const seams = ['configureTurnKernel({ resolveWorkspaceCustomLlm, configuredProviders })',
      'ports.mountPublicExtraRoutes(app,', 'ports.mountExtraRoutes(app, ctx)', 'startSessionEventBus()']
    const at = seams.map((s) => body.indexOf(s))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // The early public hook runs between the public routes and the first bare /api guard.
    expect(body.indexOf('registerPublicRoutes(')).toBeLessThan(at[1])
    expect(at[1]).toBeLessThan(body.indexOf('registerApiRoutes('))
    // BootContext is assembled before the channel hosts and the late overlay hook read it.
    expect(body.indexOf('registerBootContext(')).toBeLessThan(body.indexOf('registerChannels('))
    expect(body.indexOf('registerChannels(')).toBeLessThan(at[2])
  })

  it('imports no aggregate core barrel and no closed package from the root or any register module', () => {
    for (const file of ['../boot.ts', ...STEPS.map(([step]) => `${step}.register.ts`), 'scope.ts', 'late.ts']) {
      const source = read(file)
      for (const pattern of CLOSED_OR_AGGREGATE) expect(source, `${file} matches ${pattern}`).not.toMatch(pattern)
    }
  })

  it('gives every late binding exactly one declaring or publishing step', () => {
    const late = read('late.ts')
    const fields = [...late.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1])
    expect(fields.length).toBeGreaterThan(0)
    for (const field of fields) {
      const writers = STEPS.filter(([step]) => new RegExp(`\\blate\\.${field} = `).test(read(`${step}.register.ts`)))
      expect(writers.length, `late.${field} has no writer`).toBeGreaterThan(0)
    }
  })

  it('inlines the composition in call order for source anchors', () => {
    const source = bootCompositionSource()
    let cursor = 0
    for (const [step] of STEPS) {
      const at = source.indexOf(`export ${read(`${step}.register.ts`).includes('export async function') ? 'async ' : ''}function register`, cursor)
      expect(at, `${step} inlined after its predecessor`).toBeGreaterThan(cursor - 1)
      cursor = at + 1
    }
  })
})

describe('[COMP:api/boot] register steps', () => {
  for (const [step, tag] of STEPS) {
    it(`${tag} ${step} exports one register function typed by its scope`, () => {
      const source = read(`${step}.register.ts`)
      const exported = [...source.matchAll(/^export (?:async )?function (register\w+)\(scope: (\w+)\)/gm)]
      expect(exported).toHaveLength(1)
      expect(source).toContain(`import type { ${exported[0][2]} } from './scope.js'`)
      expect(source).not.toMatch(/^export (?:const|let|class) /m)
    })
  }
})

describe('[COMP:api/boot-lazy] eager and lazy composition sets', () => {
  const bindings = (step: string) => [...read(`${step}.register.ts`).matchAll(LAZY_BINDING)]
    .map(([, name, helper, module, key, tag]) => ({ name, helper, module, key, tag }))

  it('binds exactly the documented routers and workers lazily, per step', () => {
    for (const [step] of STEPS) {
      const found = bindings(step)
      const expected = LAZY[step] ?? {}
      expect(found.filter((b) => b.helper === 'lazyRoutes').map((b) => b.name).sort(), `${step} lazy routers`).toEqual([...(expected.routes ?? [])].sort())
      expect(found.filter((b) => b.helper === 'lazyWorker').map((b) => b.name).sort(), `${step} lazy workers`).toEqual([...(expected.workers ?? [])].sort())
      // Any other lazy helper use in a step would escape this list.
      const uses = read(`${step}.register.ts`).match(/\blazy(?:Routes|Worker)\(/g) ?? []
      expect(uses.length, `${step} uses lazy helpers only in pinned bindings`).toBe(found.length)
    }
  })

  it('keeps each mount and construction statement unchanged: the binding has the factory name', () => {
    for (const [step] of STEPS) {
      const source = read(`${step}.register.ts`)
      const imports = staticValueImports(source)
      for (const b of bindings(step)) {
        expect(b.name, `${step}: ${b.name} binds ${b.key}`).toBe(b.key)
        expect(b.module.startsWith('../'), `${step}: ${b.name} loads a sibling module`).toBe(true)
        // Not also imported statically by the same step, so the step does not load it at boot.
        expect([...imports.values()], `${step} statically imports ${b.module}`).not.toContain(b.module)
        // The binding is called where the factory was: a mount for routers, a construction for workers.
        expect(source, `${step}: ${b.name} is called`).toMatch(new RegExp(`\\b${b.name}\\(`))
        if (b.helper === 'lazyWorker') expect(b.tag, `${step}: ${b.name} names its log tag`).toMatch(/^\[[\w-]+\]$/)
      }
    }
  })

  it('keeps the eager set static: chat, sessions, auth, health and public chat load at boot', () => {
    for (const step of EAGER_STEPS) {
      expect(read(`${step}.register.ts`), `${step} must stay eager`).not.toMatch(/\blazy(?:Routes|Worker)\(/)
    }
    const chat = staticValueImports(read('chat-routes.register.ts'))
    expect(chat.get('createNativeChatRuntime')).toBe('../routes/chat.js')
    for (const step of ['auth', 'http']) expect(read(`${step}.register.ts`)).not.toMatch(/import\('\.\.\/routes\//)
    expect(read('http.register.ts')).toMatch(/app\.get\('\/health'/)
    for (const [step, name, module] of EAGER_MOUNTS) {
      const source = read(`${step}.register.ts`)
      expect(staticValueImports(source).get(name), `${step}: ${name} is a static import of ${module}`).toBe(module)
      expect(source, `${step}: ${name} is built at boot`).toMatch(new RegExp(`\\b${name}\\(`))
    }
  })

  it('imports the lazy helpers from boot/lazy.ts, which holds no module state', () => {
    const lazy = read('lazy.ts')
    expect(lazy).not.toMatch(/^(?:let|var) /m)
    expect(lazy).not.toMatch(/^const \w+ = new (?:Map|Set|WeakMap)/m)
    for (const [step] of STEPS) {
      const source = read(`${step}.register.ts`)
      if (!/\blazy(?:Routes|Worker)\(/.test(source)) continue
      expect(source).toMatch(/^import \{ (?:lazyRoutes|lazyWorker)(?:, lazyWorker)? \} from '\.\/lazy\.js'$/m)
    }
    for (const pattern of CLOSED_OR_AGGREGATE) expect(lazy).not.toMatch(pattern)
  })
})
