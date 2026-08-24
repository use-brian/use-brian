import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../../../migrations/466_channel_trusted_guest_memberships.sql', import.meta.url),
  'utf8',
)

describe('[COMP:api/channel-user-store] trusted channel membership schema', () => {
  it('tracks channel provenance and cleans only the final generated member grant', () => {
    expect(migration).toContain('REFERENCES workspace_members (workspace_id, user_id)')
    expect(migration).toContain('REFERENCES channel_integrations(id) ON DELETE CASCADE')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('FROM channel_trusted_memberships')
    expect(migration).toContain('FROM channel_trusted_access_grants')
    expect(migration).toContain("AND role = 'member'")
  })
})
