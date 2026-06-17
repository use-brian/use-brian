import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseSkillMarkdown } from '@sidanclaw/core'
import type { SkillContent } from '@sidanclaw/core'

const TOOLS_DIR = resolve(
  import.meta.dirname, '..', '..', '..', '..', 'sidanclaw-tools',
)

/**
 * Load the community skill registry from sidanclaw-tools/skills/<name>/SKILL.md.
 * Called once at server boot. Returns full SkillContent[] (with prompt body).
 */
export function loadSkillRegistry(): SkillContent[] {
  try {
    const skillsDir = join(TOOLS_DIR, 'skills')
    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())

    const skills: SkillContent[] = []
    for (const dir of dirs) {
      try {
        const raw = readFileSync(join(skillsDir, dir.name, 'SKILL.md'), 'utf-8')
        const skill = parseSkillMarkdown(raw, 'community')
        if (skill) skills.push(skill)
      } catch {
        // Skip dirs without a valid SKILL.md
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name))
    console.log(`[registry] Loaded ${skills.length} community skill(s)`)
    return skills
  } catch (err) {
    console.warn('[registry] Failed to load community skills:', (err as Error).message)
    return []
  }
}
