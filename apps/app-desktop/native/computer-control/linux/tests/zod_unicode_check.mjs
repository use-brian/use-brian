// Cross-check the actual shared Zod schemas against Python's private validators.
// Test runner only: child stdout contains booleans, never tested strings/AX data.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { IdentitySchema, TargetSchema, GrantSchema, CommandSchema, AxNodeSchema } from '../../../../../../packages/computer-control/src/protocol.ts'

const python = process.argv[2]
if (!python?.startsWith('/')) throw new Error('Pass a fixed absolute test Python interpreter')
const root = fileURLToPath(new URL('../', import.meta.url))
const emoji = String.fromCodePoint(0x1f600)
const combining = 'e' + String.fromCodePoint(0x301)
const identity = Object.fromEntries(['deploymentId', 'userId', 'workspaceId', 'deviceId', 'sessionId', 'conversationId', 'taskId'].map(k => [k, k]))
const target = { appId: 'fixture', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
const grant = { protocol: 'native-computer-v1', identity, grantId: 'g', epoch: 1, expiresAt: Date.now() + 60_000, targets: [target], allowControl: true, allowCapture: false, requester: 'local', goal: 'audit' }
const command = { protocol: 'native-computer-v1', identity, grantId: 'g', epoch: 1, commandId: 'c', deadlineAt: Date.now() + 30_000, action: { kind: 'setValue', target, observationId: 'o', ref: 'r', text: '' } }
const node = { ref: 'r', role: 'text', name: '', enabled: true, focused: false, selected: false, sensitive: false, actions: [] }
const cases = []
function add(operation, value, schema, candidate, expected) {
  const valid = schema.safeParse(candidate).success
  if (valid !== expected) throw new Error(`Unexpected shared-schema result for ${operation}; case ${cases.length}`)
  cases.push({ operation, value, expected: valid })
}
for (const [count, expected] of [[128, true], [129, false]]) {
  for (const field of Object.keys(identity)) {
    const candidate = { ...identity, [field]: emoji.repeat(count) }
    add('identity', candidate, IdentitySchema, candidate, expected)
  }
  for (const field of Object.keys(target).filter(k => k !== 'processId')) {
    const candidate = { ...target, [field]: emoji.repeat(count) }
    add('target', candidate, TargetSchema, candidate, expected)
  }
  for (const field of ['grantId', 'commandId', 'observationId', 'ref', 'frameId']) {
    const candidate = structuredClone(command)
    if (field === 'grantId' || field === 'commandId') candidate[field] = emoji.repeat(count)
    else if (field === 'frameId') candidate.action = { kind: 'click', target, observationId: 'o', frameId: emoji.repeat(count), x: 0, y: 0 }
    else candidate.action[field] = emoji.repeat(count)
    add('command', candidate, CommandSchema, candidate, expected)
  }
}
for (const [field, max] of [['grantId', 256], ['requester', 200], ['goal', 2000]]) {
  for (const [count, expected] of [[max / 2, true], [max / 2 + 1, false]]) {
    const candidate = { ...grant, [field]: emoji.repeat(count) }
    add('grant', candidate, GrantSchema, candidate, expected)
  }
}
for (const symbol of [emoji, combining]) {
  for (const [count, expected] of [[2048, true], [2049, false]]) {
    const value = symbol.repeat(count)
    const candidate = { ...command, action: { ...command.action, text: value } }
    add('command', candidate, CommandSchema, candidate, expected)
    add('axText', value, AxNodeSchema, { ...node, name: value }, expected)
    add('axText', value, AxNodeSchema, { ...node, value }, expected)
  }
}
for (const [count, expected] of [[50, true], [51, false]]) {
  const value = emoji.repeat(count)
  add('role', value, AxNodeSchema, { ...node, role: value }, expected)
}
const code = `
import json,sys
sys.path.insert(0,sys.argv[1])
import contract as C
validators={'identity':C.identity,'target':C.target,'grant':C.grant,'command':C.command,'axText':lambda v:C.text(v,C.AX_TEXT_UNITS,0),'role':lambda v:C.text(v,C.ROLE_UNITS,0)}
items=json.load(sys.stdin)
print(json.dumps([validators[item['operation']](item['value']) for item in items]))
`
const result = spawnSync(python, ['-Es', '-c', code, root], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 30_000 })
if (result.error || result.status !== 0) throw new Error('Python Unicode oracle failed (details withheld)')
const actual = JSON.parse(result.stdout)
if (actual.length !== cases.length || actual.some((valid, i) => valid !== cases[i].expected)) throw new Error('Python/Zod Unicode boundary mismatch (values withheld)')
console.log(`PASS: ${cases.length} Python/shared-Zod UTF-16 boundary comparisons; no values logged`)
