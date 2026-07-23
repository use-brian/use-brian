import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createKnowledgeRepoWriter, type RepoWriterGithubOps, type RepoWriterStore } from '../repo-writer.js'

const SOURCE = {
  id: 'src1',
  workspaceId: 'w1',
  sourceType: 'github' as const,
  repo: 'acme/kb',
  branch: 'main',
  rootPath: 'docs/kb',
  connectorInstanceId: 'ci1',
  writeAccess: true as boolean | null,
}

// Live repo file: frontmatter + the body the DB mirror holds.
const RAW_FILE = '---\ntitle: "Vault"\nsensitivity: internal\n---\nOld body\n'

function makeStore(overrides?: Partial<RepoWriterStore>): RepoWriterStore {
  return {
    getSource: vi.fn(async () => ({ ...SOURCE })),
    upsertByPath: vi.fn(async () => ({ id: 'e1', path: 'products/vault' })),
    updateSourceWriteAccess: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeOps(overrides?: Partial<RepoWriterGithubOps>): RepoWriterGithubOps {
  return {
    getBranchHead: vi.fn(async () => 'head_sha'),
    getRepoTree: vi.fn(async () => [
      { path: 'docs/kb/products/vault.md' },
      { path: 'docs/kb/index.md' },
    ]),
    getFileContents: vi.fn(async () => ({ content: RAW_FILE })),
    createOrUpdateFile: vi.fn(async () => ({
      commit: { sha: 'commit_sha', html_url: 'https://github.com/acme/kb/commit/commit_sha' },
    })),
    ...overrides,
  }
}

const syncCredentials = { getPat: vi.fn(async () => 'ghp_pat') }

beforeEach(() => { vi.clearAllMocks() })

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const UPDATE_PARAMS = {
  workspaceId: 'w1',
  entry: { id: 'e1', path: 'products/vault', content: 'Old body', sourceId: 'src1' },
  newBody: 'New body',
  changeSummary: 'clarify fees',
  requestedBy: { userId: 'u1', label: 'neal@example.com' },
}

describe('[COMP:knowledge/repo-writer] createKnowledgeRepoWriter', () => {
  describe('commitEntryUpdate', () => {
    it('commits the new body under the verbatim frontmatter and writes through', async () => {
      const store = makeStore()
      const ops = makeOps()
      const events: unknown[] = []
      const writer = createKnowledgeRepoWriter({
        store, syncCredentials, githubOps: ops,
        recordEvent: (e) => events.push(e),
      })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result).toMatchObject({ ok: true, entryId: 'e1', commitSha: 'commit_sha' })
      const commit = vi.mocked(ops.createOrUpdateFile).mock.calls[0][3]
      expect(commit.path).toBe('docs/kb/products/vault.md')
      expect(commit.branch).toBe('main')
      // Frontmatter preserved byte-for-byte, body replaced.
      expect(commit.content).toBe('---\ntitle: "Vault"\nsensitivity: internal\n---\nNew body\n')
      // Attribution trailer names the requesting member.
      expect(commit.message).toContain('kb(assistant): clarify fees')
      expect(commit.message).toContain('on behalf of neal@example.com')
      // Write-through mirrors the worker's parse+upsert with the commit sha.
      expect(store.upsertByPath).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'w1', path: 'products/vault', content: 'New body',
        sourceId: 'src1', sourceSha: 'commit_sha',
      }))
      // Audit event keyed to the requesting user.
      expect(events[0]).toMatchObject({ userId: 'u1', eventName: 'kb_repo_write' })
    })

    it('aborts when the repo body moved ahead of the synced copy (staleness guard)', async () => {
      const ops = makeOps({
        getFileContents: vi.fn(async () => ({
          content: '---\ntitle: "Vault"\n---\nSomeone else edited this\n',
        })),
      })
      const store = makeStore()
      const writer = createKnowledgeRepoWriter({ store, syncCredentials, githubOps: ops })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result).toMatchObject({ ok: false, reason: 'stale_entry' })
      expect(ops.createOrUpdateFile).not.toHaveBeenCalled()
      expect(store.upsertByPath).not.toHaveBeenCalled()
    })

    it('reports file_missing when no repo file resolves to the entry path', async () => {
      const ops = makeOps({ getRepoTree: vi.fn(async () => [{ path: 'docs/kb/other.md' }]) })
      const writer = createKnowledgeRepoWriter({ store: makeStore(), syncCredentials, githubOps: ops })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result).toMatchObject({ ok: false, reason: 'file_missing' })
    })

    it('refuses when the cached probe says the source is not writable', async () => {
      const store = makeStore({ getSource: vi.fn(async () => ({ ...SOURCE, writeAccess: null })) })
      const ops = makeOps()
      const writer = createKnowledgeRepoWriter({ store, syncCredentials, githubOps: ops })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result).toMatchObject({ ok: false, reason: 'not_writable' })
      expect(ops.getBranchHead).not.toHaveBeenCalled()
    })

    it('refuses a cross-workspace source (defense in depth)', async () => {
      const store = makeStore({ getSource: vi.fn(async () => ({ ...SOURCE, workspaceId: 'OTHER' })) })
      const writer = createKnowledgeRepoWriter({ store, syncCredentials, githubOps: makeOps() })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result).toMatchObject({ ok: false, reason: 'source_missing' })
    })

    it('flips write_access=false and reports push_denied on a GitHub 403', async () => {
      const store = makeStore()
      const ops = makeOps({
        createOrUpdateFile: vi.fn(async () => { throw new Error('GitHub API error (403): forbidden') }),
      })
      const writer = createKnowledgeRepoWriter({ store, syncCredentials, githubOps: ops })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result).toMatchObject({ ok: false, reason: 'push_denied' })
      expect(store.updateSourceWriteAccess).toHaveBeenCalledWith('src1', false)
    })

    it('maps a 401 to no_credentials without flipping the write probe', async () => {
      const store = makeStore()
      const ops = makeOps({
        getBranchHead: vi.fn(async () => { throw new Error('GitHub PAT is invalid or revoked (401): Bad credentials') }),
      })
      const writer = createKnowledgeRepoWriter({ store, syncCredentials, githubOps: ops })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result).toMatchObject({ ok: false, reason: 'no_credentials' })
      expect(store.updateSourceWriteAccess).not.toHaveBeenCalled()
    })

    it('stays honest when the commit landed but the mirror write failed', async () => {
      const store = makeStore({ upsertByPath: vi.fn(async () => { throw new Error('db down') }) })
      const writer = createKnowledgeRepoWriter({ store, syncCredentials, githubOps: makeOps() })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain('committed to GitHub')
        expect(result.message).toContain('next sync')
      }
    })
  })

  describe('commitEntryCreate', () => {
    const CREATE_PARAMS = {
      workspaceId: 'w1',
      sourceId: 'src1',
      path: 'docs/new-entry',
      fileContent: '---\ntitle: "New"\nsensitivity: internal\n---\n\nBody.\n',
      changeSummary: 'add docs/new-entry: New',
      requestedBy: { userId: 'u1', label: null },
    }

    it('commits a new file under rootPath and writes through', async () => {
      const store = makeStore({ upsertByPath: vi.fn(async () => ({ id: 'e9', path: 'docs/new-entry' })) })
      const ops = makeOps()
      const writer = createKnowledgeRepoWriter({ store, syncCredentials, githubOps: ops })

      const result = await writer.commitEntryCreate(CREATE_PARAMS)

      expect(result).toMatchObject({ ok: true, entryId: 'e9', path: 'docs/new-entry' })
      const commit = vi.mocked(ops.createOrUpdateFile).mock.calls[0][3]
      expect(commit.path).toBe('docs/kb/docs/new-entry.md')
      expect(commit.branch).toBe('main')
      expect(store.upsertByPath).toHaveBeenCalledWith(expect.objectContaining({
        path: 'docs/new-entry', sourceId: 'src1', sourceSha: 'commit_sha',
      }))
    })

    it('refuses to create over an existing file (either .md variant)', async () => {
      const ops = makeOps({
        getRepoTree: vi.fn(async () => [{ path: 'docs/kb/docs/new-entry/index.md' }]),
      })
      const writer = createKnowledgeRepoWriter({ store: makeStore(), syncCredentials, githubOps: ops })

      const result = await writer.commitEntryCreate(CREATE_PARAMS)

      expect(result).toMatchObject({ ok: false, reason: 'file_exists' })
      expect(ops.createOrUpdateFile).not.toHaveBeenCalled()
    })

    it('reports no_credentials when the bound connector has no PAT', async () => {
      const writer = createKnowledgeRepoWriter({
        store: makeStore(),
        syncCredentials: { getPat: vi.fn(async () => { throw new Error('no creds') }) },
        githubOps: makeOps(),
      })

      const result = await writer.commitEntryCreate(CREATE_PARAMS)

      expect(result).toMatchObject({ ok: false, reason: 'no_credentials' })
    })
  })

  describe('local source parity', () => {
    async function makeLocalSource() {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'brian-kb-writer-'))
      tempDirs.push(base)
      const root = path.join(base, 'docs', 'kb')
      await fs.mkdir(root, { recursive: true })
      const source = {
        ...SOURCE,
        sourceType: 'local' as const,
        repo: base,
        branch: 'local',
        rootPath: 'docs/kb',
        connectorInstanceId: null,
        writeAccess: null,
      }
      return { base, root, source }
    }

    it('updates the local file atomically, preserves frontmatter, and writes through', async () => {
      const { root, source } = await makeLocalSource()
      const filePath = path.join(root, 'products', 'vault.md')
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, RAW_FILE)
      const store = makeStore({ getSource: vi.fn(async () => source) })
      const ops = makeOps()
      const events: unknown[] = []
      const writer = createKnowledgeRepoWriter({
        store,
        githubOps: ops,
        recordEvent: (event) => events.push(event),
      })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result).toMatchObject({ ok: true, sourceType: 'local', commitSha: null, commitUrl: null })
      expect(await fs.readFile(filePath, 'utf8')).toBe('---\ntitle: "Vault"\nsensitivity: internal\n---\nNew body\n')
      expect(ops.getBranchHead).not.toHaveBeenCalled()
      expect(store.upsertByPath).toHaveBeenCalledWith(expect.objectContaining({
        path: 'products/vault', content: 'New body', sourceId: 'src1', sourceSha: null,
      }))
      expect(events[0]).toMatchObject({
        eventName: 'kb_repo_write', metadata: expect.objectContaining({ sourceType: 'local', op: 'update' }),
      })
    })

    it('rejects a stale local body without changing the file', async () => {
      const { root, source } = await makeLocalSource()
      const filePath = path.join(root, 'products', 'vault', 'index.md')
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const changed = '---\ntitle: "Vault"\n---\nExternal edit\n'
      await fs.writeFile(filePath, changed)
      const store = makeStore({ getSource: vi.fn(async () => source) })
      const writer = createKnowledgeRepoWriter({ store })

      const result = await writer.commitEntryUpdate(UPDATE_PARAMS)

      expect(result).toMatchObject({ ok: false, reason: 'stale_entry' })
      expect(await fs.readFile(filePath, 'utf8')).toBe(changed)
      expect(store.upsertByPath).not.toHaveBeenCalled()
    })

    it('creates a local markdown file beneath rootPath with no GitHub calls', async () => {
      const { root, source } = await makeLocalSource()
      const store = makeStore({
        getSource: vi.fn(async () => source),
        upsertByPath: vi.fn(async () => ({ id: 'local-new', path: 'guides/start' })),
      })
      const ops = makeOps()
      const writer = createKnowledgeRepoWriter({ store, githubOps: ops })

      const result = await writer.commitEntryCreate({
        workspaceId: 'w1', sourceId: 'src1', path: 'guides/start',
        fileContent: '---\ntitle: "Start"\n---\nBody\n', changeSummary: 'add guide',
      })

      expect(result).toMatchObject({ ok: true, sourceType: 'local', commitSha: null })
      expect(await fs.readFile(path.join(root, 'guides', 'start.md'), 'utf8')).toContain('title: "Start"')
      expect(ops.createOrUpdateFile).not.toHaveBeenCalled()
      expect(store.upsertByPath).toHaveBeenCalledWith(expect.objectContaining({ path: 'guides/start' }))
    })

    it('rejects local path traversal and existing index variants', async () => {
      const { root, source } = await makeLocalSource()
      await fs.mkdir(path.join(root, 'guides', 'start'), { recursive: true })
      await fs.writeFile(path.join(root, 'guides', 'start', 'index.md'), '# Existing\n')
      const store = makeStore({ getSource: vi.fn(async () => source) })
      const writer = createKnowledgeRepoWriter({ store })
      const params = {
        workspaceId: 'w1', sourceId: 'src1', fileContent: '# New\n', changeSummary: 'add',
      }

      await expect(writer.commitEntryCreate({ ...params, path: '../outside' }))
        .resolves.toMatchObject({ ok: false, reason: 'error' })
      await expect(writer.commitEntryCreate({ ...params, path: 'guides/start' }))
        .resolves.toMatchObject({ ok: false, reason: 'file_exists' })
      await expect(fs.stat(path.join(root, '..', 'outside.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('rejects a local root symlink that escapes the configured source', async () => {
      const { base, source } = await makeLocalSource()
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'brian-kb-outside-'))
      tempDirs.push(outside)
      await fs.rm(path.join(base, 'docs', 'kb'), { recursive: true })
      await fs.symlink(outside, path.join(base, 'docs', 'kb'))
      const writer = createKnowledgeRepoWriter({ store: makeStore({ getSource: vi.fn(async () => source) }) })

      const result = await writer.commitEntryCreate({
        workspaceId: 'w1', sourceId: 'src1', path: 'escape', fileContent: '# Escape\n', changeSummary: 'add',
      })

      expect(result).toMatchObject({ ok: false, reason: 'source_missing' })
      await expect(fs.stat(path.join(outside, 'escape.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})
