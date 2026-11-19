/** [COMP:api/memory-bulk-export] */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainAuth } from '../auth.js'
import type { Memory } from '../../db/memories.js'
import { getWorkspaceRoleSystem } from '../../db/workspace-store.js'
import { memoryExportHeader, serializeMemoryExportRow } from '../../memory-bulk-export.js'
import { createMemoryExportTool } from '../memory-bulk-export.js'
import { serveStatelessMcp } from '../stateless.js'

const current = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../auth.js', () => ({ getAuthenticatedBrainCredentialCurrent: () => current }))
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceRoleSystem: vi.fn() }))
const role = vi.mocked(getWorkspaceRoleSystem)
const workspaceId = '88c5f28a-f239-40af-8191-3cd97680113e'
const url = `https://app.example/w/${workspaceId}/brain?memoryExport=csv`
const auth: BrainAuth = {
  workspaceId, keyId: 'fictional-oauth', actingUserId: 'fictional-member', authKind: 'oauth_token',
  scope: 'read', storeScope: 'none', agentScope: 'none', maxClearance: 'internal',
}

function fixture() {
  const entitled = vi.fn(async () => true)
  const observe = vi.fn()
  const options = { appOrigin: 'https://app.example', entitled, observe, workspaceStore: {
    getByIdSystem: vi.fn(async () => ({ name: 'Fictional Atlas' })),
  } }
  const tool = createMemoryExportTool(auth, options)!
  const app = express().use(express.json())
  app.post('/mcp', (req, res) => { void serveStatelessMcp(req, res, [tool]) })
  async function rpc(method: string, params: object) {
    const response = await request(app).post('/mcp').set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method, params })
    const event = response.text.split('\n').find(line => line.startsWith('data: '))
    return (event ? JSON.parse(event.slice(6)) : response.body).result
  }
  const call = (args: object) => rpc('tools/call', { name: tool.name, arguments: args })
  return { tool, call, rpc, entitled, options, observe }
}

beforeEach(() => {
  current.mockReset().mockResolvedValue(true)
  role.mockReset().mockResolvedValue('member')
})

describe('connected bulk Memory export', () => {
  it('discovers the format and returns a signed-in Brain link for the connected workspace', async () => {
    const f = fixture()
    expect((await f.rpc('tools/list', {})).tools).toEqual([expect.objectContaining({
      name: 'exportMemories',
      inputSchema: expect.objectContaining({ properties: expect.objectContaining({
        format: expect.objectContaining({ enum: ['markdown', 'csv'] }),
      }) }),
    })])
    expect((await f.call({ workspace: 'Fictional Atlas', format: 'csv' })).structuredContent).toEqual({
      status: 'ready', workspace: 'Fictional Atlas', format: 'csv', url,
    })
    expect(f.entitled).toHaveBeenCalledWith(workspaceId)
    expect(f.observe).not.toHaveBeenCalled()
  })

  it('refuses a workspace substitution, a revoked credential, and missing member access', async () => {
    const f = fixture()
    expect((await f.call({ workspace: 'Another Workspace' })).isError).toBe(true)
    current.mockResolvedValueOnce(false)
    expect((await f.call({})).isError).toBe(true)
    role.mockResolvedValueOnce(null)
    expect((await f.call({})).isError).toBe(true)
    expect(f.entitled).not.toHaveBeenCalled()
    current.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect((await f.call({ format: 'csv' })).isError).toBe(true)
    expect(f.observe).not.toHaveBeenCalled()
    expect(createMemoryExportTool({ ...auth, authKind: 'api_key' }, f.options)).toBeUndefined()
  })

  it('keeps the tool discoverable on unpaid workspaces and gives the plan path', async () => {
    const f = fixture()
    f.entitled.mockResolvedValue(false)
    expect((await f.call({ format: 'csv' })).structuredContent).toEqual({
      status: 'upgrade_required', workspace: 'Fictional Atlas', format: 'csv', url,
    })
    expect(f.observe).toHaveBeenCalledExactlyOnceWith({
      userId: auth.actingUserId, workspaceId, format: 'csv', entrypoint: 'mcp', outcome: 'upgrade_required',
    })
  })
})

describe('bulk Memory file encoding', () => {
  const memory = {
    id: '1', summary: " \t=危険", detail: '多言語 "引用"\n行 2', source: 'programmatic',
    createdAt: new Date('2026-11-18T03:00:00Z'), updatedAt: new Date('2026-11-18T04:00:00Z'),
    createdByUserId: 'user', createdByAssistantId: null,
  } as Memory

  it('writes a UTF-8 CSV header and one valid row with neutralized formula prefixes', () => {
    expect(memoryExportHeader('csv')).toBe('id,summary,detail,created_at,updated_at,source,author_user_id,author_assistant_id\r\n')
    expect(serializeMemoryExportRow('csv', memory)).toBe(
      '"1","\' \t=危険","多言語 ""引用""\n行 2","2026-11-18T03:00:00.000Z","2026-11-18T04:00:00.000Z","programmatic","user",""\r\n',
    )
    for (const prefix of ['=','+','-','@','＝','\t','\r','\n','\uFEFF =']) {
      expect(serializeMemoryExportRow('csv', { ...memory, summary: prefix + 'x' })).toContain(`"'${prefix}x"`)
    }
  })

  it('preserves multiline detail and prevents embedded markup from ending its text block', () => {
    const detail = '第一行\n```\n<img src="https://example.test/pixel">\n第二行'
    const markdown = serializeMemoryExportRow('markdown', { ...memory, summary: '[Atlas]\n# 予定', detail })
    expect(markdown).toContain('## \\[Atlas\\] \\# 予定\n')
    expect(markdown).toContain('- Author (user): user')
    expect(markdown).toContain('````text\n' + detail + '\n````\n')
  })
})
