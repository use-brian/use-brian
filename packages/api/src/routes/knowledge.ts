/**
 * Knowledge base routes — two mount points.
 *
 * [COMP:api/knowledge-route] [COMP:api/knowledge-proposals]
 *
 * 1. `/api/assistants/:assistantId/knowledge` (knowledgeRoutes) — viewer +
 *    source management from the assistant detail page. Reads are filtered
 *    by the assistant's clearance.
 * 2. `/api/workspaces/:workspaceId/knowledge` (workspaceKnowledgeRoutes) —
 *    source management from the Studio ▸ Knowledge page. Workspace-scoped
 *    source CRUD + the GitHub picker + the entry reader's edit-proposal
 *    flow (`GET /entries/:id/edit-capability`, `POST /entries/:id/proposals`
 *    — see docs/architecture/features/knowledge-base.md → "Knowledge
 *    reader + edit proposals"). No general entry reads (those need an
 *    assistant context for clearance filtering); the proposal routes read
 *    one entry bounded by the member's effective clearance.
 */

import { Router } from 'express'
import { query, queryWithRLS } from '../db/client.js'
import { resolveAssistantAccess } from '../db/users.js'
import type { KnowledgeStore } from '../db/knowledge-store.js'
import type { ConnectorInstance, ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import { listUsableWorkspaceConnectors } from '../connectors/usable-connectors.js'
import { effectiveReadClearance, effectiveReadCompartments } from '../db/workspace-store.js'
import * as github from '../github/client.js'
import type { AccessContext, Sensitivity } from '@use-brian/core'
import { splitFrontmatterBlock, resolveRepoFilePath } from '../knowledge/repo-files.js'

// Re-exported for existing consumers/tests; the implementations moved to
// `../knowledge/repo-files.ts` so the assistant repo writer shares them.
export { splitFrontmatterBlock, resolveRepoFilePath } from '../knowledge/repo-files.js'

/**
 * The GitHub calls the edit-proposal flow makes. Injectable so the route
 * tests run without the network; production defaults to the fetch-based
 * client in `../github/client.ts`.
 */
export type KnowledgeGithubOps = {
  getRepoPermissions(pat: string, owner: string, repo: string): Promise<{ push: boolean }>
  getBranchHead(pat: string, owner: string, repo: string, branch: string): Promise<string>
  getRepoTree(pat: string, owner: string, repo: string, sha: string): Promise<Array<{ path: string }>>
  getFileContents(
    pat: string, owner: string, repo: string, path: string, ref?: string,
  ): Promise<{ content?: string } | Array<{ content?: string }>>
  createBranchRef(pat: string, owner: string, repo: string, branch: string, sha: string): Promise<void>
  createOrUpdateFile(
    pat: string, owner: string, repo: string,
    params: { path: string; content: string; message: string; branch?: string },
  ): Promise<unknown>
  createPullRequest(
    pat: string, owner: string, repo: string,
    params: { title: string; body?: string; head: string; base: string },
  ): Promise<{ number: number; html_url: string }>
}

const DEFAULT_GITHUB_OPS: KnowledgeGithubOps = {
  getRepoPermissions: github.getRepoPermissions,
  getBranchHead: github.getBranchHead,
  getRepoTree: github.getRepoTree,
  getFileContents: github.getFileContents,
  createBranchRef: github.createBranchRef,
  createOrUpdateFile: github.createOrUpdateFile,
  createPullRequest: github.createPullRequest,
}

type KnowledgeRouteOptions = {
  knowledgeStore: KnowledgeStore
  /**
   * Resolves credentials for the GitHub repo/branch lookups behind the KB
   * settings UI. Under the unified-connectors model a GitHub connector is
   * available to a workspace either as a legacy team-native instance
   * (scope='workspace') or as a member-exposed personal instance
   * (scope='user' + a `connector_grant`). The picker lists both; the caller
   * selects one before any repo loads.
   * See docs/architecture/features/knowledge-base.md → "Team credential scoping".
   */
  connectorInstanceStore?: ConnectorInstanceStore
  /**
   * Resolves which connectors are exposed to the workspace: the picker and the
   * PAT resolver both authorize through the exposure-gated usable set, so a
   * personal connector never surfaces (or operates) in a workspace it wasn't
   * granted to — the grant is also what lets the workspace-scoped sync worker
   * resolve credentials by `workspaceId`.
   */
  connectorGrantStore?: ConnectorGrantStore
  triggerSync?: (sourceId: string) => Promise<void>
  /**
   * Resolves the PAT a GitHub-synced source operates through — the SAME
   * bound-instance resolution the sync worker uses (`getPat(workspaceId,
   * connectorInstanceId)`), so an edit proposal always travels through
   * the connector the workspace configured for that source. Required for
   * the edit-proposal routes; absent → those routes report
   * `canPropose: false` / 503.
   */
  syncCredentials?: { getPat(workspaceId: string, connectorInstanceId: string | null): Promise<string> }
  /** Test seam for the proposal flow's GitHub calls. Defaults to the real client. */
  githubOps?: KnowledgeGithubOps
}

/**
 * List the GitHub `connector_instance` rows usable as a workspace KB source —
 * the member's own personal instances EXPOSED to this workspace PLUS every
 * workspace-shared GitHub connector within their clearance (legacy team-native
 * + teammate-granted). Mirrors `listUsableWorkspaceConnectors` so the picker
 * shows exactly what the member is allowed to configure with; an un-exposed
 * personal connector (connected in another workspace) and above-clearance
 * shared connectors are hidden. Deduped by id.
 *
 * Exported for the skill-import picker (routes/skills.ts), which lists the
 * same usable set.
 */
export async function listWorkspaceGithubInstances(
  connectorInstanceStore: ConnectorInstanceStore | undefined,
  connectorGrantStore: ConnectorGrantStore | undefined,
  userId: string,
  workspaceId: string,
): Promise<ConnectorInstance[]> {
  if (!connectorInstanceStore || !connectorGrantStore) return []
  const usable = await listUsableWorkspaceConnectors({
    connectorInstanceStore,
    connectorGrantStore,
    userId,
    workspaceId,
  })
  return usable
    .map((u) => u.instance)
    .filter((i) => i.provider === 'github' && i.connected)
}

const GITHUB_PAGE_SIZE = 100
const GITHUB_MAX_PAGES = 10

function parseNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1] ?? null
  }
  return null
}

