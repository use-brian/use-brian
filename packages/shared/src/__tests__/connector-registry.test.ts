import { describe, it, expect } from 'vitest'
import { OFFICIAL_CONNECTORS, ConnectorEntrySchema } from '../connector-registry.js'
import { OFFICIAL_CONNECTOR_TOOLS, OFFICIAL_OAUTH_SCOPES } from '../builtin-connectors.js'
import { TOOL_DISPLAY_NAMES } from '../tool-display-names.js'

/**
 * The v1 Microsoft Graph tool set, in the order `createMsGraphTools` returns
 * it (`packages/core/src/tools/base/msgraph.ts`). Spelled out rather than
 * imported: `shared` is the client-safe surface and must not depend on core.
 */
const MSGRAPH_TOOLS = [
  'msTeamsListTeams',
  'msTeamsListChannels',
  'msTeamsReadChannelMessages',
  'msTeamsReadThreadReplies',
  'msTeamsListChats',
  'msTeamsReadChatMessages',
  'msTeamsSearchMessages',
  'msTeamsListMembers',
  'msTeamsFindPerson',
]

describe('[COMP:shared/connector-registry] Official connector registry', () => {
  it('registers Office as a first-party governed primitive', () => {
    expect(OFFICIAL_CONNECTORS.find((connector) => connector.id === 'office')).toMatchObject({
      auth_type: 'none',
      oauth_required: false,
    })
    expect(OFFICIAL_CONNECTOR_TOOLS.office?.map((tool) => tool.name)).toEqual([
      'createOfficeArtifact',
      'getOfficeArtifact',
      'reviseOfficeArtifact',
    ])
  })

  describe('Microsoft Teams (msgraph)', () => {
    const msgraph = OFFICIAL_CONNECTORS.find((c) => c.id === 'msgraph')

    it('is registered as an official OAuth connector', () => {
      expect(msgraph).toBeDefined()
      expect(ConnectorEntrySchema.parse(msgraph)).toMatchObject({
        id: 'msgraph',
        name: 'Microsoft Teams',
        category: 'official',
        auth_type: 'oauth',
        oauth_required: true,
        enabled: true,
        // One Microsoft identity per user — a v1 boundary (the imap D11
        // call), not a structural one: the shipped flow authorizes against
        // `organizations`, which narrows the picker to work/school accounts
        // but not to a single tenant, so a second work account stays possible
        // in principle. The flag is what keeps msgraph out of
        // MULTI_INSTANCE_RUNTIME_PROVIDERS, so the injector needs no
        // `extrasByProvider` plumbing; flipping it means wiring those extras
        // into injectMsGraphTools in the same change.
        single_instance: true,
      })
    })

    it('exposes the nine v1 tools, in the order the factory returns them', () => {
      expect(OFFICIAL_CONNECTOR_TOOLS.msgraph?.map((t) => t.name)).toEqual(MSGRAPH_TOOLS)
    })

    it('requests the delegated Graph scopes, including offline_access', () => {
      // offline_access is what mints the refresh token. Without it the
      // connector dies at the first access-token expiry (~1h) and the user
      // has to reconnect by hand, forever.
      // Scope set: docs/architecture/integrations/msgraph.md §6 +
      // docs/research/external/microsoft-teams-connector-2026.md §5.1.
      const scopes = OFFICIAL_OAUTH_SCOPES.msgraph
      expect(scopes).toContain('offline_access')
      expect(scopes).toEqual([
        'offline_access',
        'User.Read',
        'User.ReadBasic.All',
        'Team.ReadBasic.All',
        'Channel.ReadBasic.All',
        'ChannelMessage.Read.All',
        'Chat.Read',
        'TeamMember.Read.All',
        'ChannelMember.Read.All',
      ])
    })

    it('asks for no write scope (the read-only guarantee, at the consent screen)', () => {
      const writeish = (OFFICIAL_OAUTH_SCOPES.msgraph ?? []).filter((s) =>
        /\.(Send|ReadWrite|Migrate)\b/.test(s),
      )
      expect(writeish).toEqual([])
    })

    it('is read-only: every tool is classified `read` and defaults to allow', () => {
      // D1 — Graph publishes no application permission for sending, so every
      // Graph write is attributed to a human rather than to the assistant.
      // Sending stays on the Teams bot and NO write tool may ever be added
      // here. `classification` is load-bearing: a write misclassified as
      // `read` ships past gateToolsOnActionGrants ungated.
      // See docs/architecture/integrations/msgraph.md §1.
      const tools = OFFICIAL_CONNECTOR_TOOLS.msgraph ?? []
      expect(tools).toHaveLength(MSGRAPH_TOOLS.length)
      for (const tool of tools) {
        expect(tool).toMatchObject({ classification: 'read', defaultPolicy: 'allow' })
      }
    })
  })

  describe('Cross-table integrity (derived, never a hardcoded id list)', () => {
    it('every registered tool has a TOOL_DISPLAY_NAMES entry', () => {
      // Without one, a confirmation prompt shows the raw tool id. Same rule
      // `pnpm check` grades as `invariants/connector-registry` → no-display-name.
      const missing = Object.values(OFFICIAL_CONNECTOR_TOOLS)
        .flat()
        .map((t) => t.name)
        .filter((name) => !(name in TOOL_DISPLAY_NAMES))
      expect(missing).toEqual([])
    })

    it('every connector with a tool table is a registered official connector', () => {
      const officialIds = new Set(OFFICIAL_CONNECTORS.map((c) => c.id))
      const orphans = Object.keys(OFFICIAL_CONNECTOR_TOOLS).filter((id) => !officialIds.has(id))
      expect(orphans).toEqual([])
    })

    it('every registered official connector has a tool table', () => {
      // `gcs` carries an empty array deliberately: a credentialed connector
      // with no assistant tools still has to count as official (it rebinds
      // where the Workspace Files bytes layer writes). `s3`, its sibling, has
      // no row at all — pre-existing drift, left alone here rather than
      // flipped as a side effect of the msgraph registration, because
      // `isOfficialConnector('s3')` changing value is a decision of its own.
      const KNOWN_GAPS = new Set(['s3'])
      const missing = OFFICIAL_CONNECTORS
        .map((c) => c.id)
        .filter((id) => !(id in OFFICIAL_CONNECTOR_TOOLS) && !KNOWN_GAPS.has(id))
      expect(missing).toEqual([])
    })

    it('every OAuth scope list belongs to a connector that actually uses OAuth', () => {
      // The reverse does NOT hold and must not be asserted: Notion is an
      // oauth connector with no scope list (its capabilities come from the
      // integration config, not the authorize URL).
      const oauthIds = new Set(
        OFFICIAL_CONNECTORS.filter((c) => c.auth_type === 'oauth').map((c) => c.id),
      )
      const strays = Object.keys(OFFICIAL_OAUTH_SCOPES).filter((id) => !oauthIds.has(id))
      expect(strays).toEqual([])
    })
  })
})
