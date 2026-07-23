/**
 * Knowledge source writer — assistant KB write-back for GitHub and local sources.
 * [COMP:knowledge/repo-writer]
 *
 * Implements the core `KnowledgeRepoWriter` port: direct commits to a
 * repo-synced source's branch through the source's bound PAT (the same
 * credential resolution the sync worker and the human proposal flow use),
 * followed by an eager one-file write-through — the same parse+upsert the
 * sync worker runs — so retrieval reflects the edit immediately.
 *
 * Invariants (docs/architecture/features/knowledge-base.md → "Assistant
 * direct edits"):
 * - Update preserves the live file's frontmatter byte-for-byte; only the
 *   body changes.
 * - A staleness guard aborts when the live repo body differs from the
 *   synced DB copy the model read — never commit an edit derived from a
 *   stale base.
 * - `last_synced_sha` is never touched: the next incremental sync re-walks
 *   the assistant's commit idempotently and re-resolves wikilinks (the
 *   write-through mirrors the worker's upsert, which resets `related_ids`
 *   until that pass).
 * - A GitHub 403 flips the source's cached `write_access` to false, so the
 *   write tools drop out of injection on the next turn.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import { parseMarkdownFile } from '@use-brian/core'
import type { KnowledgeRepoWriter, KnowledgeRepoWriteResult, Sensitivity } from '@use-brian/core'
import * as github from '../github/client.js'
import { splitFrontmatterBlock, resolveRepoFilePath, validateKnowledgeEntryPath } from './repo-files.js'

/** The GitHub calls the writer makes. Injectable so tests run without the network. */
export type RepoWriterGithubOps = {
  getBranchHead(pat: string, owner: string, repo: string, branch: string): Promise<string>
  getRepoTree(pat: string, owner: string, repo: string, sha: string): Promise<Array<{ path: string }>>
  getFileContents(
    pat: string, owner: string, repo: string, path: string, ref?: string,
  ): Promise<{ content?: string } | Array<{ content?: string }>>
  createOrUpdateFile(
    pat: string, owner: string, repo: string,
    params: { path: string; content: string; message: string; branch?: string },
  ): Promise<unknown>
}

const DEFAULT_GITHUB_OPS: RepoWriterGithubOps = {
  getBranchHead: github.getBranchHead,
  getRepoTree: github.getRepoTree,
  getFileContents: github.getFileContents,
  createOrUpdateFile: github.createOrUpdateFile,
}

/** The store slice the writer needs — the api `KnowledgeStore` satisfies it. */
export type RepoWriterStore = {
  getSource(id: string): Promise<{
    id: string
    workspaceId: string
    sourceType: 'github' | 'local'
    repo: string
    branch: string
    rootPath: string
    connectorInstanceId: string | null
    writeAccess: boolean | null
  } | null>
  upsertByPath(params: {
    workspaceId: string; path: string; title: string
    summary?: string | null; content: string; tags?: string[]
    sensitivity: Sensitivity
    metadata?: Record<string, unknown>; sourceId?: string | null; sourceSha?: string | null
  }): Promise<{ id: string; path: string }>
  updateSourceWriteAccess(id: string, writeAccess: boolean): Promise<void>
}

export type KnowledgeRepoWriterDeps = {
  store: RepoWriterStore
  /** Same bound-instance PAT resolution the sync worker uses. */
  syncCredentials?: { getPat(workspaceId: string, connectorInstanceId: string | null): Promise<string> }
  /** Test seam. Defaults to the real fetch-based client. */
  githubOps?: RepoWriterGithubOps
  /** Metadata-only audit emit (`kb_repo_write` into analytics_events). */
  recordEvent?: (event: { userId: string; eventName: string; metadata: Record<string, unknown> }) => void
}

type ResolvedTarget =
  | { ok: true; kind: 'github'; source: NonNullable<Awaited<ReturnType<RepoWriterStore['getSource']>>>; owner: string; repo: string; pat: string }
  | { ok: true; kind: 'local'; source: NonNullable<Awaited<ReturnType<RepoWriterStore['getSource']>>>; root: string }
  | { ok: false; result: KnowledgeRepoWriteResult }

