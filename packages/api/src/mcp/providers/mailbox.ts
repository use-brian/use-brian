/**
 * Company Email (IMAP) provider (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyToolPolicies`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { createMailboxTools, type MailboxApi, type MailboxAccountRouter } from '@use-brian/core/tools/base/mailbox.js'
import type { FilesApi } from '@use-brian/core/workspace-files/api.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { lazyImplementation } from '@use-brian/agent-runtime/tools/lazy-implementation.js'
import { readSendAsAliases } from '../../mailbox/send-as.js'
import { createSearchEmailArchiveTool, getGlobalMailboxArchiveDeps } from '../../mailbox/archive-search-tool.js'
import { createMailboxContactImportTools, getGlobalMailboxContactImportDeps } from '../../mailbox/contact-import-tools.js'
import { createSyncMailboxNowTool, getGlobalMailboxSyncDeps } from '../../mailbox/sync-tool.js'
import type { MailboxAccountSettings } from '../../mailbox/types.js'
import { enqueueFileIngestJob } from '../../db/file-ingest-jobs-store.js'
import { countEmailArchiveMessages, searchLiteralEmailArchiveMessages } from '../../db/email-archive-store.js'
import type { AssistantConnectorStore } from '../../db/assistant-connector-store.js'
import type { ConnectorActionAudit, ConnectorActionPreflight } from '../../connector-action-port.js'
import { gateToolsOnActionGrants } from '../../safety/assert-action-allowed.js'
import { classifyConnectorAuthError, type HealthReporter } from '../connector-health.js'
import { connectorInstanceGovernanceId } from '../../db/connector-instance-store.js'
import { applyToolPolicies } from '../activation.js'
import { instanceToolSuffix } from '../tool-names.js'
import { notConnectedNotice } from './notices.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes, laneUnavailable, type BuiltinLane } from './lanes.js'

const loadMailboxApi = lazyImplementation('The company mailbox client (IMAP/SMTP)', () => import('../../mailbox/mailbox-api.js'))

// ── Company mailbox (imap) injection ──────────────────────────
//
// The USER'S own corporate mailbox (mailbox-imap.md) — the third identity
// lane beside gmail (the user's Google account) and agentmail (the
// assistant's own address). Multiple mailboxes inject as instance-bound tool
// sets: primary canonical names plus stable suffixed variants. Credentials are
// the typed `type:'imap'` blob on each connector_instance;
// `imapSendMessage` reuses the Gmail governance chain verbatim: `ask`
// classification + write-grant gate (registry-derived), then advisory
// connector_actions classification + audit. Reaching execution means the
// exact frozen payload already passed configured governance.

async function collectMailboxTools(params: {
  deliveryUserId?: string
  workspaceId?: string
  connectors: Array<{ connectorId: string; connected: boolean; id?: string; createdAt?: Date; name?: string }>
  settingsStore: McpSettingsStore
  userId: string
  assistantId: string
  assistantConnectorStore: AssistantConnectorStore | undefined
  tools: Map<string, Tool>
  unavailable?: string[]
  connectorInstanceStore?: import('../../db/connector-instance-store.js').ConnectorInstanceStore
  connectorActionAudit?: ConnectorActionAudit
  assistantConnectorGrantsStore?: import('../../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
  /** Legacy single-instance overlay path: bind to this EXACT instance id. */
  instanceIdOverride?: string | null
  healthProbe?: { report: HealthReporter }
  /**
   * Workspace file primitive. Present = `imapSaveAttachment` is built
   * (Phase 3 / D17); absent = the tool is simply not injected, never a tool
   * that always errors.
   */
  filesApi?: FilesApi
  /** Team-owned rows resolve both policy layers from workspace_tool_policy. */
  workspacePolicyScoped?: boolean
}): Promise<void> {
  const {
    connectors, settingsStore, userId, assistantId, assistantConnectorStore, tools, unavailable,
    connectorInstanceStore, connectorActionAudit, assistantConnectorGrantsStore, instanceIdOverride, healthProbe,
    filesApi, workspacePolicyScoped = false,
  } = params

  const imapConnectors = connectors.filter((c) => c.connectorId === 'imap' && c.connected)
  if (imapConnectors.length === 0) {
    unavailable?.push(notConnectedNotice('Company email (IMAP)', "searching, reading, and sending from the user's own corporate mailbox"))
    return
  }
  if (!connectorInstanceStore) return  // credentials live only on the instance row — nothing to bind
  const store = connectorInstanceStore

  // Which instances to bind. Normal personal injection and both workspace
  // overlays pass EVERY authorized connected mailbox; the optional override is
  // retained for legacy/single-instance callers. Primary = first-connected
  // (createdAt asc), which keeps the canonical unsuffixed tool names.
  const candidateRows = (instanceIdOverride
    ? imapConnectors.filter((c) => c.id === instanceIdOverride)
    : [...imapConnectors])
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
  const rows: typeof candidateRows = []
  for (const row of candidateRows) {
    const instanceId = row.id ?? instanceIdOverride ?? null
    if (!instanceId) continue
    const governanceId = connectorInstanceGovernanceId('imap', instanceId)
    if (
      assistantConnectorStore
      && !(await assistantConnectorStore.isEnabled(assistantId, governanceId, 'imap'))
    ) continue
    rows.push(row)
  }
  if (rows.length === 0) {
    unavailable?.push(notConnectedNotice('Company email (IMAP)', "searching, reading, and sending from the user's own corporate mailbox"))
    return
  }
  // The IMAP/SMTP client (imapflow, mailparser, nodemailer) loads inside
  // catalog.activate, on the first activation with a connected mailbox, not at
  // boot (M4 step 5). Awaited outside the injection catch below, so a load
  // failure is the catalog's honest `unavailable` outcome, never an empty family.
  const { createMailboxApi } = await loadMailboxApi()

  // Health rides at the API level, per instance, so a mailbox whose auth died
  // flips ITS OWN row — never a sibling's — and the read-only archive tool
  // (built below) stays outside it. Mirrors `wrapToolsWithHealthProbe`'s
  // auth-error classification.
  const withHealth = (raw: MailboxApi, instanceId: string): MailboxApi => {
    if (!healthProbe) return raw
    const report = healthProbe.report
    const guard = async <R>(op: () => Promise<R>): Promise<R> => {
      try {
        const r = await op()
        report(instanceId, 'ok')
        return r
      } catch (err) {
        if (classifyConnectorAuthError(err)) report(instanceId, 'auth_failed', err instanceof Error ? err.message : String(err))
        throw err
      }
    }
    return {
      searchMessages: (p) => guard(() => raw.searchMessages(p)),
      getMessage: (id) => guard(() => raw.getMessage(id)),
      // Attachment fetches log in like every other IMAP call, so a dead
      // credential must flip health here too — a bare pass-through would
      // typecheck and silently skip the auth-failure report.
      getAttachment: (id, partId) => guard(() => raw.getAttachment(id, partId)),
      sendMessage: (p) => guard(() => raw.sendMessage(p)),
      // The confirmation preview's From line resolves through the same seam
      // (a reply-from-origin lookup logs in like any other IMAP call).
      ...(raw.resolveSender ? { resolveSender: (p) => guard(() => raw.resolveSender!(p)) } : {}),
    }
  }

  // Audit-wrapped send (the Gmail pattern): classifier preflight observes
  // BEFORE the network call; executed/failed both audit. v1
  // `audienceClearance='public'` for all recipients, like gmail. `from` is the
  // sending identity — the RESOLVED sender when the seam reports one (a
  // send-as alias picked by reply-from-origin or passed explicitly), else the
  // bound account; the pre-send `denied` audit can only know the account or
  // the explicit `from`, since resolution happens inside the send.
  const withAudit = (raw: MailboxApi, fromEmail: string): MailboxApi => ({
    searchMessages: (p) => raw.searchMessages(p),
    getMessage: (id) => raw.getMessage(id),
    // Reads are unaudited (the `getMessage` precedent) — `connector_actions`
    // records egress, and an attachment save stays inside the workspace.
    getAttachment: (id, partId) => raw.getAttachment(id, partId),
    ...(raw.resolveSender ? { resolveSender: (p) => raw.resolveSender!(p) } : {}),
    sendMessage: async (p) => {
      const auditPayload = {
        to: p.to,
        from: p.from?.trim() || fromEmail,
        subject: p.subject,
        has_body: Boolean(p.body),
        body_length: p.body?.length ?? 0,
        in_reply_to: p.inReplyTo ?? null,
        attachment_count: p.attachments?.length ?? 0,
        attachments: (p.attachments ?? []).map((attachment) => ({
          name: attachment.filename,
          mime: attachment.mime,
          size_bytes: attachment.data.byteLength,
        })),
      }
      const classifierPayload = { ...auditPayload, body: p.body ?? '' }
      let preflight: ConnectorActionPreflight | undefined
      if (connectorActionAudit) {
        preflight = connectorActionAudit.preflight({
          audienceClearance: 'public',
          payload: classifierPayload,
          enforcement: 'advisory',
        })
      }
      try {
        const result = await raw.sendMessage(p)
        if (connectorActionAudit) {
          try {
            await connectorActionAudit.emit(
              { userId, assistantId },
              {
                connectorId: 'imap', actionKind: 'send_email', audienceClearance: 'public', status: 'executed', externalId: result.messageId,
                // Record the identity the mail actually carried (mailbox-imap.md → "Send-as aliases").
                payload: { ...auditPayload, from: result.from ?? auditPayload.from },
                preflight,
              },
            )
          } catch (auditErr) {
            console.warn('[mcp-inject] imap connector_action audit emit failed (best-effort, suppressed):', auditErr instanceof Error ? auditErr.message : String(auditErr))
          }
        }
        return result
      } catch (err) {
        if (connectorActionAudit) {
          try {
            await connectorActionAudit.emit(
              { userId, assistantId },
              {
                connectorId: 'imap', actionKind: 'send_email', audienceClearance: 'public', status: 'failed',
                payload: { ...auditPayload, error: err instanceof Error ? err.message : String(err) },
                preflight,
              },
            )
          } catch (auditErr) {
            console.warn('[mcp-inject] imap connector_action audit emit failed (failure path, suppressed):', auditErr instanceof Error ? auditErr.message : String(auditErr))
          }
        }
        throw err
      }
    },
  })

  try {
    // Build a bound MailboxApi per connected mailbox + resolve its
    // authoritative email (the model-visible binding label; the instance label
    // can be renamed, so it is NOT the identity). A creds-missing instance is
    // skipped rather than surfaced as a dead tool.
    const bound: Array<{ instanceId: string; email: string; api: MailboxApi }> = []
    for (const row of rows) {
      const instanceId = row.id ?? instanceIdOverride ?? null
      if (!instanceId) continue
      let email: string
      try {
        const creds = await store.getAuthCredentialsSystem(instanceId)
        if (!creds || creds.type !== 'imap') continue
        email = creds.email
      } catch { continue }
      const boundId = instanceId
      const getSettings = async (): Promise<MailboxAccountSettings> => {
        const creds = await store.getAuthCredentialsSystem(boundId)
        if (!creds || creds.type !== 'imap') {
          throw new Error('Company mailbox is not connected (no imap credentials on the instance)')
        }
        const { type: _t, ...settings } = creds
        return settings
      }
      // Send-as aliases ride the instance config (`config.sendAsAliases`), read
      // per call like the credentials so a panel edit applies to the next send.
      const getSendAsAliases = async (): Promise<string[]> => {
        try {
          const row = await store.getSystem(boundId)
          return readSendAsAliases(row?.config)
        } catch {
          return []
        }
      }
      const getKnownFolderPaths = async (): Promise<string[]> => {
        const paths = new Set<string>()
        try {
          const current = await store.getSystem(boundId)
          const sync = current?.config?.mailboxSync as { folders?: unknown } | undefined
          const folders = sync?.folders
          if (folders && typeof folders === 'object' && !Array.isArray(folders)) {
            for (const path of Object.keys(folders)) paths.add(path)
          }
        } catch {
          // Live LIST remains available even if config lookup is degraded.
        }
        try {
          const archived = await countEmailArchiveMessages(boundId)
          for (const path of Object.keys(archived.byFolder)) paths.add(path)
        } catch {
          // The archive is a recovery hint, not a dependency of live IMAP.
        }
        return [...paths]
      }
      const rawApi = createMailboxApi({
        cacheKey: boundId,
        deliveryContext:{ userId:params.deliveryUserId ?? userId,connectorInstanceId:boundId,workspaceId:params.workspaceId },
        getSettings,
        getSendAsAliases,
        getKnownFolderPaths,
        searchArchivedMessages: (params) => searchLiteralEmailArchiveMessages({
          ownerUserId: userId,
          instanceId: boundId,
          params,
        }),
      })
      bound.push({ instanceId: boundId, email, api: withHealth(withAudit(rawApi, email), boundId) })
    }
    if (bound.length === 0) {
      unavailable?.push(notConnectedNotice('Company email (IMAP)', "searching, reading, and sending from the user's own corporate mailbox"))
      return
    }

    // Build one complete tool set per mailbox. The first/oldest keeps canonical
    // names for single-account compatibility; every later set uses the same
    // stable instance suffix convention as Google/GitHub/etc. Every schema is
    // bound to one identity (no model-selectable `account` field), while policy
    // and write grants resolve through that mailbox's governance id.
    const archiveDeps = getGlobalMailboxArchiveDeps()
    const syncDeps = getGlobalMailboxSyncDeps()
    const contactImportDeps = getGlobalMailboxContactImportDeps()
    for (const [index, mailbox] of bound.entries()) {
      const governanceId = connectorInstanceGovernanceId('imap', mailbox.instanceId)
      const accountRef = {
        instanceId: mailbox.instanceId,
        email: mailbox.email,
        isPrimary: true,
      }
      const router: MailboxAccountRouter = {
        list: () => [{ email: mailbox.email, isPrimary: true }],
        get: (email) => email.trim().toLowerCase() === mailbox.email.trim().toLowerCase()
          ? mailbox.api
          : undefined,
      }
      // Attachment saves (Phase 3) land bytes in the workspace file primitive
      // and then ride the existing file-ingest queue so the saved document is
      // searchable — the `channel-media-deps` persist shape, on request only.
      const accountTools: Tool[] = gateToolsOnActionGrants(
        createMailboxTools(router, {
          boundAccountEmail: mailbox.email,
          ...(filesApi
            ? {
                attachments: {
                  filesApi,
                  enqueueIngest: async ({ fileId, workspaceId, actingUserId, assistantId: forAssistant }) => {
                    await enqueueFileIngestJob({
                      fileId,
                      workspaceId,
                      actingUserId,
                      assistantId: forAssistant,
                      sourceLabel: 'email-attachment',
                    })
                  },
                },
              }
            : {}),
        }),
        'imap',
        assistantConnectorGrantsStore,
        assistantId,
        governanceId,
      )

      // Archive search + on-demand sync stay outside the live API health wrap,
      // but each is bound to the SAME concrete instance as this variant set.
      if (archiveDeps) {
        accountTools.push(createSearchEmailArchiveTool({
          ownerUserId: userId,
          accounts: [accountRef],
          boundAccount: accountRef,
          deps: archiveDeps,
        }))
      }
      if (syncDeps) {
        accountTools.push(createSyncMailboxNowTool({
          accounts: [accountRef],
          boundAccount: accountRef,
          deps: syncDeps,
        }))
      }
      if (contactImportDeps) {
        accountTools.push(...createMailboxContactImportTools({
          ownerUserId: userId,
          instanceId: mailbox.instanceId,
          accountEmail: mailbox.email,
          deps: contactImportDeps,
        }))
      }

      const suffix = index === 0 ? '' : instanceToolSuffix(mailbox.instanceId, mailbox.email)
      const candidates = accountTools.map(rawTool => ({
        ...rawTool,
        name: `${rawTool.name}${suffix}`,
        description: `[${mailbox.email}] ${rawTool.description}`,
      }))
      for (const tool of await applyToolPolicies(candidates, governanceId, settingsStore, assistantId, userId, unavailable, {
        canonicalName: tool => tool.name.slice(0, tool.name.length - suffix.length),
        appServerName: workspacePolicyScoped ? governanceId : 'imap',
        assistantFallbackServerName: 'imap',
      })) {
        tools.set(tool.name, tool)
      }
    }
    console.debug(`[mcp-inject] Company mailbox (imap): injected ${bound.length} account-bound tool set(s)`)
  } catch (err) {
    console.error('[mcp-inject] Company mailbox (imap) injection failed:', err)
  }
}

