import { describe, it, expect, vi } from 'vitest'
import { TabExecutor } from '../executor.js'

async function fixture() {
  let root: number | undefined = 100
  let url = 'https://example.com'
  const axNodes = [
    { nodeId: 'ax-button', backendDOMNodeId: 101, role: { value: 'button' }, name: { value: 'Save' }, properties: [{ name: 'checked', value: { value: 'false' } }, { name: 'required', value: { value: true } }, { name: 'invalid', value: { value: 'grammar' } }] },
    { nodeId: 'ax-text', backendDOMNodeId: 102, role: { value: 'StaticText' }, name: { value: 'Message' } },
  ]
  const send = vi.fn(async (_target, method) => {
    if (method === 'DOM.getDocument') return { root: { backendNodeId: root } }
    if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes }
    return {}
  })
  vi.stubGlobal('chrome', {
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: send },
    tabs: { get: vi.fn(async () => ({ url, title: 'Example' })) },
  })
  const executor = new TabExecutor()
  await executor.attach(1)
  return { executor, send, setRoot: (id: number | undefined) => { root = id }, setUrl: (next: string) => { url = next } }
}

describe('Chromium snapshot document identity', () => {
  it('keeps identity across snapshots and same-document URL changes, including informational node ids', async () => {
    const { executor, send, setUrl } = await fixture()
    const first = await executor.snapshot('full')
    setUrl('https://example.com#section')
    const second = await executor.snapshot('full')
    expect(first.documentId).toMatch(/^1:.+:100$/)
    expect(second.documentId).toBe(first.documentId)
    expect(second.nodes.map(n => n.nodeId)).toEqual(['101', '102'])
    expect(second.nodes[1]?.ref).toBeUndefined()
    expect(send).toHaveBeenCalledWith({ tabId: 1 }, 'DOM.getDocument', { depth: 0 })
  })
  it('changes identity for a new document even at the same URL', async () => {
    const { executor, setRoot } = await fixture()
    const first = await executor.snapshot()
    setRoot(200)
    const second = await executor.snapshot()
    expect(second.url).toBe(first.url)
    expect(second.documentId).not.toBe(first.documentId)
    expect(second.documentId).toMatch(/:200$/)
  })
  it('scopes reused backend ids to attachment and tab identity', async () => {
    const { executor } = await fixture()
    const first = await executor.snapshot()
    await executor.attach(1) // cached attachment is not a new identity
    expect((await executor.snapshot()).documentId).toBe(first.documentId)
    executor.onDetached(1)
    await executor.attach(1)
    const reattached = await executor.snapshot()
    expect(reattached.documentId).not.toBe(first.documentId)
    await executor.attach(2)
    const otherTab = await executor.snapshot()
    expect(otherTab.documentId).toMatch(/^2:/)
    expect(otherTab.documentId).not.toBe(reattached.documentId)
  })
  it('omits unavailable identity rather than using the URL or AX root id', async () => {
    const { executor, setRoot, send } = await fixture()
    setRoot(undefined)
    expect((await executor.snapshot()).documentId).toBeUndefined()
    const original = send.getMockImplementation()!
    send.mockImplementation(async (...args) => {
      if (args[1] === 'DOM.getDocument') throw new Error('DOM not available')
      return original(...args)
    })
    expect((await executor.snapshot()).documentId).toBeUndefined()
  })
  it('rejects repeated document changes during capture and discards refs', async () => {
    const { executor, send, setRoot } = await fixture()
    const first = await executor.snapshot()
    const original = send.getMockImplementation()!
    let nextRoot = 200
    send.mockClear()
    send.mockImplementation(async (...args) => {
      if (args[1] === 'Accessibility.getFullAXTree') setRoot(nextRoot++)
      return original(...args)
    })
    await expect(executor.snapshot()).rejects.toMatchObject({ code: 'stale_ref' })
    expect(send.mock.calls.filter(c => c[1] === 'Accessibility.getFullAXTree')).toHaveLength(2)
    await expect(executor.click(first.nodes[0]!.ref!)).rejects.toMatchObject({ code: 'stale_ref' })
  })
  it('retries a raced AX capture once and returns only the fresh document tree', async () => {
    const { executor, send, setRoot } = await fixture()
    const original = send.getMockImplementation()!
    let captures = 0
    send.mockImplementation(async (...args) => {
      if (args[1] === 'Accessibility.getFullAXTree') {
        captures++
        if (captures === 1) setRoot(200)
        return { nodes: [{ nodeId: 'ax', backendDOMNodeId: captures === 1 ? 101 : 201, role: { value: 'button' }, name: { value: captures === 1 ? 'Old' : 'Next page' } }] }
      }
      return original(...args)
    })
    const result = await executor.snapshot()
    expect(captures).toBe(2)
    expect(result.documentId).toMatch(/:200$/)
    expect(result.nodes).toEqual([{ ref: '@e1', nodeId: '201', role: 'button', name: 'Next page' }])
  })
  it('settles before sampling identity and ignores settle evaluation errors', async () => {
    const { executor, send } = await fixture()
    const original = send.getMockImplementation()!
    send.mockClear()
    send.mockImplementation(async (...args) => {
      if (args[1] === 'Runtime.evaluate') throw new Error('Execution context was destroyed')
      return original(...args)
    })
    expect((await executor.snapshot()).documentId).toMatch(/:100$/)
    expect(send.mock.calls.map(c => c[1])).toEqual(['Runtime.evaluate', 'DOM.getDocument', 'Accessibility.getFullAXTree', 'DOM.getDocument'])
  })
  it('does not swallow debugger detachment as missing optional identity', async () => {
    const { executor, send } = await fixture()
    send.mockRejectedValue(new Error('Debugger is not attached'))
    await expect(executor.snapshot()).rejects.toMatchObject({ code: 'detached' })
  })
})
