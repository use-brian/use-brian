/**
 * Tests for the shared connector result-projection helper and a representative
 * end-to-end projection (GitHub repo search + Notion query), which slim raw
 * provider JSON down to the model-relevant fields. Added with the 2026-06-11
 * MCP precision pass — see docs/architecture/integrations/mcp.md →
 * "Connector result projection".
 */

import { describe, it, expect, vi } from 'vitest'
import { asRows, str, num, bool, obj, projectList, mapField } from '../base/_connector-result.js'
import { createGitHubTools } from '../base/github.js'
import { createNotionTools } from '../base/notion.js'

const ctx = {} as never

describe('[COMP:tools/connector-result] projection helpers', () => {
  it('asRows coerces only arrays of objects', () => {
    expect(asRows([{ a: 1 }, 2, null, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }])
    expect(asRows('nope')).toEqual([])
    expect(asRows(undefined)).toEqual([])
  })

  it('typed field readers return undefined on type mismatch', () => {
    const o = { s: 'x', n: 3, b: true, nested: { k: 1 } }
    expect(str(o, 's')).toBe('x')
    expect(str(o, 'n')).toBeUndefined()
    expect(num(o, 'n')).toBe(3)
    expect(num(o, 's')).toBeUndefined()
    expect(bool(o, 'b')).toBe(true)
    expect(obj(o, 'nested')).toEqual({ k: 1 })
    expect(obj(o, 's')).toBeUndefined()
  })

  it('projectList caps, maps, and reports matched/truncated with an explicit total', () => {
    const rows = [{ n: 1 }, { n: 2 }, { n: 3 }]
    const r = projectList(rows, 2, (x) => num(x, 'n'), 18442)
    expect(r).toEqual({ matched: 18442, returned: 2, truncated: true, items: [1, 2] })
  })

  it('projectList falls back to row count when no total is given', () => {
    const r = projectList([{ n: 1 }, { n: 2 }], 5, (x) => num(x, 'n'))
    expect(r).toEqual({ matched: 2, returned: 2, truncated: false, items: [1, 2] })
  })

  it('mapField projects a nested array field', () => {
    const issue = { labels: [{ name: 'bug' }, { name: 'p1' }] }
    expect(mapField(issue, 'labels', (l) => str(l, 'name'))).toEqual(['bug', 'p1'])
  })
})

describe('[COMP:tools/connector-result] GitHub repo search projection', () => {
  it('slims raw repo search to the documented fields and preserves total_count', async () => {
    const api = {
      searchRepositories: vi.fn().mockResolvedValue({
        total_count: 18442,
        incomplete_results: false,
        items: [
          {
            full_name: 'octocat/hello',
            description: 'hi',
            stargazers_count: 99,
            language: 'Rust',
            html_url: 'https://github.com/octocat/hello',
            updated_at: '2026-06-01T00:00:00Z',
            private: false,
            // noise the projection must drop:
            owner: { login: 'octocat', avatar_url: 'x', url: 'y', html_url: 'z' },
            forks_count: 5, watchers: 5, open_issues_count: 1, node_id: 'abc',
          },
        ],
      }),
    } as never

    const tools = createGitHubTools(api)
    const search = tools.find((t) => t.name === 'githubSearchRepositories')!
    const res = await search.execute({ query: 'hello' }, ctx)
    const data = res.data as { matched: number; returned: number; truncated: boolean; items: Record<string, unknown>[] }

    expect(data.matched).toBe(18442)
    expect(data.returned).toBe(1)
    expect(data.truncated).toBe(true)
    expect(data.items[0]).toEqual({
      full_name: 'octocat/hello',
      description: 'hi',
      stars: 99,
      language: 'Rust',
      url: 'https://github.com/octocat/hello',
      updated_at: '2026-06-01T00:00:00Z',
      private: false,
    })
    // The 60 KB-blob fields are gone.
    expect(data.items[0]).not.toHaveProperty('owner')
    expect(data.items[0]).not.toHaveProperty('node_id')
  })
})

describe('[COMP:tools/connector-result] Notion query projection', () => {
  it('flattens database-row properties to plain values', async () => {
    const api = {
      queryDatabase: vi.fn().mockResolvedValue({
        results: [
          {
            id: 'pg1',
            url: 'https://notion.so/pg1',
            properties: {
              Name: { type: 'title', title: [{ plain_text: 'Acme' }, { plain_text: ' Corp' }] },
              Stage: { type: 'select', select: { name: 'Won' } },
              Value: { type: 'number', number: 1000 },
              Tags: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] },
              Done: { type: 'checkbox', checkbox: true },
            },
            // noise:
            created_by: { object: 'user', id: 'u1' },
            cover: { type: 'external', external: { url: 'x' } },
          },
        ],
      }),
    } as never

    const tools = createNotionTools(api)
    const query = tools.find((t) => t.name === 'notionQueryDatabase')!
    const res = await query.execute({ databaseId: 'db1' }, ctx)
    const data = res.data as { items: Array<{ id: string; properties: Record<string, unknown> }> }

    expect(data.items[0].id).toBe('pg1')
    expect(data.items[0].properties).toEqual({
      Name: 'Acme Corp',
      Stage: 'Won',
      Value: 1000,
      Tags: ['a', 'b'],
      Done: true,
    })
  })
})
