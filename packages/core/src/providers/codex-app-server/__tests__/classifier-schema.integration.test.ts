import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLlmDecisionProvider, type LlmDecisionAnswerFormat } from '../../../decisions/adapters/llm.js'
import type { DecisionQuestion, DecisionRequest } from '../../../decisions/types.js'
import { buildToolSelectionQuestions } from '../../../engine/tool-selection.js'
import { buildCodexEnvironment, buildCodexToolSurfaceArgs, resolvePinnedCodexCommand } from '../process.js'
import { InitializeResponseSchema, PINNED_CODEX_VERSION } from '../protocol.js'
import { createCodexAppServerProvider } from '../provider.js'
import { CodexRpcPeer } from '../rpc.js'

type Schema = {
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  enum?: string[]
  $defs?: Record<string, Schema>
  $ref?: string
}

/** Validate the actual wire schema, not a repaired copy or compiled dist artifact. */
function inspectSchema(root: Schema, questions: DecisionQuestion[], format: LlmDecisionAnswerFormat = 'detailed') {
  let enumValues = 0
  let leafRefs = 0
  const resolve = (node: Schema): Schema => {
    if (!node.$ref) return node
    expect(Object.keys(node)).toEqual(['$ref'])
    expect(node.$ref).toMatch(/^#\/\$defs\/[^/]+$/)
    const leaf = root.$defs?.[node.$ref.slice('#/$defs/'.length)]
    expect(leaf).toBeDefined()
    expect(leaf?.type).toBe('string')
    expect(leaf?.enum).toBeInstanceOf(Array)
    expect(Object.keys(leaf!).sort()).toEqual(['enum', 'type'])
    return leaf!
  }
  const visit = (node: Schema) => {
    if (node.$ref) { resolve(node); leafRefs++ }
    if (node.enum) enumValues += node.enum.length
    if (node.type === 'object') {
      expect(node.additionalProperties).toBe(false)
      expect([...(node.required ?? [])].sort()).toEqual(Object.keys(node.properties ?? {}).sort())
    }
    Object.values(node.properties ?? {}).forEach(visit)
    Object.values(node.$defs ?? {}).forEach(visit)
  }
  visit(root)
  expect(enumValues).toBeLessThanOrEqual(1000)
  expect(root.type).toBe('object')
  expect(Object.keys(root.properties!)).toEqual(['answers'])
  const answers = root.properties!.answers!
  expect(answers.type).toBe('object')
  expect(Object.keys(answers.properties!)).toEqual(questions.map(question => question.id))
  const output: Record<string, unknown> = {}
  for (const question of questions) {
    const answer = answers.properties![question.id]!
    if (format === 'choice_values') {
      if (question.kind !== 'choice') throw new Error('Compact fixture must be choice-only')
      const value = resolve(answer)
      expect(value.type).toBe('string')
      expect(value.enum).toEqual(question.options.map(option => option.value))
      output[question.id] = value.enum![0]
      continue
    }
    expect(answer.type).toBe('object')
    expect(Object.keys(answer.properties!).sort()).toEqual(question.kind === 'boolean'
      ? ['confidence', 'pTrue', 'value'] : ['confidence', 'value'])
    expect(answer.properties!.confidence).toEqual({ type: ['number', 'null'] })
    const value = resolve(answer.properties!.value!)
    if (question.kind === 'choice') {
      expect(value.type).toBe('string')
      // Ordered domains must survive leaf refs unchanged.
      expect(value.enum).toEqual(question.options.map(option => option.value))
      output[question.id] = { value: value.enum![0], confidence: null }
    } else {
      expect(value.type).toBe(question.kind === 'boolean' ? 'boolean' : 'number')
      if (question.kind === 'boolean') {
        expect(answer.properties!.pTrue).toEqual({ type: ['number', 'null'] })
        output[question.id] = { value: false, confidence: null, pTrue: null }
      } else output[question.id] = { value: 1, confidence: null }
    }
  }
  return { enumValues, leafRefs, output }
}

describe('[COMP:providers/codex-classifier-schema] offline pinned runtime', () => {
  it('accepts strict common decisions with shared ranked enums and unavailable uncertainty', async () => {
    expect(PINNED_CODEX_VERSION).toBe('0.165.0')
    const plan = buildToolSelectionQuestions(Array.from({ length: 357 }, (_, index) => ({
      name: `fictional_tool_${index}`, description: `Fictional capability ${index}`,
    })))!
    const choices: DecisionQuestion[] = [{
      kind: 'choice', id: 'intent', prompt: 'Choose a fictional intent.',
      options: ['ordinary', 'research_focused', 'research', 'research_deep', 'operate_site'].map(value => ({ value })),
    }, ...plan.questions]
    expect(choices).toHaveLength(7)
    expect(choices.reduce((sum, question) => sum + (question.kind === 'choice' ? question.options.length : 0), 0)).toBe(1082)
    const mixed: DecisionQuestion[] = [
      { kind: 'boolean', id: 'fictional_flag', prompt: 'Is the fictional flag enabled?' },
      { kind: 'score', id: 'fictional_score', prompt: 'Rate the fictional item.',
        rubric: [{ value: 0, description: 'Absent' }, { value: 1, description: 'Present' }] },
    ]
    const result = await runFixture([choices, mixed, choices], ['detailed', 'detailed', 'choice_values'])
    expect(result.invalidRequests).toBe(0)
    expect(result.invocations).toBe(3)
    expect(result.terminals).toEqual(['completed', 'completed', 'completed'])
    expect(result.wire).toEqual([
      { enumValues: 364, leafRefs: 6, definitions: 2, strict: true, effort: 'low' },
      { enumValues: 0, leafRefs: 0, definitions: 0, strict: true, effort: 'low' },
      { enumValues: 364, leafRefs: 6, definitions: 2, strict: true, effort: 'low' },
    ])
    expect(result.responses[0]!.answers).toEqual(choices.map(question => ({
      kind: 'choice', questionId: question.id,
      value: question.kind === 'choice' ? question.options[0]!.value : '',
      evidence: { source: 'unavailable' },
    })))
    expect(result.responses[1]!.answers).toEqual([
      { kind: 'boolean', questionId: 'fictional_flag', value: false, evidence: { source: 'unavailable' } },
      { kind: 'score', questionId: 'fictional_score', value: 1, evidence: { source: 'unavailable' } },
    ])
    expect(result.responses[2]!.answers).toEqual(result.responses[0]!.answers)
    for (const response of result.responses) expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 5 })
  }, 30_000)
})

