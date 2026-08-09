import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSkillRegistry } from '../load-skill-registry.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('[COMP:api/skill-registry] native brian-tools registry', () => {
  it('loads a complete path-preserving bundle through the canonical compiler', () => {
    const toolsDirectory = mkdtempSync(join(tmpdir(), 'brian-tools-registry-'))
    temporaryDirectories.push(toolsDirectory)
    const skillDirectory = join(toolsDirectory, 'skills', 'finance')
    mkdirSync(join(skillDirectory, 'references'), { recursive: true })
    mkdirSync(join(skillDirectory, 'assets', 'templates'), { recursive: true })
    writeFileSync(join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: finance',
      'description: Analyze finances when the user asks about margins.',
      '---',
      'Read [margins](references/margins.md).',
      'Use the [snapshot](assets/templates/snapshot.md).',
    ].join('\n'))
    writeFileSync(join(skillDirectory, 'references', 'margins.md'), 'Gross margin method.')
    writeFileSync(join(skillDirectory, 'assets', 'templates', 'snapshot.md'), '# Snapshot')

    const registry = loadSkillRegistry(toolsDirectory)

    expect(registry).toHaveLength(1)
    expect(registry[0]).toMatchObject({ id: 'finance', bundleVersion: 2 })
    expect(registry[0]!.resources?.map((resource) => resource.path)).toEqual([
      'assets/templates/snapshot.md',
      'references/margins.md',
    ])
    expect(registry[0]!.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
  })
})
