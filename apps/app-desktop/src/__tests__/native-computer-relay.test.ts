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
  const controller = { status: () => ({ state: 'active', identity }), relayDisconnected: vi.fn(), execute: vi.fn() }
  const make = vi.fn(() => socket as unknown as WebSocket)
  const relay = new NativeRelayClient(controller as unknown as NativeComputerController, identity, make)
  return { socket, controller, relay, make }
}
describe('native relay client', () => {
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
