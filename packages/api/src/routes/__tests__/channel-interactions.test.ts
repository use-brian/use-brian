import { describe, expect, it, vi } from 'vitest'
import { ChannelInteractions, confirmationMessage } from '../channel-interactions.js'

const scope = { channelType: 'slack', integrationId: 'integration', conversationId: 'conversation', senderId: 'sender', sessionId: 'thread' }
const prompt = { toolCallId: 'call', toolName: 'tool', serverName: 'server', input: { detail: 'input fallback' }, description: '', classification: null }

describe('shared channel controls', () => {
  it.each([' stop ', '/STOP', 'cancel', '/cancel', 'abort', '/abort', 'nevermind', '/nevermind', 'never mind', '/never mind'])('consumes %s, denies before abort and acknowledges once', text => {
    const service = new ChannelInteractions()
    const controller = new AbortController()
    const onAbort = vi.fn()
    const order: string[] = []
    const resolve = vi.fn(() => { expect(controller.signal.aborted).toBe(false); order.push('deny') })
    service.registerTurn(scope, controller, { onAbort })
    const dispose = service.register(scope, prompt, { resolve } as never, controller.signal)
    controller.signal.addEventListener('abort', () => order.push('abort'))
    expect(service.handle(scope, { kind: 'text', text }).handled).toBe(true)
    expect(order).toEqual(['deny', 'abort'])
    expect(resolve).toHaveBeenCalledWith('call', 'deny')
    expect(onAbort).toHaveBeenCalledOnce()
    expect(service.handle(scope, { kind: 'text', text }).handled).toBe(false)
    dispose()
  })

  it.each(['channelType', 'integrationId', 'conversationId', 'senderId', 'sessionId'])('cannot cancel a different %s', field => {
    const service = new ChannelInteractions()
    const controller = new AbortController()
    const dispose = service.registerTurn(scope, controller, { onAbort: vi.fn(), messageId: 'original' })
    const other = { ...scope, [field]: 'other' }
    expect(service.handle(other, { kind: 'text', text: 'stop' }).handled).toBe(false)
    expect(service.abortForEdit(other, 'original')).toBe(false)
    expect(controller.signal.aborted).toBe(false)
    dispose()
  })

  it('edits only the original message and never sends a stop acknowledgement', () => {
    const service = new ChannelInteractions()
    const controller = new AbortController()
    const onAbort = vi.fn()
    service.registerTurn(scope, controller, { onAbort, messageId: 'original' })
    expect(service.abortForEdit(scope, undefined)).toBe(false)
    expect(service.abortForEdit(scope, 'next')).toBe(false)
    expect(service.abortForEdit(scope, 'original')).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('identity-safe cleanup cannot remove a successor and external abort unregisters', () => {
    const service = new ChannelInteractions()
    const old = new AbortController()
    const next = new AbortController()
    const dispose = service.registerTurn(scope, old, { onAbort: vi.fn() })
    service.registerTurn(scope, next, { onAbort: () => { throw new Error('delivery failed') } })
    dispose()
    expect(service.handle(scope, { kind: 'text', text: 'stop' }).handled).toBe(true)
    expect(next.signal.aborted).toBe(true)
    expect(old.signal.aborted).toBe(false)
    service.registerTurn(scope, old, { onAbort: vi.fn() })
    old.abort()
    expect(service.handle(scope, { kind: 'text', text: 'stop' }).handled).toBe(false)
  })

  it('preserves prompt input fallback', () => {
    expect(confirmationMessage(prompt).text).toContain('input fallback')
  })

  it('puts complete input behind Watch more only when compact details are requested', () => {
    const request = { ...prompt, displayLines: ['To: recipient@example.com', 'Body: Hello.\nBest regards, Sender', 'Attachment: receipt.pdf'] }
    const compact = confirmationMessage(request, { compactDetails: true })
    expect(compact.text).toContain('Allow this action?')
    expect(compact.text).not.toContain('Body:')
    expect(compact.collapsibleDetails).toBe(`Watch more\n${request.displayLines.join('\n')}`)
    expect(compact.actions).toEqual(confirmationMessage(request).actions)
    expect(confirmationMessage(request).collapsibleDetails).toBeUndefined()
    expect(confirmationMessage(request).text).toContain('Body: Hello.\nBest regards, Sender')
  })
})