async function githubFetchAllPages<T>(
  firstUrl: string,
  token: string,
): Promise<{ ok: true; items: T[] } | { ok: false }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  }
  const items: T[] = []
  let url: string | null = firstUrl
  for (let page = 0; page < GITHUB_MAX_PAGES && url; page++) {
    const res = await fetch(url, { headers })
    if (!res.ok) return { ok: false }
    const batch = (await res.json()) as T[]
    if (!Array.isArray(batch)) return { ok: false }
    items.push(...batch)
    url = parseNextPageUrl(res.headers.get('link'))
  }
  return { ok: true, items }
}

/**
 * Resolve a workspace-scoped GitHub PAT from a caller-selected
 * `connector_instance`. Shared between the assistant-scoped and
 * workspace-scoped routers. Writes a 4xx on failure and returns null.
 *
 * Authorization travels through the SAME usable-set the picker lists from
 * (`listUsableWorkspaceConnectors`), so the resolver can never operate a
 * connector the member isn't allowed to see — un-exposed personal,
 * above-clearance, or not shared to this workspace is denied. It accepts the
 * member's own workspace-exposed personal instance, a legacy team-native
 * instance, and a teammate-granted personal instance (within clearance for
 * the shared kinds).
 *
 * Exported for the skill-import routes (routes/skills.ts), which authorize
 * their GitHub reads through the same usable-set gate.
 */
export async function resolveWorkspaceGithubPat(
  connectorInstanceStore: ConnectorInstanceStore | undefined,
  connectorGrantStore: ConnectorGrantStore | undefined,
  userId: string,
  workspaceId: string,
  connectorInstanceId: string | undefined,
  res: import('express').Response,
): Promise<{ pat: string } | null> {
  if (!connectorInstanceStore || !connectorGrantStore) {
    res.status(503).json({ error: 'Connector store not configured on the server.' })
    return null
  }
  if (!connectorInstanceId) {
    res.status(400).json({
      error: 'A GitHub connector must be selected. Configure one at the workspace level first.',
    })
    return null
  }
  const usable = await listUsableWorkspaceConnectors({
    connectorInstanceStore,
    connectorGrantStore,
    userId,
    workspaceId,
  })
  const match = usable.find((u) => u.instance.id === connectorInstanceId)
  if (!match) {
    res.status(403).json({ error: 'Selected connector is not available to this workspace.' })
    return null
  }
  if (match.instance.provider !== 'github') {
    res.status(400).json({ error: 'Selected connector is not a GitHub connector.' })
    return null
  }
  // A teammate-granted instance is owned by another member, so it isn't
  // RLS-readable here — resolve its credential with the SAME system read the
  // sync worker uses for granted connectors. The usable-set lookup already
  // proved the grant + clearance, so this discloses nothing the member
  // couldn't already use. Own / team-native instances stay on the RLS read
  // (which also enforces `connected = true`); a disconnected granted instance
  // is treated as having no credentials.
  const creds = match.source === 'granted'
    ? (match.instance.connected ? await connectorInstanceStore.getCredentialsSystem(connectorInstanceId) : null)
    : await connectorInstanceStore.getCredentials(userId, connectorInstanceId)
  if (!creds) {
    res.status(400).json({
      error: 'Selected connector has no credentials configured. Reconnect it in Studio → Connectors.',
    })
    return null
  }
  return { pat: creds.client_secret }
}

/**
 * Validate and create a workspace knowledge source. Shared between the
 * assistant-scoped POST `/sources` and the workspace-scoped POST
 * `/sources`. Writes the response itself — caller should return after.
 */
