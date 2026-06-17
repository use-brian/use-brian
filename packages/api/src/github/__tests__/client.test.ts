/**
 * Unit tests for the GitHub API client.
 * Component tag: [COMP:api/github-client].
 *
 * Mocks global `fetch`. Verifies the shared ghFetch auth headers + error
 * mapping (401 vs generic), query-string building, the getFileContents
 * base64→utf-8 decode, the getRepoTree blob filter, the compareCommits
 * headSha fallback, getBranchHead extraction, and createIssue's
 * conditional body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  searchRepositories,
  getRepository,
  getFileContents,
  getRepoTree,
  compareCommits,
  getBranchHead,
  createIssue,
  listIssues,
} from '../client.js'

const mockFetch = vi.fn()

function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => '' }
}
function fail(status: number, body = 'error body') {
  return { ok: false, status, json: async () => ({}), text: async () => body }
}

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('[COMP:api/github-client] ghFetch error mapping', () => {
  it('maps a 401 to an invalid/revoked-PAT error', async () => {
    mockFetch.mockResolvedValueOnce(fail(401, 'Bad credentials'))
    await expect(getRepository('pat', 'o', 'r')).rejects.toThrow(/invalid or revoked/)
  })

  it('maps other non-OK statuses to a generic API error', async () => {
    mockFetch.mockResolvedValueOnce(fail(503, 'down'))
    await expect(getRepository('pat', 'o', 'r')).rejects.toThrow(/GitHub API error \(503\)/)
  })

  it('sends the bearer token and API-version headers', async () => {
    mockFetch.mockResolvedValueOnce(ok({ id: 1 }))
    await getRepository('my-pat', 'owner', 'repo')
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/owner/repo')
    const headers = (init as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer my-pat')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
  })
})

describe('[COMP:api/github-client] requests', () => {
  it('searchRepositories builds the query string with a default per_page of 10', async () => {
    mockFetch.mockResolvedValueOnce(ok({ total_count: 0, items: [] }))
    await searchRepositories('pat', { query: 'topic:ai' })
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/search/repositories?')
    expect(url).toContain('per_page=10')
  })

  it('listIssues defaults to state=open and per_page=20', async () => {
    mockFetch.mockResolvedValueOnce(ok([]))
    await listIssues('pat', 'o', 'r', {})
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('state=open')
    expect(url).toContain('per_page=20')
  })

  it('createIssue includes labels/assignees only when non-empty', async () => {
    mockFetch.mockResolvedValueOnce(ok({ number: 1 }))
    await createIssue('pat', 'o', 'r', { title: 'Bug', labels: [], assignees: ['alice'] })
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)
    expect(body.title).toBe('Bug')
    expect(body.labels).toBeUndefined() // empty array → omitted
    expect(body.assignees).toEqual(['alice'])
  })
})

describe('[COMP:api/github-client] response shaping', () => {
  it('getFileContents decodes a base64 single file to utf-8', async () => {
    const encoded = Buffer.from('hello world', 'utf-8').toString('base64')
    mockFetch.mockResolvedValueOnce(
      ok({ type: 'file', name: 'a.txt', content: encoded, encoding: 'base64' }),
    )
    const data = await getFileContents('pat', 'o', 'r', 'a.txt')
    expect(Array.isArray(data)).toBe(false)
    expect((data as { content: string }).content).toBe('hello world')
    expect((data as { encoding: string }).encoding).toBe('utf-8')
  })

  it('getFileContents returns a directory listing array unchanged', async () => {
    mockFetch.mockResolvedValueOnce(
      ok([{ type: 'file', name: 'a.txt' }, { type: 'dir', name: 'sub' }]),
    )
    expect(Array.isArray(await getFileContents('pat', 'o', 'r', ''))).toBe(true)
  })

  it('getRepoTree keeps only blob entries', async () => {
    mockFetch.mockResolvedValueOnce(
      ok({ tree: [
        { path: 'a.ts', sha: 's1', type: 'blob' },
        { path: 'dir', sha: 's2', type: 'tree' },
      ] }),
    )
    const tree = await getRepoTree('pat', 'o', 'r', 'main')
    expect(tree.map((t) => t.path)).toEqual(['a.ts'])
  })

  it('compareCommits uses the last commit sha as headSha, falling back to head', async () => {
    mockFetch.mockResolvedValueOnce(ok({ commits: [{ sha: 'c1' }, { sha: 'c2' }], files: [] }))
    expect((await compareCommits('pat', 'o', 'r', 'b', 'h')).headSha).toBe('c2')
    mockFetch.mockResolvedValueOnce(ok({ commits: [], files: [] }))
    expect((await compareCommits('pat', 'o', 'r', 'b', 'h')).headSha).toBe('h')
  })

  it('getBranchHead extracts the ref object sha', async () => {
    mockFetch.mockResolvedValueOnce(ok({ object: { sha: 'abc123' } }))
    expect(await getBranchHead('pat', 'o', 'r', 'main')).toBe('abc123')
  })
})
