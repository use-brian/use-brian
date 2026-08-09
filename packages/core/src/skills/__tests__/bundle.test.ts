import { describe, expect, it } from 'vitest'
import {
  findSkillResource,
  formatSkillInstructions,
  parseSkillBundle,
  searchSkillResourceContent,
} from '../bundle.js'

const ROOT = [
  '---',
  'name: consult-finance',
  'description: Analyze a small business\'s finances.',
  '---',
  '# Finance',
  '',
  'For a P&L review, read [statement analysis](references/statement-analysis.md).',
  'Coordinate revenue work with [sales](../consult-sales/SKILL.md).',
].join('\n')

describe('[COMP:skills/bundle] canonical SkillBundle compiler', () => {
  it('preserves relative resources, hashes content, and derives explicit edges', () => {
    const bundle = parseSkillBundle({
      skillMarkdown: ROOT,
      files: [
        { path: 'references/statement-analysis.md', content: '# Statement analysis\n\nFive-pass P&L review.' },
        { path: 'assets/templates/snapshot.md', content: '# Snapshot\n\nUse this layout.' },
      ],
      skillSource: 'community',
    })!

    expect(bundle.skill.bundleVersion).toBe(2)
    expect(bundle.resources.map((resource) => resource.path)).toEqual([
      'assets/templates/snapshot.md',
      'references/statement-analysis.md',
    ])
    expect(bundle.resources[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.links).toContainEqual({
      sourcePath: 'SKILL.md',
      targetPath: 'references/statement-analysis.md',
      relation: 'references',
    })
    expect(bundle.links).toContainEqual({
      sourcePath: 'SKILL.md',
      targetPath: '../consult-sales/SKILL.md',
      relation: 'uses_skill',
      targetSkillSlug: 'consult-sales',
    })
    expect(bundle.issues).toContainEqual(expect.objectContaining({
      code: 'orphaned_resource',
      path: 'assets/templates/snapshot.md',
    }))
  })

  it('returns root plus a compact index without eager resource bodies', () => {
    const bundle = parseSkillBundle({
      skillMarkdown: ROOT,
      files: [{ path: 'references/statement-analysis.md', content: 'SECRET RESOURCE BODY' }],
    })!
    const instructions = formatSkillInstructions(bundle.skill)
    expect(instructions).toContain('references/statement-analysis.md')
    expect(instructions).not.toContain('SECRET RESOURCE BODY')
    expect(findSkillResource(bundle.skill, './references/statement-analysis.md')?.content).toBe(
      'SECRET RESOURCE BODY',
    )
  })

  it('searches only the selected bundle and returns bounded excerpts', () => {
    const bundle = parseSkillBundle({
      skillMarkdown: ROOT,
      files: [
        { path: 'references/statement-analysis.md', content: 'Review gross margin and operating costs.' },
        { path: 'references/fundraising.md', content: 'Assess dilution and investor readiness.' },
      ],
    })!
    const matches = searchSkillResourceContent(bundle.skill, 'gross margin', 1)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.path).toBe('references/statement-analysis.md')
    expect(matches[0]!.excerpt).toContain('gross margin')
  })
})
