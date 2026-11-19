/**
 * Google provider (gcal, gmail, gdrive and the Docs/Sheets/Slides tools that ride on the gdrive grant) (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyPolicyOrSkip`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { inheritRoutineCalendarRead } from '@use-brian/core/engine/routine-read-ownership.js'
import { createGDriveFilesTools, type GDriveFilesStore, type GDriveFileKind } from '@use-brian/core/tools/base/gdrive-files.js'
import { createGoogleCalendarTools } from '@use-brian/core/tools/base/google-calendar.js'
import { createGoogleDocsTools } from '@use-brian/core/tools/base/google-docs.js'
import { createGoogleDriveTools, type AuthorizedFile } from '@use-brian/core/tools/base/google-drive.js'
import { createGmailTools } from '@use-brian/core/tools/base/google-gmail.js'
import { createGoogleSheetsTools } from '@use-brian/core/tools/base/google-sheets.js'
import { createGoogleSlidesTools } from '@use-brian/core/tools/base/google-slides.js'
import type { FilesApi } from '@use-brian/core/workspace-files/api.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { enqueueGDriveLazyEnrichment } from '../../db/gdrive-enrichment-store.js'
import { getGDriveCatalogReadPolicy, getGDriveCatalogRuntimeScope, listGDriveCatalogFiles } from '../../db/gdrive-catalog-store.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { AssistantConnectorStore } from '../../db/assistant-connector-store.js'
import type { ConnectorActionAudit, ConnectorActionPreflight } from '../../connector-action-port.js'
import { gateToolsOnActionGrants } from '../../safety/assert-action-allowed.js'
import { wrapToolsWithHealthProbe, type HealthReporter } from '../connector-health.js'
import { refreshGoogleAccessToken, unpackGoogleRefreshCredential, listCalendarList, listCalendarEventColors, listCalendarEvents, getCalendarEvent, queryCalendarFreeBusy, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, listGmailMessages, getGmailMessage, sendGmailMessage, listDriveFiles, getDriveFile, getDriveFileContentWithMetadata, createDriveFile, updateDriveFileContent, getDocContent, appendToDoc, replaceInDoc, createDocument, getSpreadsheetInfo, readSheetRange, writeSheetRange, appendSheetRows, createSpreadsheet, formatSpreadsheet, batchUpdateSpreadsheet, getPresentationInfo, getSlideContent, getSlideThumbnail, createSlide as slidesCreateSlide, updateSlideContent as slidesUpdateSlideContent, insertImage as slidesInsertImage, deleteSlide as slidesDeleteSlide, reorderSlides as slidesReorderSlides, duplicateSlide as slidesDuplicateSlide, batchUpdateSlides, createPresentation } from '../../google/client.js'
import { connectorInstanceGovernanceId, parseConnectorInstanceGovernanceId } from '../../db/connector-instance-store.js'
import { getConnectorConfig } from '../../connector-config.js'
import { applyPolicyOrSkip, injectInstanceVariants } from '../activation.js'
import { baseToolName, instanceToolSuffix, type ConnectorInstanceRef } from '../tool-names.js'
import { notConnectedNotice, googleNotConnectedForCall, expiredCredentialsNotice } from './notices.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes, laneUnavailable, type BuiltinLane } from './lanes.js'

/** Enriches confirmation input by fetching real data (e.g. actual event title from Google Calendar). */
export type ConfirmationEnricher = (toolName: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>

async function collectGoogleTools(
  connectors: Array<{
    id?: string
    connectorId: string
    connected: boolean
    name?: string
    connectedEmail?: string | null
    url?: string | null
    config?: Record<string, unknown>
  }>,
  connectorStore: ConnectorStore,
  settingsStore: McpSettingsStore,
  userId: string,
  assistantId: string,
  assistantConnectorStore: AssistantConnectorStore | undefined,
  tools: Map<string, Tool>,
  userTimezone?: string,
  unavailable?: string[],
  gdriveFilesStore?: GDriveFilesStore,
  /**
   * Per-connector refresh-token override (Stage 5 of the team-connector
   * promotion). When a key is present (e.g. 'gcal' → async () => refresh_token),
   * that closure supplies the refresh token instead of the legacy
   * `connectorStore.getCredentials(userId, connectorId)` lookup. Lets the
   * caller drive injection from team-native `connector_instance` rows whose
   * credentials don't live in `mcp_connectors`.
   *
   * Note: auto-disconnect-on-revoke is skipped for overridden connectors
   * (we can't flip a bit on a row we didn't read from mcp_connectors).
   * Operators see the revocation in logs and re-connect via the team
   * settings UI.
   */
  credsOverridePerConnector?: Partial<Record<string, () => Promise<string | null>>>,
  /**
   * Connector-action audit deps — when set, the Gmail `sendMessage`
   * callback wraps its execute with a `connector_action` Episode +
   * audit row emit (per `connector-actions.md`). Absent → Gmail sends
   * as before, just without the brain-level audit trail.
   */
  connectorActionAudit?: ConnectorActionAudit,
  /**
   * Per-assistant capability grants store (#4 in
   * `connector-actions.md`). When set, every registry-classified
   * write/destructive tool in this injector's Google sets is wrapped by
   * `gateToolsOnActionGrants` so `assertActionAllowed` runs BEFORE the
   * network call. On rejection the tool throws a structured error and
   * writes NO audit row (the action never started). Absent → no
   * enforcement (back-compat with legacy boot configurations).
   */
  assistantConnectorGrantsStore?: import('../../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore,
  /**
   * Authoritative primary email domain for the acting assistant's
   * workspace. Used by the GCal audit hook to detect "internal-only"
   * attendees → `audience_clearance='internal'`. Absent / null → every
   * attendee is treated as external and `audience_clearance='public'`.
   */
  workspaceDomain?: string | null,
  /**
   * Workspace-files byte layer — enables `gmailSendMessage` attachments
   * (resolution + gates run in core; see `google-gmail.ts`). Absent →
   * attachment requests fail honestly inside the tool.
   */
  filesApi?: FilesApi,
  /**
   * Multi-account extras. Additional connected
   * instances per Google provider beyond the primary — each is injected as a
   * label-qualified variant tool set bound to its own refresh token via
   * `resolveInstanceCreds`, mirroring the GitHub/Notion/Fathom pattern. The
   * workspace overlay paths pass the same shape so exposed/team-owned sibling
   * accounts receive the same exact-instance variants as personal assistants.
   */
  extrasByProvider?: Map<string, ConnectorInstanceRef[]>,
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>,
  /**
   * Call-time liveness writer for the extra instances (migration 294): a
   * 401/403/invalid_grant inside a variant tool call flips that instance to
   * `auth_failed`. The PRIMARY keeps the legacy prevalidation +
   * auto-disconnect path above instead.
   */
  healthReport?: HealthReporter,
  /** Acting workspace context for lazy full-Drive enrichment. */
  driveEnrichmentContext?: { workspaceId: string; actingUserId: string },
): Promise<ConfirmationEnricher> {
  const googleCfg = getConnectorConfig('google')

  /**
   * Refresh with the app that minted this grant. Managed/legacy rows use the
   * deployment Google app; BYO Drive rows carry their customer app pair inside
   * the encrypted instance credential.
   */
  async function refreshStoredGoogleCredential(stored: string): Promise<string> {
    const grant = unpackGoogleRefreshCredential(stored)
    const clientId = grant.appClientId ?? googleCfg?.clientId
    const clientSecret = grant.appClientSecret ?? googleCfg?.clientSecret
    // These three throws surface INSIDE a Google tool result (rendered by
    // core's describeGoogleError as a plain-error frame), so each is a full
    // sentence: what is missing, why no retry helps, and who can fix it.
    if (!clientId || !clientSecret) {
      throw new Error('this Google connection cannot be refreshed because the OAuth app that minted its grant is not configured on this deployment (no client id/secret for it). No retry or different argument helps — the workspace admin must reconnect Google (Studio → Connectors) under the configured app.')
    }
    return refreshGoogleAccessToken(grant.refreshToken, clientId, clientSecret)
  }

  // ── Token prevalidation + cache ─────────────────────────────
  // Validate tokens once up-front instead of letting each tool call
  // discover failures independently. Caches valid tokens so all tool
  // calls within the same request reuse the same access token.
  const tokenCache = new Map<string, string>()  // connectorId → accessToken
  const revokedConnectors = new Set<string>()

  function isTokenRevoked(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('invalid_grant') || msg.includes('expired or revoked')
  }

  async function readRefreshToken(connectorId: string): Promise<string | null> {
    const override = credsOverridePerConnector?.[connectorId]
    if (override) return override()
    // Bind Gmail's token to the same exact account whose policy will admit it.
    const gmailInstanceId = connectorId === 'gmail' ? connectors.find(c => c.connectorId === 'gmail' && c.connected)?.id : undefined
    if (gmailInstanceId && resolveInstanceCreds) return resolveInstanceCreds(gmailInstanceId)
    const creds = await connectorStore.getCredentials(userId, connectorId)
    return creds?.client_secret ?? null
  }

  async function prevalidateToken(connectorId: string): Promise<boolean> {
    const refreshToken = await readRefreshToken(connectorId)
    if (!refreshToken) return false
    try {
      const token = await refreshStoredGoogleCredential(refreshToken)
      tokenCache.set(connectorId, token)
      return true
    } catch (err) {
      if (isTokenRevoked(err)) {
        revokedConnectors.add(connectorId)
        if (!credsOverridePerConnector?.[connectorId]) {
          // Auto-disconnect only for the legacy path. Team-native revocations
          // need admin action via the team settings UI.
          connectorStore.setConnected(userId, connectorId, false)
            .catch((e) => console.error(`[mcp-inject] failed to auto-disconnect ${connectorId}:`, e))
        }
        console.warn(`[mcp-inject] ${connectorId}: token revoked — ${credsOverridePerConnector?.[connectorId] ? 'team-native instance, admin must reconnect' : 'auto-disconnected'}`)
        return false
      }
      // Transient error (network blip) — still inject tools, let them retry
      console.warn(`[mcp-inject] ${connectorId}: token prevalidation failed (transient), injecting tools anyway:`, err)
      return true
    }
  }

  async function getAccessToken(connectorId: string): Promise<string> {
    // Return cached token if available (from prevalidation)
    const cached = tokenCache.get(connectorId)
    if (cached) return cached
    // Fallback: refresh on demand (transient prevalidation failure, or token expired mid-request)
    const refreshToken = await readRefreshToken(connectorId)
    if (!refreshToken) throw new Error(googleNotConnectedForCall(connectorId))
    const token = await refreshStoredGoogleCredential(refreshToken)
    tokenCache.set(connectorId, token)
    return token
  }

  // ── Per-instance tokens (multi-account extras) ────────────────
  // An EXTRA Google account resolves its own refresh token off its
  // connector_instance row, lazily at first tool call — no prevalidation, so
  // a dead extra account never delays the primary's injection; it surfaces
  // through the variant's health probe (`wrapToolsWithHealthProbe` classifies
  // the thrown invalid_grant) on first use instead. Same request-scoped cache
  // as the primary, keyed by instance id.
  async function getAccessTokenForInstance(instanceId: string): Promise<string> {
    const cacheKey = `inst:${instanceId}`
    const cached = tokenCache.get(cacheKey)
    if (cached) return cached
    const refreshToken = resolveInstanceCreds ? await resolveInstanceCreds(instanceId) : null
    if (!refreshToken) {
      throw new Error(`the additional Google account behind this tool (connector instance ${instanceId}) has no stored credentials — it was disconnected or its grant was never completed. Retrying will not help; the user must reconnect that account (Studio → Connectors) or use the primary account's tool of the same name.`)
    }
    const token = await refreshStoredGoogleCredential(refreshToken)
    tokenCache.set(cacheKey, token)
    return token
  }

  // Suffix → per-instance token getter, populated as variant sets are
  // injected below. Lets the confirmation enricher resolve the RIGHT
  // account's token for a suffixed tool name (`googleCalendarUpdateEvent__work_1a2b3c4d`).
  const instanceTokenBySuffix = new Map<string, () => Promise<string>>()

  /** Extras for one Google provider, regardless of credential source. */
  function googleExtras(provider: 'gcal' | 'gmail' | 'gdrive'): ConnectorInstanceRef[] {
    if (!resolveInstanceCreds) return []
    return extrasByProvider?.get(provider) ?? []
  }

  /** Whether at least one additional account survives its exact enable gate. */
  async function hasEnabledGoogleExtra(
    provider: 'gcal' | 'gmail' | 'gdrive',
    extras: ConnectorInstanceRef[],
  ): Promise<boolean> {
    if (extras.length === 0) return false
    if (!assistantConnectorStore) return true
    for (const extra of extras) {
      if (await assistantConnectorStore.isEnabled(
        assistantId,
        connectorInstanceGovernanceId(provider, extra.id),
        provider,
      )) return true
    }
    return false
  }

  /** Wrap a variant tool set with the per-instance health probe (when wired). */
  function probeVariant(built: Tool[], instanceId: string): Tool[] {
    if(!healthReport)return built
    return wrapToolsWithHealthProbe(built,instanceId,healthReport).map((tool,index)=>inheritRoutineCalendarRead(built[index],tool))
  }

  // ── Prevalidate all connected Google connectors in parallel ──
  const gcalRaw = connectors.find((c) => c.connectorId === 'gcal' && c.connected)
  const gmailRaw = connectors.find((c) => c.connectorId === 'gmail' && c.connected)
  const gdriveRaw = connectors.find((c) => c.connectorId === 'gdrive' && c.connected)

  await Promise.all([
    gcalRaw ? prevalidateToken('gcal') : Promise.resolve(false),
    gmailRaw ? prevalidateToken('gmail') : Promise.resolve(false),
    gdriveRaw ? prevalidateToken('gdrive') : Promise.resolve(false),
  ])

  // Google Calendar — Layer 1 (connected + not revoked) + Layer 2 (enabled for this assistant)
  const gcal = gcalRaw && !revokedConnectors.has('gcal') ? gcalRaw : undefined
  const gcalEnabled = gcal && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'gcal'))
  const gcalExtras = googleExtras('gcal')
  const gcalExtraEnabled = await hasEnabledGoogleExtra('gcal', gcalExtras)
  if (revokedConnectors.has('gcal')) {
    unavailable?.push(expiredCredentialsNotice('Google Calendar'))
  } else if ((!gcal || !gcalEnabled) && !gcalExtraEnabled) {
    unavailable?.push(notConnectedNotice('Google Calendar', 'calendar events and availability'))
  }
  if (gcalRaw && (gcalEnabled || gcalExtraEnabled)) {
    try {
      // Read per-user gcal config (e.g. sendUpdates preference)
      const gcalConfig = await connectorStore.getConfig(userId, 'gcal')
      const sendUpdates = (gcalConfig.sendUpdates as 'all' | 'externalOnly' | 'none' | undefined) ?? 'all'

      // Local helper — derive `audience_clearance` from the attendee
      // list per the GCal contract in connector-actions.md:
      //   - all attendees on `workspaceDomain` (or none) → 'internal'
      //   - any external attendee                       → 'public'
      // `workspaceDomain` is the authoritative primary domain — wired
      // from the chat route. When absent, default to 'public' (the
      // safer ceiling).
      function deriveAudienceFromAttendees(attendees?: string[]): 'internal' | 'public' {
        if (!workspaceDomain || !attendees || attendees.length === 0) return 'internal'
        const dom = `@${workspaceDomain.toLowerCase()}`
        const allInternal = attendees.every((a) => a.toLowerCase().endsWith(dom))
        return allInternal ? 'internal' : 'public'
      }

      type GCalEventLike = {
        id?: string | null
        summary?: string | null
        description?: string | null
        location?: string | null
        attendees?: Array<{ email?: string }>
        recurrence?: string[]
        recurringEventId?: string
        originalStartTime?: { dateTime?: string; date?: string }
        reminders?: unknown
        attachments?: unknown[]
        conferenceData?: unknown
        transparency?: string
        visibility?: string
        eventType?: string
        focusTimeProperties?: unknown
        outOfOfficeProperties?: unknown
        workingLocationProperties?: unknown
        eventLabelId?: string
        colorId?: string
        start?: { dateTime?: string; date?: string }
        end?: { dateTime?: string; date?: string }
      }

      async function emitGcalAudit(
        actionKind: 'create_event' | 'update_event' | 'delete_event',
        audienceClearance: 'public' | 'internal',
        payload: Record<string, unknown>,
        status: 'executed' | 'failed' | 'denied',
        externalId: string | null,
      ): Promise<void> {
        if (!connectorActionAudit) return
        try {
          await connectorActionAudit.emit(
            { userId, assistantId },
            {
              connectorId: 'gcal',
              actionKind,
              audienceClearance,
              status,
              externalId,
              payload,
            },
          )
        } catch (auditErr) {
          console.warn(
            `[mcp-inject] gcal connector_action audit emit failed (${actionKind}/${status}, suppressed):`,
            auditErr instanceof Error ? auditErr.message : String(auditErr),
          )
        }
      }

      // Tool set bound to one account's token source — built once for the
      // primary (canonical names) and once per extra account (suffixed
      // variants). Audit metadata + sendUpdates remain provider-level; action
      // grants use each account's exact governance id.
      const buildCalTools = (
        getToken: () => Promise<string>,
        governanceId: string = 'gcal',
      ) => gateToolsOnActionGrants(createGoogleCalendarTools({
        listCalendars: async () => {
          const token = await getToken()
          return listCalendarList(token)
        },
        listEventColors: async (calendarId) => {
          const token = await getToken()
          return listCalendarEventColors(token, calendarId)
        },
        listEvents: async (params) => {
          const token = await getToken()
          return listCalendarEvents(token, params)
        },
        getEvent: async (eventId, calendarId) => {
          const token = await getToken()
          return getCalendarEvent(token, eventId, calendarId)
        },
        queryFreeBusy: async (params) => {
          const token = await getToken()
          return queryCalendarFreeBusy(token, params)
        },
        createEvent: async (event) => {
          const token = await getToken()
          const audience = deriveAudienceFromAttendees(event.attendees?.map((attendee) => attendee.email))
          const auditPayload: Record<string, unknown> = {
            calendar_id: event.calendarId ?? 'primary',
            ...event,
            attendees: event.attendees ?? [],
            recurrence: event.recurrence ?? [],
          }
          try {
            const result = (await createCalendarEvent(token, event, event.calendarId ?? 'primary', sendUpdates)) as GCalEventLike | null
            const eventId = result?.id ?? null
            await emitGcalAudit('create_event', audience, auditPayload, 'executed', eventId)
            return result
          } catch (err) {
            await emitGcalAudit('create_event', audience, {
              ...auditPayload,
              error: err instanceof Error ? err.message : String(err),
            }, 'failed', null)
            throw err
          }
        },
        updateEvent: async (eventId, updates) => {
          const token = await getToken()
          const attendeeEmails = [
            ...(updates.attendees?.map((attendee) => attendee.email) ?? []),
            ...(updates.attendeeChanges?.add?.map((attendee) => attendee.email) ?? []),
          ]
          const audience = deriveAudienceFromAttendees(attendeeEmails)
          const auditPayload: Record<string, unknown> = {
            event_id: eventId,
            calendar_id: updates.calendarId ?? 'primary',
            recurring_scope: updates.recurringScope ?? 'instance',
            updates: { ...updates },
          }
          try {
            const result = await updateCalendarEvent(token, eventId, updates, updates.calendarId ?? 'primary', sendUpdates)
            await emitGcalAudit('update_event', audience, auditPayload, 'executed', result.id ?? eventId)
            return result
          } catch (err) {
            await emitGcalAudit('update_event', audience, {
              ...auditPayload,
              error: err instanceof Error ? err.message : String(err),
            }, 'failed', null)
            throw err
          }
        },
        deleteEvent: async (eventId, calendarId, recurringScope) => {
          const token = await getToken()
          // Snapshot the event BEFORE delete so the audit captures
          // what was removed (delete is the first DESTRUCTIVE
          // connector action — operators need to see what was lost).
          // Best-effort: if the snapshot fetch fails we still proceed
          // with the delete, just without rich payload data.
          let snapshot: GCalEventLike | null = null
          try {
            snapshot = (await getCalendarEvent(token, eventId, calendarId ?? 'primary')) as GCalEventLike
          } catch (snapErr) {
            console.warn('[mcp-inject] gcal delete: snapshot fetch failed:', snapErr instanceof Error ? snapErr.message : String(snapErr))
          }
          const audience = deriveAudienceFromAttendees(
            snapshot?.attendees?.map((a) => a.email ?? '').filter(Boolean),
          )
          const auditPayload: Record<string, unknown> = {
            event_id: eventId,
            calendar_id: calendarId ?? 'primary',
            recurring_scope: recurringScope ?? 'instance',
            prior_snapshot: snapshot
              ? {
                  summary: snapshot.summary,
                  start: snapshot.start,
                  end: snapshot.end,
                  description: snapshot.description,
                  location: snapshot.location,
                  attendees: snapshot.attendees ?? [],
                  recurrence: snapshot.recurrence ?? [],
                  recurring_event_id: snapshot.recurringEventId,
                  original_start_time: snapshot.originalStartTime,
                  reminders: snapshot.reminders,
                  attachments: snapshot.attachments ?? [],
                  conference_data: snapshot.conferenceData,
                  availability: snapshot.transparency,
                  visibility: snapshot.visibility,
                  event_type: snapshot.eventType,
                  focus_time_properties: snapshot.focusTimeProperties,
                  out_of_office_properties: snapshot.outOfOfficeProperties,
                  working_location_properties: snapshot.workingLocationProperties,
                  event_label_id: snapshot.eventLabelId,
                  color_id: snapshot.colorId,
                }
              : null,
          }
          try {
            await deleteCalendarEvent(
              token,
              eventId,
              calendarId ?? 'primary',
              sendUpdates,
              recurringScope ?? 'instance',
            )
            await emitGcalAudit('delete_event', audience, auditPayload, 'executed', eventId)
          } catch (err) {
            await emitGcalAudit('delete_event', audience, {
              ...auditPayload,
              error: err instanceof Error ? err.message : String(err),
            }, 'failed', null)
            throw err
          }
        },
      }, userTimezone), 'gcal', assistantConnectorGrantsStore, assistantId, governanceId)
      if (gcalEnabled) {
        const calTools = buildCalTools(() => getAccessToken('gcal'))
        for (const tool of calTools) {
          if (await applyPolicyOrSkip(tool, 'gcal', settingsStore, assistantId, userId, unavailable) === 'include') {
            tools.set(tool.name, tool)
          }
        }
      }

      // Extra Google Calendar accounts → label-qualified variant sets bound
      // to their own tokens.
      if (gcalExtras.length) {
        await injectInstanceVariants({
          provider: 'gcal',
          extras: gcalExtras,
          settingsStore, assistantId, userId, assistantConnectorStore, tools,
          buildToolsForInstance: (inst, governanceId) => {
            const getToken = () => getAccessTokenForInstance(inst.id)
            instanceTokenBySuffix.set(instanceToolSuffix(inst.id, inst.label), getToken)
            return probeVariant(buildCalTools(getToken, governanceId), inst.id)
          },
        })
      }
      console.debug(`[mcp-inject] Google Calendar: injected tools${gcalExtras.length ? ` (+${gcalExtras.length} extra account(s))` : ''}`)
    } catch (err) {
      console.error('[mcp-inject] Google Calendar injection failed:', err)
    }
  }

  // Gmail — Layer 1 (connected + not revoked) + Layer 2 (enabled for this assistant)
  const gmail = gmailRaw && !revokedConnectors.has('gmail') ? gmailRaw : undefined
  const gmailEnabled = gmail && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'gmail'))
  const gmailExtras = googleExtras('gmail')
  const gmailExtraEnabled = await hasEnabledGoogleExtra('gmail', gmailExtras)
  if (revokedConnectors.has('gmail')) {
    unavailable?.push(expiredCredentialsNotice('Gmail'))
  } else if ((!gmail || !gmailEnabled) && !gmailExtraEnabled) {
    unavailable?.push(notConnectedNotice('Gmail', 'sending and reading email'))
  }
  if (gmailRaw && (gmailEnabled || gmailExtraEnabled)) {
    try {
      // Tool set bound to one account's token source (primary + per-extra
      // variants, same shape as the gcal builder above). Audit + classifier
      // behavior stays provider-level; grants use each account's exact key.
      const buildGmailToolSet = (
        getToken: () => Promise<string>,
        senderEmail?: string | null,
        governanceId: string = 'gmail',
      ) => gateToolsOnActionGrants(createGmailTools({
        listMessages: async (params) => {
          const token = await getToken()
          return listGmailMessages(token, params)
        },
        getMessage: async (messageId) => {
          const token = await getToken()
          return getGmailMessage(token, messageId)
        },
        sendMessage: async (params) => {
          const token = await getToken()
          // Connector-action audit wrap (per `connector-actions.md`). The
          // classifier sees the transient full draft, but email governance is
          // authoritative: reaching this callback means the exact frozen
          // input passed its grant + Allow/Ask/Block policy. Classification is
          // therefore advisory and raw body text is not persisted.
          //
          // v1 `audienceClearance='public'` for all recipients —
          // per-recipient classification (internal vs external) is a
          // future enhancement.
          const auditPayload = {
            to: params.to,
            cc: params.cc ?? [],
            bcc: params.bcc ?? [],
            from: params.from ?? null,
            subject: params.subject,
            has_body: Boolean(params.body),
            body_length: params.body?.length ?? 0,
            // Attachment METADATA only — never bytes. Filenames ride
            // through the payload classifier with the rest.
            attachment_count: params.attachments?.length ?? 0,
            attachments: (params.attachments ?? []).map((a) => ({
              name: a.filename,
              mime: a.mime,
              size_bytes: a.data.byteLength,
            })),
          }

          const classifierPayload = {
            ...auditPayload,
            body: params.body ?? '',
          }

          // Advisory preflight: audit the detection without adding a hidden
          // post-policy veto after the user admitted this exact email.
          let preflight: ConnectorActionPreflight | undefined
          if (connectorActionAudit) {
            preflight = connectorActionAudit.preflight({
              audienceClearance: 'public',
              payload: classifierPayload,
              enforcement: 'advisory',
            })
          }

          try {
            const result = await sendGmailMessage(token, params, { userId:driveEnrichmentContext?.actingUserId ?? userId,workspaceId:driveEnrichmentContext?.workspaceId,
              connectorInstanceId:parseConnectorInstanceGovernanceId(governanceId)?.instanceId ?? gmailRaw.id })
            if (connectorActionAudit) {
              try {
                await connectorActionAudit.emit(
                  { userId, assistantId },
                  {
                    connectorId: 'gmail',
                    actionKind: 'send_email',
                    audienceClearance: 'public',
                    status: 'executed',
                    externalId: result?.id ?? null,
                    payload: auditPayload,
                    preflight,
                  },
                )
              } catch (auditErr) {
                console.warn(
                  '[mcp-inject] gmail connector_action audit emit failed (best-effort, suppressed):',
                  auditErr instanceof Error ? auditErr.message : String(auditErr),
                )
              }
            }
            return result
          } catch (err) {
            if (connectorActionAudit) {
              try {
                await connectorActionAudit.emit(
                  { userId, assistantId },
                  {
                    connectorId: 'gmail',
                    actionKind: 'send_email',
                    audienceClearance: 'public',
                    status: 'failed',
                    payload: {
                      ...auditPayload,
                      error: err instanceof Error ? err.message : String(err),
                    },
                    preflight,
                  },
                )
              } catch (auditErr) {
                console.warn(
                  '[mcp-inject] gmail connector_action audit emit failed (failure path, suppressed):',
                  auditErr instanceof Error ? auditErr.message : String(auditErr),
                )
              }
            }
            throw err
          }
        },
      }, { filesApi, senderEmail: senderEmail ?? undefined }), 'gmail', assistantConnectorGrantsStore,
      assistantId, governanceId)
      if (gmailEnabled) {
        const gmailTools = buildGmailToolSet(
          () => getAccessToken('gmail'),
          gmail.connectedEmail,
        )
        for (const tool of gmailTools) {
          if (await applyPolicyOrSkip(tool, 'gmail', settingsStore, assistantId, userId, unavailable) === 'include') {
            tools.set(tool.name, tool)
          }
        }
      }

      // Extra Gmail accounts → label-qualified variant sets bound to their
      // own tokens.
      if (gmailExtras.length) {
        await injectInstanceVariants({
          provider: 'gmail',
          extras: gmailExtras,
          settingsStore, assistantId, userId, assistantConnectorStore, tools,
          buildToolsForInstance: (inst, governanceId) => {
            const getToken = () => getAccessTokenForInstance(inst.id)
            instanceTokenBySuffix.set(instanceToolSuffix(inst.id, inst.label), getToken)
            return probeVariant(
              buildGmailToolSet(getToken, inst.connectedEmail, governanceId),
              inst.id,
            )
          },
        })
      }
      console.debug(`[mcp-inject] Gmail: injected tools${gmailExtras.length ? ` (+${gmailExtras.length} extra account(s))` : ''}`)
    } catch (err) {
      console.error('[mcp-inject] Gmail injection failed:', err)
    }
  }

  // Google Drive (+ Docs, Sheets, Slides) — Layer 1 (connected + not revoked) + Layer 2 (enabled)
  const gdrive = gdriveRaw && !revokedConnectors.has('gdrive') ? gdriveRaw : undefined
  const gdriveEnabled = gdrive && (!assistantConnectorStore || await assistantConnectorStore.isEnabled(assistantId, 'gdrive'))
  const gdriveExtras = googleExtras('gdrive')
  const gdriveExtraEnabled = await hasEnabledGoogleExtra('gdrive', gdriveExtras)
  if (revokedConnectors.has('gdrive')) {
    unavailable?.push(expiredCredentialsNotice('Google Drive, Docs, Sheets and Slides'))
  } else if ((!gdrive || !gdriveEnabled) && !gdriveExtraEnabled) {
    unavailable?.push(notConnectedNotice('Google Drive, Docs, Sheets and Slides', 'creating or opening docs, slides, spreadsheets, and Excel files'))
  }
  if (gdriveRaw && (gdriveEnabled || gdriveExtraEnabled)) {
    try {
      // Load per-user gdrive config — the authorized-files list is the set of
      // Google Docs/Sheets/Slides the user has explicitly picked via the
      // Google Picker. Writes against any of these files auto-approve because
      // the Picker itself is the consent ceremony. See
      // docs/architecture/integrations/mcp.md → "The `gdrive` connector".
      //
      // Legacy rows may still have `allowedPaths` (the pre-drive.file whitelist)
      // — migrate file-type entries in-place so confirmation still works.
      const gdriveConfig = await connectorStore.getConfig(userId, 'gdrive')
      let gdriveAuthorizedFiles = (gdriveConfig.authorizedFiles as AuthorizedFile[] | undefined) ?? []
      if (!gdriveAuthorizedFiles.length && Array.isArray(gdriveConfig.allowedPaths)) {
        type LegacyPath = { id: string; name: string; type: 'file' | 'folder' }
        const legacy = gdriveConfig.allowedPaths as LegacyPath[]
        gdriveAuthorizedFiles = legacy
          .filter((p) => p && p.type === 'file' && typeof p.id === 'string')
          .map((p) => ({ id: p.id, name: p.name, mimeType: 'application/octet-stream', addedAt: new Date(0).toISOString() }))
      }

      // Records a newly-created Drive file: (1) appends to the in-memory
      // authorizedFiles array so follow-up writes in the same turn skip the
      // confirmation prompt, (2) persists the addition to the gdrive
      // connector config, and (3) inserts into gdrive_files for
      // findGDriveFiles search. Persistence is fire-and-forget — a DB hiccup
      // shouldn't mask a successful Google create.
      const recordCreated = (
        kind: GDriveFileKind,
        externalId: string,
        title: string,
        url: string,
        mimeType: string,
      ): void => {
        const entry: AuthorizedFile = { id: externalId, name: title, mimeType, addedAt: new Date().toISOString() }
        gdriveAuthorizedFiles.push(entry)
        connectorStore
          .setConfig(userId, 'gdrive', { authorizedFiles: gdriveAuthorizedFiles })
          .catch((e) => console.error('[mcp-inject] failed to persist authorizedFiles after create:', e))
        if (gdriveFilesStore) {
          gdriveFilesStore
            .insert({ userId, kind, externalId, title, url })
            .catch((e) => console.error('[mcp-inject] failed to record gdrive_files row:', e))
        }
      }

      // Opportunistic title sync on read. No-op if the store isn't wired.
      const syncOnRead = (externalId: string, title: string): void => {
        if (!gdriveFilesStore) return
        gdriveFilesStore
          .updateOnAccess(userId, externalId, title)
          .catch((e) => console.error('[mcp-inject] updateOnAccess failed:', e))
      }

      type DriveEnrichmentTarget = {
        instanceId?: string
        accessMode?: 'picked_files' | 'full_drive_readonly'
      }
      const primaryDriveTarget: DriveEnrichmentTarget = {
        instanceId: gdrive?.id,
        accessMode: gdrive?.config?.driveAccessMode === 'full_drive_readonly'
          ? 'full_drive_readonly'
          : 'picked_files',
      }

      async function assertDriveReadInScope(
        fileId: string,
        target: DriveEnrichmentTarget,
      ): Promise<void> {
        if (
          target.accessMode !== 'full_drive_readonly'
          || !target.instanceId
          || !driveEnrichmentContext
        ) return
        const policy = await getGDriveCatalogReadPolicy({
          workspaceId: driveEnrichmentContext.workspaceId,
          connectorInstanceId: target.instanceId,
          externalFileId: fileId,
        })
        if (!policy.allowed) {
          throw new Error('This file is outside the Google Drive folders selected for this Brian workspace')
        }
      }

      async function listScopedDriveFiles(
        token: string,
        params: { query?: string; maxResults?: number; folderId?: string },
        target: DriveEnrichmentTarget,
      ) {
        if (
          target.accessMode !== 'full_drive_readonly'
          || !target.instanceId
          || !driveEnrichmentContext
        ) return listDriveFiles(token, params)
        const runtime = await getGDriveCatalogRuntimeScope({
          workspaceId: driveEnrichmentContext.workspaceId,
          connectorInstanceId: target.instanceId,
        })
        if (runtime.syncScope !== 'selected_folders') return listDriveFiles(token, params)
        if (params.folderId) await assertDriveReadInScope(params.folderId, target)
        const rows = await listGDriveCatalogFiles({
          workspaceId: driveEnrichmentContext.workspaceId,
          connectorInstanceId: target.instanceId,
          query: params.query,
          folderId: params.folderId,
          limit: params.maxResults,
        })
        return rows.map((entry) => ({
          id: entry.externalFileId,
          name: entry.name,
          mimeType: entry.mimeType,
          version: entry.sourceVersion,
          ...(entry.modifiedTime ? { modifiedTime: entry.modifiedTime } : {}),
          ...(entry.sizeBytes !== null ? { size: String(entry.sizeBytes) } : {}),
          ...(entry.webViewLink ? { webViewLink: entry.webViewLink } : {}),
          parents: entry.parentIds,
        }))
      }

      async function enqueueDriveRead(
        file: Awaited<ReturnType<typeof getDriveFile>>,
        target: DriveEnrichmentTarget,
      ): Promise<void> {
        if (
          target.accessMode !== 'full_drive_readonly'
          || !target.instanceId
          || !driveEnrichmentContext
        ) return
        const sourceVersion = file.version?.trim() || file.modifiedTime?.trim()
        if (!sourceVersion) {
          console.warn(`[mcp-inject] Drive enrichment skipped for ${file.id}: no stable version`)
          return
        }
        try {
          await enqueueGDriveLazyEnrichment({
            workspaceId: driveEnrichmentContext.workspaceId,
            connectorInstanceId: target.instanceId,
            actingUserId: driveEnrichmentContext.actingUserId,
            assistantId,
            externalFileId: file.id,
            sourceVersion,
            fileName: file.name,
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime,
            webViewLink: file.webViewLink,
          })
        } catch (err) {
          // A knowledge derivative must never mask a successful live Drive
          // read. The next read retries the idempotent enqueue.
          console.error('[mcp-inject] failed to enqueue Drive enrichment:', err)
        }
      }

      async function enqueueDriveReadById(
        token: string,
        fileId: string,
        target: DriveEnrichmentTarget,
      ): Promise<void> {
        if (target.accessMode !== 'full_drive_readonly') return
        try {
          await enqueueDriveRead(await getDriveFile(token, fileId), target)
        } catch (err) {
          console.error('[mcp-inject] failed to resolve Drive version for enrichment:', err)
        }
      }

      // Per-account tool-set builders — instantiated for the primary below
      // and re-bound per extra account in the variants block after the four
      // families. `gdriveAuthorizedFiles`, `recordCreated`, and `syncOnRead`
      // are per-USER state (Picker consent + created-file index),
      // intentionally shared across accounts.
      const buildDriveTools = (
        getToken: () => Promise<string>,
        governanceId: string = 'gdrive',
        enrichmentTarget: DriveEnrichmentTarget = primaryDriveTarget,
      ) => gateToolsOnActionGrants(createGoogleDriveTools({
        listFiles: async (params) => {
          const token = await getToken()
          return listScopedDriveFiles(token, params, enrichmentTarget)
        },
        getFile: async (fileId) => {
          const token = await getToken()
          await assertDriveReadInScope(fileId, enrichmentTarget)
          return getDriveFile(token, fileId)
        },
        getFileContent: async (fileId, exportMimeType) => {
          const token = await getToken()
          await assertDriveReadInScope(fileId, enrichmentTarget)
          const fetched = await getDriveFileContentWithMetadata(token, fileId, exportMimeType)
          await enqueueDriveRead(fetched.file, enrichmentTarget)
          return fetched.content
        },
        createFile: async (params) => {
          const token = await getToken()
          return createDriveFile(token, params)
        },
        updateFile: async (fileId, params) => {
          const token = await getToken()
          return updateDriveFileContent(token, fileId, params)
        },
      }, gdriveAuthorizedFiles), 'gdrive', assistantConnectorGrantsStore, assistantId, governanceId)
      if (gdriveEnabled) {
        const driveTools = buildDriveTools(() => getAccessToken('gdrive'))
        for (const tool of driveTools) {
          if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
            tools.set(tool.name, tool)
          }
        }
      }

      // Docs tools
      const buildDocsTools = (
        getToken: () => Promise<string>,
        governanceId: string = 'gdrive',
        enrichmentTarget: DriveEnrichmentTarget = primaryDriveTarget,
      ) => gateToolsOnActionGrants(createGoogleDocsTools({
        getContent: async (documentId) => {
          const token = await getToken()
          await assertDriveReadInScope(documentId, enrichmentTarget)
          const doc = await getDocContent(token, documentId)
          syncOnRead(documentId, doc.title)
          await enqueueDriveReadById(token, documentId, enrichmentTarget)
          return doc
        },
        appendText: async (documentId, text) => {
          const token = await getToken()
          return appendToDoc(token, documentId, text)
        },
        replaceText: async (documentId, findText, replaceText) => {
          const token = await getToken()
          return replaceInDoc(token, documentId, findText, replaceText)
        },
        create: async (title) => {
          const token = await getToken()
          const doc = await createDocument(token, title)
          recordCreated('doc', doc.documentId, doc.title, doc.url, 'application/vnd.google-apps.document')
          return doc
        },
      }, gdriveAuthorizedFiles), 'gdrive', assistantConnectorGrantsStore, assistantId, governanceId)
      if (gdriveEnabled) {
        const docsTools = buildDocsTools(() => getAccessToken('gdrive'))
        for (const tool of docsTools) {
          if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
            tools.set(tool.name, tool)
          }
        }
      }

      // Sheets tools
      const buildSheetsTools = (
        getToken: () => Promise<string>,
        governanceId: string = 'gdrive',
        enrichmentTarget: DriveEnrichmentTarget = primaryDriveTarget,
      ) => gateToolsOnActionGrants(createGoogleSheetsTools({
        getSpreadsheetInfo: async (spreadsheetId) => {
          const token = await getToken()
          await assertDriveReadInScope(spreadsheetId, enrichmentTarget)
          const info = await getSpreadsheetInfo(token, spreadsheetId)
          syncOnRead(spreadsheetId, info.title)
          return info
        },
        readRange: async (spreadsheetId, range) => {
          const token = await getToken()
          await assertDriveReadInScope(spreadsheetId, enrichmentTarget)
          const values = await readSheetRange(token, spreadsheetId, range)
          await enqueueDriveReadById(token, spreadsheetId, enrichmentTarget)
          return values
        },
        writeRange: async (spreadsheetId, range, values) => {
          const token = await getToken()
          return writeSheetRange(token, spreadsheetId, range, values)
        },
        appendRows: async (spreadsheetId, range, values) => {
          const token = await getToken()
          return appendSheetRows(token, spreadsheetId, range, values)
        },
        create: async (title) => {
          const token = await getToken()
          const sheet = await createSpreadsheet(token, title)
          recordCreated('sheet', sheet.spreadsheetId, sheet.title, sheet.url, 'application/vnd.google-apps.spreadsheet')
          return sheet
        },
        format: async (spreadsheetId, opts) => {
          const token = await getToken()
          return formatSpreadsheet(token, spreadsheetId, opts)
        },
        batchUpdate: async (spreadsheetId, requests) => {
          const token = await getToken()
          return batchUpdateSpreadsheet(token, spreadsheetId, requests)
        },
      }, gdriveAuthorizedFiles), 'gdrive', assistantConnectorGrantsStore, assistantId, governanceId)
      if (gdriveEnabled) {
        const sheetsTools = buildSheetsTools(() => getAccessToken('gdrive'))
        for (const tool of sheetsTools) {
          if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
            tools.set(tool.name, tool)
          }
        }
      }

      // Slides tools — structured read + placeholder-targeted, atomic write.
      // See docs/architecture/integrations/google-slides.md.
      const buildSlidesTools = (
        getToken: () => Promise<string>,
        governanceId: string = 'gdrive',
        enrichmentTarget: DriveEnrichmentTarget = primaryDriveTarget,
      ) => gateToolsOnActionGrants(createGoogleSlidesTools({
        getPresentationInfo: async (presentationId) => {
          const token = await getToken()
          await assertDriveReadInScope(presentationId, enrichmentTarget)
          const info = await getPresentationInfo(token, presentationId)
          syncOnRead(presentationId, info.title)
          await enqueueDriveReadById(token, presentationId, enrichmentTarget)
          return info
        },
        getSlideContent: async (presentationId, slideIndex) => {
          const token = await getToken()
          await assertDriveReadInScope(presentationId, enrichmentTarget)
          const content = await getSlideContent(token, presentationId, slideIndex)
          await enqueueDriveReadById(token, presentationId, enrichmentTarget)
          return content
        },
        getSlideThumbnail: async (presentationId, slideObjectId, options) => {
          const token = await getToken()
          await assertDriveReadInScope(presentationId, enrichmentTarget)
          const thumbnail = await getSlideThumbnail(token, presentationId, slideObjectId, options)
          await enqueueDriveReadById(token, presentationId, enrichmentTarget)
          return thumbnail
        },
        createSlide: async (presentationId, args) => {
          const token = await getToken()
          return slidesCreateSlide(token, presentationId, args)
        },
        updateSlideContent: async (presentationId, args) => {
          const token = await getToken()
          return slidesUpdateSlideContent(token, presentationId, args)
        },
        insertImage: async (presentationId, args) => {
          const token = await getToken()
          return slidesInsertImage(token, presentationId, args)
        },
        deleteSlide: async (presentationId, slideObjectId) => {
          const token = await getToken()
          return slidesDeleteSlide(token, presentationId, slideObjectId)
        },
        reorderSlides: async (presentationId, slideObjectIds, insertionIndex) => {
          const token = await getToken()
          return slidesReorderSlides(token, presentationId, slideObjectIds, insertionIndex)
        },
        duplicateSlide: async (presentationId, slideObjectId, insertionIndex) => {
          const token = await getToken()
          return slidesDuplicateSlide(token, presentationId, slideObjectId, insertionIndex)
        },
        batchUpdate: async (presentationId, requests) => {
          const token = await getToken()
          return batchUpdateSlides(token, presentationId, requests)
        },
        createPresentation: async (title) => {
          const token = await getToken()
          const pres = await createPresentation(token, title)
          recordCreated('slide', pres.presentationId, pres.title, pres.url, 'application/vnd.google-apps.presentation')
          return pres
        },
      }, gdriveAuthorizedFiles), 'gdrive', assistantConnectorGrantsStore, assistantId, governanceId)
      if (gdriveEnabled) {
        const slidesTools = buildSlidesTools(() => getAccessToken('gdrive'))
        for (const tool of slidesTools) {
          if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
            tools.set(tool.name, tool)
          }
        }
      }

      // Extra Drive accounts → label-qualified variants of all four families,
      // each bound to its own token. `findGDriveFiles` is deliberately NOT
      // variant-injected: it reads the per-user created-file index, not the
      // Drive API — one copy serves every account.
      if (gdriveExtras.length) {
        await injectInstanceVariants({
          provider: 'gdrive',
          extras: gdriveExtras,
          settingsStore, assistantId, userId, assistantConnectorStore, tools,
          buildToolsForInstance: (inst, governanceId) => {
            const getToken = () => getAccessTokenForInstance(inst.id)
            instanceTokenBySuffix.set(instanceToolSuffix(inst.id, inst.label), getToken)
            const target = { instanceId: inst.id, accessMode: inst.driveAccessMode }
            return probeVariant([
              ...buildDriveTools(getToken, governanceId, target),
              ...buildDocsTools(getToken, governanceId, target),
              ...buildSheetsTools(getToken, governanceId, target),
              ...buildSlidesTools(getToken, governanceId, target),
            ], inst.id)
          },
        })
      }

      // findGDriveFiles — local index of files this assistant has created.
      // Only inject when a store is wired (unit tests without DB skip this).
      if (gdriveFilesStore) {
        const findTools = createGDriveFilesTools(gdriveFilesStore, userId)
        for (const tool of findTools) {
          if (await applyPolicyOrSkip(tool, 'gdrive', settingsStore, assistantId, userId, unavailable) === 'include') {
            tools.set(tool.name, tool)
          }
        }
      }

      console.debug(`[mcp-inject] Google Drive (Drive/Docs/Sheets/Slides): injected tools${gdriveExtras.length ? ` (+${gdriveExtras.length} extra account(s))` : ''}`)
    } catch (err) {
      console.error('[mcp-inject] Google Drive injection failed:', err)
    }
  }

  // Build a confirmation enricher that fetches real data for calendar tools.
  // This prevents AI hallucination and shows human-readable details in the
  // Approve/Deny prompt instead of opaque IDs.
  const gcalConnected = gcal && gcalEnabled
  const enricher: ConfirmationEnricher = async (toolName, input) => {
    if (!gcalConnected) return input

    // Multi-account: a suffixed variant name enriches with ITS OWN account's
    // token; canonical names use the primary's. An unrecognized suffix (a
    // non-Google variant, or a stale name) leaves the input unenriched.
    const canonicalName = baseToolName(toolName)
    const suffix = toolName.slice(canonicalName.length)
    const getEnrichToken = suffix ? instanceTokenBySuffix.get(suffix) : () => getAccessToken('gcal')

    // ── Google Calendar: fetch event summary/attendees ──
    if (canonicalName !== 'googleCalendarUpdateEvent' && canonicalName !== 'googleCalendarDeleteEvent') return input

    const eventId = input.eventId as string | undefined
    if (!eventId || !getEnrichToken) return input

    try {
      const token = await getEnrichToken()
      const calendarId = (input.calendarId as string | undefined) ?? 'primary'
      const event = await getCalendarEvent(token, eventId, calendarId)
      const summary = (event as Record<string, unknown>).summary as string | undefined
      const start = (event as Record<string, unknown>).start as { dateTime?: string; date?: string } | undefined
      const end = (event as Record<string, unknown>).end as { dateTime?: string; date?: string } | undefined
      const attendees = ((event as Record<string, unknown>).attendees as Array<{ email: string }> | undefined)
        ?.map(a => a.email)

      if (canonicalName === 'googleCalendarUpdateEvent') {
        return {
          ...input,
          currentSummary: summary ?? input.currentSummary,
          currentStart: start?.dateTime ?? start?.date ?? input.currentStart,
          currentEnd: end?.dateTime ?? end?.date ?? input.currentEnd,
          currentAttendees: attendees ?? input.currentAttendees,
        }
      }
      // googleCalendarDeleteEvent
      return {
        ...input,
        summary: summary ?? input.summary,
        startTime: start?.dateTime ?? start?.date ?? input.startTime,
        endTime: end?.dateTime ?? end?.date ?? input.endTime,
        attendees: attendees ?? input.attendees,
      }
    } catch (err) {
      console.warn('[mcp-inject] Failed to enrich confirmation with real event data:', err)
      return input
    }
  }

  return enricher
}

