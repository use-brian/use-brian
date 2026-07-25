/**
 * Unit tests for the CLI connector transport (MCP stdio).
 * Component tag: [COMP:mcp/cli-transport].
 *
 * Mocks the @modelcontextprotocol/sdk Client + StdioClientTransport.
 * Verifies discoverCliServer, callCliMcpTool, isShellBinary, validateCliArgs.
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
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

import { discoverCliServer, callCliMcpTool, isShellBinary, normalizeCliTimeout, validateCliArgs, validateCliEnv } from '../cli-transport.js'

beforeEach(() => {
  fakeClient.connect.mockReset().mockResolvedValue(undefined)
  fakeClient.listTools.mockReset()
  fakeClient.callTool.mockReset()
  fakeClient.close.mockReset().mockResolvedValue(undefined)
})

describe('[COMP:mcp/cli-transport] discoverCliServer', () => {
  it('maps server tools into McpToolInfo with stdio:// url', async () => {
    fakeClient.listTools.mockResolvedValueOnce({
      tools: [
        { name: 'deploy', description: 'Deploy the app', inputSchema: { type: 'object' } },
        { name: 'status', inputSchema: { type: 'object' } },
      ],
    })
    const cfg = await discoverCliServer({ binaryPath: '/usr/local/bin/my-mcp' }, 'MyTool')
    expect(cfg).toEqual({
      name: 'MyTool',
      url: 'stdio:///usr/local/bin/my-mcp',
      tools: [
        { name: 'deploy', description: 'Deploy the app', inputSchema: { type: 'object' } },
        { name: 'status', description: '', inputSchema: { type: 'object' } },
      ],
    })
    expect(fakeClient.close).toHaveBeenCalledOnce()
  })

  it('handles empty tools list', async () => {
    fakeClient.listTools.mockResolvedValueOnce({ tools: [] })
    const cfg = await discoverCliServer({ binaryPath: '/bin/tool' }, 'Empty')
    expect(cfg.tools).toEqual([])
  })

  it('closes client even on listTools failure', async () => {
    fakeClient.listTools.mockRejectedValueOnce(new Error('boom'))
    await expect(discoverCliServer({ binaryPath: '/bin/tool' }, 'Fail')).rejects.toThrow('boom')
    expect(fakeClient.close).toHaveBeenCalledOnce()
  })
})

describe('[COMP:mcp/cli-transport] callCliMcpTool', () => {
  it('returns joined text content', async () => {
    fakeClient.callTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ],
    })
    const result = await callCliMcpTool({ binaryPath: '/bin/tool' }, 'myTool', { arg: 'val' })
    expect(result).toBe('line1\nline2')
    expect(fakeClient.callTool).toHaveBeenCalledWith({ name: 'myTool', arguments: { arg: 'val' } })
    expect(fakeClient.close).toHaveBeenCalledOnce()
  })

  it('returns text + images when image content present', async () => {
    fakeClient.callTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'here is an image' },
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
      ],
    })
    const result = await callCliMcpTool({ binaryPath: '/bin/tool' }, 'imgTool', {}) as { text: string; images: unknown[] }
    expect(result.text).toBe('here is an image')
    expect(result.images).toEqual([{ mimeType: 'image/png', data: 'base64data' }])
  })

  it('returns empty string for no content', async () => {
    fakeClient.callTool.mockResolvedValueOnce({ content: [] })
    const result = await callCliMcpTool({ binaryPath: '/bin/tool' }, 'empty', {})
    expect(result).toBe('')
  })

  it('closes client even on callTool failure', async () => {
    fakeClient.callTool.mockRejectedValueOnce(new Error('tool crashed'))
    await expect(callCliMcpTool({ binaryPath: '/bin/tool' }, 'bad', {})).rejects.toThrow('tool crashed')
    expect(fakeClient.close).toHaveBeenCalledOnce()
  })
})

describe('[COMP:mcp/cli-transport] isShellBinary', () => {
  it('rejects shell binaries', () => {
    expect(isShellBinary('/bin/bash')).toBe(true)
    expect(isShellBinary('/usr/bin/zsh')).toBe(true)
    expect(isShellBinary('/bin/sh')).toBe(true)
    expect(isShellBinary('/usr/local/bin/fish')).toBe(true)
  })

  it('allows non-shell binaries', () => {
    expect(isShellBinary('/usr/local/bin/my-mcp-server')).toBe(false)
    expect(isShellBinary('/usr/bin/kubectl')).toBe(false)
    expect(isShellBinary('/bin/cat')).toBe(false)
  })
})

describe('[COMP:mcp/cli-transport] validateCliArgs', () => {
  it('returns null for valid args', () => {
    expect(validateCliArgs(['--config', '/etc/tool.json'])).toBeNull()
    expect(validateCliArgs([])).toBeNull()
  })

  it('rejects more than 20 args', () => {
    const args = Array.from({ length: 21 }, (_, i) => `arg${i}`)
    expect(validateCliArgs(args)).toBe('Maximum 20 arguments allowed')
  })

  it('rejects args over 4096 chars', () => {
    expect(validateCliArgs(['x'.repeat(4097)])).toBe('Each argument must be at most 4096 characters')
  })

  it('rejects args with CR/LF', () => {
    expect(validateCliArgs(['line1\nline2'])).toBe('Arguments must not contain CR/LF characters')
    expect(validateCliArgs(['line1\rline2'])).toBe('Arguments must not contain CR/LF characters')
  })
})

describe('[COMP:mcp/cli-transport] validateCliEnv', () => {
  it('accepts string-valued environment variables', () => {
    expect(validateCliEnv({ API_TOKEN: 'secret', MODE: 'read-only' })).toBeNull()
    expect(validateCliEnv(undefined)).toBeNull()
  })

  it('rejects malformed names and non-string values', () => {
    expect(validateCliEnv({ 'BAD-NAME': 'value' })).toBe('Invalid environment variable name: BAD-NAME')
    expect(validateCliEnv({ PORT: 3000 })).toBe('Environment variable PORT must be a string')
  })
})

describe('[COMP:mcp/cli-transport] normalizeCliTimeout', () => {
  it('accepts the supported range', () => {
    expect(normalizeCliTimeout(undefined)).toBeUndefined()
    expect(normalizeCliTimeout(1_000)).toBe(1_000)
    expect(normalizeCliTimeout(300_000)).toBe(300_000)
  })

  it('rejects invalid timeout values', () => {
    expect(() => normalizeCliTimeout(999)).toThrow('timeoutMs must be an integer between 1000 and 300000')
    expect(() => normalizeCliTimeout(1_500.5)).toThrow('timeoutMs must be an integer between 1000 and 300000')
  })
})
