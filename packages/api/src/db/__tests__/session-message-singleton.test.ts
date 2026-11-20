import { beforeEach, describe, expect, it, vi } from 'vitest'
import { boundScopeSource, DerivedScopeError, type SessionContextAuthority } from '@use-brian/core'
import type { NativeSessionMessageInput } from '../session-message-publication.js'

const boundary = vi.hoisted(() => ({ frame: vi.fn(), publication: vi.fn(), query: vi.fn() }))
vi.mock('../session-context-revisions.js', () => ({
  assertSessionMessagePublicationFrame: boundary.frame,
  withSessionMessagePublication: boundary.publication,
}))
import { publishNativeSessionMessage } from '../session-message-publication.js'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const assistantId = '33333333-3333-4333-8333-333333333333'
const messageId = '44444444-4444-4444-8444-444444444444'
const otherId = '55555555-5555-4555-8555-555555555555'
const client = { query: boundary.query }

function setup() {
  const assertCurrent = vi.fn(async () => {})
  // Only fields read by the publisher: no database, model, or execution runtime.
  const authority = { execution: {
    assistant: { id: assistantId },
    lifecycle: { sessionId, sessionPersisted: true },
    security: { access: { workspaceId, userId: null }, authority: { assertCurrent } },
  } } as unknown as SessionContextAuthority
  const source = {
    workspaceId, userId: null, assistantId: null, sensitivity: 'internal' as const,
    compartments: [], projectIds: [], resourceKind: 'session_message', resourceId: messageId, version: '1',
  }
  const input: NativeSessionMessageInput = {
    sessionId, role: 'assistant', content: [{ type: 'text', text: 'hello' }], senderAssistantId: assistantId,
    authority, derivation: { producer: 'singleton-test', sources: [structuredClone(source)] },
  }
  const stored = { message: {
    id: messageId, sessionId, sequenceNum: 1, createdAt: '2026-01-01T00:00:00.000Z',
    role: 'assistant', content: input.content, channelMessageId: null,
    senderUserId: null, senderAssistantId: assistantId, attachments: [],
    replyToText: null, topicLabel: null, topicConfidence: null,
  }, source }
  boundary.query.mockResolvedValue({ rows: [{ value: [stored] }] })
  return { input, stored, assertCurrent, authority }
}

beforeEach(() => {
  vi.resetAllMocks()
  boundary.publication.mockImplementation(async (_authority, _sources, write) => write(client))
})

