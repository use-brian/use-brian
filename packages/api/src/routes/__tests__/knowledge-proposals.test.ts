/**
 * Unit tests for the knowledge entry-reader edit-proposal routes.
 * Component tag: [COMP:api/knowledge-proposals].
 *
 * Mounts workspaceKnowledgeRoutes() with a mocked store, a stub
 * syncCredentials provider, and an injected githubOps port (no network).
 * Verifies the membership gate, the edit-capability matrix (push /
 * read-only / manual entry / missing source / missing credentials), and
 * the proposal flow: tree-probed file resolution (flat vs index.md),
 * verbatim frontmatter preservation, branch + commit + PR sequencing,
 * and the server-side push re-check.
 *
 * Spec: docs/architecture/features/knowledge-base.md → "Knowledge
 * reader + edit proposals".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { workspaceKnowledgeRoutes, splitFrontmatterBlock, resolveRepoFilePath } from '../knowledge.js'
import { validateKnowledgeEntryPath } from '../../knowledge/repo-files.js'
import { query, queryWithRLS } from '../../db/client.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)

const knowledgeStore = {
  getById: vi.fn(),
  getSource: vi.fn(),
  listSources: vi.fn(),
  createSource: vi.fn(),
  deleteSource: vi.fn(),
  deleteBySource: vi.fn(),
}

const githubOps = {
  getRepoPermissions: vi.fn(),
  getBranchHead: vi.fn(),
  getRepoTree: vi.fn(),
  getFileContents: vi.fn(),
  createBranchRef: vi.fn(),
  createOrUpdateFile: vi.fn(),
  createPullRequest: vi.fn(),
}

const syncCredentials = { getPat: vi.fn() }

const ENTRY = {
  id: 'e-1',
  workspaceId: 'ws-1',
  path: 'products/vault',
  title: 'Vault',
  content: 'old body',
  relatedIds: [],
  sourceId: 'src-1',
}

const SOURCE = {
  id: 'src-1',
  workspaceId: 'ws-1',
  sourceType: 'github',
  repo: 'acme/kb',
  branch: 'main',
  rootPath: '',
  connectorInstanceId: 'ci-1',
}

function app(userId?: string) {
  return createTestApp(
    '/api/workspaces/:workspaceId/knowledge',
    workspaceKnowledgeRoutes({
      knowledgeStore: knowledgeStore as never,
      syncCredentials,
      githubOps: githubOps as never,
    }),
    userId ? { userId } : undefined,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Two RLS-gated reads, dispatched by SQL: the workspace-membership
  // gate and the caller's own email for PR attribution. Tests that need
  // a non-member override with a plain mockResolvedValue (it replaces
  // this implementation).
  mockRls.mockImplementation(async (_userId: string, sql: string) => {
    if (String(sql).includes('FROM users')) {
      return { rows: [{ email: 'kim@acme.test' }], rowCount: 1 } as never
    }
    return {
      rows: [{ role: 'member', clearance: 'confidential', compartments: null }],
      rowCount: 1,
    } as never
  })
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
  knowledgeStore.getById.mockResolvedValue(ENTRY)
  knowledgeStore.getSource.mockResolvedValue(SOURCE)
  syncCredentials.getPat.mockResolvedValue('pat-1')
  githubOps.getRepoPermissions.mockResolvedValue({ push: true })
  githubOps.getBranchHead.mockResolvedValue('head-sha')
  githubOps.getRepoTree.mockResolvedValue([
    { path: 'products/vault.md' },
    { path: 'products/fees/index.md' },
    { path: 'README.md' },
  ])
  githubOps.getFileContents.mockResolvedValue({
    content: '---\ntitle: Vault\nsensitivity: internal\n---\nold body\n',
  })
  githubOps.createBranchRef.mockResolvedValue(undefined)
  githubOps.createOrUpdateFile.mockResolvedValue({})
  githubOps.createPullRequest.mockResolvedValue({ number: 7, html_url: 'https://github.com/acme/kb/pull/7' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:api/knowledge-proposals] GET /entries/:id/edit-capability', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app()).get('/api/workspaces/ws-1/knowledge/entries/e-1/edit-capability')
    expect(res.status).toBe(401)
  })

  it('rejects a non-member with 403', async () => {
    mockRls.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    const res = await request(app('u-1')).get('/api/workspaces/ws-1/knowledge/entries/e-1/edit-capability')
    expect(res.status).toBe(403)
  })

  it('returns 404 for a missing or invisible entry', async () => {
    knowledgeStore.getById.mockResolvedValue(null)
    const res = await request(app('u-1')).get('/api/workspaces/ws-1/knowledge/entries/ghost/edit-capability')
    expect(res.status).toBe(404)
  })

  it('reports canPropose when the PAT can push', async () => {
    const res = await request(app('u-1')).get('/api/workspaces/ws-1/knowledge/entries/e-1/edit-capability')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      mode: 'github', canPropose: true, reason: null,
      repo: 'acme/kb', branch: 'main', repoUrl: 'https://github.com/acme/kb',
    })
  })

  it('greys out with no_write_access on a read-only PAT', async () => {
    githubOps.getRepoPermissions.mockResolvedValue({ push: false })
    const res = await request(app('u-1')).get('/api/workspaces/ws-1/knowledge/entries/e-1/edit-capability')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ mode: 'github', canPropose: false, reason: 'no_write_access' })
  })

  it('reports mode manual for an entry without a source', async () => {
    knowledgeStore.getById.mockResolvedValue({ ...ENTRY, sourceId: null })
    const res = await request(app('u-1')).get('/api/workspaces/ws-1/knowledge/entries/e-1/edit-capability')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ mode: 'manual', canPropose: false, reason: null })
  })

  it('reports no_credentials when the PAT cannot resolve', async () => {
    syncCredentials.getPat.mockRejectedValue(new Error('no creds'))
    const res = await request(app('u-1')).get('/api/workspaces/ws-1/knowledge/entries/e-1/edit-capability')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ mode: 'github', canPropose: false, reason: 'no_credentials' })
  })

  it('reports source_missing when the source row is gone', async () => {
    knowledgeStore.getSource.mockResolvedValue(null)
    const res = await request(app('u-1')).get('/api/workspaces/ws-1/knowledge/entries/e-1/edit-capability')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ mode: 'github', canPropose: false, reason: 'source_missing' })
  })
})

describe('[COMP:api/knowledge-proposals] POST /entries/:id/proposals', () => {
  it('requires a non-empty content string', async () => {
    const res = await request(app('u-1'))
      .post('/api/workspaces/ws-1/knowledge/entries/e-1/proposals')
      .send({ content: '   ' })
    expect(res.status).toBe(400)
  })

  it('rejects a manual entry with 400', async () => {
    knowledgeStore.getById.mockResolvedValue({ ...ENTRY, sourceId: null })
    const res = await request(app('u-1'))
      .post('/api/workspaces/ws-1/knowledge/entries/e-1/proposals')
      .send({ content: 'new body' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('not synced')
  })

  it('re-checks push permission server-side and 403s on a read-only PAT', async () => {
    githubOps.getRepoPermissions.mockResolvedValue({ push: false })
    const res = await request(app('u-1'))
      .post('/api/workspaces/ws-1/knowledge/entries/e-1/proposals')
      .send({ content: 'new body' })
    expect(res.status).toBe(403)
    expect(githubOps.createBranchRef).not.toHaveBeenCalled()
  })

  it('409s when no repo file normalises to the entry path', async () => {
    githubOps.getRepoTree.mockResolvedValue([{ path: 'other/thing.md' }])
    const res = await request(app('u-1'))
      .post('/api/workspaces/ws-1/knowledge/entries/e-1/proposals')
      .send({ content: 'new body' })
    expect(res.status).toBe(409)
  })

  it('creates branch + commit + PR, preserving frontmatter verbatim', async () => {
    const res = await request(app('u-1'))
      .post('/api/workspaces/ws-1/knowledge/entries/e-1/proposals')
      .send({ content: 'new body', comment: 'Fixed the fee table' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ prUrl: 'https://github.com/acme/kb/pull/7', prNumber: 7 })
    expect(res.body.branch).toMatch(/^brian\/kb-vault-/)

    // Branch off the source head.
    expect(githubOps.createBranchRef).toHaveBeenCalledWith(
      'pat-1', 'acme', 'kb', res.body.branch, 'head-sha',
    )
    // Commit keeps the live file's frontmatter block byte-for-byte.
    const commit = githubOps.createOrUpdateFile.mock.calls[0][3]
    expect(commit.path).toBe('products/vault.md')
    expect(commit.branch).toBe(res.body.branch)
    expect(commit.content).toBe('---\ntitle: Vault\nsensitivity: internal\n---\nnew body\n')
    // PR opens against the source branch, carrying the comment + attribution.
    const pr = githubOps.createPullRequest.mock.calls[0][3]
    expect(pr.base).toBe('main')
    expect(pr.head).toBe(res.body.branch)
    expect(pr.title).toBe('KB update: Vault')
    expect(pr.body).toContain('Fixed the fee table')
    expect(pr.body).toContain('kim@acme.test')
  })

  it('resolves an index.md entry through the tree probe', async () => {
    knowledgeStore.getById.mockResolvedValue({ ...ENTRY, path: 'products/fees', title: 'Fees' })
    githubOps.getFileContents.mockResolvedValue({ content: 'no frontmatter body\n' })
    const res = await request(app('u-1'))
      .post('/api/workspaces/ws-1/knowledge/entries/e-1/proposals')
      .send({ content: 'updated' })
    expect(res.status).toBe(201)
    const commit = githubOps.createOrUpdateFile.mock.calls[0][3]
    expect(commit.path).toBe('products/fees/index.md')
    // No frontmatter on the live file → the new body stands alone.
    expect(commit.content).toBe('updated\n')
  })

  it('502s when GitHub fails mid-flow', async () => {
    githubOps.createPullRequest.mockRejectedValue(new Error('boom'))
    const res = await request(app('u-1'))
      .post('/api/workspaces/ws-1/knowledge/entries/e-1/proposals')
      .send({ content: 'new body' })
    expect(res.status).toBe(502)
  })
})

describe('[COMP:api/knowledge-proposals] helpers', () => {
  it('splitFrontmatterBlock keeps the fence block verbatim', () => {
    const raw = '---\r\ntitle: X\r\n---\r\nbody here\n'
    const { frontmatter, body } = splitFrontmatterBlock(raw)
    expect(frontmatter).toBe('---\r\ntitle: X\r\n---\r\n')
    expect(body).toBe('body here\n')
  })

  it('splitFrontmatterBlock passes through a file with no frontmatter', () => {
    expect(splitFrontmatterBlock('plain\n')).toEqual({ frontmatter: '', body: 'plain\n' })
  })

  it('resolveRepoFilePath honours rootPath and the index.md convention', () => {
    const tree = ['docs/kb/products/vault.md', 'docs/kb/products/fees/index.md', 'docs/kb-other/products/leak.md', 'docs/other.md']
    expect(resolveRepoFilePath(tree, 'docs/kb', 'products/vault')).toBe('docs/kb/products/vault.md')
    expect(resolveRepoFilePath(tree, 'docs/kb', 'products/fees')).toBe('docs/kb/products/fees/index.md')
    expect(resolveRepoFilePath(tree, 'docs/kb', 'products/leak')).toBeNull()
    expect(resolveRepoFilePath(tree, 'docs/kb', 'missing')).toBeNull()
  })

  it('validateKnowledgeEntryPath rejects filesystem traversal and ambiguous paths', () => {
    expect(validateKnowledgeEntryPath('products/vault.md')).toBe('products/vault')
    expect(validateKnowledgeEntryPath('products/vault/index.md')).toBe('products/vault')
    expect(validateKnowledgeEntryPath('../outside')).toBeNull()
    expect(validateKnowledgeEntryPath('products//vault')).toBeNull()
    expect(validateKnowledgeEntryPath('/absolute')).toBeNull()
    expect(validateKnowledgeEntryPath('products\\vault')).toBeNull()
  })
})
