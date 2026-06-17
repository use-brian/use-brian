import { describe, it, expect } from 'vitest'
import type { Message } from '../../providers/types.js'
import {
  elideStaleDocToolResults,
  ELIDED_DOC_RESULT_PLACEHOLDER,
  KEEP_RECENT_DOC_RESULTS,
} from '../doc-history.js'

/** A doc page-state result carrying a (stand-in) full-page outline body. */
function docResult(
  id: string,
  name = 'patchPage',
  body = `OUTLINE-${id}-${'x'.repeat(200)}`,
): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: id, name, content: body }],
  }
}

/** The assistant tool_use that pairs with a doc result (kept untouched). */
function docCall(id: string, name = 'patchPage'): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: { ops: [] }, providerSignature: 'sig' }],
  }
}

function isStub(msg: Message): boolean {
  return (
    typeof msg.content !== 'string' &&
    msg.content.some(
      (b) => b.type === 'tool_result' && b.content === ELIDED_DOC_RESULT_PLACEHOLDER,
    )
  )
}

describe('[COMP:engine/doc-history] Doc tool-result elision', () => {
  it('keeps the most-recent keepRecent results verbatim and stubs older ones', () => {
    const messages: Message[] = []
    for (let i = 0; i < 5; i++) {
      messages.push(docCall(`p${i}`), docResult(`p${i}`))
    }

    const out = elideStaleDocToolResults(messages, 2)
    const results = out.filter((m) => m.role === 'user')

    // 5 results: first 3 stubbed, last 2 verbatim.
    expect(results.slice(0, 3).every(isStub)).toBe(true)
    expect(results.slice(3).some(isStub)).toBe(false)
    expect(results[4].content).toEqual([
      { type: 'tool_result', toolUseId: 'p4', name: 'patchPage', content: `OUTLINE-p4-${'x'.repeat(200)}` },
    ])
  })

  it('preserves toolUseId / name / isError on elided blocks (pairing intact)', () => {
    const messages: Message[] = [
      docCall('a'), docResult('a'),
      docCall('b'), docResult('b'),
      docCall('c'), docResult('c'),
    ]
    const out = elideStaleDocToolResults(messages, 1)
    const elided = out[1].content
    expect(elided).toEqual([
      { type: 'tool_result', toolUseId: 'a', name: 'patchPage', content: ELIDED_DOC_RESULT_PLACEHOLDER },
    ])
  })

  it('returns the same reference when nothing to elide (count <= keepRecent)', () => {
    const messages: Message[] = [docCall('a'), docResult('a'), docCall('b'), docResult('b')]
    expect(elideStaleDocToolResults(messages, 2)).toBe(messages)
  })

  it('is a no-op on non-doc histories', () => {
    const messages: Message[] = []
    for (let i = 0; i < 5; i++) {
      messages.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: `s${i}`, name: 'searchBrain', input: {}, providerSignature: 'sig' }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: `s${i}`, name: 'searchBrain', content: 'big search payload '.repeat(50) }] },
      )
    }
    expect(elideStaleDocToolResults(messages, 2)).toBe(messages)
  })

  it('elides SUPERSEDED error results too (the invalid_ops body is a full outline)', () => {
    // Error results used to be exempt; they are not anymore, because the
    // `invalid_ops` body carries a FULL outline and exempting it let the
    // biggest single body leak into history forever. Errors now count toward
    // the keep-recent window like any other doc page-state result.
    const errResult: Message = {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'e', name: 'patchPage', content: `OUTLINE-err-${'x'.repeat(200)}`, isError: true }],
    }
    const messages: Message[] = [
      docCall('a'), docResult('a'),
      docCall('e'), errResult,
      docCall('b'), docResult('b'),
      docCall('c'), docResult('c'),
    ]
    const out = elideStaleDocToolResults(messages, 1)
    // Of all 4 page-state results only the most-recent (c) stays verbatim;
    // a, the superseded error e, and b are stubbed.
    expect(isStub(out[1])).toBe(true) // a
    expect(isStub(out[3])).toBe(true) // e (error) — stubbed because superseded
    expect(isStub(out[5])).toBe(true) // b
    expect(isStub(out[7])).toBe(false) // c
    // The stubbed error keeps its isError flag (pairing intact).
    expect(out[3].content).toEqual([
      { type: 'tool_result', toolUseId: 'e', name: 'patchPage', content: ELIDED_DOC_RESULT_PLACEHOLDER, isError: true },
    ])
  })

  it('keeps the MOST-RECENT error verbatim so the model can still re-anchor', () => {
    // The immediate retry signal (the last invalid_ops outline) survives.
    const errResult: Message = {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'e', name: 'patchPage', content: `OUTLINE-err-${'x'.repeat(200)}`, isError: true }],
    }
    const messages: Message[] = [
      docCall('a'), docResult('a'),
      docCall('e'), errResult, // most-recent page-state result is the error
    ]
    const out = elideStaleDocToolResults(messages, 1)
    expect(out[3]).toBe(errResult) // kept verbatim (re-anchor signal)
    expect(isStub(out[1])).toBe(true) // older success stubbed
  })

  it('is idempotent (second pass returns the same reference)', () => {
    const messages: Message[] = []
    for (let i = 0; i < 4; i++) messages.push(docCall(`p${i}`), docResult(`p${i}`))
    const once = elideStaleDocToolResults(messages, 2)
    const twice = elideStaleDocToolResults(once, 2)
    expect(twice).toBe(once)
  })

  it('passes string-content messages through untouched', () => {
    const messages: Message[] = [
      { role: 'user', content: 'plain text turn' },
      docCall('a'), docResult('a'),
      docCall('b'), docResult('b'),
      docCall('c'), docResult('c'),
    ]
    const out = elideStaleDocToolResults(messages, 2)
    expect(out[0]).toBe(messages[0])
  })

  it('keepRecent=0 stubs every doc page-state result', () => {
    const messages: Message[] = [docCall('a'), docResult('a'), docCall('b'), docResult('b')]
    const out = elideStaleDocToolResults(messages, 0)
    expect(out.filter((m) => m.role === 'user').every(isStub)).toBe(true)
  })

  it('exposes a sane default keep-recent window', () => {
    expect(KEEP_RECENT_DOC_RESULTS).toBeGreaterThanOrEqual(1)
  })

  it('treats getSection / getBlockRange results as page-state (elidable)', () => {
    // Confirms the two read tools are in DOC_PAGE_STATE_TOOLS — a typo in
    // either name would leave their (potentially large) results un-elided.
    const messages: Message[] = [
      docCall('s1', 'getSection'), docResult('s1', 'getSection'),
      docCall('r1', 'getBlockRange'), docResult('r1', 'getBlockRange'),
      docCall('p1', 'patchPage'), docResult('p1', 'patchPage'),
    ]
    const out = elideStaleDocToolResults(messages, 1)
    // Three page-state results; only the most-recent (patchPage) stays verbatim.
    expect(isStub(out[1])).toBe(true) // getSection result stubbed
    expect(isStub(out[3])).toBe(true) // getBlockRange result stubbed
    expect(isStub(out[5])).toBe(false) // patchPage (most recent) kept
  })
})