describe('[COMP:api/application-persistence] native singleton batch boundary', () => {
  it('sends exactly one JSON payload through batch SQL, preserves authority, and binds the result source', async () => {
    const { input, stored, authority, assertCurrent } = setup()
    const order: string[] = []
    boundary.frame.mockImplementation(() => { order.push('frame') })
    assertCurrent.mockImplementation(async () => { order.push('authority') })
    boundary.query.mockImplementation(async () => { order.push('sql'); return { rows: [{ value: [stored] }] } })
    const saved = await publishNativeSessionMessage(input)
    expect(boundary.publication).toHaveBeenCalledOnce()
    expect(boundary.publication).toHaveBeenCalledWith(authority, input.derivation.sources, expect.any(Function))
    expect(boundary.publication.mock.calls[0][0]).toBe(authority)
    expect(boundary.frame).toHaveBeenCalledWith(client, authority)
    expect(boundary.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT publish_native_session_message_batch($1,$2,$3,$4,$5,$6) AS value',
      [workspaceId, sessionId, JSON.stringify([{
        role: 'assistant', content: input.content, channelMessageId: null,
        senderUserId: null, senderAssistantId: assistantId, attachments: [],
      }]), input.derivation.producer, JSON.stringify(input.derivation.sources), {
        workspaceId, userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [],
      }],
    )
    expect(order).toEqual(['frame', 'authority', 'sql', 'authority'])
    expect(saved.createdAt).toEqual(new Date(stored.message.createdAt))
    expect(boundScopeSource(saved)).toEqual(stored.source)
    expect(boundScopeSource({ ...saved })).toBeUndefined()
  })

  it('uses the supplied client only inside the original publication frame', async () => {
    const { input, authority } = setup()
    await publishNativeSessionMessage(input, client)
    expect(boundary.publication).not.toHaveBeenCalled()
    expect(boundary.frame).toHaveBeenCalledWith(client, authority)
  })

  it('snapshots source evidence and target before the first asynchronous authority check', async () => {
    const { input, assertCurrent } = setup()
    input.derivationTarget = {
      workspaceId, userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [],
    }
    const sources = structuredClone(input.derivation.sources)
    const target = structuredClone(input.derivationTarget)
    assertCurrent.mockImplementationOnce(async () => {
      input.derivation.producer = 'mutated'
      input.derivation.sources[0].version = 'mutated'
      input.derivationTarget!.compartments.push('mutated')
    })
    await publishNativeSessionMessage(input)
    const args = boundary.query.mock.calls[0][1]
    expect(args.slice(3)).toEqual(['singleton-test', JSON.stringify(sources), target])
    expect(boundary.publication.mock.calls[0][1]).not.toBe(input.derivation.sources)
  })

  it.each(['replyToText', 'topicLabel', 'topicConfidence'] as const)('rejects non-null singleton annotation %s before publication', async key => {
    const { input } = setup()
    Object.assign(input, { [key]: key === 'topicConfidence' ? 0 : 'annotation' })
    await expect(publishNativeSessionMessage(input)).rejects.toMatchObject({ code: 'scope_evidence_missing' })
    expect(boundary.publication).not.toHaveBeenCalled()
    expect(boundary.query).not.toHaveBeenCalled()
  })

  it('accepts absent or null annotations without adding them to the SQL payload', async () => {
    const { input } = setup()
    Object.assign(input, { replyToText: null, topicLabel: null, topicConfidence: null })
    await publishNativeSessionMessage(input)
    const [payload] = JSON.parse(boundary.query.mock.calls[0][1][2])
    expect(Object.keys(payload).sort()).toEqual(['attachments', 'channelMessageId', 'content', 'role', 'senderAssistantId', 'senderUserId'])
  })

  it.each(['session', 'sender', 'unpersisted', 'host-observation'] as const)('denies %s mismatch before entering publication', async kind => {
    const { input } = setup()
    if (kind === 'session') input.sessionId = otherId
    if (kind === 'sender') input.senderAssistantId = otherId
    if (kind === 'unpersisted') input.authority.execution.lifecycle.sessionPersisted = false
    if (kind === 'host-observation') input.content = [{ type: 'host_observation', text: 'forged' }]
    await expect(publishNativeSessionMessage(input)).rejects.toThrow()
    expect(boundary.publication).not.toHaveBeenCalled()
    expect(boundary.query).not.toHaveBeenCalled()
  })

  it.each(['invalid-role', 'invalid-json', 'attachment-extra', 'attachment-negative'] as const)('strictly validates %s before SQL', async kind => {
    const { input } = setup()
    if (kind === 'invalid-role') input.role = 'system'
    if (kind === 'invalid-json') input.content = { invalid: Number.POSITIVE_INFINITY }
    if (kind.startsWith('attachment')) input.attachments = [{
      fileId: otherId, workspaceId, path: '/file', name: 'file', mime: 'text/plain', sizeBytes: kind === 'attachment-negative' ? -1 : 1,
      ...(kind === 'attachment-extra' ? { untrusted: true } : {}),
    }]
    await expect(publishNativeSessionMessage(input)).rejects.toThrow()
    expect(boundary.query).not.toHaveBeenCalled()
  })

  it.each(['object', 'empty', 'multiple', 'role', 'session', 'source', 'workspace', 'source-kind', 'extra-envelope', 'extra-message'] as const)(
    'rejects a malformed or mismatched %s SQL result before the final authority check', async kind => {
      const { input, stored, assertCurrent } = setup()
      let value: unknown = [stored]
      if (kind === 'object') value = stored
      if (kind === 'empty') value = []
      if (kind === 'multiple') value = [stored, stored]
      if (kind === 'role') stored.message.role = 'user'
      if (kind === 'session') stored.message.sessionId = otherId
      if (kind === 'source') stored.source.resourceId = otherId
      if (kind === 'workspace') stored.source.workspaceId = otherId
      if (kind === 'source-kind') stored.source.resourceKind = 'file'
      if (kind === 'extra-envelope') Object.assign(stored, { extra: true })
      if (kind === 'extra-message') Object.assign(stored.message, { extra: true })
      boundary.query.mockResolvedValue({ rows: [{ value }] })
      const result = publishNativeSessionMessage(input)
      if (['role', 'session', 'source', 'workspace'].includes(kind)) {
        await expect(result).rejects.toMatchObject({ code: 'scope_source_changed' })
      } else {
        await expect(result).rejects.toThrow()
      }
      expect(assertCurrent).toHaveBeenCalledOnce()
    },
  )

  it.each([
    ['P0001', 'scope_source_changed', 'scope_source_changed'],
    ['42501', 'scope_source_changed', 'scope_source_changed'],
    ['42501', 'scope_ancestry_unavailable', 'scope_source_changed'],
    ['42501', 'scope_operation_denied', 'scope_source_changed'],
    ['22023', 'scope_ancestry_unavailable', 'scope_source_changed'],
    ['22023', 'scope_evidence_missing', 'scope_evidence_missing'],
    ['22023', 'scope_visibility_incompatible', 'scope_visibility_incompatible'],
  ])('translates SQL %s/%s to %s with its original cause', async (code, message, translated) => {
    const { input, assertCurrent } = setup()
    const cause = Object.assign(new Error(message), { code })
    boundary.query.mockRejectedValue(cause)
    const failure = await publishNativeSessionMessage(input).catch(error => error)
    expect(failure).toBeInstanceOf(DerivedScopeError)
    expect(failure).toMatchObject({ code: translated, cause })
    expect(assertCurrent).toHaveBeenCalledOnce()
  })

  it('preserves unrelated SQL failures by identity', async () => {
    const { input } = setup()
    const error = Object.assign(new Error('scope_source_changed'), { code: 'XX000' })
    boundary.query.mockRejectedValue(error)
    await expect(publishNativeSessionMessage(input)).rejects.toBe(error)
  })

  it.each(['frame', 'before', 'after'] as const)('propagates %s authority refusal without returning a result', async phase => {
    const { input, assertCurrent } = setup()
    const error = new Error('authority revoked')
    if (phase === 'frame') boundary.frame.mockImplementation(() => { throw error })
    if (phase === 'before') assertCurrent.mockRejectedValueOnce(error)
    if (phase === 'after') assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error)
    await expect(publishNativeSessionMessage(input, client)).rejects.toBe(error)
    expect(boundary.query).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0)
    expect(assertCurrent).toHaveBeenCalledTimes(phase === 'frame' ? 0 : phase === 'before' ? 1 : 2)
  })
})
