import { describe, it, expect, vi } from 'vitest'
import { createGitHubTools, type GitHubApi } from '../base/github.js'

// ── Helpers ─────────────────────────────────────────────���────

const ctx = {
  userId: 'test-user',
  assistantId: 'test-assistant',
  sessionId: 'test-session',
  appId: 'test',
  channelType: 'web' as const,
  channelId: 'test-channel',
  abortSignal: new AbortController().signal,
}

function mockApi(overrides?: Partial<GitHubApi>): GitHubApi {
  return {
    searchRepositories: vi.fn().mockResolvedValue({ total_count: 0, items: [] }),
    getRepository: vi.fn().mockResolvedValue({ id: 1, full_name: 'owner/repo' }),
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue({ issue: { id: 1, number: 42, title: 'Bug' }, comments: [] }),
    listPullRequests: vi.fn().mockResolvedValue([]),
    getPullRequest: vi.fn().mockResolvedValue({ id: 1, number: 10, title: 'Fix' }),
    createIssue: vi.fn().mockResolvedValue({ id: 99, number: 43, title: 'New Issue' }),
    createIssueComment: vi.fn().mockResolvedValue({ id: 200, body: 'Nice!' }),
    getFileContents: vi.fn().mockResolvedValue({ type: 'file', name: 'README.md', content: '# Hello', encoding: 'utf-8' }),
    createOrUpdateFile: vi.fn().mockResolvedValue({
      commit: { sha: 'c0ffee0', html_url: 'https://github.com/o/r/commit/c0ffee0' },
      content: { path: 'docs/spec.md' },
    }),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:tools/github] GitHub tools', () => {
  it('creates all 10 tools', () => {
    const tools = createGitHubTools(mockApi())
    expect(tools).toHaveLength(10)
    expect(tools.map((t) => t.name).sort()).toEqual([
      'githubCreateIssue',
      'githubCreateIssueComment',
      'githubGetFileContents',
      'githubGetIssue',
      'githubGetPullRequest',
      'githubGetRepository',
      'githubListIssues',
      'githubListPullRequests',
      'githubSearchRepositories',
      'githubWriteFile',
    ])
  })

  // ── Safety metadata ────────────────────────────────────────

  it('marks read tools as isReadOnly + isConcurrencySafe', () => {
    const tools = createGitHubTools(mockApi())
    const readTools = tools.filter((t) => t.isReadOnly)
    expect(readTools).toHaveLength(7)
    for (const tool of readTools) {
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
      expect(tool.requiresConfirmation).toBeFalsy()
    }
  })

  it('marks write tools as !isReadOnly + requiresConfirmation', () => {
    const tools = createGitHubTools(mockApi())
    const writeTools = tools.filter((t) => !t.isReadOnly)
    // githubCreateIssue, githubCreateIssueComment, githubWriteFile
    expect(writeTools).toHaveLength(3)
    for (const tool of writeTools) {
      expect(tool.isReadOnly).toBe(false)
      expect(tool.isConcurrencySafe).toBe(false)
      expect(tool.requiresConfirmation).toBe(true)
    }
  })

  it('githubWriteFile passes the file write through, defaulting the commit message', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubWriteFile')!

    await tool.execute(
      { owner: 'o', repo: 'r', path: 'docs/spec.md', content: '# Spec' },
      ctx,
    )
    expect(api.createOrUpdateFile).toHaveBeenCalledWith('o', 'r', {
      path: 'docs/spec.md',
      content: '# Spec',
      message: 'Update docs/spec.md',
      branch: undefined,
    })
  })

  // ── Execution passthrough ──────────────────────────────────

  it('searchRepositories passes query through', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubSearchRepositories')!

    await tool.execute({ query: 'rust web' }, ctx)
    expect(api.searchRepositories).toHaveBeenCalledWith({ query: 'rust web' })
  })

  it('getRepository passes owner and repo', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubGetRepository')!

    await tool.execute({ owner: 'facebook', repo: 'react' }, ctx)
    expect(api.getRepository).toHaveBeenCalledWith('facebook', 'react')
  })

  it('listIssues passes owner, repo, and params', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubListIssues')!

    await tool.execute({ owner: 'org', repo: 'proj', state: 'closed', labels: 'bug' }, ctx)
    expect(api.listIssues).toHaveBeenCalledWith('org', 'proj', { state: 'closed', labels: 'bug' })
  })

  it('getIssue passes owner, repo, and issueNumber', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubGetIssue')!

    await tool.execute({ owner: 'org', repo: 'proj', issueNumber: 42 }, ctx)
    expect(api.getIssue).toHaveBeenCalledWith('org', 'proj', 42)
  })

  it('listPullRequests passes owner, repo, and params', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubListPullRequests')!

    await tool.execute({ owner: 'org', repo: 'proj', state: 'all' }, ctx)
    expect(api.listPullRequests).toHaveBeenCalledWith('org', 'proj', { state: 'all' })
  })

  it('getPullRequest passes owner, repo, and pullNumber', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubGetPullRequest')!

    await tool.execute({ owner: 'org', repo: 'proj', pullNumber: 10 }, ctx)
    expect(api.getPullRequest).toHaveBeenCalledWith('org', 'proj', 10)
  })

  it('createIssue passes owner, repo, and params', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubCreateIssue')!

    await tool.execute({ owner: 'org', repo: 'proj', title: 'Bug report', body: 'Details here', labels: ['bug'] }, ctx)
    expect(api.createIssue).toHaveBeenCalledWith('org', 'proj', { title: 'Bug report', body: 'Details here', labels: ['bug'] })
  })

  it('getFileContents passes owner, repo, path, and ref', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubGetFileContents')!

    await tool.execute({ owner: 'org', repo: 'proj', path: 'src/index.ts', ref: 'main' }, ctx)
    expect(api.getFileContents).toHaveBeenCalledWith('org', 'proj', 'src/index.ts', 'main')
  })

  it('createIssueComment passes owner, repo, issueNumber, and body', async () => {
    const api = mockApi()
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubCreateIssueComment')!

    await tool.execute({ owner: 'org', repo: 'proj', issueNumber: 42, body: 'LGTM' }, ctx)
    expect(api.createIssueComment).toHaveBeenCalledWith('org', 'proj', 42, 'LGTM')
  })

  // ── Error handling ─────────────────────────────────────────

  it('returns isError on API failure', async () => {
    const api = mockApi({
      getRepository: vi.fn().mockRejectedValue(new Error('GitHub PAT is invalid or revoked (401)')),
    })
    const tools = createGitHubTools(api)
    const tool = tools.find((t) => t.name === 'githubGetRepository')!

    const result = await tool.execute({ owner: 'org', repo: 'proj' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('GitHub PAT is invalid or revoked')
  })

  // ── Description guards ─────────────────────────────────────

  it('tool descriptions must NOT say "Requires confirmation"', () => {
    const tools = createGitHubTools(mockApi())
    for (const tool of tools) {
      expect(tool.description).not.toMatch(/[Rr]equires confirmation/)
    }
  })

  it('write tool descriptions mention Approve/Deny prompt', () => {
    const tools = createGitHubTools(mockApi())
    const writeTools = tools.filter((t) => t.name.startsWith('githubCreate'))
    for (const tool of writeTools) {
      expect(tool.description).toMatch(/Approve\/Deny/)
    }
  })
})
