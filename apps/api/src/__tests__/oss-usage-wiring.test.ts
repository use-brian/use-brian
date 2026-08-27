/** [COMP:goals/oss-metering] */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('[COMP:goals/oss-metering] standalone boot wiring', () => {
  it('injects the real local usage store into bootOpenApi', async () => {
    const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8')

    assert.match(source, /import \{ createOssUsageStore \} from '@use-brian\/api\/db\/oss-usage-store\.js'/)
    assert.match(source, /ports:\s*\{\s*usageStore: createOssUsageStore\(\),/)
  })
})
