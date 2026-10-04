import { describe, expect, it } from 'vitest'
import { VisualApprovalSchema, ActionSchema, BoundsSchema, CapabilitiesSchema, ClientMessageSchema, CommandSchema, FrameSchema, GrantSchema, IdentitySchema, NATIVE_PROTOCOL, ObservationSchema, ReceiptSchema, ServerMessageSchema, StatusSchema, TargetSchema, MAX_MESSAGE_BYTES, framePoint, parseMessage, sameIdentity, sameTarget } from '../protocol.js'

const identity = { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'dev', sessionId: 's', conversationId: 'c', taskId: 't' }
const target = { appId: 'editor', processId: 1, processInstanceId: 'pi', windowId: 'w', windowInstanceId: 'wi' }
const bounds = { x: -100, y: 20, width: 200, height: 100 }
const frame = { id: 'f', mimeType: 'image/png' as const, data: '', width: 400, height: 200, bounds, displayLayoutVersion: 'layout' }
const grant = { protocol: NATIVE_PROTOCOL, identity, grantId: 'g', epoch: 1, expiresAt: 1000, targets: [target], allowControl: true, allowCapture: true, requester: 'User', goal: 'Read' }
const capabilities = { protocol: NATIVE_PROTOCOL, platform: 'darwin', axRead: true, semanticActions: true, windowCapture: true, input: true, accessibilityPermission: 'granted', capturePermission: 'granted', limitations: [] }
const command = { protocol: NATIVE_PROTOCOL, identity, grantId: 'g', epoch: 1, commandId: 'cmd', deadlineAt: 1000, action: { kind: 'observe', target } }
const node = { ref: 'r', role: 'password', name: '', enabled: true, focused: false, selected: false, sensitive: true, actions: [] }
const observation = { identity, epoch: 1, id: 'o', capturedAt: 100, monotonicMs: 50, target, foreground: true, bounds, displayLayoutVersion: 'layout', completeness: 'complete', nodes: [node], frame }
const status = { protocol: NATIVE_PROTOCOL, state: 'active', epoch: 1, capabilities, identity }

