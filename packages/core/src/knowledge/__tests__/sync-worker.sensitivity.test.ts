import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createKnowledgeSyncWorker,
  type SyncGitHubApi,
  type SyncStore,
  type SyncCredentials,
} from '../sync-worker.js'

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
  listPathsSystem: vi.fn().mockResolvedValue([]),
  updateRelatedIds: vi.fn(),
  getByPathSystem: vi.fn(),
  updateSourceSync: vi.fn(),
  updateSourceWriteAccess: vi.fn(),
  getSourcesDueForSync: vi.fn(),
}

const mockCreds: SyncCredentials = {
  getPat: vi.fn().mockResolvedValue('ghp_test'),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(mockStore.listPathsSystem).mockResolvedValue([])
})

const SOURCE = {
  id: 'src1',
  workspaceId: 't1',
  sourceType: 'github' as const,
  repo: 'org/kb',
  branch: 'main',
  rootPath: '',
  lastSyncedSha: null as string | null,
  connectorInstanceId: null as string | null,
}

describe('[COMP:knowledge/sync-worker] sensitivity round-trip', () => {
  it('threads parsed sensitivity into upsertByPath on full sync', async () => {
    vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([{ ...SOURCE }])
    vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('sha_head')
    vi.mocked(mockApi.getRepoTree).mockResolvedValueOnce([
      { path: 'fundraising/cap-table.md', sha: 'a1' },
      { path: 'docs/overview.md', sha: 'a2' },
      { path: 'faq.md', sha: 'a3' },
    ])
    vi.mocked(mockApi.getFileContents)
      .mockResolvedValueOnce({ content: '---\ntitle: Cap table\nsensitivity: confidential\n---\nBody' })
      .mockResolvedValueOnce({ content: '---\ntitle: Overview\n---\nBody' }) // no sensitivity → internal
      .mockResolvedValueOnce({ content: '---\ntitle: FAQ\nsensitivity: public\n---\nBody' })
    vi.mocked(mockStore.upsertByPath).mockResolvedValue({ id: 'e', path: 'x' })

    const worker = createKnowledgeSyncWorker({ store: mockStore, api: mockApi, credentials: mockCreds })
    await worker.tick()

    const calls = vi.mocked(mockStore.upsertByPath).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[0][0].sensitivity).toBe('confidential')
    expect(calls[1][0].sensitivity).toBe('internal')
    expect(calls[2][0].sensitivity).toBe('public')
  })

  it('re-sync with updated frontmatter overwrites the sensitivity (no drift)', async () => {
    // First sync: confidential
    vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([{ ...SOURCE }])
    vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('sha_v1')
    vi.mocked(mockApi.getRepoTree).mockResolvedValueOnce([{ path: 'note.md', sha: 'a' }])
    vi.mocked(mockApi.getFileContents).mockResolvedValueOnce({
      content: '---\ntitle: Note\nsensitivity: confidential\n---\nBody',
    })
    vi.mocked(mockStore.upsertByPath).mockResolvedValue({ id: 'e', path: 'note' })

    const worker = createKnowledgeSyncWorker({ store: mockStore, api: mockApi, credentials: mockCreds })
    await worker.tick()

    expect(vi.mocked(mockStore.upsertByPath).mock.calls[0][0].sensitivity).toBe('confidential')

    // Second sync: declassified to internal. Simulate an incremental sync with
    // the modified file. The upsert should overwrite the sensitivity.
    vi.mocked(mockStore.getSourcesDueForSync).mockResolvedValueOnce([
      { ...SOURCE, lastSyncedSha: 'sha_v1' },
    ])
    vi.mocked(mockApi.getBranchHead).mockResolvedValueOnce('sha_v2')
    vi.mocked(mockApi.compareCommits).mockResolvedValueOnce({
      headSha: 'sha_v2',
      files: [{ filename: 'note.md', status: 'modified' }],
    })
    vi.mocked(mockApi.getFileContents).mockResolvedValueOnce({
      content: '---\ntitle: Note\nsensitivity: internal\n---\nBody',
    })

    await worker.tick()

    const secondUpsert = vi.mocked(mockStore.upsertByPath).mock.calls[1][0]
    expect(secondUpsert.sensitivity).toBe('internal')
  })
})
