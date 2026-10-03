import { describe, it, expect, vi } from 'vitest'
import { NativeRelayClient } from '../computer-control/relay-client.js'
import type { NativeComputerController } from '../computer-control/controller.js'
class Socket extends EventTarget {
  readyState = 1
  sent: string[] = []
  send(value: string) { this.sent.push(value) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
}
const identity = { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'dev', sessionId: 's', conversationId: 'c', taskId: 't' }
function setup() {
  const socket = new Socket()
  const controller = { status: () => ({ state: 'active', epoch: 1, identity }), relayDisconnected: vi.fn(), execute: vi.fn() }
  const make = vi.fn(() => socket as unknown as WebSocket)
  const relay = new NativeRelayClient(controller as unknown as NativeComputerController, identity, make)
  return { socket, controller, relay, make }
}
describe('native relay client', () => {
  it('sends downgraded status before the successful receipt and before dispatching another command', async () => {
    const { relay, socket, controller } = setup()
    let caps = { semanticActions: true, input: true, axRead: true, windowCapture: true }
    controller.status = () => ({ state: 'active', epoch: 1, identity, capabilities: caps })
    const target = { appId: 'fixture', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
    const command = { protocol: 'native-computer-v1', identity, epoch: 1, grantId: 'g', commandId: 'click', deadlineAt: Date.now() + 10000,
      action: { kind: 'click', target, observationId: 'o', frameId: 'f', x: 1, y: 1 } }
    controller.execute.mockImplementation(async (c: typeof command) => {
      if (c.commandId === 'second') expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'receipt', receipt: { commandId: 'click' } })
      caps = { ...caps, semanticActions: false, input: false }
      return { commandId: c.commandId, code: 'ok', outcome: 'executed' }
    })
    try {
      relay.connect('wss://relay.example/native-computer-v1', 'token')
      socket.message({ type: 'ready', identity })
      socket.message({ type: 'command', command })
      socket.message({ type: 'command', command: { ...command, commandId: 'second' } })
      await vi.waitFor(() => expect(socket.sent).toHaveLength(5))
      expect(socket.sent.map(s => JSON.parse(s).type)).toEqual(['status', 'status', 'receipt', 'status', 'receipt'])
      expect(JSON.parse(socket.sent[1])).toMatchObject({ type: 'status', status: { state: 'active', epoch: 1, identity,
        capabilities: { semanticActions: false, input: false, axRead: true, windowCapture: true } } })
    } finally { relay.disconnect() }
  })
  it.each(['stop', 'account', 'epoch', 'send-failure'] as const)('does not deliver a receipt after %s during execution/publication', async race => {
    const { relay, socket, controller } = setup()
    let resolve!: (value: unknown) => void
    controller.execute.mockImplementation(() => new Promise(r => { resolve = r }))
    const target = { appId: 'fixture', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
    const command = { protocol: 'native-computer-v1', identity, epoch: 1, grantId: 'g', commandId: 'c', deadlineAt: Date.now() + 10000, action: { kind: 'observe', target } }
    relay.connect('wss://relay.example/native-computer-v1', 'token')
    socket.message({ type: 'ready', identity })
    socket.message({ type: 'command', command })
    await vi.waitFor(() => expect(controller.execute).toHaveBeenCalledOnce())
    if (race === 'send-failure') socket.send = () => { throw new Error('closed') }
    else controller.status = () => ({ state: race === 'stop' ? 'stopped' : 'active', epoch: race === 'epoch' ? 3 : race === 'stop' ? 2 : 1,
      identity: race === 'account' ? { ...identity, userId: 'other' } : identity })
    resolve({ commandId: 'c', code: 'ok', outcome: 'executed' })
    await vi.waitFor(() => expect(socket.readyState).toBe(3))
    expect(controller.relayDisconnected).toHaveBeenCalledTimes(race === 'send-failure' ? 1 : 0)
    expect(socket.sent.map(s => JSON.parse(s).type)).toEqual(['status'])
  })
  it('does not dispatch an old queued command or revoke the replacement generation', async () => {
    const { relay, socket, controller } = setup()
    relay.connect('wss://relay.example/native-computer-v1', 'token')
    socket.message({ type: 'ready', identity })
    socket.message({ type: 'command', command: { protocol: 'native-computer-v1', identity, epoch: 1, grantId: 'g', commandId: 'c', deadlineAt: Date.now() + 10000,
      action: { kind: 'observe', target: { appId: 'fixture', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' } } } })
    controller.status = () => ({ state: 'active', epoch: 3, identity })
    await vi.waitFor(() => expect(socket.readyState).toBe(3))
    expect(controller.execute).not.toHaveBeenCalled()
    expect(controller.relayDisconnected).not.toHaveBeenCalled()
  })
  it('uses separate native hello, checks identity, revokes on loss and never reconnects', () => {
    const { socket, controller, relay, make } = setup()
    relay.connect('wss://relay.example/native-computer-v1', 'native-token')
    socket.dispatchEvent(new Event('open'))
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'hello', protocol: 'native-computer-v1', token: 'native-token' })
    socket.message({ type: 'ready', identity: { ...identity, userId: 'other' } })
    expect(controller.relayDisconnected).toHaveBeenCalledOnce(); expect(controller.execute).not.toHaveBeenCalled()
    expect(() => relay.connect('wss://relay.example/native-computer-v1', 'native-token')).toThrow(); expect(make).toHaveBeenCalledOnce()
  })
  it('never permits relay start/resume or plaintext URLs', () => {
    const { relay, socket, controller } = setup()
    expect(() => relay.connect('ws://relay.example/native-computer-v1', 'token')).toThrow()
    relay.connect('wss://relay.example/native-computer-v1', 'token')
    socket.message({ type: 'resume' })
    expect(controller.relayDisconnected).toHaveBeenCalledOnce(); expect(controller.execute).not.toHaveBeenCalled()
  })
})
