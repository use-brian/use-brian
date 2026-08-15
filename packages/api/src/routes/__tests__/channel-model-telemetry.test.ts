// [COMP:api/codex-provider] - the channel boundary must expose the model that
// actually served a turn even when the OSS build has no billing usage store.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pipelineSource = readFileSync(new URL('../channel-pipeline.ts', import.meta.url), 'utf8')

describe('[COMP:api/codex-provider] channel model telemetry', () => {
  it('logs the completed-turn model outside the optional usage-store branch', () => {
    expect(pipelineSource).toMatch(
      /if \(usage\) \{[\s\S]*if \(usageStore\) \{[\s\S]*\n\s*\}\n\n\s*analytics\?\.logEvent\(\{[\s\S]*eventName: 'turn_completed'/,
    )
    expect(pipelineSource).toContain(
      'model: sanitizeAnalytics(event.response.model)',
    )
  })
})