describe('native shared protocol', () => {
  it.each([
    ['identity', IdentitySchema, identity], ['target', TargetSchema, target], ['bounds', BoundsSchema, bounds],
    ['grant', GrantSchema, grant], ['capabilities', CapabilitiesSchema, capabilities], ['frame', FrameSchema, frame],
    ['observation', ObservationSchema, observation], ['command', CommandSchema, command], ['status', StatusSchema, status],
    ['receipt', ReceiptSchema, { commandId: 'cmd', outcome: 'executed', code: 'ok' }],
    ['client', ClientMessageSchema, { type: 'hello', protocol: NATIVE_PROTOCOL, token: 'secret' }],
    ['server', ServerMessageSchema, { type: 'ready', identity }], ['action', ActionSchema, command.action],
  ])('%s accepts its contract and rejects extra authority fields', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true)
    expect(schema.safeParse({ ...value, injected: true }).success).toBe(false)
  })
  it.each([GrantSchema, CommandSchema, CapabilitiesSchema, StatusSchema])('rejects missing and unsupported protocol versions', schema => {
    const value = schema === GrantSchema ? grant : schema === CommandSchema ? command : schema === CapabilitiesSchema ? capabilities : status
    for (const protocol of [undefined, 'native-computer-v2', 'browser-v1']) expect(schema.safeParse({ ...value, protocol }).success).toBe(false)
  })
  it('keeps visual support explicit, optional and separate from raw input', () => {
    expect(CapabilitiesSchema.parse(capabilities).visualInvokeVersion).toBeUndefined()
    expect(CapabilitiesSchema.parse({ ...capabilities, input: false, visualInvokeVersion: 1 }).input).toBe(false)
    for (const visualInvokeVersion of [0, 2, true, '1', null]) {
      expect(CapabilitiesSchema.safeParse({ ...capabilities, visualInvokeVersion }).success).toBe(false)
    }
    expect(ObservationSchema.parse({ ...observation, captureCohort: 'public-shapes-v1' }).captureCohort).toBe('public-shapes-v1')
    for (const captureCohort of ['public', 'safe-canvas', true, null]) {
      expect(ObservationSchema.safeParse({ ...observation, captureCohort }).success).toBe(false)
    }
  })
  it('validates visual proposals separately from native resolved approval', () => {
    const action = { kind: 'visualInvoke', target, observationId: 'o', frameId: 'f', x: 10.5, y: 20.5 }
    expect(ActionSchema.parse(action)).toEqual(action)
    expect(CommandSchema.parse({ ...command, action }).action).toEqual(action)
    for (const patch of [{ x: -1 }, { x: NaN }, { y: Infinity }, { frameId: '' }, { ref: 'forged' }, { bindingId: 'forged' }, { safe: true }]) {
      expect(ActionSchema.safeParse({ ...action, ...patch }).success).toBe(false)
    }
    const approval = { bindingId: 'b', commandId: 'cmd', frameId: 'f', action: { kind: 'invoke', target, observationId: 'o', ref: 'native-ref' } }
    expect(VisualApprovalSchema.parse(approval)).toEqual(approval)
    for (const value of [true, false, { ...approval, bindingId: '' }, { ...approval, approved: true }, { ...approval, action }, { ...approval, action: { ...approval.action, x: 1 } }]) {
      expect(VisualApprovalSchema.safeParse(value).success).toBe(false)
    }
  })
  it('rejects unknown wire messages and nested extra fields', () => {
    expect(ClientMessageSchema.safeParse({ type: 'hello', protocol: 'native-computer-v2', token: 'x' }).success).toBe(false)
    for (const type of ['start', 'resume', 'approve']) expect(ServerMessageSchema.safeParse({ type }).success).toBe(false)
    expect(CommandSchema.safeParse({ ...command, identity: { ...identity, token: 'secret' } }).success).toBe(false)
    expect(ObservationSchema.safeParse({ ...observation, nodes: [{ ...node, secret: 'value' }] }).success).toBe(false)
  })
  it('enforces numeric, collection, and text bounds', () => {
    for (const width of [0, -1, 32769, Infinity, NaN]) expect(BoundsSchema.safeParse({ ...bounds, width }).success).toBe(false)
    expect(BoundsSchema.safeParse({ ...bounds, x: Infinity }).success).toBe(false)
    for (const width of [0, 8193, 1.5]) expect(FrameSchema.safeParse({ ...frame, width }).success).toBe(false)
    for (const epoch of [-1, 1.5, Infinity]) expect(CommandSchema.safeParse({ ...command, epoch }).success).toBe(false)
    for (const targets of [[], Array(9).fill(target)]) expect(GrantSchema.safeParse({ ...grant, targets }).success).toBe(false)
    expect(GrantSchema.safeParse({ ...grant, goal: 'x'.repeat(2001) }).success).toBe(false)
    expect(ObservationSchema.safeParse({ ...observation, nodes: Array(501).fill(node) }).success).toBe(false)
    for (const deltaY of [-601, 601, 0.5]) expect(ActionSchema.safeParse({ kind: 'scroll', target, observationId: 'o', ref: 'r', deltaY }).success).toBe(false)
  })
  it('requires secure nodes to redact names, values and actions', () => {
    expect(ObservationSchema.safeParse(observation).success).toBe(true)
    for (const leak of [{ name: 'password' }, { value: '' }, { value: 'secret' }, { actions: ['setValue'] }]) {
      expect(ObservationSchema.safeParse({ ...observation, nodes: [{ ...node, ...leak }] }).success).toBe(false)
    }
    expect(ObservationSchema.safeParse({ ...observation, nodes: [{ ...node, sensitive: false, name: 'Public', value: 'Text', actions: ['invoke'] }] }).success).toBe(true)
  })
  it('compares every identity and target scope field', () => {
    expect(sameIdentity(identity, { ...identity })).toBe(true)
    for (const key of Object.keys(identity)) expect(sameIdentity(identity, { ...identity, [key]: 'other' })).toBe(false)
    expect(sameTarget(target, { ...target })).toBe(true)
    for (const key of Object.keys(target)) expect(sameTarget(target, { ...target, [key]: key === 'processId' ? 2 : 'other' })).toBe(false)
  })
  it('maps frame-local pixels to desktop coordinates with scaling and negative origins', () => {
    expect(framePoint(frame, 0, 0)).toEqual({ x: -100, y: 20 })
    expect(framePoint(frame, 200, 100)).toEqual({ x: 0, y: 70 })
    expect(framePoint(frame, 399, 199)).toEqual({ x: 99.5, y: 119.5 })
    for (const [x, y] of [[-1, 0], [0, -1], [400, 0], [0, 200], [NaN, 0], [0, Infinity]]) expect(() => framePoint(frame, x, y)).toThrow('Point outside capture')
  })
  it('bounds raw messages by UTF-8 bytes, not characters, and rejects invalid JSON', () => {
    const exact = `"${'a'.repeat(MAX_MESSAGE_BYTES - 2)}"`
    expect(parseMessage(exact)).toHaveLength(MAX_MESSAGE_BYTES - 2)
    expect(() => parseMessage(exact + ' ')).toThrow('Native message too large')
    expect(() => parseMessage(`"${'é'.repeat(MAX_MESSAGE_BYTES / 2)}"`)).toThrow('Native message too large')
    expect(() => parseMessage('{')).toThrow()
  })
})

it('keeps bounded optional discovery labels out of every authoritative target shape', async () => {
  const { DiscoveredTargetSchema } = await import('../protocol.js')
  expect(DiscoveredTargetSchema.parse(target)).toEqual(target)
  const discovered = { ...target, displayName: '😀'.repeat(128) }
  expect(DiscoveredTargetSchema.parse(discovered)).toEqual(discovered)
  for (const displayName of ['😀'.repeat(129), 'a'.repeat(257), 3, null]) expect(DiscoveredTargetSchema.safeParse({ ...target, displayName }).success).toBe(false)
  expect(DiscoveredTargetSchema.safeParse({ ...discovered, token: 'extra' }).success).toBe(false)
  expect(sameTarget(discovered, { ...target, displayName: 'renamed' } as typeof discovered)).toBe(true)
  expect(sameTarget(discovered, { ...discovered, windowInstanceId: 'reused' })).toBe(false)
  expect(TargetSchema.safeParse(discovered).success).toBe(false)
  expect(GrantSchema.safeParse({ ...grant, targets: [discovered] }).success).toBe(false)
  expect(ActionSchema.safeParse({ kind: 'observe', target: discovered }).success).toBe(false)
  expect(ObservationSchema.safeParse({ ...observation, target: discovered }).success).toBe(false)
})
