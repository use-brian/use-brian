/**
 * Skill import service — fetch a skill file (or Agent Skills folder) from a
 * public URL or a GitHub repo, normalize it into a Use Brian draft, and map
 * folder support files onto `workspace_skill_files` kinds. Parse-only: the
 * service never writes to the database.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Importing skills
 * (GitHub / URL)".
 *
 * [COMP:api/skill-import]
 */

import {
  parseSkillBundle,
  parseImportedSkill,
  sha256,
  skillResourceKindFromPath,
  type SkillBundleLink,
  type SkillResourceKind,
  type ImportDialect,
  type ImportedSkillDraft,
  type ImportWarning,
} from '@use-brian/core'
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
  kind: SkillResourceKind
  name: string
  path: string
  content: string
  description?: string
  contentHash: string
}

export type SkillImportResult = {
  dialect: ImportDialect
  draft: ImportedSkillDraft
  supportFiles: SkillImportSupportFile[]
  links: SkillBundleLink[]
  bundleVersion: 2
  sourceDigest: string
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

const SUPPORT_DIRS = new Set(['references', 'assets', 'templates', 'scripts'])

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
    links: [],
    bundleVersion: 2,
    sourceDigest: sha256(text),
    warnings: parsed.warnings,
    importSource: { ...normalized.provenance, sourceDigest: sha256(text) },
  }
}

// ── Paste import (markdown handed straight to the server) ─────

/** File name assumed for a paste that carries none — only ever used to derive
 *  a fallback display name, and only when the body has no frontmatter or H1. */
const PASTED_FILE_NAME = 'pasted-skill.md'

/**
 * Normalize markdown the user pasted (or uploaded) into a draft.
 *
 * Synchronous by construction: unlike the URL and GitHub sources this one
 * performs NO server-side fetch, which is why it needs no host allowlist —
 * the bytes arrived in the request. `fileName` is optional and matters only
 * for dialect detection (`.mdc` ⇒ Cursor rule) and name derivation.
 */
export function importSkillFromPaste(content: string, fileName?: string): SkillImportResult {
  if (typeof content !== 'string' || !content.trim()) {
    throw new SkillImportError('Paste the skill markdown first.')
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > IMPORT_MAX_FILE_BYTES) {
    throw new SkillImportError(
      `That paste is too large to import (${bytes} bytes; limit ${IMPORT_MAX_FILE_BYTES}).`,
    )
  }

  const parsed = parseImportedSkill(fileName?.trim() || PASTED_FILE_NAME, content)
  if (!parsed) {
    throw new SkillImportError(
      'That does not look like a skill: it is empty, binary, or has no usable body.',
    )
  }

  return {
    dialect: parsed.dialect,
    draft: parsed.draft,
    supportFiles: [],
    links: [],
    bundleVersion: 2,
    sourceDigest: sha256(content),
    warnings: parsed.warnings,
    importSource: { kind: 'paste', sourceDigest: sha256(content) },
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
      links: [],
      bundleVersion: 2,
      sourceDigest: sha256(entry.content),
      warnings: parsed.warnings,
      importSource: {
        kind: 'github', owner, repo, path, ref: ref ?? null, sha: entry.sha,
        sourceDigest: sha256(entry.content),
      },
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
  const { files, skipped } = await collectSupportFiles(github, target, entry)
  const bundle = parseSkillBundle({
    skillMarkdown: skillContents.content,
    files,
    skillSource: 'community',
    source: { kind: 'github', owner, repo, path, ref: ref ?? null, sha: skillContents.sha },
  })
  if (!bundle) {
    throw new SkillImportError('The folder\'s SKILL.md has invalid Agent Skills frontmatter.')
  }
  const supportFiles: SkillImportSupportFile[] = bundle.resources.map((resource) => ({
    kind: resource.kind,
    name: resource.name,
    path: resource.path,
    content: resource.content,
    description: resource.description,
    contentHash: resource.contentHash,
  }))

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
  for (const issue of bundle.issues) {
    warnings.push({ code: issue.code, detail: issue.detail })
  }

  return {
    dialect: parsed.dialect,
    draft: parsed.draft,
    supportFiles,
    links: bundle.links,
    bundleVersion: 2,
    sourceDigest: bundle.sourceDigest,
    warnings,
    importSource: {
      kind: 'github',
      owner,
      repo,
      path,
      ref: ref ?? null,
      sha: skillContents.sha,
      sourceDigest: bundle.sourceDigest,
      resourceHashes: Object.fromEntries(bundle.resources.map((resource) => [resource.path, resource.contentHash])),
    },
  }
}

async function collectSupportFiles(
  github: GithubContentsReader,
  target: GithubImportTarget,
  folderListing: GithubContentEntry[],
): Promise<{ files: Array<{ path: string; content: string }>; skipped: string[] }> {
  const files: Array<{ path: string; content: string }> = []
  const skipped: string[] = []
  let totalBytes = 0

  const collectDirectory = async (directoryPath: string): Promise<void> => {
    const listing = await github.getFileContents(target.owner, target.repo, directoryPath, target.ref)
    const entries = Array.isArray(listing) ? listing : [listing]
    for (const file of entries) {
      if (file.type === 'dir') {
        await collectDirectory(file.path)
        continue
      }
      if (file.type !== 'file') {
        skipped.push(file.path)
        continue
      }
      if (files.length >= IMPORT_MAX_SUPPORT_FILES) {
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
      const relativePath = file.path.startsWith(`${target.path}/`)
        ? file.path.slice(target.path.length + 1)
        : file.path
      if (!skillResourceKindFromPath(relativePath)) {
        skipped.push(file.path)
        continue
      }
      files.push({ path: relativePath, content: fetched.content })
    }
  }

  for (const dirEntry of folderListing) {
    if (dirEntry.name.toLowerCase() === 'skill.md') continue

    const isSupportDir = dirEntry.type === 'dir' && SUPPORT_DIRS.has(dirEntry.name.toLowerCase())
    if (!isSupportDir) {
      skipped.push(dirEntry.type === 'dir' ? `${dirEntry.name}/` : dirEntry.name)
      continue
    }
    await collectDirectory(dirEntry.path)
  }

  return { files, skipped }
}

// Re-exported so the route can share one cap constant with URL fetches.
export { IMPORT_MAX_FILE_BYTES }
