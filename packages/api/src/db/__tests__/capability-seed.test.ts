import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOME_APP_TOOL_CAPABILITIES } from '@use-brian/shared'
import { seedBuiltinPrimitiveCapabilities } from '../capability-seed.js'

describe('[COMP:connectors/builtin-primitive-switch] mini-app defaults', () => {
  it('seeds every declared new grant in the caller transaction without granting kind-specific primitives', async () => {
    const query = vi.fn(async () => ({}))
    await seedBuiltinPrimitiveCapabilities(query, 'assistant-one', 'user-one')
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('ON CONFLICT')
    expect(params.slice(0, 2)).toEqual(['assistant-one', 'user-one'])
    expect(params).toEqual(expect.arrayContaining([...DEFAULT_HOME_APP_TOOL_CAPABILITIES]))
    expect(params).not.toContain('tasks')
    expect(params).not.toContain('crm')
    expect(params).not.toContain('files')
    expect(params).not.toContain('native_computer')
    expect(params).not.toContain('association')
    expect(params).not.toContain('home_app:association:read')
    expect(params).not.toContain('home_app:association:write')
  })
  it('backfills exactly the new catalog grants and preserves historical revocations', () => {
    const sql = readFileSync(new URL('../../../migrations/496_home_app_tool_sets.sql', import.meta.url), 'utf8')
    const grants = [...sql.matchAll(/\('([^']+)'\)/g)].map((m) => m[1])
    expect(grants.sort()).toEqual([...DEFAULT_HOME_APP_TOOL_CAPABILITIES].sort())
    const historyGuard = sql.slice(sql.indexOf('AND NOT EXISTS'))
    expect(historyGuard).toContain('existing.assistant_id = a.id AND existing.capability = cap.capability')
    expect(historyGuard.slice(0, historyGuard.indexOf('ON CONFLICT'))).not.toContain('revoked_at')
  })
})
