import { describe, expect, it } from 'vitest'
import { normalizeImportUrl } from '../import-source.js'
import {
  importSkillFromGithub,
  importSkillFromPaste,
  importSkillFromUrl,
  SkillImportError,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_SUPPORT_FILE_BYTES,
  type GithubContentEntry,
  type GithubContentsReader,
} from '../import-service.js'

const SKILL_MD = [
  '---',
  'name: Release Notes',
  'description: Drafts release notes from merged PRs.',
  '---',
  'Collect merged PRs, then draft the notes.',
].join('\n')

describe('[COMP:api/skill-import] URL normalization', () => {
  it('rewrites github.com blob URLs to the raw host with provenance', () => {
    const result = normalizeImportUrl(
      'https://github.com/acme/skills/blob/main/skills/notes/SKILL.md',
    )
    expect(result).toMatchObject({
      fetchUrl: 'https://raw.githubusercontent.com/acme/skills/main/skills/notes/SKILL.md',
      fileName: 'SKILL.md',
      provenance: {
        kind: 'url',
        owner: 'acme',
        repo: 'skills',
        ref: 'main',
        path: 'skills/notes/SKILL.md',
      },
    })
  })

  it('passes raw.githubusercontent.com through and parses provenance', () => {
    const result = normalizeImportUrl(
      'https://raw.githubusercontent.com/acme/skills/main/deploy.md',
    )
    expect(result).toMatchObject({
      fetchUrl: 'https://raw.githubusercontent.com/acme/skills/main/deploy.md',
      fileName: 'deploy.md',
      provenance: { owner: 'acme', repo: 'skills', ref: 'main', path: 'deploy.md' },
    })
  })

  it('rewrites gist page URLs to the gist raw endpoint', () => {
    const result = normalizeImportUrl('https://gist.github.com/someone/abc123')
    expect(result).toMatchObject({
      fetchUrl: 'https://gist.githubusercontent.com/someone/abc123/raw',
    })
  })

  it('rejects non-https, non-allowlisted, and malformed URLs', () => {
    expect(normalizeImportUrl('http://raw.githubusercontent.com/a/b/c/d.md')).toHaveProperty('error')
    expect(normalizeImportUrl('https://evil.example.com/skill.md')).toHaveProperty('error')
    expect(normalizeImportUrl('https://github.com/acme/skills')).toHaveProperty('error')
    expect(normalizeImportUrl('not a url')).toHaveProperty('error')
  })
})

describe('[COMP:api/skill-import] importSkillFromUrl', () => {
  it('fetches, parses, and returns the draft with url provenance', async () => {
    const result = await importSkillFromUrl(
      'https://github.com/acme/skills/blob/main/SKILL.md',
      async () => SKILL_MD,
    )
    expect(result.dialect).toBe('agent-skills')
    expect(result.draft.name).toBe('Release Notes')
    expect(result.supportFiles).toEqual([])
    expect(result.importSource).toMatchObject({ kind: 'url', owner: 'acme', repo: 'skills' })
  })

  it('maps fetch failures to a 502 SkillImportError and junk content to 400', async () => {
    await expect(
      importSkillFromUrl('https://github.com/a/b/blob/main/x.md', async () => {
        throw new Error('boom')
      }),
    ).rejects.toMatchObject({ name: 'SkillImportError', status: 502 })

    await expect(
      importSkillFromUrl('https://github.com/a/b/blob/main/x.md', async () => '   '),
    ).rejects.toMatchObject({ name: 'SkillImportError', status: 400 })
  })

  it('rejects disallowed URLs before any fetch happens', async () => {
    let fetched = false
    await expect(
      importSkillFromUrl('https://evil.example.com/skill.md', async () => {
        fetched = true
        return SKILL_MD
      }),
    ).rejects.toBeInstanceOf(SkillImportError)
    expect(fetched).toBe(false)
  })
})

// ── GitHub import ─────────────────────────────────────────────

function file(path: string, content: string, size = content.length): GithubContentEntry {
  const name = path.split('/').pop()!
  return { type: 'file', name, path, size, sha: `sha-${name}`, content, encoding: 'utf-8' }
}

function dir(path: string): GithubContentEntry {
  const name = path.split('/').pop()!
  return { type: 'dir', name, path, size: 0, sha: `sha-${name}` }
}

/** Stub reader over a path → entry/listing map. */
function readerOf(map: Record<string, GithubContentEntry | GithubContentEntry[]>): GithubContentsReader {
  return {
    async getFileContents(_owner, _repo, path) {
      const hit = map[path]
      if (!hit) throw new Error(`no such path: ${path}`)
      return hit
    },
  }
}

