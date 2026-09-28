import { describe, expect, it, vi } from 'vitest'
import { WorkspaceModuleError } from '@use-brian/shared'
import { createAssociationTools } from '../tools.js'
import { SiteContentCollectionSchema } from '../site-content.js'
import type { AssociationServicePort } from '../operations.js'
import type { Tool, ToolContext } from '../../tools/types.js'
import { filterToolsByCapabilities } from '../../tools/capability-gate.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const capabilities = ['association', 'home_app:association:read', 'home_app:association:write', 'crm', 'home_app:crm:read', 'home_app:crm:write']
const context = (patch: Partial<ToolContext> = {}): ToolContext => ({
  workspaceId: id(1), userId: id(2), assistantId: id(3), sessionId: id(4), appId: id(3),
  channelType: 'web', channelId: 'fictional-channel', abortSignal: new AbortController().signal,
  activeCapabilities: new Set(capabilities), ...patch,
})
const order = { contactId: id(5), idempotencyKey: 'fictional-order-one', lines: [
  { ticketId: id(6), quantity: 1, attendees: [{ contactId: id(5), name: 'Example Attendee' }] },
] }
function fixture() {
  const execute = vi.fn<AssociationServicePort['execute']>(async (_context, command) => ({
    command: command.kind, items: [{ id: id(7) }], nextCursor: 'opaque-continuation',
  }))
  const tools = createAssociationTools({ execute })
  return { tools, execute, map: new Map<string, Tool>(Object.values(tools).map(tool => [tool.name, tool])) }
}

