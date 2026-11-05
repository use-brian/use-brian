import { describe, expect, it, vi } from 'vitest'
import { createOfficeTemplateDiscovery } from '../template-discovery.js'
import type { OfficeDbQuery } from '../../db/office-artifacts.js'
import type { ToolContext } from '@use-brian/core'

const context = { userId: 'user', workspaceId: 'workspace', clearance: 'internal', compartments: ['team:sales'], projectIds: ['project'] } as ToolContext
const scope = { sensitivity: 'internal', compartments: ['team:sales'], projectIds: ['project'] }
const row = { templateId: 'registry', templateVersionId: 'published-version', name: 'Waterman', description: 'Photography', family: 'document', version: 3, scopes: [scope] }

describe('[COMP:api/office-template-discovery] published template lookup', () => {
  it('keeps registry and version IDs distinct, uses current SQL authority and returns evidence without internal scopes', async () => {
    const query = vi.fn(async (_actor: string, _sql: string, _params: unknown[]) => ({ rows: [row] }))
    const result = await createOfficeTemplateDiscovery(query as OfficeDbQuery)(context, { family: 'document', query: 'Waterman' })
    expect(result.templates).toEqual([{ templateId: 'registry', templateVersionId: 'published-version', name: 'Waterman', description: 'Photography', family: 'document', version: 3 }])
    expect(result.scopeEvidence).toMatchObject(scope)
    expect(query).toHaveBeenCalledWith('user', expect.stringContaining('office_template_version_scope_allows'), ['workspace', 'document', 'Waterman'])
    expect(query.mock.calls[0]?.[1]).toContain("t.lifecycle_state='admitted'")
  })
  it.each([
    { sensitivity: 'confidential' },
    { compartments: ['team:finance'] },
    { projectIds: ['other-project'] },
  ])('withholds a template if any dependency exceeds the active turn ceiling: %j', async patch => {
    const query = vi.fn(async () => ({ rows: [{ ...row, scopes: [scope, { ...scope, ...patch }] }] }))
    const result = await createOfficeTemplateDiscovery(query as OfficeDbQuery)(context, {})
    expect(result.templates).toEqual([])
    expect(JSON.stringify(result.scopeEvidence)).not.toContain('team:finance')
  })
  it('does not query without a workspace binding', async () => {
    const query = vi.fn()
    expect((await createOfficeTemplateDiscovery(query)({ ...context, workspaceId: undefined }, {})).templates).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })
})
