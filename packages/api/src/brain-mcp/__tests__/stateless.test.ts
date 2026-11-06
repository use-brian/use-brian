import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { serveStatelessMcp } from '../stateless.js'
import type { BrainTool } from '../tools.js'

function fixture(count = 205) {
  const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
  const tools: BrainTool[] = Array.from({ length: count }, (_, i) => ({ name: `operation${String(i).padStart(3, '0')}`,
    description: `Native operation ${i}`, inputSchema: z.object({ value: z.string().optional() }), handler }))
  const app = express().use(express.json())
  app.post('/mcp', (req, res) => { void serveStatelessMcp(req, res, tools) })
  async function rpc(method: string, params: object) {
    const response = await request(app).post('/mcp').set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method, params })
    const event = response.text.split('\n').find(line => line.startsWith('data: '))
    return event ? JSON.parse(event.slice(6)) : response.body
  }
  return { tools, rpc, handler }
}

describe('[COMP:api/brain-mcp] shared MCP transport', () => {
  it('paginates the full authorized catalog without skips or duplicates', async () => {
    const f = fixture()
    const first = (await f.rpc('tools/list', {})).result
    const second = (await f.rpc('tools/list', { cursor: first.nextCursor })).result
    const third = (await f.rpc('tools/list', { cursor: second.nextCursor })).result
    expect([first.tools.length, second.tools.length, third.tools.length]).toEqual([100, 100, 5])
    expect(third.nextCursor).toBeUndefined()
    expect([...first.tools, ...second.tools, ...third.tools].map(t => t.name)).toEqual(f.tools.map(t => t.name))
    f.tools[0] = { ...f.tools[0], inputSchema: z.object({ changed: z.number() }) }
    expect((await f.rpc('tools/list', { cursor: first.nextCursor })).error.code).toBe(-32602)
    expect((await f.rpc('tools/list', { cursor: 'garbage' })).error.code).toBe(-32602)
  })
  it('forwards an explicit operation UUID separately from native arguments', async () => {
    const f = fixture(1), operationId = '11111111-1111-4111-8111-111111111111'
    const args = { value: 'input' }
    await f.rpc('tools/call', { name: 'operation000', arguments: args, _meta: { 'usebrian.ai/operation-id': operationId } })
    expect(f.handler).toHaveBeenCalledWith(args, { operationId })
    f.handler.mockClear()
    expect((await f.rpc('tools/call', { name: 'operation000', arguments: args, _meta: { 'usebrian.ai/operation-id': 'bad' } })).result.isError).toBe(true)
    expect(f.handler).not.toHaveBeenCalled()
  })
})