describe('[COMP:crm/association-tools] canonical native Association adapters', () => {
  it('publishes bounded object schemas without module or provider mutation tools', () => {
    const { tools } = fixture()
    expect(Object.keys(tools)).toHaveLength(29)
    for (const tool of Object.values(tools)) expect('shape' in tool.inputSchema).toBe(true)
    expect(Object.keys(tools).filter(name => /enable|disable|reconcile|bind.*provider|mark.*paid/i.test(name))).toEqual([])
    expect(tools.confirmFreeAssociationOrder.requiresConfirmation).toBe(true)
    expect(tools.listAssociationOrders.inputSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(tools.getAssociationModuleStatus.inputSchema.safeParse({ action: 'enable' }).success).toBe(false)
  })
  it('keeps discovery and direct execution closed without the app and both relevant sets', async () => {
    const { tools, execute, map } = fixture()
    expect(filterToolsByCapabilities(map, new Set()).size).toBe(0)
    expect([...filterToolsByCapabilities(map, new Set(['association', 'home_app:association:read'])).keys()])
      .toEqual(['getAssociationModuleStatus', 'listAssociationTickets'])
    for (const missing of ['association', 'home_app:association:write', 'crm', 'home_app:crm:write']) {
      const activeCapabilities = new Set(capabilities.filter(cap => cap !== missing))
      expect(filterToolsByCapabilities(map, activeCapabilities).has('createAssociationOrder')).toBe(false)
      expect(await tools.createAssociationOrder.execute({ order } as never, context({ activeCapabilities })))
        .toMatchObject({ isError: true, data: { error: 'not_authorized', requiredCapability: missing } })
    }
    expect(execute).not.toHaveBeenCalled()
  })
  it.each(['web', 'workflow', 'assistant-call', 'programmatic'])('retains the assistant actor on %s and canonical replay input', async channelType => {
    const { tools, execute } = fixture()
    await tools.createAssociationOrder.execute({ order } as never, context({ channelType }))
    const [ctx, command] = execute.mock.calls[0]!
    expect(ctx).toMatchObject({ workspaceId: id(1), actor: { kind: 'assistant', assistantId: id(3), userId: id(2), sessionId: id(4) },
      authority: { role: 'member', canWrite: true, canRead: false, canConfigure: false, canReconcileProvider: false } })
    expect(command).toMatchObject({ kind: 'create_order', order: { ...order, reservationMinutes: 20, metadata: {} } })
  })
  it.each(['brain_key', 'oauth_token', 'home_app'] as const)('retains the authenticated %s principal', async kind => {
    const { tools, execute } = fixture()
    await tools.getAssociationModuleStatus.execute({}, context({ programmaticPrincipal: { kind, credentialId: id(8), userId: id(2) } }))
    expect(execute.mock.calls[0]![0].actor).toMatchObject({ kind, credentialId: id(8) })
    expect(execute.mock.calls[0]![0].authority).toMatchObject({ canWrite: false, canRead: true, canConfigure: false, canReconcileProvider: false })
  })
  it('passes continuation unchanged and leaves disabled history to the service', async () => {
    const { tools, execute } = fixture()
    const result = await tools.listAssociationOrders.execute({ cursor: 'prior-page', eventId: id(9), limit: 20 }, context())
    expect(execute.mock.calls[0]![1]).toEqual({ kind: 'list_orders', eventId: id(9), cursor: 'prior-page', limit: 20 })
    expect(result).toMatchObject({ data: { nextCursor: 'opaque-continuation' } })
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('keeps waitlist promotion identity and registration updates on canonical commands', async () => {
    const { tools, execute } = fixture()
    await tools.offerAssociationWaitlistPlace.execute({ offer: { submissionId: id(10), promotionId: id(11) } } as never, context())
    expect(execute.mock.calls[0]![1]).toEqual({ kind: 'offer_waitlist_place', offer: {
      submissionId: id(10), promotionId: id(11), reservationMinutes: 20, useMemberPrice: false,
    } })
    await tools.updateAssociationRegistration.execute({ registrationId: id(12), update: { status: 'checked_in' } }, context())
    expect(execute.mock.calls[1]![1]).toEqual({ kind: 'update_registration', registrationId: id(12), update: { status: 'checked_in' } })
  })
  it('preserves typed shutdown conflicts and withholds unexpected backend details', async () => {
    const { tools, execute } = fixture()
    execute.mockRejectedValueOnce(new WorkspaceModuleError('module_draining', 'Reservations are paused.', { state: 'draining', version: 2 }))
    expect(await tools.createAssociationOrder.execute({ order } as never, context()))
      .toMatchObject({ isError: true, data: { error: 'module_draining', details: { state: 'draining', version: 2 } } })
    execute.mockRejectedValueOnce(new Error('PRIVATE DATABASE ROW'))
    expect(JSON.stringify(await tools.getAssociationModuleStatus.execute({}, context()))).not.toContain('PRIVATE DATABASE ROW')
  })
  it('rejects missing workspace and malformed direct calls before any service effect', async () => {
    const { tools, execute } = fixture()
    expect(await tools.getAssociationModuleStatus.execute({}, context({ workspaceId: undefined }))).toMatchObject({ isError: true })
    expect(await tools.createAssociationOrder.execute({ order: { ...order, lines: [{ ...order.lines[0], quantity: 2 }] } } as never, context()))
      .toMatchObject({ isError: true, data: { error: 'invalid_input' } })
    expect(execute).not.toHaveBeenCalled()
  })

})

describe('[COMP:crm/site-content] website content tools', () => {
  const configure = new Set([...capabilities, 'configure'])
  const draft = { collection: 'event-pages', version: 4, readers: ['north', 'south'], issues: [],
    published: { schemaVersion: 1, pages: [{ event: 'space-night', sections: [] }] },
    document: { schemaVersion: 1, pages: [{ event: 'space-night', summary: { en: 'Non\\u{2011}stop' }, sections: [] }] } }
  function content() {
    const execute = vi.fn<AssociationServicePort['execute']>(async (_context, command) => ({ command: command.kind, record: command.kind === 'site_content_draft' ? structuredClone(draft) : { version: 5, changed: [] } }))
    return { tools: createAssociationTools({ execute }), execute }
  }
  it('stay hidden without the configure grant and never confirm draft edits', () => {
    const { tools } = content()
    const map = new Map<string, Tool>(Object.values(tools).map(tool => [tool.name, tool]))
    for (const name of ['getWebsiteStatus', 'updateWebsiteContent', 'updateEventPage', 'listWebsiteMedia', 'addWebsiteMediaFromAttachment', 'getWebsitePreviewLink']) {
      expect(filterToolsByCapabilities(map, new Set(capabilities)).has(name)).toBe(false)
      expect(filterToolsByCapabilities(map, configure).has(name)).toBe(true)
    }
    expect(tools.updateWebsiteContent.requiresConfirmation).toBe(false)
    expect(tools.publishWebsiteContent.requiresConfirmation).toBe(true)
    expect(tools.publishMembershipCatalogue.requiresConfirmation).toBe(true)
    // Descriptions name no site: the site keys come from the home page collection names.
    const siteKeys = SiteContentCollectionSchema.options.filter(name => name.startsWith('home-')).map(name => name.slice(5))
    for (const site of siteKeys) expect(JSON.stringify(Object.values(tools).map(tool => tool.description))).not.toMatch(new RegExp(`\\b${site}\\b`, 'i'))
  })
  it('reads one entry with real characters and writes escapes back', async () => {
    const { tools, execute } = content()
    const read = await tools.previewWebsiteContent.execute({ collection: 'event-pages', path: 'pages/space-night/summary' }, context({ activeCapabilities: configure }))
    expect(read.data).toMatchObject({ version: 4, value: { en: 'Non\u2011stop' }, publishedValue: null })
    await tools.updateWebsiteContent.execute({ collection: 'event-pages', expectedVersion: 4, operations: [{ op: 'set', path: 'pages/space-night/summary', value: { en: 'Non\u2011stop again' } }] }, context({ activeCapabilities: configure }))
    expect(execute.mock.calls[1]![0].authority).toMatchObject({ canConfigure: true })
    expect(execute.mock.calls[1]![1]).toEqual({ kind: 'update_site_content', collection: 'event-pages', expectedVersion: 4,
      operations: [{ op: 'set', path: 'pages/space-night/summary', value: { en: 'Non\\u{2011}stop again' } }] })
  })
  it('turns an event page edit into item operations against the current draft', async () => {
    const { tools, execute } = content()
    await tools.updateEventPage.execute({ eventSlug: 'space-night', expectedVersion: 4, sections: [{ op: 'add', section: { id: 'faq', kind: 'faq', items: [] } }] } as never, context({ activeCapabilities: configure }))
    expect(execute.mock.calls[1]![1]).toMatchObject({ kind: 'update_site_content', expectedVersion: 4, operations: [{ op: 'insert', path: 'pages/space-night/sections', index: 0 }] })
    expect(await tools.updateEventPage.execute({ eventSlug: 'space-night', expectedVersion: 3, summary: { en: 'x' } } as never, context({ activeCapabilities: configure })))
      .toMatchObject({ isError: true, data: { error: 'conflict' } })
  })
  it('shows the person what publishing changes before they confirm', async () => {
    const { tools } = content()
    expect(await tools.publishWebsiteContent.describeConfirmation!({ collection: 'event-pages', expectedVersion: 4 }, context({ activeCapabilities: configure })))
      .toEqual(['Publish event-pages (draft version 4) to NORTH, SOUTH:', 'changed pages/space-night'])
    expect(await tools.getWebsitePreviewLink.execute({ collection: 'event-pages', eventSlug: 'space-night' }, context({ activeCapabilities: configure })))
      .toMatchObject({ data: { consolePath: `/w/${id(1)}/association?section=events&eventSlug=space-night` } })
  })
})
