/**
 * Skill import service — fetch a skill file (or Agent Skills folder) from a
 * public URL or a GitHub repo, normalize it into a sidanclaw draft, and map
 * folder support files onto `workspace_skill_files` kinds. Parse-only: the
 * service never writes to the database.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Importing skills
 * (GitHub / URL)".
 *
 * [COMP:api/skill-import]
 */

import {
  parseImportedSkill,
  type ImportDialect,
  type ImportedSkillDraft,
  type ImportWarning,
} from '@sidanclaw/core'
import {
  fetchAllowlistedRaw,
  normalizeImportUrl,
  IMPORT_MAX_FILE_BYTES,
  type RawImportFetcher,
} from './import-source.js'

export class SkillImportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502 = 400,
  ) {
    super(message)
    this.name = 'SkillImportError'
  }
}

export type SkillImportSupportFile = {
  kind: 'reference' | 'template' | 'script'
  name: string
  content: string
}

export type SkillImportResult = {
  dialect: ImportDialect
  draft: ImportedSkillDraft
  supportFiles: SkillImportSupportFile[]
  warnings: ImportWarning[]
  /** Provenance blob stored on the row at save (`import_source`, mig 328). */
  importSource: Record<string, unknown>
}

/** The narrow slice of `github/client.ts` the folder walk needs — injected so
 *  tests stub GitHub without network. */
