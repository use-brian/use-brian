import { describe, it, expect } from 'vitest'
import { createFindingsSourceTool } from '../findings-source-tool.js'
import type { ToolContext } from '@sidanclaw/core'

// The synthesis loop's synthetic context is irrelevant to this tool — the
// findings are bound in the closure, not read from anywhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CTX = {} as ToolContext

const FINDINGS = 'HK SME cloud adoption is 62% (source: census.gov.hk).'

describe('[COMP:api/findings-source-tool] createFindingsSourceTool', () => {
  it('is a read-only core tool named searchSource', () => {
    const tool = createFindingsSourceTool({ findings: FINDINGS })
    expect(tool.name).toBe('searchSource')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.requiresConfirmation).toBe(false)
  })

  it('returns the pre-gathered findings in full by default', async () => {
    const tool = createFindingsSourceTool({ findings: FINDINGS })
    const res = await tool.execute({ query: '' }, CTX)
    expect(res.isError).toBeFalsy()
    expect(res.data).toBe(FINDINGS)
  })

  it('returns the full findings even with a query when the gather is short', async () => {
    const tool = createFindingsSourceTool({ findings: FINDINGS })
    const res = await tool.execute({ query: 'something unrelated' }, CTX)
    // Short gather → never narrowed, so a section is never starved of context.
    expect(res.data).toBe(FINDINGS)
  })

  it('narrows a LONG gather (over the full-return threshold) to the matching paragraphs', async () => {
    // Each paragraph must be big enough that the gather exceeds FULL_RETURN_CHARS
    // (12k), so the query-narrowing path actually engages.
    const big = 'A'.repeat(5000)
    const findings = [
      `${big} alpha topic about pricing`,
      `${big} beta topic about hiring`,
      `${big} gamma topic about pricing again`,
    ].join('\n\n')
    const tool = createFindingsSourceTool({ findings })
    const res = await tool.execute({ query: 'pricing' }, CTX)
    expect(String(res.data)).toContain('alpha topic about pricing')
    expect(String(res.data)).toContain('gamma topic about pricing again')
    expect(String(res.data)).not.toContain('beta topic about hiring')
  })

  it('falls back to the full long gather when a query matches nothing', async () => {
    const findings = [
      `${'A'.repeat(7000)} alpha`,
      `${'B'.repeat(7000)} beta`,
    ].join('\n\n')
    const tool = createFindingsSourceTool({ findings })
    const res = await tool.execute({ query: 'zzz-no-match' }, CTX)
    // Never an empty result — the model still gets the gather to work from.
    expect(String(res.data)).toContain('alpha')
    expect(String(res.data)).toContain('beta')
  })

  it('handles empty findings without throwing', async () => {
    const tool = createFindingsSourceTool({ findings: '' })
    const res = await tool.execute({ query: 'anything' }, CTX)
    expect(res.isError).toBeFalsy()
    expect(res.data).toBe('')
  })
})