/** No credentials, inherited config/proxies, account client, or real model endpoint. */
async function runFixture(batches: DecisionQuestion[][], formats: LlmDecisionAnswerFormat[] = []) {
  const home = await mkdtemp(join(tmpdir(), 'brian-classifier-home-'))
  let cwd: string | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  let rpc: CodexRpcPeer | undefined
  let invocations = 0
  let invalidRequests = 0
  const wire: { enumValues: number; leafRefs: number; definitions: number; strict: boolean; effort: string }[] = []
  const terminals: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      invocations++
      try {
        expect(request.method).toBe('POST')
        expect(request.url).toBe('/v1/responses')
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          text?: { format?: { type?: string; strict?: boolean; schema?: Schema } }
          reasoning?: { effort?: string }
        }
        expect(body.reasoning?.effort).toBe('low')
        const format = body.text?.format
        expect(format?.type).toBe('json_schema')
        expect(format?.strict).toBe(true)
        expect(format?.schema).toBeDefined()
        const questions = batches[invocations - 1]
        expect(questions).toBeDefined()
        const inspected = inspectSchema(format!.schema!, questions!, formats[invocations - 1])
        wire.push({ enumValues: inspected.enumValues, leafRefs: inspected.leafRefs,
          definitions: Object.keys(format!.schema!.$defs ?? {}).length, strict: format!.strict === true,
          effort: body.reasoning!.effort! })
        const id = `fictional-response-${invocations}`
        const item = { type: 'message', id: `fictional-item-${invocations}`, role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify({ answers: inspected.output }), annotations: [] }] }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          { type: 'response.created', response: { id } },
          { type: 'response.output_item.done', item },
          { type: 'response.completed', response: {
            id, output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          } },
        ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      } catch {
        // Fail in the real native turn, without retaining/logging request bodies or errors.
        invalidRequests++
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Synthetic classifier schema rejected',
          type: 'invalid_request_error', param: 'text.format.schema', code: 'invalid_json_schema' } }))
      }
    })
  })
  try {
    cwd = await mkdtemp(join(tmpdir(), 'brian-classifier-cwd-'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Synthetic fixture has no TCP port')
    const command = await resolvePinnedCodexCommand()
    child = spawn(command.command, [
      ...(command.argsPrefix ?? []), 'app-server',
      // Exact production hardening, without capability overrides or relaxations.
      ...await buildCodexToolSurfaceArgs(command, cwd, 'inference'),
      '-c', 'analytics.enabled=false', '-c', 'model_provider="brian_mock"',
      '-c', 'model_providers.brian_mock.name="Brian mock"',
      '-c', `model_providers.brian_mock.base_url="http://127.0.0.1:${address.port}/v1"`,
      '-c', 'model_providers.brian_mock.wire_api="responses"',
      '-c', 'model_providers.brian_mock.requires_openai_auth=false', '--listen', 'stdio://',
    ], { cwd, env: buildCodexEnvironment(home, { PATH: process.env.PATH, RUST_LOG: 'error' }),
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stderr.resume()
    rpc = new CodexRpcPeer({ input: child.stdout, output: child.stdin, requestTimeoutMs: 10_000 })
    rpc.onNotification('turn/completed', params => {
      const notification = params as { turn?: { status?: string } }
      terminals.push(notification.turn?.status ?? 'unknown')
    })
    await rpc.request('initialize', { clientInfo: { name: 'brian_classifier_fixture', version: '0.0.1' },
      capabilities: { experimentalApi: true } }, InitializeResponseSchema)
    await rpc.notify('initialized', {})
    const model = 'gpt-6-luna'
    const provider = createCodexAppServerProvider({ transport: { rpc, cwd }, models: [model], toolBatchQuietMs: 1 })
    // Synthetic advertised catalog metadata; the API manager independently
    // tests the authenticated catalog -> proxy -> router -> adapter path.
    const responses = []
    for (const [index, questions] of batches.entries()) {
      const decisions = createLlmDecisionProvider({ provider: {
        ...provider, supportedThinkingLevels: id => id === model ? ['low'] : [],
      }, answerFormat: formats[index] })
      const request: DecisionRequest = {
        runId: `fictional-classifier-${index}`,
        operation: { id: 'fixture.classifier', version: '1', stateVersion: '1', questionVersion: '1' },
        model: { catalogId: model, wireId: model }, state: { fictional: true }, questions,
        deadlineAt: Date.now() + 10_000,
      }
      responses.push(await decisions.evaluate(request))
    }
    return { responses, invocations, invalidRequests, wire, terminals }
  } catch {
    // Do not dump provider errors, stderr, or user content even on regression.
    throw new Error(`Synthetic classifier fixture failed (requests=${invocations}, rejected=${invalidRequests})`)
  } finally {
    rpc?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.stdin.end()
      child.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([exited, new Promise<void>(resolve => {
          timer = setTimeout(() => { child!.kill('SIGKILL'); resolve() }, 1_000)
        })])
        if (child.exitCode === null && child.signalCode === null) await exited
      } finally { clearTimeout(timer) }
    }
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.all([rm(home, { recursive: true, force: true }),
      ...(cwd ? [rm(cwd, { recursive: true, force: true })] : [])])
  }
}
