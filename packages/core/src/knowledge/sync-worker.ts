/**
 * Knowledge sync worker — polls GitHub repos and mirrors markdown files into the DB.
 *
 * Follows the consolidation worker pattern: setInterval + tick + advisory lock.
 * Pure deterministic sync — no LLM.
 *
 * Team-scoped: entries are stored once per (workspace_id, path); assistants in the
 * team read the team's entries filtered by their clearance. Sync writes one
 * row per file regardless of how many assistants are in the team.
 *
 * See docs/architecture/features/knowledge-base.md.
 */

import { parseMarkdownFile } from './parser.js'
import { buildPathIndex, resolveWikilink } from './wikilink-resolver.js'
import { buildLintIndex, runAllChecks, type Finding, type LintInputEntry } from '@use-brian/brian-kb'
import type { Sensitivity } from '../security/sensitivity.js'
import { promises as fs } from 'node:fs'
import * as nodePath from 'node:path'
import { createHash } from 'node:crypto'

// ── Types ──────────────────────────────────────────────────────

export type SyncSource = {
  bindingVersion?: string
  configuredByUserId?: string | null
  bindingHeld?: boolean
  id: string
  workspaceId: string
  sourceType: 'github' | 'local'
  repo: string
  branch: string
  rootPath: string
  lastSyncedSha: string | null
  /**
   * The connector_instance this source syncs through. Persisted from the user's
   * picker choice at source creation. NULL on legacy rows (or after the bound
   * connector is deleted) — the credential provider then falls back to
   * by-workspace resolution.
   */
  connectorInstanceId: string | null
  /**
   * Tier stamped on entries whose frontmatter carries no explicit (valid)
   * `sensitivity:` (migration 410). Explicit frontmatter always wins; this
   * only replaces the parser's global 'internal' fallback per source.
   */
  defaultSensitivity: Sensitivity
}

export type SyncGitHubApi = {
  getBranchHead(pat: string, owner: string, repo: string, branch: string): Promise<string>
  getRepoTree(pat: string, owner: string, repo: string, sha: string): Promise<Array<{ path: string; sha: string }>>
  getFileContents(pat: string, owner: string, repo: string, path: string, ref?: string): Promise<{ content?: string } | Array<{ content?: string }>>
  compareCommits(pat: string, owner: string, repo: string, base: string, head: string): Promise<{
    headSha: string
    files: Array<{ filename: string; status: string }>
  }>
  /** The PAT's effective repo permissions — backs the write-capability probe. */
  getRepoPermissions(pat: string, owner: string, repo: string): Promise<{ push: boolean }>
}

export type SyncStore = {
  captureSourceSync?(source: SyncSource): Promise<object | undefined>
  releaseSourceSync?(authority: object): Promise<void>
  syncRequiresFullReconciliation?(authority: object): boolean
  upsertByPath(params: {
    workspaceId: string; path: string; title: string
    summary?: string | null; content: string; tags?: string[]; relatedIds?: string[]
    sensitivity: Sensitivity
    /** Whether `sensitivity` came from explicit frontmatter (mig 410 provenance). */
    sensitivityExplicit?: boolean
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    metadata?: Record<string, unknown>; sourceId?: string | null; sourceSha?: string | null
  }, syncAuthority?: object): Promise<{ id: string; path: string }>
  deleteByTeamAndPath(workspaceId: string, path: string, syncAuthority?: object): Promise<boolean>
  // System-level reads — sync is a privileged-service caller (no
  // per-viewer projection). See permissions.md § Privileged-service
  // exception and packages/api/src/db/knowledge-store.ts.
  listPathsSystem(workspaceId: string): Promise<string[]>
  getByPathSystem(workspaceId: string, path: string): Promise<{
    id: string
    sourceId?: string | null
    metadata?: Record<string, unknown>
  } | null>
  updateRelatedIds(id: string, relatedIds: string[], syncAuthority?: object): Promise<void>
  updateSourceSync(id: string, sha: string, error?: string | null, syncAuthority?: object): Promise<void>
  /** Persist the per-tick PAT write-capability probe (migration 310). */
  updateSourceWriteAccess(id: string, writeAccess: boolean, syncAuthority?: object): Promise<void>
  getSourcesDueForSync(): Promise<SyncSource[]>
}

