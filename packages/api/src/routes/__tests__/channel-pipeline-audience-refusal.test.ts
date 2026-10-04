import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * An interactive channel has a person waiting, so a delivery-audience
 * refusal must reach them as a reply. Before generation, the pipeline's
 * audience checks run outside the query loop's catch; one that throws there
 * unwinds into the channel route's detached catch and the person hears
 * nothing. On 2026-10-03 the compaction-time check did exactly that on every
 * Feishu turn of a thread-scoped DM. Every pre-generation check therefore
 * goes through `deliveryAudienceAdmitsTurn`, which records the refusal and
 * replies; a bare `await assertDeliveryAudience()` is allowed only inside
 * that helper and inside the query-loop `try` (whose catch replies too).
 */
const source = readFileSync(fileURLToPath(new URL('../channel-pipeline.ts', import.meta.url)), 'utf8')

describe('[COMP:api/channel-pipeline-audience-refusal] pre-generation audience refusals always reply', () => {
  it('gates compaction and processing start through the replying helper', () => {
    const helperCalls = source.match(/if \(!\(await deliveryAudienceAdmitsTurn\(\)\)\) return/g) ?? []
    expect(helperCalls.length).toBe(2)
    const beforeCompaction = source.slice(0, source.indexOf('await runProactiveCompaction('))
    expect(beforeCompaction).toMatch(/if \(!\(await deliveryAudienceAdmitsTurn\(\)\)\) return\s*\n\s*const compactionResult/)
  })

  it('has no bare audience assertion between the helper and the query-loop try', () => {
    const helperEnd = source.indexOf('const deliveryAudienceAdmitsTurn')
    const loopTry = source.indexOf('await hooks.onProcessingStart?.()')
    expect(helperEnd).toBeGreaterThan(0)
    expect(loopTry).toBeGreaterThan(helperEnd)
    const helperBody = source.slice(helperEnd, source.indexOf('\n  }\n', helperEnd))
    const between = source.slice(helperEnd + helperBody.length, loopTry)
    expect(between).not.toMatch(/await assertDeliveryAudience\(\)/)
  })

  it('looks the DM recipient up under the thread-scoped session key', () => {
    expect(source).toMatch(/channelId,\s*\n\s*sessionChannelId,\s*\n\s*channelIntegrationId: params\.channelIntegrationId/)
  })
})
