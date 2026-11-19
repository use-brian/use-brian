import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))

describe('[COMP:api/native-turn-frame] inputtable executable successor source', () => {
  it('reproduces the installed successor while preserving both applied predecessors', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-executable-record.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('keeps the complete independently authenticated predecessor as a named historical input', async () => {
    const { createHash } = await import('node:crypto')
    expect(createHash('sha256').update(readFileSync(directory + 'installation-authentication-8273.mjs')).digest('hex'))
      .toBe('244efe86dad38d3d2e1e9fa89c3cfa91b4cfe5b85f1cba3e9fb7af23fb6be447')
  })
})