// ── Provider module ───────────────────────────────────────────

/**
 * One Google lane over every Google service it carries (gcal, gmail, gdrive
 * and the Docs/Sheets/Slides tools that ride on gdrive). Workspace-owned
 * lanes override credentials per connector; extras become instance variants.
 */
export type GoogleLane = BuiltinLane<{
  id?: string
  connectorId: string
  connected: boolean
  name?: string
  connectedEmail?: string | null
  url?: string | null
  config?: Record<string, unknown>
}> & {
  credsOverridePerConnector?: Partial<Record<string, () => Promise<string | null>>>
  extrasByProvider?: Map<string, ConnectorInstanceRef[]>
  resolveInstanceCreds?: (instanceId: string) => Promise<string | null>
  healthReport?: HealthReporter
  driveEnrichmentContext?: { workspaceId: string; actingUserId: string }
}

/** Google is the one family whose lane also yields a confirmation enricher (calendar previews). */
export async function activateGoogleLane(
  ctx: ProviderActivationContext,
  lane: GoogleLane,
): Promise<{ tools: Tool[]; enrichConfirmation: ConfirmationEnricher }> {
  const tools = new Map<string, Tool>()
  const enrichConfirmation = await collectGoogleTools(
    lane.connectors, ctx.stores.connectorStore, lane.settingsStore, lane.userId, ctx.assistantId,
    ctx.stores.assistantConnectorStore, tools, ctx.userTimezone, laneUnavailable(ctx, lane),
    ctx.stores.gdriveFilesStore, lane.credsOverridePerConnector, ctx.hosted.connectorActionAudit,
    ctx.stores.assistantConnectorGrantsStore, ctx.workspaceDomain, ctx.attachments.filesApi,
    lane.extrasByProvider, lane.resolveInstanceCreds, lane.healthReport, lane.driveEnrichmentContext,
  )
  return { tools: [...tools.values()], enrichConfirmation }
}

export const googleProvider: ProviderModule<readonly GoogleLane[]> = {
  family: 'google',
  describe: memoDescribe(() => describeFactoryTools('google', {
    gcal: () => createGoogleCalendarTools(inertPort('gcal'), 'UTC'),
    gmail: () => createGmailTools(inertPort('gmail'), { filesApi: inertPort('gmail files') }),
    gdrive: () => [
      ...createGoogleDriveTools(inertPort('gdrive')),
      ...createGoogleDocsTools(inertPort('google docs')),
      ...createGoogleSheetsTools(inertPort('google sheets')),
      ...createGoogleSlidesTools(inertPort('google slides')),
      ...createGDriveFilesTools(inertPort('gdrive files'), 'descriptor'),
    ],
  })),
  activate: (ctx, lanes) => runLanes(lanes, async (lane) => {
    const activated = await activateGoogleLane(ctx, lane)
    ctx.confirmationEnrichers?.push(activated.enrichConfirmation)
    return activated.tools
  }),
}