// ── Provider module ───────────────────────────────────────────

/**
 * One Company Email (IMAP) lane: every usable mailbox of that lane in one
 * pass, each bound to its exact instance. `deliveryUserId` is the acting
 * user on a grant lane (the grantor owns the credentials).
 */
export type MailboxLane = BuiltinLane<{ connectorId: string; connected: boolean; id?: string; createdAt?: Date; name?: string }> & {
  deliveryUserId?: string
  healthProbe?: { report: HealthReporter }
  workspacePolicyScoped?: boolean
  instanceIdOverride?: string | null
}

export async function activateMailboxLane(ctx: ProviderActivationContext, lane: MailboxLane): Promise<Tool[]> {
  const tools = new Map<string, Tool>()
  await collectMailboxTools({
    workspaceId: ctx.assistantTeamId ?? undefined,
    connectors: lane.connectors,
    settingsStore: lane.settingsStore,
    userId: lane.userId,
    deliveryUserId: lane.deliveryUserId,
    assistantId: ctx.assistantId,
    assistantConnectorStore: ctx.stores.assistantConnectorStore,
    tools,
    unavailable: laneUnavailable(ctx, lane),
    connectorInstanceStore: ctx.stores.connectorInstanceStore,
    connectorActionAudit: ctx.hosted.connectorActionAudit,
    assistantConnectorGrantsStore: ctx.stores.assistantConnectorGrantsStore,
    instanceIdOverride: lane.instanceIdOverride,
    healthProbe: lane.healthProbe,
    filesApi: ctx.attachments.filesApi,
    workspacePolicyScoped: lane.workspacePolicyScoped,
  })
  return [...tools.values()]
}

export const mailboxProvider: ProviderModule<readonly MailboxLane[]> = {
  family: 'mailbox',
  describe: memoDescribe(() => describeFactoryTools('mailbox', {
    imap: () => {
      const account = { instanceId: 'descriptor', email: 'mailbox@example.invalid', isPrimary: true }
      return [
        ...createMailboxTools(inertPort('imap'), {
          boundAccountEmail: account.email,
          attachments: { filesApi: inertPort('imap files'), enqueueIngest: inertPort('imap ingest') },
        }),
        createSearchEmailArchiveTool({ ownerUserId: 'descriptor', accounts: [account], boundAccount: account, deps: inertPort('email archive') }),
        createSyncMailboxNowTool({ accounts: [account], boundAccount: account, deps: inertPort('mailbox sync') }),
        ...createMailboxContactImportTools({ ownerUserId: 'descriptor', instanceId: account.instanceId, accountEmail: account.email, deps: inertPort('contact import') }),
      ]
    },
  })),
  activate: (ctx, lanes) => runLanes(lanes, (lane) => activateMailboxLane(ctx, lane)),
}
