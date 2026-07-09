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
  getPullRequest,
  createIssue,
  listIssues,
  listOrgRepos,
  listAffiliatedRepos,
} from '../client.js'

const mockFetch = vi.fn()

function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => '' }
}
/** OK response carrying a `Link` header (for pagination tests). */
function okLinked(data: unknown, link: string | null) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => '',
    headers: { get: (h: string) => (h.toLowerCase() === 'link' ? link : null) },
  }
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

  it('compareCommits surfaces commit messages and total_commits (push enrichment)', async () => {
    mockFetch.mockResolvedValueOnce(ok({
      status: 'ahead',
      total_commits: 3,
      commits: [
        { sha: 'c1', commit: { message: 'fix(a): first' } },
        { sha: 'c2', commit: { message: 'feat(b): second\n\nbody' } },
        { sha: 'c3', commit: { message: 'chore: third' } },
      ],
      files: [],
    }))
    const out = await compareCommits('pat', 'o', 'r', 'b', 'h')
    expect(out.totalCommits).toBe(3)
    expect(out.commits.map((c) => c.message)).toEqual([
      'fix(a): first',
      'feat(b): second\n\nbody',
      'chore: third',
    ])
  })

  it('compareCommits tolerates sha-only commit entries and a missing total_commits', async () => {
    // Older mocks / defensive: the mapping must not require `commit.message`.
    mockFetch.mockResolvedValueOnce(ok({ commits: [{ sha: 'c1' }, { sha: 'c2' }], files: [] }))
    const out = await compareCommits('pat', 'o', 'r', 'b', 'h')
    expect(out.totalCommits).toBe(2)
    expect(out.commits).toEqual([
      { sha: 'c1', message: '' },
      { sha: 'c2', message: '' },
    ])
  })

  it('getPullRequest surfaces the merged flag from the single-PR endpoint', async () => {
    mockFetch.mockResolvedValueOnce(ok({
      id: 1, number: 5, title: 'Add storage connector', body: 'long body',
      state: 'closed', merged: true, html_url: 'https://github.com/o/r/pull/5',
      base: { ref: 'develop' },
    }))
    const pr = await getPullRequest('pat', 'o', 'r', 5)
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls/5')
    expect(pr.merged).toBe(true)
    expect(pr.title).toBe('Add storage connector')
  })

  it('getBranchHead extracts the ref object sha', async () => {
    mockFetch.mockResolvedValueOnce(ok({ object: { sha: 'abc123' } }))
    expect(await getBranchHead('pat', 'o', 'r', 'main')).toBe('abc123')
  })
})

describe('[COMP:api/github-client] paginated repo listing', () => {
  it('listOrgRepos hits /orgs/{org}/repos and follows every Link rel="next" page', async () => {
    mockFetch
      .mockResolvedValueOnce(
        okLinked(
          [{ full_name: 'acme/a' }, { full_name: 'acme/b' }],
          '<https://api.github.com/orgs/acme/repos?per_page=100&page=2>; rel="next"',
        ),
      )
      .mockResolvedValueOnce(okLinked([{ full_name: 'acme/c' }], null))

    const repos = await listOrgRepos('pat', 'acme')

    expect(repos.map((r) => r.full_name)).toEqual(['acme/a', 'acme/b', 'acme/c'])
    // First page is the org endpoint; second page is the Link URL, origin-stripped.
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.github.com/orgs/acme/repos?sort=pushed&direction=desc&per_page=100',
    )
    expect(mockFetch.mock.calls[1][0]).toBe(
      'https://api.github.com/orgs/acme/repos?per_page=100&page=2',
    )
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('listOrgRepos stops when there is no next page (single page)', async () => {
    mockFetch.mockResolvedValueOnce(okLinked([{ full_name: 'acme/only' }], null))
    const repos = await listOrgRepos('pat', 'acme')
    expect(repos.map((r) => r.full_name)).toEqual(['acme/only'])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('listAffiliatedRepos requests owner + organization_member affiliation', async () => {
    mockFetch.mockResolvedValueOnce(okLinked([{ full_name: 'me/x' }], null))
    await listAffiliatedRepos('pat')
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/user/repos?')
    expect(url).toContain('affiliation=owner,organization_member')
    expect(url).toContain('per_page=100')
  })
})
