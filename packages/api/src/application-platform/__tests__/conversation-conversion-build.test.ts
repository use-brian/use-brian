import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const run = (file: string, args: string[]) => execFileSync(process.execPath, [join(directory, file), ...args], { encoding: 'utf8', stdio: 'pipe' })

describe('[COMP:api/native-turn-frame] source-bound conversion installer generation', () => {
  it('matches the installed forward source and reproduces its frozen compiler profile', () => {
    expect(() => run('build-conversion.mjs', ['--check'])).not.toThrow()
    expect(() => run('prepare-conversion-predecessor.mjs', ['--check'])).not.toThrow()
  })
  it('refuses an altered expected source profile before writing a migration', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'conversion-source-refusal-'))
    try {
      const profile = JSON.parse(readFileSync(join(directory, 'conversion-predecessor-source.json'), 'utf8'))
      profile.sourceSpecs[0].body += '\n-- unreviewed expected body\n'
      const input = join(temporary, 'source.json'), output = join(temporary, 'migration.sql')
      writeFileSync(input, JSON.stringify(profile, null, 2))
      expect(() => run('build-conversion.mjs', ['--compiler-input', input, '--output', output])).toThrow(/conversion_source_compiler_input_changed/)
      expect(existsSync(output)).toBe(false)
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  })
})
