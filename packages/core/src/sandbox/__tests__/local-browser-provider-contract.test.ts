import { describe, it, expect, vi } from 'vitest'
import { BrowserFormFieldsSchema } from '../types.js'
import { createLocalBrowserProvider } from '../local-browser-provider.js'

const ctx = { userId: 'u', workspaceId: 'w', sessionId: 's', profileId: 'p' }
describe('local browser provider wire contracts', () => {
  it.each([
    {
      documentId: '1:attachment:100', url: 'https://example.com', title: 'Example',
      nodes: [
        { ref: '@e1', nodeId: '101', role: 'checkbox', name: 'Agree', checked: false, required: true, invalid: 'grammar' },
        { nodeId: '102', role: 'statictext', name: 'Message' },
      ],
    },
    { url: 'https://example.com', title: 'Example', nodes: [{ role: 'button', name: 'Save' }] },
  ])('preserves snapshot identity/state and accepts legacy snapshots: %#', async data => {
    const send = vi.fn(async () => ({ ok: true as const, data }))
    const provider = createLocalBrowserProvider({ transport: { send } })
    expect(await provider.snapshot(ctx, { mode: 'full' })).toEqual(data)
    expect(send).toHaveBeenCalledExactlyOnceWith({ userId: 'u', browserProfileId: 'p', op: 'snapshot', args: { mode: 'full' } })
  })
  it.each(['fill', 'select'])('enforces the core %s string boundary without truncating values', action => {
    expect(BrowserFormFieldsSchema.parse([{ action, ref: 'a', value: 'x'.repeat(20000) }])[0]).toMatchObject({ value: 'x'.repeat(20000) })
    expect(() => BrowserFormFieldsSchema.parse([{ action, ref: 'a', value: 'x'.repeat(20001) }])).toThrow()
  })
  it('sends one ordered batch and preserves per-field failures', async () => {
    const data = { fields: [{ ref: 'a', status: 'success' }, { ref: 'b', status: 'failed', error: 'replaced' }, { ref: 'c', status: 'skipped' }] }
    const send = vi.fn(async () => ({ ok: true as const, data }))
    const provider = createLocalBrowserProvider({ transport: { send } })
    const fields = [{ action: 'fill' as const, ref: 'a', value: 'hello' }, { action: 'select' as const, ref: 'b', value: 'x' }, { action: 'check' as const, ref: 'c', checked: false }]
    expect(await provider.fillForm!(ctx, fields)).toEqual(data)
    expect(send).toHaveBeenCalledExactlyOnceWith({ userId: 'u', browserProfileId: 'p', op: 'fillForm', args: { fields } })
  })
  it('rejects oversized batches before transport and propagates unsupported Firefox', async () => {
    const send = vi.fn(async () => ({ ok: false as const, code: 'unsupported_browser', error: 'Not implemented in Firefox' }))
    const provider = createLocalBrowserProvider({ transport: { send } })
    await expect(provider.fillForm!(ctx, Array(51).fill({ action: 'fill', ref: 'a', value: '' }))).rejects.toThrow()
    await expect(provider.fillForm!(ctx, [{ action: 'fill', ref: 'a', value: 'first' }, { action: 'fill', ref: 'a', value: 'last' }])).rejects.toThrow(/Duplicate/)
    expect(send).not.toHaveBeenCalled()
    await expect(provider.fillForm!(ctx, [{ action: 'check', ref: 'a', checked: true }])).rejects.toMatchObject({ code: 'unsupported_browser' })
  })
})