export function createKnowledgeRepoWriter(deps: KnowledgeRepoWriterDeps): KnowledgeRepoWriter {
  const ops = deps.githubOps ?? DEFAULT_GITHUB_OPS

  function fail(reason: Extract<KnowledgeRepoWriteResult, { ok: false }>['reason'], message: string): { ok: false; result: KnowledgeRepoWriteResult } {
    return { ok: false, result: { ok: false, reason, message } }
  }

  async function resolveTarget(workspaceId: string, sourceId: string): Promise<ResolvedTarget> {
    const source = await deps.store.getSource(sourceId)
    if (!source || source.workspaceId !== workspaceId) {
      return fail('source_missing', 'The knowledge source backing this entry no longer exists.')
    }
    if (source.sourceType === 'local') {
      try {
        const base = await fs.realpath(source.repo)
        const root = await fs.realpath(nodePath.resolve(base, source.rootPath || '.'))
        const relative = nodePath.relative(base, root)
        if (relative === '..' || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) {
          return fail('source_missing', 'The local knowledge root escapes its configured source directory.')
        }
        const stat = await fs.stat(root)
        if (!stat.isDirectory()) return fail('source_missing', 'The local knowledge root is not a directory.')
        return { ok: true, kind: 'local', source, root }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return fail('not_writable', `The local knowledge directory is unavailable: ${message}`)
      }
    }

    // Defense-in-depth behind the injection gate: the cached probe is the
    // authority even if a stale tool instance survives a capability flip.
    if (source.writeAccess !== true) {
      return fail('not_writable', `The GitHub token for ${source.repo} is read-only (needs push permission). Reconnect it with a read-write token in Studio → Connectors.`)
    }
    const [owner, repo] = source.repo.split('/')
    if (!owner || !repo) {
      return fail('source_missing', `The knowledge source has an invalid repo format: ${source.repo}`)
    }
    let pat: string
    try {
      if (!deps.syncCredentials) throw new Error('GitHub credentials are not configured')
      pat = await deps.syncCredentials.getPat(source.workspaceId, source.connectorInstanceId)
    } catch {
      return fail('no_credentials', `The GitHub connector backing ${source.repo} has no credentials. Reconnect it in Studio → Connectors.`)
    }
    return { ok: true, kind: 'github', source, owner, repo, pat }
  }

  /**
   * Map a thrown GitHub error to a result. A 403 means the PAT lost push
   * access — flip the cached probe so injection drops the write tools on
   * the next turn (fire-and-forget; the sync tick re-probes regardless).
   */
  function classifyWriteError(source: { id: string; repo: string }, err: unknown): KnowledgeRepoWriteResult {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('(403)')) {
      deps.store.updateSourceWriteAccess(source.id, false).catch((e) => {
        console.error('[kb-repo-writer] failed to persist write_access=false:', e)
      })
      return {
        ok: false,
        reason: 'push_denied',
        message: `GitHub rejected the write to ${source.repo} (403): the token no longer has push access. Knowledge editing is disabled until it is reconnected with a read-write token in Studio → Connectors.`,
      }
    }
    if (message.includes('(401)')) {
      return {
        ok: false,
        reason: 'no_credentials',
        message: `The GitHub token for ${source.repo} is invalid or revoked. Reconnect it in Studio → Connectors.`,
      }
    }
    return { ok: false, reason: 'error', message: `GitHub write failed: ${message}` }
  }

  function classifyLocalWriteError(source: { repo: string }, err: unknown): KnowledgeRepoWriteResult {
    const code = (err as NodeJS.ErrnoException | null)?.code
    const message = err instanceof Error ? err.message : String(err)
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return { ok: false, reason: 'not_writable', message: `The local knowledge directory is not writable: ${source.repo}` }
    }
    return { ok: false, reason: 'error', message: `Local knowledge write failed: ${message}` }
  }

  function toPosixPath(value: string): string {
    return value.split(nodePath.sep).join('/')
  }

  async function listLocalMarkdownFiles(root: string): Promise<Array<{ absolute: string; relative: string }>> {
    const files: Array<{ absolute: string; relative: string }> = []
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const absolute = nodePath.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          await walk(absolute)
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          files.push({ absolute, relative: toPosixPath(nodePath.relative(root, absolute)) })
        }
      }
    }
    await walk(root)
    return files
  }

  async function replaceLocalFile(filePath: string, content: string): Promise<void> {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The local knowledge file is not a regular file.')
    const tempPath = nodePath.join(nodePath.dirname(filePath), `.${nodePath.basename(filePath)}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(tempPath, content, { flag: 'wx', mode: stat.mode })
      await fs.rename(tempPath, filePath)
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {})
    }
  }

  async function ensureLocalCreateParent(root: string, entryPath: string): Promise<string> {
    const segments = entryPath.split('/')
    let current = root
    for (const segment of segments.slice(0, -1)) {
      current = nodePath.join(current, segment)
      try {
        const stat = await fs.lstat(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Local knowledge path parent is not a regular directory: ${segment}`)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        await fs.mkdir(current)
      }
    }
    const target = nodePath.join(root, ...segments) + '.md'
    const relative = nodePath.relative(root, target)
    if (relative === '..' || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) {
      throw new Error('Local knowledge path escapes its configured root.')
    }
    return target
  }

  function relativeRepoPath(rootPath: string, filePath: string): string {
    const prefix = rootPath.replace(/\/+$/, '')
    return prefix ? filePath.slice(prefix.length).replace(/^\//, '') : filePath
  }

  function commitMessage(changeSummary: string, entryPath: string, requestedBy?: { label?: string | null } | null): string {
    const subject = `kb(assistant): ${changeSummary.trim()}`.split('\n')[0]
    const trailer = `Committed-via: Use Brian assistant${requestedBy?.label ? ` on behalf of ${requestedBy.label}` : ''}`
    return `${subject}\n\nEntry: ${entryPath}\n${trailer}`
  }

  function emitAudit(
    requestedBy: { userId: string } | null | undefined,
    metadata: Record<string, unknown>,
  ): void {
    if (!requestedBy?.userId) return
    deps.recordEvent?.({ userId: requestedBy.userId, eventName: 'kb_repo_write', metadata })
  }

  function commitRef(res: unknown): { sha: string | null; url: string | null } {
    const commit = (res as { commit?: { sha?: string; html_url?: string } } | null)?.commit
    return { sha: commit?.sha ?? null, url: commit?.html_url ?? null }
  }

  /**
   * Eager one-file mirror: run the exact parse+upsert the sync worker runs
   * for this file, so the DB row equals what the next tick would produce.
   * `related_ids` resets like a worker upsert; the next incremental sync
   * (which will see this commit — `last_synced_sha` stays untouched)
   * re-resolves wikilinks workspace-wide.
   */
  async function writeThrough(
    source: { id: string; workspaceId: string; rootPath: string },
    relativePath: string,
    fileContent: string,
    commitSha: string | null,
  ): Promise<{ id: string; path: string }> {
    const parsed = parseMarkdownFile(relativePath, fileContent)
    return await deps.store.upsertByPath({
      workspaceId: source.workspaceId,
      path: parsed.path,
      title: parsed.title,
      summary: parsed.summary,
      content: parsed.content,
      tags: parsed.tags,
      sensitivity: parsed.sensitivity,
      metadata: { ...parsed.metadata, _rawRelated: parsed.related },
      sourceId: source.id,
      sourceSha: commitSha,
    })
  }

  function mirrorFailure(sourceType: 'github' | 'local', commitSha: string | null, err: unknown): KnowledgeRepoWriteResult {
    console.error('[kb-repo-writer] write-through failed after a successful source write:', err)
    return {
      ok: false,
      reason: 'error',
      message: sourceType === 'github'
        ? `The change was committed to GitHub${commitSha ? ` (${commitSha.slice(0, 7)})` : ''}, but the local mirror update failed — it will appear after the next sync (within ~15 minutes).`
        : 'The local knowledge file was updated, but the database mirror failed — it will recover after the next sync (within ~15 minutes).',
    }
  }

  return {
    async commitEntryUpdate({ workspaceId, entry, newBody, changeSummary, requestedBy }) {
      const target = await resolveTarget(workspaceId, entry.sourceId)
      if (!target.ok) return target.result
      const { source } = target

      let filePath: string
      let relativePath: string
      let newFile: string
      let commitSha: string | null = null
      let commitUrl: string | null = null

      if (target.kind === 'github') {
        try {
          const headSha = await ops.getBranchHead(target.pat, target.owner, target.repo, source.branch)
          const tree = await ops.getRepoTree(target.pat, target.owner, target.repo, headSha)
          const resolved = resolveRepoFilePath(tree.map((t) => t.path), source.rootPath, entry.path)
          if (!resolved) {
            return { ok: false, reason: 'file_missing', message: 'The file behind this entry was not found in the repository — it may have been moved or deleted. Try again after the next sync.' }
          }
          filePath = resolved
          relativePath = relativeRepoPath(source.rootPath, filePath)

          const fileData = await ops.getFileContents(target.pat, target.owner, target.repo, filePath, headSha)
          const rawFile = Array.isArray(fileData) ? null : (fileData.content ?? null)
          if (rawFile === null) {
            return { ok: false, reason: 'file_missing', message: 'Could not read the current file from the repository.' }
          }
          const { frontmatter, body: liveBody } = splitFrontmatterBlock(rawFile)
          if (liveBody.trim() !== entry.content.trim()) {
            return { ok: false, reason: 'stale_entry', message: 'The repository moved ahead of the synced copy. Retry after the next sync (within ~15 minutes), then re-read the entry before editing.' }
          }
          const body = newBody.endsWith('\n') ? newBody : `${newBody}\n`
          newFile = `${frontmatter}${body}`
          const res = await ops.createOrUpdateFile(target.pat, target.owner, target.repo, {
            path: filePath,
            content: newFile,
            message: commitMessage(changeSummary, entry.path, requestedBy),
            branch: source.branch,
          })
          ;({ sha: commitSha, url: commitUrl } = commitRef(res))
        } catch (err) {
          return classifyWriteError(source, err)
        }
      } else {
        try {
          const files = await listLocalMarkdownFiles(target.root)
          const resolved = files.find((file) => validateKnowledgeEntryPath(file.relative) === entry.path)
          if (!resolved) {
            return { ok: false, reason: 'file_missing', message: 'The file behind this entry was not found in the local knowledge directory. Try again after the next sync.' }
          }
          filePath = resolved.absolute
          relativePath = resolved.relative
          const rawFile = await fs.readFile(filePath, 'utf8')
          const { frontmatter, body: liveBody } = splitFrontmatterBlock(rawFile)
          if (liveBody.trim() !== entry.content.trim()) {
            return { ok: false, reason: 'stale_entry', message: 'The local knowledge file moved ahead of the synced copy. Retry after the next sync, then re-read the entry before editing.' }
          }
          const body = newBody.endsWith('\n') ? newBody : `${newBody}\n`
          newFile = `${frontmatter}${body}`
          await replaceLocalFile(filePath, newFile)
        } catch (err) {
          return classifyLocalWriteError(source, err)
        }
      }

      let row: { id: string; path: string }
      try {
        row = await writeThrough(source, relativePath, newFile, commitSha)
      } catch (err) {
        return mirrorFailure(source.sourceType, commitSha, err)
      }
      emitAudit(requestedBy, {
        workspaceId, sourceId: source.id, sourceType: source.sourceType, entryId: row.id, op: 'update', repo: source.repo, commitSha,
      })
      return { ok: true, entryId: row.id, path: row.path, sourceType: source.sourceType, commitSha, commitUrl }
    },

    async commitEntryCreate({ workspaceId, sourceId, path, fileContent, changeSummary, requestedBy }) {
      const target = await resolveTarget(workspaceId, sourceId)
      if (!target.ok) return target.result
      const { source } = target

      const entryPath = validateKnowledgeEntryPath(path)
      if (!entryPath) {
        return { ok: false, reason: 'error', message: `Invalid entry path: "${path}"` }
      }

      let filePath: string
      let relativePath: string
      let newFile: string
      let commitSha: string | null = null
      let commitUrl: string | null = null

      if (target.kind === 'github') {
        try {
          const headSha = await ops.getBranchHead(target.pat, target.owner, target.repo, source.branch)
          const tree = await ops.getRepoTree(target.pat, target.owner, target.repo, headSha)
          const existing = resolveRepoFilePath(tree.map((t) => t.path), source.rootPath, entryPath)
          if (existing) {
            return { ok: false, reason: 'file_exists', message: `An entry already exists at "${entryPath}" (${existing}). Use updateKnowledgeEntry to change it.` }
          }

          const prefix = source.rootPath.replace(/\/+$/, '')
          filePath = prefix ? `${prefix}/${entryPath}.md` : `${entryPath}.md`
          relativePath = relativeRepoPath(source.rootPath, filePath)
          newFile = fileContent.endsWith('\n') ? fileContent : `${fileContent}\n`
          const res = await ops.createOrUpdateFile(target.pat, target.owner, target.repo, {
            path: filePath,
            content: newFile,
            message: commitMessage(changeSummary, entryPath, requestedBy),
            branch: source.branch,
          })
          ;({ sha: commitSha, url: commitUrl } = commitRef(res))
        } catch (err) {
          return classifyWriteError(source, err)
        }
      } else {
        try {
          const files = await listLocalMarkdownFiles(target.root)
          const existing = files.find((file) => validateKnowledgeEntryPath(file.relative) === entryPath)
          if (existing) {
            return { ok: false, reason: 'file_exists', message: `An entry already exists at "${entryPath}" (${existing.relative}). Use updateKnowledgeEntry to change it.` }
          }
          filePath = await ensureLocalCreateParent(target.root, entryPath)
          relativePath = toPosixPath(nodePath.relative(target.root, filePath))
          newFile = fileContent.endsWith('\n') ? fileContent : `${fileContent}\n`
          await fs.writeFile(filePath, newFile, { flag: 'wx' })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            return { ok: false, reason: 'file_exists', message: `An entry already exists at "${entryPath}". Use updateKnowledgeEntry to change it.` }
          }
          return classifyLocalWriteError(source, err)
        }
      }

      let row: { id: string; path: string }
      try {
        row = await writeThrough(source, relativePath, newFile, commitSha)
      } catch (err) {
        return mirrorFailure(source.sourceType, commitSha, err)
      }
      emitAudit(requestedBy, {
        workspaceId, sourceId: source.id, sourceType: source.sourceType, entryId: row.id, op: 'create', repo: source.repo, commitSha,
      })
      return { ok: true, entryId: row.id, path: row.path, sourceType: source.sourceType, commitSha, commitUrl }
    },
  }
}