describe('[COMP:api/skill-import] importSkillFromPaste', () => {
  it('parses pasted markdown into a draft with paste provenance', () => {
    const result = importSkillFromPaste(SKILL_MD)
    expect(result.dialect).toBe('agent-skills')
    expect(result.draft.name).toBe('Release Notes')
    expect(result.supportFiles).toEqual([])
    expect(result.importSource).toMatchObject({ kind: 'paste' })
    expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  // The file name only ever informs dialect detection + name derivation, so a
  // paste with no name still has to land on a usable draft.
  it('derives the name from an H1 when there is no frontmatter or file name', () => {
    const result = importSkillFromPaste('# Weekly Status\n\nCollect the updates.')
    expect(result.dialect).toBe('generic-markdown')
    expect(result.draft.name).toBe('Weekly Status')
    expect(result.warnings.map((w) => w.code)).toContain('no_frontmatter')
  })

  it('uses an uploaded file name for the name and the dialect', () => {
    const fromName = importSkillFromPaste('Collect the updates.', 'weekly-status.md')
    expect(fromName.draft.name).toBe('Weekly Status')

    // `.mdc` is the Cursor-rule signal — it must survive an upload.
    const cursor = importSkillFromPaste(
      ['---', 'description: A rule.', 'globs: "*.ts"', '---', 'Do the thing.'].join('\n'),
      'rule.mdc',
    )
    expect(cursor.dialect).toBe('cursor-rule')
  })

  it('carries the dialect lints through unchanged', () => {
    const result = importSkillFromPaste(
      ['---', 'description: A command.', 'argument-hint: <pr>', '---', 'Review `Bash` on $ARGUMENTS.'].join('\n'),
      'review.md',
    )
    expect(result.dialect).toBe('slash-command')
    const codes = result.warnings.map((w) => w.code)
    expect(codes).toContain('foreign_tools')
    expect(codes).toContain('arguments_placeholder')
    expect(codes).toContain('ignored_metadata')
  })

  it('rejects empty, blank, and unparseable pastes', () => {
    expect(() => importSkillFromPaste('')).toThrow(SkillImportError)
    expect(() => importSkillFromPaste('   \n  ')).toThrow(SkillImportError)
    expect(() => importSkillFromPaste('binary\u0000content')).toThrow(SkillImportError)
  })

  it('rejects a paste over the file byte cap', () => {
    expect(() => importSkillFromPaste('x'.repeat(IMPORT_MAX_FILE_BYTES + 1))).toThrow(
      /too large/i,
    )
  })

  // Paste does no server-side fetch at all, so it needs no host allowlist —
  // the property that makes it strictly safer than the URL source.
  it('never performs a network fetch', () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('paste import must not fetch')
    }) as typeof fetch
    try {
      expect(importSkillFromPaste(SKILL_MD).draft.name).toBe('Release Notes')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('[COMP:api/skill-import] importSkillFromGithub', () => {
  it('imports a single file with sha provenance', async () => {
    const github = readerOf({ 'skills/notes.md': file('skills/notes.md', SKILL_MD) })
    const result = await importSkillFromGithub(github, {
      owner: 'acme', repo: 'skills', path: 'skills/notes.md', ref: 'main',
    })
    expect(result.draft.name).toBe('Release Notes')
    expect(result.importSource).toMatchObject({
      kind: 'github', owner: 'acme', repo: 'skills', path: 'skills/notes.md',
      ref: 'main', sha: 'sha-notes.md',
    })
  })

  it('imports a native Agent Skills folder without rewriting SKILL.md', async () => {
    const linkedSkill = SKILL_MD.replace(
      'Collect merged PRs, then draft the notes.',
      'Read [style](references/style.md), then collect merged PRs and draft the notes.',
    )
    const github = readerOf({
      'notes': [
        file('notes/SKILL.md', linkedSkill),
        dir('notes/references'),
        dir('notes/scripts'),
        dir('notes/assets'),
        file('notes/logo.png', 'x'),
      ],
      'notes/SKILL.md': file('notes/SKILL.md', linkedSkill),
      'notes/references': [file('notes/references/style.md', 'House style guide.')],
      'notes/scripts': [file('notes/scripts/collect.sh', 'echo prs')],
      'notes/assets': [dir('notes/assets/templates')],
      'notes/assets/templates': [file('notes/assets/templates/release.md', 'Release layout.')],
      'notes/references/style.md': file('notes/references/style.md', 'House style guide.'),
      'notes/scripts/collect.sh': file('notes/scripts/collect.sh', 'echo prs'),
      'notes/assets/templates/release.md': file('notes/assets/templates/release.md', 'Release layout.'),
    })

    const result = await importSkillFromGithub(github, { owner: 'acme', repo: 'skills', path: 'notes' })

    expect(result.supportFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'reference', name: 'style.md', path: 'references/style.md' }),
      expect.objectContaining({ kind: 'script', name: 'collect.sh', path: 'scripts/collect.sh' }),
      expect.objectContaining({ kind: 'asset', name: 'release.md', path: 'assets/templates/release.md' }),
    ]))
    expect(result.draft.content).toBe(
      'Read [style](references/style.md), then collect merged PRs and draft the notes.',
    )
    expect(result.draft.content).not.toContain('{{reference:')
    expect(result.bundleVersion).toBe(2)
    expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/)

    const codes = result.warnings.map((w) => w.code)
    expect(codes).toContain('scripts_not_executable')
    const skipped = result.warnings.find((w) => w.code === 'unsupported_files')
    expect(skipped!.detail).toContain('logo.png')
    expect(result.importSource).toMatchObject({ kind: 'github', path: 'notes', sha: 'sha-SKILL.md' })
  })

  it('rejects a folder without SKILL.md and oversize support files', async () => {
    await expect(
      importSkillFromGithub(readerOf({ 'notes': [file('notes/readme.md', 'hi')] }), {
        owner: 'a', repo: 'b', path: 'notes',
      }),
    ).rejects.toMatchObject({ name: 'SkillImportError' })

    const big = { ...file('n/references/big.md', 'x'), size: IMPORT_MAX_SUPPORT_FILE_BYTES + 1 }
    await expect(
      importSkillFromGithub(
        readerOf({
          'n': [file('n/SKILL.md', SKILL_MD), dir('n/references')],
          'n/SKILL.md': file('n/SKILL.md', SKILL_MD),
          'n/references': [big],
        }),
        { owner: 'a', repo: 'b', path: 'n' },
      ),
    ).rejects.toThrow(/per-file limit/)
  })
})
