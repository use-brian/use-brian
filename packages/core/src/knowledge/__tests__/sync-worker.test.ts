import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeSyncWorker, type SyncGitHubApi, type SyncStore, type SyncCredentials } from '../sync-worker.js'

const mockApi: SyncGitHubApi = {
  getBranchHead: vi.fn(),
  getRepoTree: vi.fn(),
  getFileContents: vi.fn(),
  compareCommits: vi.fn(),
  getRepoPermissions: vi.fn(async () => ({ push: false })),
}

const mockStore: SyncStore = {
  upsertByPath: vi.fn(),
  deleteByTeamAndPath: vi.fn(),
  listPathsSystem: vi.fn(),
  updateRelatedIds: vi.fn(),
  getByPathSystem: vi.fn(),
  updateSourceSync: vi.fn(),
  updateSourceWriteAccess: vi.fn(),
  getSourcesDueForSync: vi.fn(),
}

const mockCreds: SyncCredentials = {
  getPat: vi.fn().mockResolvedValue('ghp_test123'),
}

beforeEach(() => { vi.clearAllMocks() })

const SOURCE = {
  id: 'src1',
  workspaceId: 't1',
  sourceType: 'github' as const,
  repo: 'deltadefi-protocol/knowledge',
  branch: 'main',
  rootPath: '',
  lastSyncedSha: null as string | null,
  connectorInstanceId: null as string | null,
  defaultSensitivity: 'internal' as const,
}

