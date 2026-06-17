/**
 * Unit tests for the remote MCP client.
 * Component tag: [COMP:api/mcp-client].
 *
 * Mocks the @modelcontextprotocol/sdk Client + Streamable-HTTP transport.
 * Verifies discoverMcpServer (tool listing → McpToolInfo mapping, the
 * missing-description default, the empty-tools case) and callRemoteMcpTool
 * (text-content extraction + join, the isError → throw path, the
 * non-text content fallback, and the always-close finally).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakeClient = {
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => fakeClient),
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

import { discoverMcpServer, callRemoteMcpTool } from '../client.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const MockTransport = vi.mocked(StreamableHTTPClientTransport)

beforeEach(() => {
  fakeClient.connect.mockReset().mockResolvedValue(undefined)
  fakeClient.listTools.mockReset()
  fakeClient.callTool.mockReset()
  fakeClient.close.mockReset().mockResolvedValue(undefined)
  MockTransport.mockClear()
})

describe('[COMP:api/mcp-client] discoverMcpServer', () => {
  it('maps server tools into McpToolInfo, defaulting a missing description', async () => {
    fakeClient.listTools.mockResolvedValueOnce({
      tools: [
        { name: 'search', description: 'Search the web', inputSchema: { type: 'object' } },
        { name: 'fetch', inputSchema: { type: 'object' } }, // no description
      ],
    })
    const cfg = await discoverMcpServer('https://mcp.example/sse', 'Example')
    expect(cfg).toEqual({
      name: 'Example',
      url: 'https://mcp.example/sse',
      tools: [
        { name: 'search', description: 'Search the web', inputSchema: { type: 'object' } },
        { name: 'fetch', description: '', inputSchema: { type: 'object' } },
      ],
    })
    expect(fakeClient.close).toHaveBeenCalledOnce()
  })

  it('returns an empty tool list when the server exposes none', async () => {
    fakeClient.listTools.mockResolvedValueOnce({ tools: undefined })
    const cfg = await discoverMcpServer('https://mcp.example/sse', 'Example')
    expect(cfg.tools).toEqual([])
  })

  it('closes the connection even when listTools throws', async () => {
    fakeClient.listTools.mockRejectedValueOnce(new Error('boom'))
    await expect(discoverMcpServer('https://mcp.example/sse', 'Example')).rejects.toThrow('boom')
    expect(fakeClient.close).toHaveBeenCalledOnce()
  })

  it('passes auth headers to the transport via requestInit', async () => {
    fakeClient.listTools.mockResolvedValueOnce({ tools: [] })
    await discoverMcpServer('https://mcp.example/sse', 'Example', { Authorization: 'Bearer t1' })
    expect(MockTransport).toHaveBeenCalledWith(
      expect.any(URL),
      { requestInit: { headers: { Authorization: 'Bearer t1' } } },
    )
  })

  it('constructs the transport with no options when headers are absent or empty', async () => {
    fakeClient.listTools.mockResolvedValue({ tools: [] })
    await discoverMcpServer('https://mcp.example/sse', 'Example')
    await discoverMcpServer('https://mcp.example/sse', 'Example', {})
    expect(MockTransport).toHaveBeenNthCalledWith(1, expect.any(URL), undefined)
    expect(MockTransport).toHaveBeenNthCalledWith(2, expect.any(URL), undefined)
  })
})

describe('[COMP:api/mcp-client] callRemoteMcpTool', () => {
  it('extracts and joins the text content of a successful call', async () => {
    fakeClient.callTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
        { type: 'image', data: '...' },
      ],
    })
    const out = await callRemoteMcpTool('https://mcp.example/sse', 'search', { q: 'x' })
    expect(out).toBe('line 1\nline 2')
  })

  it('throws with the error text when the result is flagged isError', async () => {
    fakeClient.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'rate limited' }],
    })
    await expect(callRemoteMcpTool('https://mcp.example/sse', 'search', {})).rejects.toThrow('rate limited')
  })

  it('returns the raw content when the result has no text parts', async () => {
    const content = [{ type: 'image', data: 'b64' }]
    fakeClient.callTool.mockResolvedValueOnce({ content })
    const out = await callRemoteMcpTool('https://mcp.example/sse', 'render', {})
    expect(out).toBe(content)
  })

  it('closes the connection even when the call throws', async () => {
    fakeClient.callTool.mockRejectedValueOnce(new Error('network'))
    await expect(callRemoteMcpTool('https://mcp.example/sse', 'search', {})).rejects.toThrow('network')
    expect(fakeClient.close).toHaveBeenCalledOnce()
  })

  it('passes auth headers to the transport via requestInit', async () => {
    fakeClient.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
    await callRemoteMcpTool('https://mcp.example/sse', 'search', { q: 'x' }, { 'X-Api-Key': 'k1' })
    expect(MockTransport).toHaveBeenCalledWith(
      expect.any(URL),
      { requestInit: { headers: { 'X-Api-Key': 'k1' } } },
    )
  })

  it('constructs the transport with no options when headers are absent', async () => {
    fakeClient.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
    await callRemoteMcpTool('https://mcp.example/sse', 'search', {})
    expect(MockTransport).toHaveBeenCalledWith(expect.any(URL), undefined)
  })
})
