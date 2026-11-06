import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createWorkspaceTurnSink } from '../native-turn.js'

describe('[COMP:api/workspace-mcp] native turn result boundary', () => {
  it('retains durable message references without exposing reasoning, tool narration or stream text', () => {
    const output = createWorkspaceTurnSink(), id = randomUUID()
    for (const event of ['reasoning', 'text_delta', 'tool_input', 'tool_result', 'status']) {
      output.sink.write(`event: ${event}\ndata: ${JSON.stringify({ text: 'Private fixture payload', input: 'Private fixture arguments' })}\n\n`)
    }
    output.sink.write(`event: assistant_message_saved\ndata: ${JSON.stringify({ id })}\n\n`)
    output.sink.end()
    expect(output.result()).toEqual({ status: 'succeeded', messageIds: [id] })
  })
  it('does not report an empty or failed native turn as successful work', () => {
    const empty = createWorkspaceTurnSink()
    empty.sink.end()
    expect(empty.result().status).toBe('failed')
    const failed = createWorkspaceTurnSink()
    failed.sink.write(`event: assistant_message_saved\ndata: ${JSON.stringify({ id: randomUUID() })}\n\n`)
    failed.sink.write('event: error\ndata: {"error":"Private backend detail"}\n\n')
    expect(failed.result()).toMatchObject({ status: 'failed', errorCode: 'native_turn_failed' })
    expect(JSON.stringify(failed.result())).not.toContain('Private')
  })
  it('reports research publication separately from the reply and discards unrelated event payload', () => {
    const output = createWorkspaceTurnSink(), id = randomUUID(), activityId = randomUUID()
    output.sink.write(`event: assistant_message_saved\ndata: ${JSON.stringify({ id })}\n\n`)
    output.sink.write(`event: research_saved\ndata: ${JSON.stringify({ activityId, status: 'partial', saveError: 'research_source_unavailable', privateDetail: 'hidden' })}\n\n`)
    expect(output.result()).toEqual({ status: 'succeeded', messageIds: [id], research: [{ activityId, status: 'partial', saveError: 'research_source_unavailable' }] })
  })
  it('fails closed for a malformed research receipt without exposing its payload', () => {
    const output = createWorkspaceTurnSink()
    output.sink.write(`event: assistant_message_saved\ndata: ${JSON.stringify({ id: randomUUID() })}\n\n`)
    output.sink.write(`event: research_saved\ndata: ${JSON.stringify({ activityId: randomUUID(), status: 'partial', saveError: 'Private backend details' })}\n\n`)
    expect(output.result().status).toBe('failed')
    expect(JSON.stringify(output.result())).not.toContain('Private')
  })

})