export type GithubContentsReader = {
  getFileContents(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GithubContentEntry | GithubContentEntry[]>
}

export type GithubContentEntry = {
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  name: string
  path: string
  size: number
  sha: string
  content?: string
  encoding?: string
}

// Folder-walk caps (spec → "Folder skills"). Over-cap fails the import with
// the counts — never a silent partial import.
export const IMPORT_MAX_SUPPORT_FILES = 20
export const IMPORT_MAX_SUPPORT_FILE_BYTES = 65_536
export const IMPORT_MAX_SUPPORT_TOTAL_BYTES = 262_144

/** Agent Skills / Hermes support dirs → workspace_skill_files kinds. */
const SUPPORT_DIR_KINDS: Record<string, SkillImportSupportFile['kind']> = {
  references: 'reference',
  templates: 'template',
  scripts: 'script',
}

// ── URL import ────────────────────────────────────────────────

export async function importSkillFromUrl(
  rawUrl: string,
  fetchRaw: RawImportFetcher = fetchAllowlistedRaw,
): Promise<SkillImportResult> {
  const normalized = normalizeImportUrl(rawUrl)
  if ('error' in normalized) throw new SkillImportError(normalized.error)

  let text: string
  try {
    text = await fetchRaw(normalized.fetchUrl)
  } catch (err) {
    throw new SkillImportError(
      err instanceof Error ? err.message : 'Failed to fetch the file.',
      502,
    )
  }

  const parsed = parseImportedSkill(normalized.fileName, text)
  if (!parsed) {
    throw new SkillImportError(
      'That file does not look like a skill: it is empty, binary, or has no usable body.',
    )
  }

  return {
    dialect: parsed.dialect,
    draft: parsed.draft,
    supportFiles: [],
    warnings: parsed.warnings,
    importSource: { ...normalized.provenance },
  }
}

// ── GitHub import (file or Agent Skills folder) ───────────────

export type GithubImportTarget = {
  owner: string
  repo: string
  path: string
  ref?: string
}

export async function importSkillFromGithub(
  github: GithubContentsReader,
  target: GithubImportTarget,
): Promise<SkillImportResult> {
  const { owner, repo, path, ref } = target

  let entry: GithubContentEntry | GithubContentEntry[]
  try {
    entry = await github.getFileContents(owner, repo, path, ref)
  } catch {
    throw new SkillImportError(
      'Could not read that path from GitHub. Check the repo, path, and connector access.',
      502,
    )
  }

  // A single file: parse it directly.
  if (!Array.isArray(entry)) {
    if (entry.type !== 'file' || typeof entry.content !== 'string') {
      throw new SkillImportError('That path is not a readable file.')
    }
    const parsed = parseImportedSkill(entry.name, entry.content)
    if (!parsed) {
      throw new SkillImportError(
        'That file does not look like a skill: it is empty, binary, or has no usable body.',
      )
    }
    return {
      dialect: parsed.dialect,
      draft: parsed.draft,
      supportFiles: [],
      warnings: parsed.warnings,
      importSource: { kind: 'github', owner, repo, path, ref: ref ?? null, sha: entry.sha },
    }
  }

  // A directory: Agent Skills folder — needs a SKILL.md inside.
  const skillFile = entry.find(
    (e) => e.type === 'file' && e.name.toLowerCase() === 'skill.md',
  )
  if (!skillFile) {
    throw new SkillImportError(
      'That folder has no SKILL.md. Pick the skill file itself, or a folder in the Agent Skills layout.',
    )
  }

  const skillContents = await github.getFileContents(owner, repo, skillFile.path, ref)
  if (Array.isArray(skillContents) || typeof skillContents.content !== 'string') {
    throw new SkillImportError('Could not read the folder\'s SKILL.md.', 502)
  }
  const parsed = parseImportedSkill(skillContents.name, skillContents.content)
  if (!parsed) {
    throw new SkillImportError('The folder\'s SKILL.md is empty or not parseable as a skill.')
  }

  const warnings: ImportWarning[] = [...parsed.warnings]
  const { supportFiles, skipped } = await collectSupportFiles(github, target, entry)

  if (skipped.length > 0) {
    warnings.push({
      code: 'unsupported_files',
      detail: `Skipped entries with no equivalent here: ${skipped.join(', ')}.`,
    })
  }
  if (supportFiles.some((f) => f.kind === 'script')) {
    warnings.push({
      code: 'scripts_not_executable',
      detail:
        'Scripts were imported as text for the assistant to read; they are never executed here.',
    })
  }

  // Surface the support files to the model at useSkill time through the
  // normal pointer machinery — an appendix of {{kind:name}} pointers.
  let content = parsed.draft.content
  if (supportFiles.length > 0) {
    const pointerLines = supportFiles.map((f) => `- {{${f.kind}:${f.name}}}`)
    content = `${content}\n\n## Imported support files\n\n${pointerLines.join('\n')}`
  }

  return {
    dialect: parsed.dialect,
    draft: { ...parsed.draft, content },
    supportFiles,
    warnings,
    importSource: {
      kind: 'github',
      owner,
      repo,
      path,
      ref: ref ?? null,
      sha: skillFile.sha,
    },
  }
}

async function collectSupportFiles(
  github: GithubContentsReader,
  target: GithubImportTarget,
  folderListing: GithubContentEntry[],
): Promise<{ supportFiles: SkillImportSupportFile[]; skipped: string[] }> {
  const supportFiles: SkillImportSupportFile[] = []
  const skipped: string[] = []
  let totalBytes = 0

  for (const dirEntry of folderListing) {
    if (dirEntry.name.toLowerCase() === 'skill.md') continue

    const kind = dirEntry.type === 'dir' ? SUPPORT_DIR_KINDS[dirEntry.name.toLowerCase()] : undefined
    if (!kind) {
      skipped.push(dirEntry.type === 'dir' ? `${dirEntry.name}/` : dirEntry.name)
      continue
    }

    const listing = await github.getFileContents(target.owner, target.repo, dirEntry.path, target.ref)
    const files = Array.isArray(listing) ? listing : [listing]
    for (const file of files) {
      if (file.type !== 'file') {
        skipped.push(`${file.path}/`)
        continue
      }
      if (supportFiles.length >= IMPORT_MAX_SUPPORT_FILES) {
        throw new SkillImportError(
          `The folder has more than ${IMPORT_MAX_SUPPORT_FILES} support files; trim it before importing.`,
        )
      }
      if (file.size > IMPORT_MAX_SUPPORT_FILE_BYTES) {
        throw new SkillImportError(
          `Support file ${file.path} is ${file.size} bytes; the per-file limit is ${IMPORT_MAX_SUPPORT_FILE_BYTES}.`,
        )
      }
      totalBytes += file.size
      if (totalBytes > IMPORT_MAX_SUPPORT_TOTAL_BYTES) {
        throw new SkillImportError(
          `The folder's support files exceed ${IMPORT_MAX_SUPPORT_TOTAL_BYTES} bytes in total; trim it before importing.`,
        )
      }
      const fetched = await github.getFileContents(target.owner, target.repo, file.path, target.ref)
      if (Array.isArray(fetched) || typeof fetched.content !== 'string') {
        skipped.push(file.path)
        continue
      }
      supportFiles.push({ kind, name: file.name, content: fetched.content })
    }
  }

  return { supportFiles, skipped }
}

// Re-exported so the route can share one cap constant with URL fetches.
export { IMPORT_MAX_FILE_BYTES }
