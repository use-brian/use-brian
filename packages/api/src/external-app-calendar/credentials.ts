/** Server-owned connector authority and rotating delegated OAuth. */
import { z } from 'zod'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { UsableConnector } from '../connectors/usable-connectors.js'
import { createMsGraphTokenManager, packMsGraphTokens, unpackMsGraphTokens, unpackMsGraphAppCredentials } from '../msgraph/token.js'
import { CalendarError, createOutlookCalendarClient, type CalendarContext } from './client.js'

export type CalendarMemberContext = Omit<CalendarContext, 'calendarId'>
export const CalendarConfiguration = z.object({ enabled: z.literal(true), calendarId: z.string().min(1).max(1024).refine(value => !/[\r\n\x00]/.test(value)) }).strict()
export function createCalendarCredentials(deps: {
  workspaceStore: Pick<WorkspaceStore, 'getRole'>
  instances: Pick<ConnectorInstanceStore, 'getAuthCredentialsSystem' | 'updateCredentialsSystem' | 'setConfig'>
  listUsable(userId: string, workspaceId: string): Promise<UsableConnector[]>
  fetchImpl?: typeof fetch
}) {
  async function owned(context: CalendarMemberContext) {
    if (!await deps.workspaceStore.getRole(context.userId, context.workspaceId)) throw new CalendarError('calendar_membership_required', 403)
    const usable = (await deps.listUsable(context.userId, context.workspaceId)).find(row => row.instance.id === context.connectorInstanceId)
    const instance = usable?.instance
    if (!instance || usable?.source !== 'personal' || instance.scope !== 'user' || instance.userId !== context.userId || instance.provider !== 'msgraph' || !instance.connected) throw new CalendarError('calendar_connector_forbidden', 403)
    return instance
  }
  // Serializes refresh + mutations for this adapter's instance within one process.
  // No permanent credential cache. Other product consumers/processes are separate.
  const active = new Map<string, Promise<void>>()
  const withCalendar = async <T>(context: CalendarMemberContext, operation: (client: ReturnType<ReturnType<typeof createOutlookCalendarClient>>) => Promise<T>): Promise<T> => {
    const previous = active.get(context.connectorInstanceId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    active.set(context.connectorInstanceId, tail)
    await previous
    try {
      async function authorized() {
        const instance = await owned(context)
        if (instance.healthStatus === 'auth_failed') throw new CalendarError('calendar_oauth_reconnect_required', 401)
        const config = CalendarConfiguration.safeParse(instance.config.externalAppCalendar)
        if (!config.success) throw new CalendarError('calendar_oauth_configuration_missing')
        return config.data
      }
      const config = await authorized()
      async function readBlob() {
        const current = await authorized()
        if (current.calendarId !== config.calendarId) throw new CalendarError('calendar_configuration_changed', 409)
        const credentials = await deps.instances.getAuthCredentialsSystem(context.connectorInstanceId)
        if (!credentials || !('client_secret' in credentials) || !credentials.client_secret) throw new CalendarError('calendar_oauth_configuration_missing')
        return credentials.client_secret
      }
      const blob = await readBlob(), app = unpackMsGraphAppCredentials(blob)
      if (!app || !unpackMsGraphTokens(blob)) throw new CalendarError('calendar_oauth_configuration_missing')
      const manager = createMsGraphTokenManager({ ...app, fetchImpl: (url, init) => (deps.fetchImpl ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }),
        store: {
          getTokens: async () => unpackMsGraphTokens(await readBlob()),
          persistTokens: async tokens => {
            await authorized()
            await deps.instances.updateCredentialsSystem(context.connectorInstanceId, { client_id: 'msgraph_oauth', client_secret: packMsGraphTokens(tokens) })
          },
        },
      })
      return await operation(createOutlookCalendarClient({ getAccessToken: () => manager.getAccessToken(), fetchImpl: deps.fetchImpl })({ ...context, calendarId: config.calendarId }))
    } finally {
      release()
      if (active.get(context.connectorInstanceId) === tail) active.delete(context.connectorInstanceId)
    }
  }
  return Object.assign(withCalendar, {
    async configure(context: CalendarMemberContext, raw: unknown) {
      const config = CalendarConfiguration.parse(raw)
      await owned(context)
      await deps.instances.setConfig(context.userId, context.connectorInstanceId, { externalAppCalendar: config })
      return { configured: true as const, calendarId: config.calendarId }
    },
  })
}