async function createGithubKnowledgeSource(opts: {
  knowledgeStore: KnowledgeStore
  connectorInstanceStore: ConnectorInstanceStore | undefined
  connectorGrantStore: ConnectorGrantStore | undefined
  userId: string
  workspaceId: string
  repo: string
  branch?: string
  rootPath?: string
  connectorInstanceId: string
  res: import('express').Response
}): Promise<void> {
  const { knowledgeStore, connectorInstanceStore, connectorGrantStore, userId, workspaceId, repo, branch, rootPath, connectorInstanceId, res } = opts

  if (connectorInstanceStore) {
    try {
      const resolved = await resolveWorkspaceGithubPat(connectorInstanceStore, connectorGrantStore, userId, workspaceId, connectorInstanceId, res)
      if (!resolved) return

      // No ensure-grant here: a selectable personal connector already carries a
      // live grant to this workspace (`resolveWorkspaceGithubPat` authorizes
      // through the exposure-gated usable set), so the workspace-scoped sync
      // worker can resolve its PAT by `workspaceId`. Re-minting the grant here
      // would silently resurrect an exposure the owner deliberately revoked.

      const [repoOwner, repoName] = repo.split('/')
      if (!repoOwner || !repoName) {
        res.status(400).json({ error: 'Invalid repo format. Expected owner/name.' })
        return
      }

      const targetBranch = branch || 'main'
      const pat = resolved.pat

      const branchRes = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeURIComponent(targetBranch)}`,
        { headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' } },
      )
      if (!branchRes.ok) {
        res.status(400).json({ error: `Branch "${targetBranch}" not found in ${repo}.` })
        return
      }
      const branchData = await branchRes.json() as { object: { sha: string } }

      const treeRes = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/git/trees/${branchData.object.sha}?recursive=1`,
        { headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' } },
      )
      if (!treeRes.ok) {
        res.status(400).json({ error: 'Failed to read repository contents.' })
        return
      }
      const treeData = await treeRes.json() as { tree: Array<{ path: string; type: string }> }

      const prefix = rootPath?.replace(/\/+$/, '') ?? ''
      const allBlobs = treeData.tree.filter((f) => f.type === 'blob')
      const mdFiles = allBlobs.filter((f) =>
        f.path.endsWith('.md') &&
        (!prefix || f.path.startsWith(prefix)),
      )

      const EXCLUDED_NAMES = new Set(['readme', 'changelog', 'contributing', 'license', 'code_of_conduct'])
      const contentMdFiles = mdFiles.filter((f) => {
        const name = f.path.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() ?? ''
        return !EXCLUDED_NAMES.has(name)
      })

      if (contentMdFiles.length === 0) {
        const pathHint = prefix ? ` under "${prefix}"` : ''
        const hint = mdFiles.length > 0
          ? ` Found ${mdFiles.length} markdown file(s), but they are all standard project files (README, CHANGELOG, etc.), not knowledge entries.`
          : ''
        res.status(400).json({
          error: `No knowledge content found in ${repo}${pathHint}.${hint} A knowledge repo should contain multiple .md files organized in directories with descriptions.`,
        })
        return
      }

      const hasIndexFile = mdFiles.some((f) => f.path.endsWith('/index.md') || f.path === 'index.md')
      const hasNesting = contentMdFiles.some((f) => {
        const relativePath = prefix ? f.path.slice(prefix.length).replace(/^\//, '') : f.path
        return relativePath.includes('/')
      })

      if (!hasIndexFile && !hasNesting && contentMdFiles.length < 3) {
        res.status(400).json({
          error: `This repo doesn't look like a knowledge base. Found ${contentMdFiles.length} content file(s) but no directory structure or index.md. A knowledge repo should have multiple .md files organized in directories.`,
        })
        return
      }

      const samplePaths = contentMdFiles.slice(0, 5)
      let frontmatterCount = 0
      for (const sample of samplePaths) {
        try {
          const fileRes = await fetch(
            `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/contents/${sample.path}?ref=${encodeURIComponent(targetBranch)}`,
            { headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' } },
          )
          if (fileRes.ok) {
            const fileData = await fileRes.json() as { content?: string; encoding?: string }
            if (fileData.content && fileData.encoding === 'base64') {
              const decoded = Buffer.from(fileData.content, 'base64').toString('utf-8')
              if (decoded.startsWith('---')) frontmatterCount++
            }
          }
        } catch { /* skip this sample */ }
      }

      const hasFrontmatter = frontmatterCount > 0
      const validationWarning = !hasFrontmatter
        ? 'No YAML frontmatter detected. Entries will sync with limited metadata (no descriptions or tags). For best results, add frontmatter with description and tags fields.'
        : null

      const source = await knowledgeStore.createSource({
        workspaceId,
        sourceType: 'github',
        repo,
        branch: targetBranch,
        rootPath: rootPath?.replace(/\/+$/, ''),
        // Bind the source to the connector the user picked, so sync uses this
        // exact PAT instead of re-resolving by workspace. See
        // docs/architecture/features/knowledge-base.md → "Workspace credential scoping".
        connectorInstanceId,
      })

      // Inline write-capability probe so a just-created source is writable
      // for the assistant KB tools immediately instead of after the first
      // sync tick (≤15 min). Best-effort — the tick re-probes regardless.
      try {
        const perms = await github.getRepoPermissions(pat, repoOwner, repoName)
        await knowledgeStore.updateSourceWriteAccess(source.id, perms.push)
      } catch (probeErr) {
        console.warn('[knowledge] create-time write-access probe failed:', probeErr instanceof Error ? probeErr.message : String(probeErr))
      }

      res.status(201).json({
        ...source,
        validation: {
          markdownFiles: contentMdFiles.length,
          hasIndexFile,
          hasNesting,
          hasFrontmatter,
          frontmatterRatio: samplePaths.length > 0 ? `${frontmatterCount}/${samplePaths.length}` : null,
          warning: validationWarning,
        },
      })
      return
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'This repo is already connected' })
        return
      }
      console.error('[knowledge] pre-connect validation failed:', err)
      // Fall through to basic create below
    }
  }

  try {
    const source = await knowledgeStore.createSource({
      workspaceId,
      sourceType: 'github',
      repo,
      branch,
      rootPath,
      connectorInstanceId,
    })
    res.status(201).json(source)
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'This repo is already connected' })
      return
    }
    console.error('[knowledge] create source failed:', err)
    res.status(500).json({ error: 'Failed to connect source' })
  }
}

