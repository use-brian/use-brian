import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { parseSkillBundle, skillResourceKindFromPath } from '@use-brian/core'
import type { SkillBundleFileInput, SkillContent } from '@use-brian/core'

const TOOLS_DIR_CANDIDATES = [
  process.env.BRIAN_TOOLS_DIR,
  // Historical in-tree optional submodule.
  resolve(import.meta.dirname, '..', '..', '..', '..', 'brian-tools'),
  // Native sibling checkout beside brian-platform.
  resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'brian-tools'),
].filter((path): path is string => Boolean(path))

function findToolsDir(): string {
  return TOOLS_DIR_CANDIDATES.find((candidate) => existsSync(join(candidate, 'skills'))) ?? TOOLS_DIR_CANDIDATES[0]!
}

function collectBundleFiles(skillDir: string, currentDir = skillDir): SkillBundleFileInput[] {
  const files: SkillBundleFileInput[] = []
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const absolute = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectBundleFiles(skillDir, absolute))
      continue
    }
    if (!entry.isFile() || entry.name.toLowerCase() === 'skill.md') continue
    const path = relative(skillDir, absolute).replace(/\\/g, '/')
    if (!skillResourceKindFromPath(path)) continue
    const content = readFileSync(absolute, 'utf8')
    files.push({ path, content })
  }
  return files
}

/**
 * Load the community registry through the canonical SkillBundle compiler.
 * Resource bodies ride on SkillContent only for the guarded resource tools;
 * `useSkill` returns their compact index rather than eager content.
 */
export function loadSkillRegistry(toolsDirectory?: string): SkillContent[] {
  try {
    const toolsDir = toolsDirectory ?? findToolsDir()
    const skillsDir = join(toolsDir, 'skills')
    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())

    const skills: SkillContent[] = []
    for (const dir of dirs) {
      try {
        const skillDir = join(skillsDir, dir.name)
        const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
        const bundle = parseSkillBundle({
          skillMarkdown: raw,
          files: collectBundleFiles(skillDir),
          skillSource: 'community',
          source: {
            kind: 'brian-tools',
            path: `skills/${dir.name}`,
            ref: 'main',
          },
        })
        if (bundle) skills.push(bundle.skill)
      } catch {
        // Skip dirs without a valid SKILL.md
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name))
    console.log(`[registry] Loaded ${skills.length} community skill(s)`)
    return skills
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    // Expected in a clean open-source clone: community skills live in the
    // optional brian-tools submodule, so its skills dir is absent (ENOENT).
    // Populate it with `git submodule update --init brian-tools`. Any other
    // error is a real problem worth a warn.
    if (e.code === 'ENOENT') {
      console.log('[registry] No community skills (brian-tools not present)')
    } else {
      console.warn('[registry] Failed to load community skills:', e.message)
    }
    return []
  }
}