describe('[COMP:knowledge/sync-worker] createKnowledgeSyncWorker', () => {
  describe('write-capability probe', () => {
    it('persists the probe result every tick, even when the repo is unchanged', async () => {
      vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([{ ...SOURCE, lastSyncedSha: 'sha_head' }])
      vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('sha_head') // no new commits
      vi.mocked(mockApi.getRepoPermissions).mockResolvedValueOnce({ push: true })

      const worker = createKnowledgeSyncWorker({ store: mockStore, api: mockApi, credentials: mockCreds })
      await worker.tick()

      expect(mockApi.getRepoPermissions).toHaveBeenCalledWith('ghp_test123', 'deltadefi-protocol', 'knowledge')
      expect(mockStore.updateSourceWriteAccess).toHaveBeenCalledWith('src1', true, undefined)
      // The sync itself stayed a no-op — the probe is what self-heals a
      // swapped PAT without waiting for a new commit.
      expect(mockStore.upsertByPath).not.toHaveBeenCalled()
    })

    it('never fails the sync when the probe throws (advisory only)', async () => {
      vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([{ ...SOURCE, lastSyncedSha: 'sha_head' }])
      vi.mocked(mockApi.getRepoPermissions).mockRejectedValueOnce(new Error('boom'))
      vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('sha_head')

      const events: unknown[] = []
      const worker = createKnowledgeSyncWorker({
        store: mockStore, api: mockApi, credentials: mockCreds, onEvent: (e) => events.push(e),
      })
      await worker.tick()

      expect(mockStore.updateSourceWriteAccess).not.toHaveBeenCalled()
      expect(events.filter((e) => (e as { type: string }).type === 'sync_error')).toHaveLength(0)
    })
  })

  describe('full sync (no lastSyncedSha)', () => {
    it('fetches tree, parses markdown files, and upserts once per file (team-scoped)', async () => {
      vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([{ ...SOURCE }])
      vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('sha_head')
      vi.mocked(mockApi.getRepoTree).mockResolvedValueOnce([
        { path: 'index.md', sha: 'a1' },
        { path: 'products/vault/index.md', sha: 'a2' },
        { path: 'README.md', sha: 'a3' }, // no frontmatter, still parsed
      ])
      vi.mocked(mockApi.getFileContents)
        .mockResolvedValueOnce({ content: '---\ndescription: Root\ntags: [index]\n---\n# KB' })
        .mockResolvedValueOnce({ content: '---\ndescription: Vault product\ntags: [vault]\n---\n# Vault\nDetails.' })
        .mockResolvedValueOnce({ content: '# README\nSetup instructions.' })
      vi.mocked(mockStore.upsertByPath).mockResolvedValue({ id: 'e1', path: 'test' })
      vi.mocked(mockStore.listPathsSystem).mockResolvedValue([])

      const events: unknown[] = []
      const worker = createKnowledgeSyncWorker({
        store: mockStore,
        api: mockApi,
        credentials: mockCreds,
        onEvent: (e) => events.push(e),
      })

      await worker.tick()

      // 3 files, no per-assistant fan-out — one upsert per file.
      expect(mockStore.upsertByPath).toHaveBeenCalledTimes(3)

      // Verify first upsert (index.md → path "index"), team-scoped
      const firstCall = vi.mocked(mockStore.upsertByPath).mock.calls[0][0]
      expect(firstCall.path).toBe('index')
      expect(firstCall.title).toBe('KB')
      expect(firstCall.summary).toBe('Root')
      expect(firstCall.workspaceId).toBe('t1')
      expect(firstCall).not.toHaveProperty('assistantId')

      // Verify second upsert (products/vault/index.md → path "products/vault")
      const secondCall = vi.mocked(mockStore.upsertByPath).mock.calls[1][0]
      expect(secondCall.path).toBe('products/vault')
      expect(secondCall.summary).toBe('Vault product')

      // Verify sync completed
      expect(mockStore.updateSourceSync).toHaveBeenCalledWith('src1', 'sha_head', null, undefined)

      // Verify sync lifecycle events (lint findings are orthogonal; filtered out here)
      const lifecycle = (events as Array<{ type: string }>).filter(
        (e) => e.type === 'sync_started' || e.type === 'sync_completed' || e.type === 'sync_error',
      )
      expect(lifecycle).toHaveLength(2)
      expect(lifecycle[1]).toMatchObject({ type: 'sync_completed', entriesCreated: 3 })
    })
  })

  describe('incremental sync (has lastSyncedSha)', () => {
    it('uses compareCommits for diff-based sync', async () => {
      const source = { ...SOURCE, lastSyncedSha: 'sha_old' }
      vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([source])
      vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('sha_new')
      vi.mocked(mockApi.compareCommits).mockResolvedValueOnce({
        headSha: 'sha_new',
        files: [
          { filename: 'products/vault/fees.md', status: 'modified' },
          { filename: 'products/old.md', status: 'removed' },
        ],
      })
      vi.mocked(mockApi.getFileContents).mockResolvedValueOnce({
        content: '---\ndescription: Fee structure\n---\n# Fees\n2% + 20%',
      })
      vi.mocked(mockStore.upsertByPath).mockResolvedValue({ id: 'e1', path: 'test' })
      vi.mocked(mockStore.deleteByTeamAndPath).mockResolvedValue(true)
      vi.mocked(mockStore.listPathsSystem).mockResolvedValue([])

      const worker = createKnowledgeSyncWorker({
        store: mockStore,
        api: mockApi,
        credentials: mockCreds,
      })

      await worker.tick()

      // 1 modified file → upsert
      expect(mockStore.upsertByPath).toHaveBeenCalledTimes(1)
      // 1 removed file → delete (team-scoped, not per-assistant)
      expect(mockStore.deleteByTeamAndPath).toHaveBeenCalledTimes(1)
      expect(mockStore.deleteByTeamAndPath).toHaveBeenCalledWith('t1', 'products/old', undefined)
      // Sync completed with new SHA
      expect(mockStore.updateSourceSync).toHaveBeenCalledWith('src1', 'sha_new', null, undefined)
    })
  })

  describe('skip when no changes', () => {
    it('does nothing when HEAD matches lastSyncedSha', async () => {
      const source = { ...SOURCE, lastSyncedSha: 'sha_same' }
      vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([source])
      vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('sha_same')

      const worker = createKnowledgeSyncWorker({
        store: mockStore,
        api: mockApi,
        credentials: mockCreds,
      })

      await worker.tick()

      expect(mockStore.upsertByPath).not.toHaveBeenCalled()
      expect(mockStore.updateSourceSync).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('logs error and continues to next source on failure', async () => {
      vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([
        { ...SOURCE, id: 'src1' },
        { ...SOURCE, id: 'src2', repo: 'org/other' },
      ])
      // First source fails
      vi.mocked(mockApi.getBranchHead)
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValueOnce('sha_head2')
      vi.mocked(mockApi.getRepoTree).mockResolvedValueOnce([])
      vi.mocked(mockStore.listPathsSystem).mockResolvedValue([])

      const events: unknown[] = []
      const worker = createKnowledgeSyncWorker({
        store: mockStore,
        api: mockApi,
        credentials: mockCreds,
        onEvent: (e) => events.push(e),
      })

      await worker.tick()

      // First source should have error event
      expect(events[0]).toMatchObject({ type: 'sync_error', sourceId: 'src1' })
      // Second source should have proceeded
      expect(mockApi.getBranchHead).toHaveBeenCalledTimes(2)
    })
  })

  describe('rootPath filtering', () => {
    it('only syncs files under rootPath', async () => {
      const source = { ...SOURCE, rootPath: './products//' }
      vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([source])
      vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('sha_head')
      vi.mocked(mockApi.getRepoTree).mockResolvedValueOnce([
        { path: 'products/vault.md', sha: 'a1' },
        { path: 'products-private/payroll.md', sha: 'a2' }, // prefix is not a directory
        { path: 'architecture/ctx.md', sha: 'a3' }, // outside rootPath
      ])
      vi.mocked(mockApi.getFileContents).mockResolvedValue({ content: '# Test' })
      vi.mocked(mockStore.upsertByPath).mockResolvedValue({ id: 'e1', path: 'test' })
      vi.mocked(mockStore.listPathsSystem).mockResolvedValue([])

      const worker = createKnowledgeSyncWorker({
        store: mockStore,
        api: mockApi,
        credentials: mockCreds,
      })

      await worker.tick()

      // Only 1 file under rootPath
      expect(mockStore.upsertByPath).toHaveBeenCalledTimes(1)
    })
  })

  describe('local filesystem sync', () => {
    it('syncs markdown without resolving GitHub credentials', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'brian-kb-'))
      try {
        await writeFile(join(dir, 'product.md'), '---\ndescription: Product notes\n---\n# Product\nLocal body.')
        vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([{
          ...SOURCE,
          sourceType: 'local',
          repo: dir,
          branch: 'local',
        }])
        vi.mocked(mockStore.getByPathSystem).mockResolvedValue(null)
        vi.mocked(mockStore.listPathsSystem).mockResolvedValue([])
        vi.mocked(mockStore.upsertByPath).mockResolvedValue({ id: 'entry-1', path: 'product' })

        const worker = createKnowledgeSyncWorker({ store: mockStore, api: mockApi, credentials: mockCreds })
        await worker.tick()

        expect(mockCreds.getPat).not.toHaveBeenCalled()
        expect(mockApi.getBranchHead).not.toHaveBeenCalled()
        expect(mockStore.upsertByPath).toHaveBeenCalledWith(expect.objectContaining({
          workspaceId: 't1',
          path: 'product',
          sourceId: 'src1',
        }))
        expect(mockStore.updateSourceSync).toHaveBeenCalledWith('src1', expect.stringMatching(/^[a-f0-9]{40}$/), null, undefined)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('deletes a source entry when its final local markdown file is removed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'brian-kb-empty-'))
      try {
        vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([{
          ...SOURCE,
          sourceType: 'local',
          repo: dir,
          branch: 'local',
          lastSyncedSha: 'old-hash',
        }])
        vi.mocked(mockStore.listPathsSystem).mockResolvedValue(['removed'])
        vi.mocked(mockStore.getByPathSystem).mockResolvedValue({ id: 'entry-1', sourceId: 'src1' })
        vi.mocked(mockStore.deleteByTeamAndPath).mockResolvedValue(true)

        const worker = createKnowledgeSyncWorker({ store: mockStore, api: mockApi, credentials: mockCreds })
        await worker.tick()

        expect(mockStore.deleteByTeamAndPath).toHaveBeenCalledWith('t1', 'removed', undefined)
        expect(mockStore.updateSourceSync).toHaveBeenCalledWith('src1', expect.stringMatching(/^[a-f0-9]{40}$/), null, undefined)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('rejects a rootPath symlink that escapes the local source', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'brian-kb-contained-'))
      const outside = await mkdtemp(join(tmpdir(), 'brian-kb-outside-'))
      try {
        await mkdir(join(dir, 'docs'))
        await writeFile(join(outside, 'secret.md'), '# Outside\n')
        await symlink(outside, join(dir, 'docs', 'kb'))
        vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([{
          ...SOURCE,
          sourceType: 'local',
          repo: dir,
          branch: 'local',
          rootPath: 'docs/kb',
        }])

        const worker = createKnowledgeSyncWorker({ store: mockStore, api: mockApi, credentials: mockCreds })
        await worker.tick()

        expect(mockStore.upsertByPath).not.toHaveBeenCalled()
        expect(mockStore.updateSourceSync).toHaveBeenCalledWith(
          'src1', '', expect.stringContaining('escapes its source directory'), undefined,
        )
      } finally {
        await Promise.all([
          rm(dir, { recursive: true, force: true }),
          rm(outside, { recursive: true, force: true }),
        ])
      }
    })
  })
})

it('passes the same opaque authority to deletion, wikilinks, probe and checkpoint', async () => {
  const authority = Object.freeze({})
  const store = { ...mockStore, captureSourceSync: vi.fn(async () => authority) }
  vi.mocked(store.getSourcesDueForSync).mockResolvedValueOnce([{ ...SOURCE, rootPath: 'docs', lastSyncedSha: 'old' }])
  vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('new')
  vi.mocked(mockApi.compareCommits).mockResolvedValueOnce({ headSha: 'new', files: [
    { filename: 'docs/removed.md', status: 'removed' }, { filename: 'docs-private/payroll.md', status: 'removed' },
  ] })
  vi.mocked(store.listPathsSystem).mockResolvedValue(['link', 'target', 'manual'])
  vi.mocked(store.getByPathSystem).mockImplementation(async (_, path) => ({ id: path, sourceId: path === 'manual' ? null : 'src1', metadata: { _rawRelated: ['target'] } }))
  await createKnowledgeSyncWorker({ store, api: mockApi, credentials: mockCreds }).tick()
  expect(store.deleteByTeamAndPath).toHaveBeenCalledExactlyOnceWith('t1', 'removed', authority)
  expect(store.updateRelatedIds).toHaveBeenCalledWith('link', ['target'], authority)
  expect(store.updateRelatedIds).not.toHaveBeenCalledWith('manual', expect.anything(), authority)
  expect(store.updateSourceWriteAccess).toHaveBeenCalledWith('src1', false, authority)
  expect(store.updateSourceSync).toHaveBeenCalledWith('src1', 'new', null, authority)
})

it('requires a claim when the capture port exists and does no provider I/O on rejection', async () => {
  const store = { ...mockStore, captureSourceSync: vi.fn(async () => undefined) }
  vi.mocked(store.getSourcesDueForSync).mockResolvedValueOnce([SOURCE])
  await createKnowledgeSyncWorker({ store, api: mockApi, credentials: mockCreds }).tick()
  expect(mockCreds.getPat).not.toHaveBeenCalled()
  expect(store.deleteByTeamAndPath).not.toHaveBeenCalled()
  expect(store.upsertByPath).not.toHaveBeenCalled()
})

it('releases an interrupted claim without checkpointing when reconciliation cannot fetch a file', async () => {
  const authority = Object.freeze({})
  const store = { ...mockStore, captureSourceSync: vi.fn(async () => authority),
    syncRequiresFullReconciliation: vi.fn(() => true), releaseSourceSync: vi.fn(async () => {}) }
  vi.mocked(store.getSourcesDueForSync).mockResolvedValueOnce([{ ...SOURCE, lastSyncedSha: 'same' }])
  vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('same')
  vi.mocked(mockApi.getRepoTree).mockResolvedValueOnce([{ path: 'page.md', sha: 'blob' }])
  vi.mocked(mockApi.getFileContents).mockRejectedValueOnce(new Error('fetch unavailable'))
  await createKnowledgeSyncWorker({ store, api: mockApi, credentials: mockCreds }).tick()
  expect(mockApi.compareCommits).not.toHaveBeenCalled()
  expect(store.updateSourceSync).toHaveBeenCalledExactlyOnceWith('src1', 'same', 'fetch unavailable', authority)
  expect(store.releaseSourceSync).toHaveBeenCalledExactlyOnceWith(authority)
  expect(store.deleteByTeamAndPath).not.toHaveBeenCalled()
})