export function knowledgeRoutes({
  knowledgeStore,
  connectorInstanceStore,
  connectorGrantStore,
  triggerSync,
}: KnowledgeRouteOptions): Router {
  const router = Router({ mergeParams: true })

  /**
   * Resolve a GitHub PAT for repo/branch enumeration from a caller-selected
   * `connector_instance` — either a legacy team-native instance or the
   * caller's own personal instance (the unified-connectors path).
   *
   * Returns `{ pat }` on success; on failure writes a 4xx response and
   * returns null. Callers should `return` immediately on null.
   */
  function resolveGithubPatForListing(
    userId: string,
    workspaceId: string,
    connectorInstanceId: string | undefined,
    res: import('express').Response,
  ): Promise<{ pat: string } | null> {
    return resolveWorkspaceGithubPat(connectorInstanceStore, connectorGrantStore, userId, workspaceId, connectorInstanceId, res)
  }

  async function verifyMembership(
    req: { userId?: string; params: { assistantId: string } },
    res: import('express').Response,
  ): Promise<string | null> {
    const access = await verifyTeamOrAssistantAccess(req, res)
    return access?.userId ?? null
  }

  /**
   * Authorize access to team-level knowledge operations (picker + repo
   * enumeration), returning the assistant's workspace.
   *
   * Delegates to `resolveAssistantAccess` — the single access predicate
   * (`direct assistant_members grant OR workspace_members membership`). The
   * owning workspace's members are the right audience for configuring a team's
   * KB sources; they may not be in `assistant_members` for every team-owned
   * assistant.
   *
   * **403, never 404.** This previously probed `SELECT workspace_id FROM
   * assistants` first and 404'd on an unknown id, making a nonexistent assistant
   * distinguishable from one the caller cannot reach. Both collapse to 403.
   */
  async function verifyTeamOrAssistantAccess(
    req: { userId?: string; params: { assistantId: string } },
    res: import('express').Response,
  ): Promise<{ userId: string; workspaceId: string | null } | null> {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return null }

    const access = await resolveAssistantAccess(userId, req.params.assistantId)
    if (!access) {
      res.status(403).json({ error: 'Not a member of this assistant or its team' })
      return null
    }
    return { userId, workspaceId: access.assistant.workspaceId }
  }

  // Resolve the assistant's team and clearance into an AccessContext.
  // KB reads are filtered by the assistant's clearance so the web UI
  // mirrors what the LLM sees; writes require a team.
  async function resolveAssistantContext(
    userId: string,
    assistantId: string,
    res: import('express').Response,
  ): Promise<AccessContext | null> {
    const result = await query<{
      workspace_id: string | null
      clearance: Sensitivity
      kind: AccessContext['assistantKind']
    }>(
      `SELECT workspace_id, clearance, kind FROM assistants WHERE id = $1`,
      [assistantId],
    )
    const row = result.rows[0]
    if (!row) { res.status(404).json({ error: 'Assistant not found' }); return null }
    if (!row.workspace_id) {
      res.status(400).json({ error: 'This assistant is not in a team — no knowledge base is available.' })
      return null
    }
    return {
      workspaceId: row.workspace_id,
      userId,
      assistantId,
      assistantKind: row.kind,
      clearance: row.clearance,
    }
  }

  // ── GET /entries — search or browse ─────────────────────────

  router.get('/entries', async (req, res) => {
    const userId = await verifyMembership(req as any, res)
    if (!userId) return

    const { assistantId } = req.params as { assistantId: string }
    const ctx = await resolveAssistantContext(userId, assistantId, res)
    if (!ctx) return

    const { q, path } = req.query as { q?: string; path?: string }

    try {
      if (q) {
        const results = await knowledgeStore.search(ctx, q, 20)
        res.json({
          entries: results.map((e) => ({
            id: e.id,
            path: e.path,
            title: e.title,
            summary: e.summary,
            tags: e.tags,
            sensitivity: e.sensitivity,
          })),
        })
      } else {
        const entries = await knowledgeStore.listByPath(ctx, path ?? '')
        res.json({
          entries: entries.map((e: any) => ({
            id: e.id,
            path: e.path,
            title: e.title,
            summary: e.summary,
            tags: e.tags,
            sensitivity: e.sensitivity,
            childCount: e.childCount ?? 0,
          })),
        })
      }
    } catch (err) {
      console.error('[knowledge] list entries failed:', err)
      res.status(500).json({ error: 'Failed to list entries' })
    }
  })

  // ── GET /entries/:id — read one entry ──────────────────────

  router.get('/entries/:id', async (req, res) => {
    const userId = await verifyMembership(req as any, res)
    if (!userId) return

    const { assistantId } = req.params as { assistantId: string; id: string }
    const ctx = await resolveAssistantContext(userId, assistantId, res)
    if (!ctx) return

    try {
      const entry = await knowledgeStore.getById(ctx, req.params.id)
      if (!entry || entry.workspaceId !== ctx.workspaceId) {
        res.status(404).json({ error: 'Entry not found' }); return
      }
      res.json(entry)
    } catch (err) {
      console.error('[knowledge] get entry failed:', err)
      res.status(500).json({ error: 'Failed to get entry' })
    }
  })

  // ── POST /entries — create entry ──────────────────────────

  router.post('/entries', async (req, res) => {
    const userId = await verifyMembership(req as any, res)
    if (!userId) return

    const { assistantId } = req.params as { assistantId: string }
    const ctx = await resolveAssistantContext(userId, assistantId, res)
    if (!ctx) return

    // Check if a source is connected (writes disabled)
    const sources = await knowledgeStore.listSources(ctx.workspaceId)
    if (sources.length > 0) {
      res.status(400).json({ error: 'Knowledge base is synced from a GitHub repository. Edit the repo directly.' })
      return
    }

    const { path, title, content, tags, sensitivity } = req.body as {
      path?: string; title?: string; content?: string; tags?: string[]; sensitivity?: string
    }
    if (!path || !title || !content) {
      res.status(400).json({ error: 'path, title, and content are required' })
      return
    }
    const tier = (sensitivity === 'public' || sensitivity === 'confidential' || sensitivity === 'internal')
      ? sensitivity
      : 'internal'

    try {
      const entry = await knowledgeStore.create({
        workspaceId: ctx.workspaceId,
        path,
        title,
        content,
        tags,
        sensitivity: tier,
        createdBy: userId,
      })
      res.status(201).json(entry)
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'An entry already exists at this path' })
        return
      }
      console.error('[knowledge] create entry failed:', err)
      res.status(500).json({ error: 'Failed to create entry' })
    }
  })

  // ── DELETE /entries/:id — delete entry ────────────────────

  router.delete('/entries/:id', async (req, res) => {
    const userId = await verifyMembership(req as any, res)
    if (!userId) return

    const { assistantId } = req.params as { assistantId: string; id: string }
    const ctx = await resolveAssistantContext(userId, assistantId, res)
    if (!ctx) return

    try {
      // Only allow deleting entries that belong to this assistant's team.
      const entry = await knowledgeStore.getById(ctx, req.params.id)
      if (!entry || entry.workspaceId !== ctx.workspaceId) {
        res.status(404).json({ error: 'Entry not found' }); return
      }
      const deleted = await knowledgeStore.delete(req.params.id)
      if (!deleted) { res.status(404).json({ error: 'Entry not found' }); return }
      res.status(204).end()
    } catch (err) {
      console.error('[knowledge] delete entry failed:', err)
      res.status(500).json({ error: 'Failed to delete entry' })
    }
  })

  // ── GET /sources — list connected sources ─────────────────
  // Each source carries an `enabled` flag: whether this assistant draws on it.
  // Default (no denylist row) = enabled. See the PATCH below.

  router.get('/sources', async (req, res) => {
    const userId = await verifyMembership(req as any, res)
    if (!userId) return

    const { assistantId } = req.params as { assistantId: string }
    try {
      const [sources, disabledIds] = await Promise.all([
        knowledgeStore.listSourcesForAssistant(assistantId),
        knowledgeStore.listDisabledSourceIds(assistantId),
      ])
      const disabled = new Set(disabledIds)
      res.json({ sources: sources.map((s) => ({ ...s, enabled: !disabled.has(s.id) })) })
    } catch (err) {
      console.error('[knowledge] list sources failed:', err)
      res.status(500).json({ error: 'Failed to list sources' })
    }
  })

  // ── PATCH /sources/:id/enablement — toggle a source for THIS assistant ──
  // Per-assistant denylist toggle. `{ enabled: false }` drops the source's
  // synced entries from this assistant's searchKnowledge / browseKnowledge /
  // readKnowledgeEntry reads (and this page's KB viewer); workspace-shared
  // storage and every other assistant are untouched. `{ enabled: true }`
  // clears the denylist row. Default for a never-toggled source is enabled.
  // See docs/architecture/features/knowledge-base.md → "Per-assistant source scoping".

  router.patch('/sources/:id/enablement', async (req, res) => {
    const userId = await verifyMembership(req as any, res)
    if (!userId) return

    const { assistantId } = req.params as { assistantId: string; id: string }
    const ctx = await resolveAssistantContext(userId, assistantId, res)
    if (!ctx) return

    const sourceId = (req.params as { id: string }).id
    const { enabled } = req.body as { enabled?: unknown }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' })
      return
    }

    try {
      // Only sources owned by this assistant's workspace are togglable.
      const source = await knowledgeStore.getSource(sourceId)
      if (!source || source.workspaceId !== ctx.workspaceId) {
        res.status(404).json({ error: 'Source not found' }); return
      }
      await knowledgeStore.setSourceDisabled({ assistantId, sourceId, disabled: !enabled, userId })
      res.json({ ok: true, enabled })
    } catch (err) {
      console.error('[knowledge] toggle source enablement failed:', err)
      res.status(500).json({ error: 'Failed to update source' })
    }
  })

  // ── POST /sources — connect GitHub repo ───────────────────
  // Validates the repo has syncable markdown content before saving.

  router.post('/sources', async (req, res) => {
    const userId = await verifyMembership(req as any, res)
    if (!userId) return

    const { workspaceId, repo, branch, rootPath, connectorInstanceId } = req.body as {
      workspaceId?: string; repo?: string; branch?: string; rootPath?: string;
      connectorInstanceId?: string
    }
    if (!workspaceId || !repo) {
      res.status(400).json({ error: 'workspaceId and repo are required' })
      return
    }
    if (!connectorInstanceId) {
      res.status(400).json({
        error: 'connectorInstanceId is required. Configure a workspace-scoped GitHub connector first.',
      })
      return
    }
    await createGithubKnowledgeSource({
      knowledgeStore, connectorInstanceStore, connectorGrantStore,
      userId, workspaceId, repo, branch, rootPath, connectorInstanceId, res,
    })
  })

  // ── DELETE /sources/:id — disconnect + cleanup ────────────

  router.delete('/sources/:id', async (req, res) => {
    const userId = await verifyMembership(req as any, res)
    if (!userId) return

    const { assistantId } = req.params as { assistantId: string; id: string }
    const ctx = await resolveAssistantContext(userId, assistantId, res)
    if (!ctx) return

    const sourceId = (req.params as { id: string }).id

    try {
      // Only allow deleting sources owned by this assistant's team.
      const source = await knowledgeStore.getSource(sourceId)
      if (!source || source.workspaceId !== ctx.workspaceId) {
        res.status(404).json({ error: 'Source not found' }); return
      }
      // Delete derived entries first
      await knowledgeStore.deleteBySource(sourceId)
      const deleted = await knowledgeStore.deleteSource(sourceId)
      if (!deleted) { res.status(404).json({ error: 'Source not found' }); return }
      res.status(204).end()
    } catch (err) {
      console.error('[knowledge] delete source failed:', err)
      res.status(500).json({ error: 'Failed to disconnect source' })
    }
  })

  // ── POST /sources/:id/sync — trigger manual sync ──────────

  router.post('/sources/:id/sync', async (req, res) => {
    const userId = await verifyMembership(req as any, res)
    if (!userId) return

    const { assistantId } = req.params as { assistantId: string; id: string }
    const ctx = await resolveAssistantContext(userId, assistantId, res)
    if (!ctx) return

    const sourceId = (req.params as { id: string }).id

    try {
      const source = await knowledgeStore.getSource(sourceId)
      if (!source || source.workspaceId !== ctx.workspaceId) {
        res.status(404).json({ error: 'Source not found' }); return
      }

      if (triggerSync) {
        await triggerSync(sourceId)
        res.json({ ok: true, message: 'Sync triggered' })
      } else {
        res.status(501).json({ error: 'Sync worker not configured' })
      }
    } catch (err) {
      console.error('[knowledge] trigger sync failed:', err)
      res.status(500).json({ error: 'Failed to trigger sync' })
    }
  })

  // ── GET /github/instances — list usable GitHub connectors for the picker ──
  // Returns the team-scoped GitHub `connector_instance` rows the caller can see.
  // The UI picks an instance first, then loads repos under it.

  router.get('/github/instances', async (req, res) => {
    const access = await verifyTeamOrAssistantAccess(req as any, res)
    if (!access) return
    const { userId, workspaceId } = access

    try {
      if (!workspaceId) {
        res.status(400).json({ error: 'This assistant is not in a team.' })
        return
      }

      const instances = await listWorkspaceGithubInstances(connectorInstanceStore, connectorGrantStore, userId, workspaceId)

      res.json({
        instances: instances.map((i) => ({
          id: i.id,
          label: i.label,
          connectedEmail: i.connectedEmail,
          sensitivity: i.sensitivity,
        })),
      })
    } catch (err) {
      console.error('[knowledge] list github instances failed:', err)
      res.status(500).json({ error: 'Failed to list GitHub connectors' })
    }
  })

  // ── GET /github/repos — list repos for a chosen connector instance ──
  // Requires `?connectorInstanceId=...`. Team-scoped instances only.

  router.get('/github/repos', async (req, res) => {
    const access = await verifyTeamOrAssistantAccess(req as any, res)
    if (!access) return
    const { userId, workspaceId } = access

    try {
      if (!workspaceId) {
        res.status(400).json({ error: 'This assistant is not in a team.' })
        return
      }

      const { connectorInstanceId } = req.query as { connectorInstanceId?: string }
      const resolved = await resolveGithubPatForListing(userId, workspaceId, connectorInstanceId, res)
      if (!resolved) return

      const firstUrl = `https://api.github.com/user/repos?per_page=${GITHUB_PAGE_SIZE}&sort=updated&affiliation=owner,organization_member`
      const result = await githubFetchAllPages<{ full_name: string; private: boolean; description: string | null }>(
        firstUrl,
        resolved.pat,
      )
      if (!result.ok) {
        res.json({ repos: [], error: 'Failed to list repos from GitHub' })
        return
      }
      res.json({
        repos: result.items.map((r) => ({
          fullName: r.full_name,
          private: r.private,
          description: r.description,
        })),
      })
    } catch (err) {
      console.error('[knowledge] list github repos failed:', err)
      res.status(500).json({ error: 'Failed to list repos' })
    }
  })

  // ── GET /github/repos/:owner/:repo/branches — list branches ──
  // Same `?connectorInstanceId=...` selection rule as `/github/repos`.

  router.get('/github/repos/:owner/:repo/branches', async (req, res) => {
    const access = await verifyTeamOrAssistantAccess(req as any, res)
    if (!access) return
    const { userId, workspaceId } = access

    const { owner, repo } = req.params as { assistantId: string; owner: string; repo: string }

    try {
      if (!workspaceId) {
        res.status(400).json({ error: 'This assistant is not in a team.' })
        return
      }

      const { connectorInstanceId } = req.query as { connectorInstanceId?: string }
      const resolved = await resolveGithubPatForListing(userId, workspaceId, connectorInstanceId, res)
      if (!resolved) return

      const firstUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${GITHUB_PAGE_SIZE}`
      const result = await githubFetchAllPages<{ name: string }>(firstUrl, resolved.pat)
      if (!result.ok) {
        res.json({ branches: [] })
        return
      }
      res.json({ branches: result.items.map((b) => b.name) })
    } catch (err) {
      console.error('[knowledge] list branches failed:', err)
      res.status(500).json({ error: 'Failed to list branches' })
    }
  })

  return router
}

// ── Edit-proposal helpers ──────────────────────────────────────
// `splitFrontmatterBlock` / `resolveRepoFilePath` live in
// `../knowledge/repo-files.ts` (shared with the assistant repo writer)
// and are re-exported at the top of this file.

/** Branch-name-safe slug from an entry path's last segment. */
function branchSlug(entryPath: string): string {
  const base = entryPath.split('/').pop() ?? 'entry'
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug.slice(0, 40) : 'entry'
}

/**
 * Workspace-scoped knowledge routes mounted at
 * `/api/workspaces/:workspaceId/knowledge`. Source CRUD + GitHub picker —
 * no general entry reads (those live on the assistant-scoped router because
 * they require an assistant's clearance for the result filter). The entry
 * reader's edit-proposal pair reads ONE entry bounded by the member's
 * effective clearance.
 *
 *   GET    /sources              — list workspace sources
 *   POST   /sources              — connect a GitHub repo
 *   DELETE /sources/:id          — disconnect + delete derived entries
 *   POST   /sources/:id/sync     — trigger manual sync
 *   GET    /github/instances     — list workspace GitHub connectors
 *   GET    /github/repos         — list repos under a connector
 *   GET    /github/repos/:owner/:repo/branches — list branches
 *   GET    /entries/:id/edit-capability — can the reader propose an edit?
 *   POST   /entries/:id/proposals — open a PR with the suggested change
 */
export function workspaceKnowledgeRoutes({
  knowledgeStore,
  connectorInstanceStore,
  connectorGrantStore,
  triggerSync,
  syncCredentials,
  githubOps = DEFAULT_GITHUB_OPS,
}: KnowledgeRouteOptions): Router {
  const router = Router({ mergeParams: true })

  async function verifyWorkspaceMember(
    req: { userId?: string; params: { workspaceId: string } },
    res: import('express').Response,
  ): Promise<{
    userId: string
    workspaceId: string
    role: 'owner' | 'admin' | 'member'
    clearance: Sensitivity | null
    compartments: string[] | null
  } | null> {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return null }
    const { workspaceId } = req.params
    if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return null }
    const result = await queryWithRLS<{
      role: 'owner' | 'admin' | 'member'
      clearance: Sensitivity | null
      compartments: string[] | null
    }>(
      userId,
      `SELECT role, clearance, compartments FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    )
    if (result.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return null
    }
    const row = result.rows[0]
    return { userId, workspaceId, role: row.role, clearance: row.clearance, compartments: row.compartments }
  }

  /**
   * The member's read context for the proposal routes' single-entry read —
   * the same member-bounded primary/reflector shape the brain explorer
   * uses (`resolveBrainCtx`), so an entry the member can't see in the
   * reader can't be probed or edited through this surface either.
   */
  function memberCtx(auth: NonNullable<Awaited<ReturnType<typeof verifyWorkspaceMember>>>): AccessContext {
    return {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      assistantId: '00000000-0000-0000-0000-000000000000',
      assistantKind: 'primary',
      clearance: effectiveReadClearance(auth.role, auth.clearance, 'confidential'),
      compartments: effectiveReadCompartments(auth.role, auth.compartments, null),
    }
  }

  /**
   * Shared resolution for both proposal routes: entry (member-clearance
   * read) → owning source → PAT. Distinguishes the capability outcomes
   * so GET can report them and POST can 4xx them.
   */
  async function resolveProposalTarget(
    auth: NonNullable<Awaited<ReturnType<typeof verifyWorkspaceMember>>>,
    entryId: string,
  ): Promise<
    | { ok: true; entry: { id: string; path: string; title: string }; source: { id: string; repo: string; branch: string; rootPath: string; connectorInstanceId: string | null }; owner: string; repo: string; pat: string }
    | { ok: false; status: 404 | 400 | 503; failure: 'not_found' | 'manual_entry' | 'source_missing' | 'no_credentials' | 'not_configured' }
  > {
    const entry = await knowledgeStore.getById(memberCtx(auth), entryId)
    if (!entry || entry.workspaceId !== auth.workspaceId) {
      return { ok: false, status: 404, failure: 'not_found' }
    }
    if (!entry.sourceId) return { ok: false, status: 400, failure: 'manual_entry' }
    const source = await knowledgeStore.getSource(entry.sourceId)
    if (!source || source.workspaceId !== auth.workspaceId) {
      return { ok: false, status: 400, failure: 'source_missing' }
    }
    const [owner, repo] = source.repo.split('/')
    if (!owner || !repo) return { ok: false, status: 400, failure: 'source_missing' }
    if (!syncCredentials) return { ok: false, status: 503, failure: 'not_configured' }
    let pat: string
    try {
      pat = await syncCredentials.getPat(source.workspaceId, source.connectorInstanceId)
    } catch {
      return { ok: false, status: 400, failure: 'no_credentials' }
    }
    return { ok: true, entry, source, owner, repo, pat }
  }

  // ── GET /entries/:id/edit-capability — can the reader propose? ──
  // Read-only probe for the entry reader's "Suggest an edit" button.
  // `canPropose: false` is a NORMAL answer (grey the button), so source /
  // credential problems report through the body, not an error status.

  router.get('/entries/:id/edit-capability', async (req, res) => {
    const auth = await verifyWorkspaceMember(req as any, res)
    if (!auth) return
    const entryId = (req.params as { id: string }).id

    try {
      const target = await resolveProposalTarget(auth, entryId)
      if (!target.ok) {
        if (target.failure === 'not_found') {
          res.status(404).json({ error: 'Entry not found' })
          return
        }
        res.json({
          mode: target.failure === 'manual_entry' ? 'manual' : 'github',
          canPropose: false,
          reason: target.failure === 'manual_entry' ? null : target.failure,
          repo: null,
          branch: null,
          repoUrl: null,
        })
        return
      }

      let push = false
      try {
        const perms = await githubOps.getRepoPermissions(target.pat, target.owner, target.repo)
        push = perms.push
      } catch (err) {
        console.error('[knowledge:workspace] permission probe failed:', err)
        res.json({
          mode: 'github', canPropose: false, reason: 'no_credentials',
          repo: target.source.repo, branch: target.source.branch,
          repoUrl: `https://github.com/${target.source.repo}`,
        })
        return
      }

      res.json({
        mode: 'github',
        canPropose: push,
        reason: push ? null : 'no_write_access',
        repo: target.source.repo,
        branch: target.source.branch,
        repoUrl: `https://github.com/${target.source.repo}`,
      })
    } catch (err) {
      console.error('[knowledge:workspace] edit-capability failed:', err)
      res.status(500).json({ error: 'Failed to check edit capability' })
    }
  })

  // ── POST /entries/:id/proposals — open a PR with the suggested change ──
  // The DB row is never written here — the change lands through the
  // normal sync after the PR merges (the repo stays the source of truth).

  router.post('/entries/:id/proposals', async (req, res) => {
    const auth = await verifyWorkspaceMember(req as any, res)
    if (!auth) return
    const entryId = (req.params as { id: string }).id

    const { content, comment } = req.body as { content?: unknown; comment?: unknown }
    if (typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({ error: 'content (non-empty string) is required' })
      return
    }
    if (content.length > 200_000) {
      res.status(400).json({ error: 'content is too large' })
      return
    }
    if (comment !== undefined && typeof comment !== 'string') {
      res.status(400).json({ error: 'comment must be a string' })
      return
    }

    try {
      const target = await resolveProposalTarget(auth, entryId)
      if (!target.ok) {
        const message =
          target.failure === 'not_found' ? 'Entry not found'
          : target.failure === 'manual_entry' ? 'This entry is not synced from GitHub. Edit it directly instead.'
          : target.failure === 'source_missing' ? 'The knowledge source backing this entry no longer exists.'
          : target.failure === 'no_credentials' ? 'The GitHub connector backing this source has no credentials. Reconnect it in Studio → Connectors.'
          : 'Proposals are not configured on this server.'
        res.status(target.status).json({ error: message })
        return
      }
      const { entry, source, owner, repo, pat } = target

      // Re-check push permission server-side — the greyed-out button is
      // advisory, this is the gate.
      const perms = await githubOps.getRepoPermissions(pat, owner, repo)
      if (!perms.push) {
        res.status(403).json({ error: 'The GitHub credential backing this source has read-only access.' })
        return
      }

      const headSha = await githubOps.getBranchHead(pat, owner, repo, source.branch)
      const tree = await githubOps.getRepoTree(pat, owner, repo, headSha)
      const filePath = resolveRepoFilePath(tree.map((t) => t.path), source.rootPath, entry.path)
      if (!filePath) {
        res.status(409).json({ error: 'The file behind this entry was not found in the repository. It may have been moved or deleted; try again after the next sync.' })
        return
      }

      // Preserve the live file's frontmatter verbatim — the DB body is
      // frontmatter-stripped, so the user only ever edits the body.
      const fileData = await githubOps.getFileContents(pat, owner, repo, filePath, headSha)
      const rawFile = Array.isArray(fileData) ? null : (fileData.content ?? null)
      if (rawFile === null) {
        res.status(409).json({ error: 'Could not read the current file from the repository.' })
        return
      }
      const { frontmatter } = splitFrontmatterBlock(rawFile)
      const body = content.endsWith('\n') ? content : `${content}\n`
      const newFile = `${frontmatter}${body}`

      const branch = `brian/kb-${branchSlug(entry.path)}-${Date.now().toString(36)}`
      await githubOps.createBranchRef(pat, owner, repo, branch, headSha)
      await githubOps.createOrUpdateFile(pat, owner, repo, {
        path: filePath,
        content: newFile,
        message: `kb: update ${entry.path} via Use Brian`,
        branch,
      })

      // Attribution: the commit is authored by the PAT owner, so the PR
      // body names the proposing member explicitly. Caller-scoped read —
      // RLS-gated like every other on-behalf-of access.
      let proposerEmail: string | null = null
      try {
        const user = await queryWithRLS<{ email: string | null }>(
          auth.userId,
          `SELECT email FROM users WHERE id = $1`, [auth.userId],
        )
        proposerEmail = user.rows[0]?.email ?? null
      } catch { /* attribution is best-effort */ }

      const trimmedComment = typeof comment === 'string' ? comment.trim() : ''
      const prBody = [
        trimmedComment.length > 0 ? trimmedComment : null,
        `Proposed from the Use Brian knowledge reader${proposerEmail ? ` by ${proposerEmail}` : ''}. Entry: \`${entry.path}\`.`,
      ].filter(Boolean).join('\n\n')

      const pr = await githubOps.createPullRequest(pat, owner, repo, {
        title: `KB update: ${entry.title}`,
        body: prBody,
        head: branch,
        base: source.branch,
      })

      res.status(201).json({ prUrl: pr.html_url, prNumber: pr.number, branch })
    } catch (err) {
      console.error('[knowledge:workspace] proposal failed:', err)
      res.status(502).json({ error: 'Failed to create the pull request on GitHub.' })
    }
  })

  router.get('/sources', async (req, res) => {
    const auth = await verifyWorkspaceMember(req as any, res)
    if (!auth) return
    try {
      const sources = await knowledgeStore.listSources(auth.workspaceId)
      res.json({ sources })
    } catch (err) {
      console.error('[knowledge:workspace] list sources failed:', err)
      res.status(500).json({ error: 'Failed to list sources' })
    }
  })

  router.post('/sources', async (req, res) => {
    const auth = await verifyWorkspaceMember(req as any, res)
    if (!auth) return
    const { repo, branch, rootPath, connectorInstanceId } = req.body as {
      repo?: string; branch?: string; rootPath?: string; connectorInstanceId?: string
    }
    if (!repo) {
      res.status(400).json({ error: 'repo is required' })
      return
    }
    if (!connectorInstanceId) {
      res.status(400).json({
        error: 'connectorInstanceId is required. Configure a workspace-scoped GitHub connector first.',
      })
      return
    }
    await createGithubKnowledgeSource({
      knowledgeStore, connectorInstanceStore, connectorGrantStore,
      userId: auth.userId, workspaceId: auth.workspaceId,
      repo, branch, rootPath, connectorInstanceId, res,
    })
  })

  router.delete('/sources/:id', async (req, res) => {
    const auth = await verifyWorkspaceMember(req as any, res)
    if (!auth) return
    const sourceId = (req.params as { id: string }).id
    try {
      const source = await knowledgeStore.getSource(sourceId)
      if (!source || source.workspaceId !== auth.workspaceId) {
        res.status(404).json({ error: 'Source not found' }); return
      }
      await knowledgeStore.deleteBySource(sourceId)
      const deleted = await knowledgeStore.deleteSource(sourceId)
      if (!deleted) { res.status(404).json({ error: 'Source not found' }); return }
      res.status(204).end()
    } catch (err) {
      console.error('[knowledge:workspace] delete source failed:', err)
      res.status(500).json({ error: 'Failed to disconnect source' })
    }
  })

  router.post('/sources/:id/sync', async (req, res) => {
    const auth = await verifyWorkspaceMember(req as any, res)
    if (!auth) return
    const sourceId = (req.params as { id: string }).id
    try {
      const source = await knowledgeStore.getSource(sourceId)
      if (!source || source.workspaceId !== auth.workspaceId) {
        res.status(404).json({ error: 'Source not found' }); return
      }
      if (triggerSync) {
        await triggerSync(sourceId)
        res.json({ ok: true, message: 'Sync triggered' })
      } else {
        res.status(501).json({ error: 'Sync worker not configured' })
      }
    } catch (err) {
      console.error('[knowledge:workspace] trigger sync failed:', err)
      res.status(500).json({ error: 'Failed to trigger sync' })
    }
  })

  router.get('/github/instances', async (req, res) => {
    const auth = await verifyWorkspaceMember(req as any, res)
    if (!auth) return
    try {
      const instances = await listWorkspaceGithubInstances(connectorInstanceStore, connectorGrantStore, auth.userId, auth.workspaceId)
      res.json({
        instances: instances.map((i) => ({
          id: i.id,
          label: i.label,
          connectedEmail: i.connectedEmail,
          sensitivity: i.sensitivity,
        })),
      })
    } catch (err) {
      console.error('[knowledge:workspace] list instances failed:', err)
      res.status(500).json({ error: 'Failed to list GitHub connectors' })
    }
  })

  router.get('/github/repos', async (req, res) => {
    const auth = await verifyWorkspaceMember(req as any, res)
    if (!auth) return
    const { connectorInstanceId } = req.query as { connectorInstanceId?: string }
    const resolved = await resolveWorkspaceGithubPat(connectorInstanceStore, connectorGrantStore, auth.userId, auth.workspaceId, connectorInstanceId, res)
    if (!resolved) return
    try {
      const firstUrl = `https://api.github.com/user/repos?per_page=${GITHUB_PAGE_SIZE}&sort=updated&affiliation=owner,organization_member`
      const result = await githubFetchAllPages<{ full_name: string; private: boolean; description: string | null }>(
        firstUrl,
        resolved.pat,
      )
      if (!result.ok) {
        res.json({ repos: [], error: 'Failed to list repos from GitHub' })
        return
      }
      res.json({
        repos: result.items.map((r) => ({
          fullName: r.full_name,
          private: r.private,
          description: r.description,
        })),
      })
    } catch (err) {
      console.error('[knowledge:workspace] list repos failed:', err)
      res.status(500).json({ error: 'Failed to list repos' })
    }
  })

  router.get('/github/repos/:owner/:repo/branches', async (req, res) => {
    const auth = await verifyWorkspaceMember(req as any, res)
    if (!auth) return
    const { connectorInstanceId } = req.query as { connectorInstanceId?: string }
    const resolved = await resolveWorkspaceGithubPat(connectorInstanceStore, connectorGrantStore, auth.userId, auth.workspaceId, connectorInstanceId, res)
    if (!resolved) return
    const { owner, repo } = req.params as { owner: string; repo: string }
    try {
      const firstUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${GITHUB_PAGE_SIZE}`
      const result = await githubFetchAllPages<{ name: string }>(firstUrl, resolved.pat)
      if (!result.ok) {
        res.json({ branches: [] })
        return
      }
      res.json({ branches: result.items.map((b) => b.name) })
    } catch (err) {
      console.error('[knowledge:workspace] list branches failed:', err)
      res.status(500).json({ error: 'Failed to list branches' })
    }
  })

  return router
}