export type SyncCredentials = {
  /**
   * Resolve the GitHub PAT for a source. When `connectorInstanceId` is set, the
   * provider reads that exact connector's credentials (so a source always syncs
   * through the connector it was created with). NULL falls back to by-workspace
   * resolution for legacy sources.
   */
  getPat(workspaceId: string, connectorInstanceId: string | null): Promise<string>
}

export type SyncEvent = {
  type: 'sync_started' | 'sync_completed' | 'sync_error' | 'sync_lint_findings'
  sourceId: string
  repo: string
  entriesCreated?: number
  entriesUpdated?: number
  entriesDeleted?: number
  error?: string
  findings?: Finding[]
}

// ── Worker ─────────────────────────────────────────────────────

export function createKnowledgeSyncWorker(options: {
  store: SyncStore
  api: SyncGitHubApi
  credentials: SyncCredentials
  intervalMs?: number
  onEvent?: (event: SyncEvent) => void
  tryAcquireLock?: () => Promise<boolean>
  releaseLock?: () => Promise<void>
}): { start(): void; stop(): void; tick(): Promise<void> } {
  const { store, api, credentials, intervalMs = 15 * 60 * 1000, onEvent } = options

  const upsertSynced = (params: Parameters<SyncStore['upsertByPath']>[0], authority?: object) =>
    authority ? store.upsertByPath(params, authority) : store.upsertByPath(params)

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function tick() {
    if (running) return
    running = true

    try {
      // Advisory lock
      if (options.tryAcquireLock) {
        const acquired = await options.tryAcquireLock()
        if (!acquired) return
      }

      const sources = await store.getSourcesDueForSync()

      for (const source of sources) {
        let authority: object | undefined
        try {
          authority = await store.captureSourceSync?.(source)
          if (store.captureSourceSync && !authority) throw new Error('knowledge_sync_authority_required')
          const reconcile = authority && store.syncRequiresFullReconciliation?.(authority)
          await syncSource(reconcile ? { ...source, lastSyncedSha: null } : source, authority)
        } catch (err) {
          const errorMsg = describeSyncError(err)
          console.error(`[knowledge-sync] source ${source.repo} failed:`, errorMsg, err)
          try { await store.updateSourceSync(source.id, source.lastSyncedSha ?? '', errorMsg, authority) } catch { /* stale runs cannot publish status */ }
          onEvent?.({
            type: 'sync_error',
            sourceId: source.id,
            repo: source.repo,
            error: errorMsg,
          })
        } finally {
          if (authority) await store.releaseSourceSync?.(authority).catch(() => {})
        }
      }
    } finally {
      if (options.releaseLock) {
        await options.releaseLock().catch(() => {})
      }
      running = false
    }
  }

  async function syncSource(source: SyncSource, syncAuthority?: object) {
    if (source.sourceType === 'local') {
      await syncLocalSource(source, syncAuthority)
      return
    }

    source = { ...source, rootPath: normalizeKnowledgeRoot(source.rootPath) }
    const [owner, repo] = source.repo.split('/')
    if (!owner || !repo) throw new Error(`Invalid repo format: ${source.repo}`)

    const pat = await credentials.getPat(source.workspaceId, source.connectorInstanceId)

    // Write-capability probe — cached on the source row and consumed by the
    // assistant KB write tools' injection gate. Runs BEFORE the no-change
    // early-return so a swapped PAT self-heals within one tick even when the
    // repo has no new commits. Advisory: a probe failure never fails the sync
    // (the cached value simply stays as-is).
    try {
      const perms = await api.getRepoPermissions(pat, owner, repo)
      await store.updateSourceWriteAccess(source.id, perms.push, syncAuthority)
    } catch (err) {
      console.warn(
        `[knowledge-sync] write-access probe failed for ${source.repo}:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    // Get current HEAD
    const headSha = await api.getBranchHead(pat, owner, repo, source.branch)

    // Skip if nothing changed
    if (headSha === source.lastSyncedSha) {
      if (syncAuthority) await store.updateSourceSync(source.id, headSha, null, syncAuthority)
      return
    }

    onEvent?.({ type: 'sync_started', sourceId: source.id, repo: source.repo })

    let created = 0
    let updated = 0
    let deleted = 0

    if (!source.lastSyncedSha) {
      // ── Full sync ────────────────────────────────────────
      const tree = await api.getRepoTree(pat, owner, repo, headSha)
      const mdFiles = tree.filter((f) => {
        const p = f.path
        if (!p.endsWith('.md')) return false
        if (source.rootPath && !p.startsWith(source.rootPath + "/")) return false
        return true
      })

      // Pass 1: create/update entries (+ collect lint inputs)
      const lintInputs: LintInputEntry[] = []
      for (const file of mdFiles) {
        const relativePath = source.rootPath
          ? file.path.slice(source.rootPath.length).replace(/^\//, '')
          : file.path

        const content = await fetchFileContent(pat, owner, repo, file.path, headSha)

        const parsed = parseMarkdownFile(relativePath, content)
        lintInputs.push({
          source: `${source.repo}:${file.path}`,
          relativePath,
          rawContent: content,
        })

        await upsertSynced({
          workspaceId: source.workspaceId,
          path: parsed.path,
          title: parsed.title,
          summary: parsed.summary,
          content: parsed.content,
          tags: parsed.tags,
          sensitivity: parsed.sensitivityExplicit ? parsed.sensitivity : source.defaultSensitivity,
          sensitivityExplicit: parsed.sensitivityExplicit,
          metadata: { ...parsed.metadata, _rawRelated: parsed.related },
          sourceId: source.id,
          sourceSha: headSha,
        }, syncAuthority)
        created++
      }

      const retained = new Set(mdFiles.map(file => parseMarkdownFile(source.rootPath ? file.path.slice(source.rootPath.length + 1) : file.path, '').path))
      for (const path of await store.listPathsSystem(source.workspaceId)) {
        if (retained.has(path)) continue
        const entry = await store.getByPathSystem(source.workspaceId, path)
        if (entry?.sourceId === source.id && await store.deleteByTeamAndPath(source.workspaceId, path, syncAuthority)) deleted++
      }

      // Pass 2: resolve wikilinks
      await resolveAllWikilinks(source, store, syncAuthority)

      // Lint pass — only on full sync (incremental lacks unchanged-file context)
      runLintPass(source, lintInputs)
    } else {
      // ── Incremental sync ─────────────────────────────────
      const diff = await api.compareCommits(pat, owner, repo, source.lastSyncedSha, headSha)

      const relevantFiles = diff.files.filter((f) => {
        if (!f.filename.endsWith('.md')) return false
        if (source.rootPath && !f.filename.startsWith(source.rootPath + "/")) return false
        return true
      })

      for (const file of relevantFiles) {
        const relativePath = source.rootPath
          ? file.filename.slice(source.rootPath.length).replace(/^\//, '')
          : file.filename

        if (file.status === 'removed') {
          const parsed = parseMarkdownFile(relativePath, '')
          const wasDeleted = await store.deleteByTeamAndPath(source.workspaceId, parsed.path, syncAuthority)
          if (wasDeleted) deleted++
          continue
        }

        // added or modified
        const content = await fetchFileContent(pat, owner, repo, file.filename, headSha)

        const parsed = parseMarkdownFile(relativePath, content)

        await upsertSynced({
          workspaceId: source.workspaceId,
          path: parsed.path,
          title: parsed.title,
          summary: parsed.summary,
          content: parsed.content,
          tags: parsed.tags,
          sensitivity: parsed.sensitivityExplicit ? parsed.sensitivity : source.defaultSensitivity,
          sensitivityExplicit: parsed.sensitivityExplicit,
          metadata: { ...parsed.metadata, _rawRelated: parsed.related },
          sourceId: source.id,
          sourceSha: headSha,
        }, syncAuthority)

        if (file.status === 'added') created++
        else updated++
      }

      // Resolve wikilinks for changed entries
      if (relevantFiles.length > 0) {
        await resolveAllWikilinks(source, store, syncAuthority)
      }
    }

    await store.updateSourceSync(source.id, headSha, null, syncAuthority)

    onEvent?.({
      type: 'sync_completed',
      sourceId: source.id,
      repo: source.repo,
      entriesCreated: created,
      entriesUpdated: updated,
      entriesDeleted: deleted,
    })

    console.debug(
      `[knowledge-sync] ${source.repo}: created=${created} updated=${updated} deleted=${deleted}`,
    )
  }

  async function syncLocalSource(source: SyncSource, syncAuthority?: object) {
    const baseDir = await fs.realpath(nodePath.resolve(source.repo))
    const root = await fs.realpath(nodePath.resolve(baseDir, source.rootPath || '.'))
    const relativeRoot = nodePath.relative(baseDir, root)
    if (relativeRoot === '..' || relativeRoot.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relativeRoot)) {
      throw new Error(`Local knowledge root escapes its source directory: ${source.rootPath}`)
    }

    const rootStat = await fs.stat(root)
    if (!rootStat.isDirectory()) throw new Error(`Local knowledge path is not a directory: ${root}`)

    const mdFiles = await walkMarkdownFiles(root)
    const headSha = await computeDirHash(root, mdFiles)
    if (headSha === source.lastSyncedSha) {
      if (syncAuthority) await store.updateSourceSync(source.id, headSha, null, syncAuthority)
      return
    }

    onEvent?.({ type: 'sync_started', sourceId: source.id, repo: source.repo })

    let created = 0
    let updated = 0
    let deleted = 0

    const lintInputs: LintInputEntry[] = []
    for (const absPath of mdFiles) {
      const relativePath = nodePath.relative(root, absPath)
      const content = await fs.readFile(absPath, 'utf-8')

      const parsed = parseMarkdownFile(relativePath, content)
      lintInputs.push({
        source: `${source.repo}:${relativePath}`,
        relativePath,
        rawContent: content,
      })

      const existing = await store.getByPathSystem(source.workspaceId, parsed.path)
      await upsertSynced({
        workspaceId: source.workspaceId,
        path: parsed.path,
        title: parsed.title,
        summary: parsed.summary,
        content: parsed.content,
        tags: parsed.tags,
        sensitivity: parsed.sensitivityExplicit ? parsed.sensitivity : source.defaultSensitivity,
        sensitivityExplicit: parsed.sensitivityExplicit,
        metadata: { ...parsed.metadata, _rawRelated: parsed.related },
        sourceId: source.id,
        sourceSha: headSha,
      }, syncAuthority)
      if (existing) updated++
      else created++
    }

    const syncedPaths = new Set(
      mdFiles.map((f) => parseMarkdownFile(nodePath.relative(root, f), '').path),
    )
    const allPaths = await store.listPathsSystem(source.workspaceId)
    for (const p of allPaths) {
      if (syncedPaths.has(p)) continue
      const entry = await store.getByPathSystem(source.workspaceId, p)
      if (!entry) continue
      if (entry.sourceId !== source.id) continue
      const wasDeleted = await store.deleteByTeamAndPath(source.workspaceId, p, syncAuthority)
      if (wasDeleted) deleted++
    }

    await resolveAllWikilinks(source, store, syncAuthority)
    runLintPass(source, lintInputs)
    await store.updateSourceSync(source.id, headSha, null, syncAuthority)

    onEvent?.({
      type: 'sync_completed',
      sourceId: source.id,
      repo: source.repo,
      entriesCreated: created,
      entriesUpdated: updated,
      entriesDeleted: deleted,
    })

    console.debug(
      `[knowledge-sync] ${source.repo}: created=${created} updated=${updated} deleted=${deleted}`,
    )
  }

  async function fetchFileContent(
    pat: string,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string> {
    const data = await api.getFileContents(pat, owner, repo, path, ref)
    if (Array.isArray(data) || typeof data.content !== 'string') throw new Error(`Knowledge file unavailable: ${path}`)
    return data.content
  }

  function runLintPass(source: SyncSource, inputs: LintInputEntry[]) {
    if (inputs.length === 0) return
    try {
      const index = buildLintIndex(inputs)
      const findings = runAllChecks(index)
      if (findings.length === 0) return

      const counts = findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1
        return acc
      }, {})
      console.warn(
        `[knowledge-sync] lint findings for ${source.repo}: ` +
        `errors=${counts.error ?? 0} warnings=${counts.warning ?? 0} info=${counts.info ?? 0}`,
      )
      for (const f of findings.filter((f) => f.severity === 'error').slice(0, 20)) {
        console.warn(`[knowledge-sync] ${f.source}${f.line ? ':' + f.line : ''} ${f.check} — ${f.message}`)
      }
      onEvent?.({
        type: 'sync_lint_findings',
        sourceId: source.id,
        repo: source.repo,
        findings,
      })
    } catch (err) {
      // Lint is advisory — never fail the sync over it.
      console.warn(`[knowledge-sync] lint pass failed for ${source.repo}:`, err instanceof Error ? err.message : String(err))
    }
  }

  async function resolveAllWikilinks(source: SyncSource, syncStore: SyncStore, syncAuthority?: object) {
    const allPaths = await syncStore.listPathsSystem(source.workspaceId)
    const pathIndex = buildPathIndex(allPaths)

    // For each entry, read _rawRelated from metadata, resolve refs to paths,
    // then look up UUIDs for those paths.
    let resolved = 0
    for (const entryPath of allPaths) {
      const entry = await syncStore.getByPathSystem(source.workspaceId, entryPath)
      if (!entry || entry.sourceId !== source.id) continue

      const metadata = (entry as any).metadata as Record<string, unknown> | undefined
      const rawRelated = metadata?._rawRelated as string[] | undefined
      if (!Array.isArray(rawRelated)) continue

      // Resolve each raw ref to a path
      const resolvedIds: string[] = []
      for (const ref of rawRelated) {
        const resolvedPath = resolveWikilink(ref, entryPath, pathIndex)
        if (!resolvedPath) continue

        // Look up the entry at this path to get its UUID
        const target = await syncStore.getByPathSystem(source.workspaceId, resolvedPath)
        if (target) {
          resolvedIds.push((target as any).id as string)
        }
      }

      // Empty results must clear stale edges left by an interrupted run too.
      const unique = [...new Set(resolvedIds)]
      await syncStore.updateRelatedIds((entry as any).id as string, unique, syncAuthority)
      resolved++
    }

    if (resolved > 0) {
      console.debug(`[knowledge-sync] resolved wikilinks for ${resolved} entries (team ${source.workspaceId})`)
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => { tick().catch((err) => console.error('[knowledge-sync] tick failed:', err)) }, intervalMs)
      // Run first tick immediately
      tick().catch((err) => console.error('[knowledge-sync] initial tick failed:', err))
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },

    tick,
  }
}

/**
 * Build a human-actionable error string from a thrown sync failure.
 *
 * Node 20+ undici fetch errors surface as `Error('fetch failed')` with the
 * real network condition (DNS, TLS, ECONNRESET, etc.) wrapped on `err.cause`.
 * The cause is sometimes a plain `Error` (single attempt) and sometimes an
 * `AggregateError` (happy-eyeballs IPv4+IPv6 race) whose first inner error
 * carries the OS code. This walks one level of `cause` and unwraps an
 * `AggregateError` so the user sees what actually went wrong.
 */
function describeSyncError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as Error & { cause?: unknown }).cause
  if (cause === undefined) return err.message

  // AggregateError (e.g. happy-eyeballs across IPv4 and IPv6) — surface the
  // first inner error since they typically share the same OS code.
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    const first = cause.errors[0]
    return first instanceof Error
      ? `${err.message}: ${describeInner(first)}`
      : `${err.message}: ${String(first)}`
  }
  if (cause instanceof Error) return `${err.message}: ${describeInner(cause)}`
  return `${err.message}: ${String(cause)}`
}

function describeInner(e: Error): string {
  const code = (e as Error & { code?: string }).code
  return code ? `${e.message} (${code})` : e.message
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = nodePath.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      results.push(...await walkMarkdownFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full)
    }
  }
  return results
}

async function computeDirHash(root: string, files: string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const f of files.sort()) {
    const rel = nodePath.relative(root, f)
    const content = await fs.readFile(f, 'utf-8')
    hash.update(`${rel}:${content}\n`)
  }
  return hash.digest('hex').slice(0, 40)
}

// Repository roots are directories, never string prefixes.
export function normalizeKnowledgeRoot(root: string): string {
  const parts = root.trim().replace(/\\/g, '/').split('/').filter(p => p && p !== '.')
  if (parts.includes('..')) throw new Error('Invalid knowledge root')
  return parts.join('/')
}
