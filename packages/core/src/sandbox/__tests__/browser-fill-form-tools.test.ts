import { describe, expect, it, vi } from 'vitest'
import { createComputerTools } from '../tools.js'
import type { BrowserFormField, BrowserProvider } from '../types.js'
import type { Tool, ToolContext } from '../../tools/types.js'

const context: ToolContext = {
  userId: 'user', assistantId: 'assistant', sessionId: 'session', appId: 'app',
  channelType: 'web', channelId: 'channel', workspaceId: 'workspace',
  abortSignal: new AbortController().signal,
}

function fixture(options: Partial<Parameters<typeof createComputerTools>[0]> = {}) {
  let scan = 0
  let partial = false
  let value = ''
  let checked = false
  const mutations: BrowserFormField[] = []
  const snapshot = vi.fn<BrowserProvider['snapshot']>(async (_ctx, opts) => {
    ++scan
    return {
      documentId: 'document', url: 'https://example.com/form', title: 'Application',
      nodes: [
        { nodeId: 'email', ref: `scan-${scan}-email`, role: 'textbox', name: 'Email', value, invalid: value ? 'false' : 'true' },
        { nodeId: 'country', ref: `scan-${scan}-country`, role: 'combobox', name: 'Country' },
        { nodeId: 'consent', ref: `scan-${scan}-consent`, role: 'checkbox', name: 'Consent', checked },
        ...(opts?.mode === 'full' ? [{ nodeId: 'question', role: 'statictext', name: value ? 'Which country do you live in?' : 'What is your email address?' }] : []),
      ],
    }
  })
  const fillForm = vi.fn<NonNullable<BrowserProvider['fillForm']>>(async (_ctx, fields) => ({
    fields: fields.map((field, index) => {
      if (partial && index > 0) return {
        ref: field.ref, status: index === 1 ? 'failed' as const : 'skipped' as const,
        ...(index === 1 ? { error: 'Option unavailable' } : {}),
      }
      mutations.push(field)
      if (field.action === 'fill') value = field.value
      if (field.action === 'check') checked = field.checked
      return { ref: field.ref, status: 'success' as const }
    }),
  }))
  const provider: BrowserProvider = {
    kind: 'local', snapshot, fillForm,
    navigate: vi.fn(async (_ctx, url) => ({ url })),
    click: vi.fn(async () => {}), type: vi.fn(async () => {}),
    currentUrl: vi.fn(async () => ({ url: 'https://example.com/form', title: 'Application' })),
    stop: vi.fn(async () => {}),
  }
  const tools = createComputerTools({ local: provider, cloud: provider, ...options })
  const run = (tool: Tool, input: Record<string, unknown> = {}, ctx = context) =>
    tool.execute(tool.inputSchema.parse(input), ctx)
  return { tools, provider, run, snapshot, fillForm, mutations, failSecond: () => { partial = true } }
}

const fields: BrowserFormField[] = [
  { action: 'fill', ref: '@e1', value: 'ada@example.com' },
  { action: 'select', ref: '@e2', value: 'United Kingdom' },
  { action: 'check', ref: '@e3', checked: true },
]

describe('[COMP:sandbox/browser-fill-form] tool integration', () => {
  it('sends all mapped fields in one provider call and returns public refs plus full question text', async () => {
    const f = fixture()
    const initial = await f.run(f.tools.browserNavigate, { url: 'https://example.com/form' })
    expect(initial.data).toContain('What is your email address?')
    // Stable identities retain public refs, while the backend refs change every scan.
    await f.run(f.tools.browserSnapshot, { mode: 'full' })
    const result = await f.run(f.tools.browserFillForm, { fields, observation: 'full' })
    expect(result.isError).toBeUndefined()
    expect(f.fillForm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: 'user', workspaceId: 'workspace', sessionId: 'session' }),
      fields.map((field, index) => ({ ...field, ref: `scan-2-${['email', 'country', 'consent'][index]}` })),
    )
    expect(f.mutations).toHaveLength(3)
    expect(f.provider.type).not.toHaveBeenCalled()
    expect(f.provider.click).not.toHaveBeenCalled()
    expect(f.snapshot).toHaveBeenCalledTimes(3)
    expect(f.snapshot.mock.calls.map(call => call[1]?.mode)).toEqual(['full', 'full', 'full'])
    expect(result.data).toContain('@e1: success\n@e2: success\n@e3: success')
    expect(result.data).toContain('Which country do you live in?')
    expect(result.data).not.toContain('scan-')
    expect(result.meta).toMatchObject({ backend: 'local', fields: 3, succeeded: 3 })
  })

  it('keeps explicit snapshots interactive while navigate, click and batch use full mode', async () => {
    const f = fixture()
    await f.run(f.tools.browserNavigate, { url: 'https://example.com/form' })
    const clicked = await f.run(f.tools.browserClick, { ref: '@e1', observation: 'full' })
    expect(clicked.isError).toBeUndefined()
    expect(clicked.data).toContain('What is your email address?')
    const emailRef = String(clicked.data).match(/(@e\d+) textbox "Email"/)?.[1]
    expect(emailRef).toBeDefined()
    expect((await f.run(f.tools.browserFillForm, { fields: [{ ...fields[0], ref: emailRef }] })).isError).toBeUndefined()
    const interactive = await f.run(f.tools.browserSnapshot)
    expect(interactive.data).not.toContain('What is your email address?')
    expect(interactive.data).not.toContain('Which country do you live in?')
    expect(f.snapshot.mock.calls.map(call => call[1]?.mode)).toEqual(['full', 'full', 'full', 'interactive'])
  })

  it('includes changed static question text and checked/invalid state in full-mode inline diffs', async () => {
    const f = fixture()
    const initial = await f.run(f.tools.browserNavigate, { url: 'https://example.com/form' })
    expect(initial.data).toContain('@e1 textbox "Email" value="" invalid="true"')
    expect(initial.data).toContain('@e3 checkbox "Consent" checked=false')
    expect(initial.data).toContain('statictext "What is your email address?"')

    const filled = await f.run(f.tools.browserFillForm, { fields, observation: 'diff' })
    expect(filled.isError).toBeUndefined()
    expect(filled.data).toContain('Observation v2 diff from v1')
    expect(filled.data).toContain('~ [0] @e1 textbox "Email" value="ada@example.com" invalid="false"')
    expect(filled.data).toContain('~ [2] @e3 checkbox "Consent" checked=true')
    expect(filled.data).toContain('~ [3] statictext "Which country do you live in?"')
    // Static rows participate in diffs, but never acquire actionable refs.
    expect(filled.data).not.toMatch(/@e\d+ statictext/)
    expect(filled.data).not.toMatch(/nodeId|documentId|scan-/)

    const cleared = await f.run(f.tools.browserFillForm, {
      fields: [
        { action: 'fill', ref: '@e1', value: '' },
        { action: 'check', ref: '@e3', checked: false },
      ],
      observation: 'diff',
    })
    expect(cleared.isError).toBeUndefined()
    expect(cleared.data).toContain('Observation v3 diff from v2')
    expect(cleared.data).toContain('~ [0] @e1 textbox "Email" value="" invalid="true"')
    expect(cleared.data).toContain('~ [2] @e3 checkbox "Consent" checked=false')
    expect(cleared.data).toContain('~ [3] statictext "What is your email address?"')
    expect(f.snapshot.mock.calls.map(call => call[1]?.mode)).toEqual(['full', 'full', 'full'])
  })

  it.each([23_999, 24_000, 24_001])('invalidates the baseline and refs only when the final batch output (%i chars) exceeds the cap', async size => {
    async function batchWithError(error: string) {
      const f = fixture()
      await f.run(f.tools.browserNavigate, { url: 'https://example.com/form' })
      f.fillForm.mockResolvedValueOnce({ fields: [{ ref: 'scan-1-email', status: 'failed', error }] })
      const result = await f.run(f.tools.browserFillForm, { fields: [fields[0]], observation: 'diff' })
      return { ...f, result }
    }
    // Calibrate only the summary padding: the observation itself stays small,
    // so this tests the final-output guard, not the snapshot's 20k safeguard.
    const sample = await batchWithError('x')
    const f = await batchWithError('x'.repeat(size - String(sample.result.data).length + 1))
    expect(f.tools.browserFillForm.maxResultSizeChars).toBe(24_000)
    expect(f.result.isError).toBe(true)
    expect(f.result.meta).toMatchObject({ fields: 1, succeeded: 0 })
    // execute returns raw data; the downstream executor applies the tool cap.
    const output = String(f.result.data)
    expect(output).toHaveLength(size)
    expect(output).toContain('Observation v2 diff from v1')
    expect(output.slice(output.indexOf('Observation'))).toHaveLength(
      String(sample.result.data).slice(String(sample.result.data).indexOf('Observation')).length,
    )
    expect(output.slice(output.indexOf('Observation')).length).toBeLessThan(20_000)

    const overCap = size > 24_000
    // Cached labels must be cleared too: a now-unknown click fails closed.
    expect(await f.tools.browserClick.resolveConfirmation!(context, { ref: '@e1' })).toBe(overCap)
    const typed = await f.run(f.tools.browserType, { ref: '@e1', text: 'retry' })
    if (overCap) {
      expect(typed.isError).toBe(true)
      expect(typed.data).toContain('Stale or unknown browser ref @e1')
      expect(f.provider.type).not.toHaveBeenCalled()
    } else {
      expect(typed.isError).toBeUndefined()
      expect(f.provider.type).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'scan-2-email', 'retry')
    }
    const next = await f.run(f.tools.browserSnapshot, { mode: 'full', observation: 'diff' })
    expect(next.isError).toBeUndefined()
    if (overCap) {
      expect(next.data).toContain('Observation v3 full')
      expect(next.data).not.toContain('diff from')
      expect(next.data).not.toContain('@e1 textbox')
      expect(next.data).toContain('statictext "What is your email address?"')
    } else {
      expect(next.data).toContain('Observation v3 diff from v2')
      expect(next.data).toContain('No changes.')
    }
  })

  it('blocks policy-denied batches before any backend access', async () => {
    const resolvePolicy = vi.fn(async () => 'block' as const)
    const f = fixture({ resolvePolicy })
    const result = await f.run(f.tools.browserFillForm, { fields })
    expect(result.isError).toBe(true)
    expect(result.data).toContain('blocked by tool policy')
    expect(resolvePolicy).toHaveBeenCalledWith('browserFillForm', { userId: 'user', assistantId: 'assistant' })
    expect(f.fillForm).not.toHaveBeenCalled()
    expect(f.snapshot).not.toHaveBeenCalled()
    expect(f.mutations).toEqual([])
  })

  it.each(['ask', 'allow'] as const)('honors the %s policy confirmation gate without touching the provider', async policy => {
    const resolvePolicy = vi.fn(async () => policy)
    const f = fixture({ resolvePolicy })
    expect(await f.tools.browserFillForm.resolveConfirmation!(context, { fields })).toBe(policy === 'ask')
    expect(resolvePolicy).toHaveBeenCalledWith('browserFillForm', { userId: 'user', assistantId: 'assistant' })
    expect(f.fillForm).not.toHaveBeenCalled()
    expect(f.snapshot).not.toHaveBeenCalled()
    expect(f.tools.browserFillForm.requiresCapability).toBe('computer')
    expect(f.tools.browserFillForm.isReadOnly).toBe(false)
    expect(f.tools.browserFillForm.isConcurrencySafe).toBe(false)
  })

  it.each([
    { name: 'disabled unattended mode', options: {}, message: 'autonomous' },
    { name: 'free plan', options: { unattendedEnabled: (): boolean => true, getWorkspacePlan: async () => 'free' }, message: 'paid plans' },
    { name: 'missing plan resolver', options: { unattendedEnabled: (): boolean => true }, message: 'paid plans' },
  ])('blocks autonomous batches with $name before backend access', async ({ options, message }) => {
    const f = fixture(options)
    const result = await f.run(f.tools.browserFillForm, { fields }, { ...context, channelType: 'workflow' })
    expect(result.isError).toBe(true)
    expect(result.data).toContain(message)
    expect(f.fillForm).not.toHaveBeenCalled()
    expect(f.snapshot).not.toHaveBeenCalled()
    expect(f.mutations).toEqual([])
  })

  it('allows autonomous batches when unattended mode and a paid plan are both enabled', async () => {
    const f = fixture({ unattendedEnabled: (): boolean => true, getWorkspacePlan: async () => 'pro' })
    const ctx = { ...context, channelType: 'workflow' }
    await f.run(f.tools.browserSnapshot, { mode: 'full' }, ctx)
    const result = await f.run(f.tools.browserFillForm, { fields }, ctx)
    expect(result.isError).toBeUndefined()
    expect(f.fillForm).toHaveBeenCalledTimes(1)
    expect(f.mutations).toHaveLength(3)
  })

  it('reports an unsupported backend without silently falling back to individual mutations', async () => {
    const f = fixture({ cloudAvailable: () => true })
    delete f.provider.fillForm
    const result = await f.run(f.tools.browserFillForm, { fields })
    expect(result.isError).toBe(true)
    expect(result.data).toContain('Batch form filling is unavailable')
    expect(f.fillForm).not.toHaveBeenCalled()
    expect(f.provider.type).not.toHaveBeenCalled()
    expect(f.provider.click).not.toHaveBeenCalled()
    expect(f.snapshot).not.toHaveBeenCalled()
  })

  it('preflights the entire batch: a stale later ref prevents even the valid first mutation', async () => {
    const f = fixture()
    await f.run(f.tools.browserSnapshot, { mode: 'full' })
    // Switching observation modes expires the previous refs.
    const latest = await f.run(f.tools.browserSnapshot)
    const currentRef = String(latest.data).match(/(@e\d+) textbox "Email"/)?.[1]
    expect(currentRef).toBeDefined()
    expect(currentRef).not.toBe('@e1')
    const result = await f.run(f.tools.browserFillForm, {
      fields: [{ ...fields[0], ref: currentRef }, fields[1]],
    })
    expect(result.isError).toBe(true)
    expect(result.data).toContain('Stale or unknown browser ref @e2')
    expect(f.fillForm).not.toHaveBeenCalled()
    expect(f.mutations).toEqual([])
    expect(f.snapshot).toHaveBeenCalledTimes(2)
  })

  it('preserves partial results, remaps their refs, and returns a fresh diff of successful mutations', async () => {
    const f = fixture()
    await f.run(f.tools.browserNavigate, { url: 'https://example.com/form' })
    f.failSecond()
    const result = await f.run(f.tools.browserFillForm, { fields, observation: 'diff' })
    expect(result.isError).toBe(true)
    expect(result.meta).toMatchObject({ fields: 3, succeeded: 1 })
    expect(result.data).toContain('@e1: success\n@e2: failed — Option unavailable\n@e3: skipped')
    expect(result.data).toContain('v2 diff from v1')
    expect(result.data).toContain('~ [0] @e1 textbox "Email" value="ada@example.com"')
    expect(result.data).not.toContain('scan-')
    expect(f.fillForm).toHaveBeenCalledTimes(1)
    expect(f.mutations).toEqual([{ ...fields[0], ref: 'scan-1-email' }])
    expect(f.tools.getSessionTrace('session').filter(row => row.action === 'fill')).toEqual([
      { action: 'fill', detail: 'Email', text: 'ada@example.com' },
    ])
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    // The refreshed mapping is immediately usable, not just rendered text.
    expect((await f.run(f.tools.browserType, { ref: '@e1', text: 'corrected' })).isError).toBeUndefined()
    expect(f.provider.type).toHaveBeenCalledWith(expect.anything(), 'scan-2-email', 'corrected')
  })

  it.each([
    ['empty batch', []],
    ['over 50 fields', Array.from({ length: 51 }, (_, i) => ({ action: 'fill', ref: `@e${i}`, value: '' }))],
    ['duplicate refs across actions', [fields[0], { action: 'check', ref: '@e1', checked: true }]],
    ['empty ref', [{ action: 'fill', ref: '', value: 'x' }]],
    ['oversized fill', [{ action: 'fill', ref: '@e1', value: 'x'.repeat(20001) }]],
    ['oversized select', [{ action: 'select', ref: '@e1', value: 'x'.repeat(20001) }]],
    ['non-boolean check', [{ action: 'check', ref: '@e1', checked: 'true' }]],
    ['missing value', [{ action: 'fill', ref: '@e1' }]],
    ['unsupported submit', [{ action: 'submit', ref: '@e1' }]],
    ['extra field properties', [{ ...fields[0], selector: '#email' }]],
  ])('rejects invalid schema: %s', (_name, invalidFields) => {
    const f = fixture()
    expect(() => f.tools.browserFillForm.inputSchema.parse({ fields: invalidFields })).toThrow()
    expect(f.fillForm).not.toHaveBeenCalled()
  })

  it('accepts exact schema bounds, empty replacement text, and false checkbox state', () => {
    const f = fixture()
    const bounded = Array.from({ length: 50 }, (_, i) => ({ action: 'fill', ref: `@e${i}`, value: '' }))
    bounded[0]!.value = 'x'.repeat(20000)
    expect(f.tools.browserFillForm.inputSchema.parse({ fields: bounded })).toEqual({ fields: bounded, observation: 'auto' })
    expect(() => f.tools.browserFillForm.inputSchema.parse({ fields: [
      { action: 'select', ref: '@e1', value: 'x'.repeat(20000) },
      { action: 'check', ref: '@e2', checked: false },
    ] })).not.toThrow()
    expect(() => f.tools.browserFillForm.inputSchema.parse({ fields, observation: 'invalid' })).toThrow()
  })
})
