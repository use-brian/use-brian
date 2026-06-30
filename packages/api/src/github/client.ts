/**
 * GitHub API client — thin fetch-based wrappers for repos, issues, and PRs.
 *
 * No Octokit. Each function takes a PAT and makes a single API call.
 * See docs/architecture/integrations/github.md.
 */

const GITHUB_API = 'https://api.github.com'

// ── Shared fetch helper ──────────────────────────────────────

async function ghFetch(pat: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const err = await res.text()
    const prefix = res.status === 401 ? 'GitHub PAT is invalid or revoked' : 'GitHub API error'
    throw new Error(`${prefix} (${res.status}): ${err}`)
  }
  return res
}

// ── Types ────────────────────────────────────────────────────

export type GitHubRepo = {
  id: number
  full_name: string
  name: string
  owner: { login: string }
  description: string | null
  html_url: string
  private: boolean
  language: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  updated_at: string
}

export type GitHubIssue = {
  id: number
  number: number
  title: string
  body: string | null
  state: string
  html_url: string
  user: { login: string }
  labels: Array<{ name: string }>
  assignees: Array<{ login: string }>
  created_at: string
  updated_at: string
  comments: number
}

export type GitHubPullRequest = {
  id: number
  number: number
  title: string
  body: string | null
  state: string
  html_url: string
  user: { login: string }
  head: { ref: string; sha: string }
  base: { ref: string }
  draft: boolean
  mergeable: boolean | null
  additions: number
  deletions: number
  changed_files: number
  created_at: string
  updated_at: string
}

export type GitHubComment = {
  id: number
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}

// ── Auth probe ───────────────────────────────────────────────

/**
 * The authenticated user behind a PAT — the cheapest call that proves the
 * token is valid (`GET /user`). `ghFetch` already maps a 401 to the message
 * "GitHub PAT is invalid or revoked". Used by the workflow connector preflight
 * so a workflow can't be authored against an expired/revoked GitHub token
 * (the `Bad credentials` incident).
 */
export async function getAuthenticatedUser(pat: string): Promise<{ login: string }> {
  const res = await ghFetch(pat, '/user')
  return (await res.json()) as { login: string }
}

// ── Repositories ─────────────────────────────────────────────

export async function searchRepositories(
  pat: string,
  params: { query: string; sort?: string; order?: string; perPage?: number },
): Promise<{ total_count: number; items: GitHubRepo[] }> {
  const qs = new URLSearchParams({ q: params.query })
  if (params.sort) qs.set('sort', params.sort)
  if (params.order) qs.set('order', params.order)
  qs.set('per_page', String(params.perPage ?? 10))

  const res = await ghFetch(pat, `/search/repositories?${qs}`)
  return await res.json() as { total_count: number; items: GitHubRepo[] }
}

export async function getRepository(
  pat: string,
  owner: string,
  repo: string,
): Promise<GitHubRepo> {
  const res = await ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
  return await res.json() as GitHubRepo
}

export type GitHubContent = {
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  name: string
  path: string
  size: number
  sha: string
  html_url: string
  content?: string       // base64-encoded (files only)
  encoding?: string      // 'base64' (files only)
  download_url?: string | null
}

export async function getFileContents(
  pat: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<GitHubContent | GitHubContent[]> {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const res = await ghFetch(
    pat,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}${qs}`,
  )
  const data = await res.json() as GitHubContent | GitHubContent[]

  // Decode base64 file content to UTF-8 for single files
  if (!Array.isArray(data) && data.content && data.encoding === 'base64') {
    data.content = Buffer.from(data.content, 'base64').toString('utf-8')
    data.encoding = 'utf-8'
  }

  return data
}

// ── Issues ───────────────────────────────────────────────────

export async function listIssues(
  pat: string,
  owner: string,
  repo: string,
  params: { state?: string; labels?: string; sort?: string; direction?: string; perPage?: number },
): Promise<GitHubIssue[]> {
  const qs = new URLSearchParams({
    state: params.state ?? 'open',
    per_page: String(params.perPage ?? 20),
  })
  if (params.labels) qs.set('labels', params.labels)
  if (params.sort) qs.set('sort', params.sort)
  if (params.direction) qs.set('direction', params.direction)

  const res = await ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${qs}`)
  return await res.json() as GitHubIssue[]
}

export async function getIssue(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ issue: GitHubIssue; comments: GitHubComment[] }> {
  const [issueRes, commentsRes] = await Promise.all([
    ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`),
    ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=50`),
  ])

  const issue = await issueRes.json() as GitHubIssue
  const comments = await commentsRes.json() as GitHubComment[]
  return { issue, comments }
}

export async function createIssue(
  pat: string,
  owner: string,
  repo: string,
  params: { title: string; body?: string; labels?: string[]; assignees?: string[] },
): Promise<GitHubIssue> {
  const body: Record<string, unknown> = { title: params.title }
  if (params.body) body.body = params.body
  if (params.labels?.length) body.labels = params.labels
  if (params.assignees?.length) body.assignees = params.assignees

  const res = await ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await res.json() as GitHubIssue
}

export async function createIssueComment(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number,
  commentBody: string,
): Promise<GitHubComment> {
  const res = await ghFetch(
    pat,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: commentBody }),
    },
  )
  return await res.json() as GitHubComment
}

/**
 * Create or update a file (a commit) via
 * `PUT /repos/{owner}/{repo}/contents/{path}`. GitHub requires the
 * existing blob `sha` to overwrite a file and rejects it for a fresh
 * create — so probe the path first (404 → create, 200 → update).
 */
export async function createOrUpdateFile(
  pat: string,
  owner: string,
  repo: string,
  params: { path: string; content: string; message: string; branch?: string },
): Promise<unknown> {
  const contentsPath =
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/` +
    params.path.split('/').map(encodeURIComponent).join('/')

  let sha: string | undefined
  const probe = await fetch(
    `${GITHUB_API}${contentsPath}${params.branch ? `?ref=${encodeURIComponent(params.branch)}` : ''}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )
  if (probe.ok) {
    sha = ((await probe.json()) as { sha?: string }).sha
  } else if (probe.status !== 404) {
    throw new Error(`GitHub API error (${probe.status}): ${await probe.text()}`)
  }

  const body: Record<string, unknown> = {
    message: params.message,
    content: Buffer.from(params.content, 'utf8').toString('base64'),
  }
  if (params.branch) body.branch = params.branch
  if (sha) body.sha = sha

  const res = await ghFetch(pat, contentsPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await res.json()
}

/**
 * The authenticated token's effective permissions on a repo. GitHub
 * returns `permissions` on `GET /repos/{owner}/{repo}` only for an
 * authenticated caller; absent → treat every flag as false (read-only).
 * Backs the knowledge reader's edit-capability probe — a read-only PAT
 * means "grey the suggest button", not an error.
 */
export async function getRepoPermissions(
  pat: string,
  owner: string,
  repo: string,
): Promise<{ push: boolean; admin: boolean; pull: boolean }> {
  const res = await ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
  const data = await res.json() as { permissions?: { push?: boolean; admin?: boolean; pull?: boolean } }
  return {
    push: data.permissions?.push === true,
    admin: data.permissions?.admin === true,
    pull: data.permissions?.pull === true,
  }
}

/**
 * Create a branch ref (`refs/heads/<branch>`) pointing at `sha`.
 * Used by the KB edit-proposal flow to branch off the source's head
 * before committing the suggested change.
 */
export async function createBranchRef(
  pat: string,
  owner: string,
  repo: string,
  branch: string,
  sha: string,
): Promise<void> {
  await ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  })
}

/**
 * Open a pull request. Returns the bits the proposal flow surfaces to
 * the user (URL + number).
 */
export async function createPullRequest(
  pat: string,
  owner: string,
  repo: string,
  params: { title: string; body?: string; head: string; base: string },
): Promise<{ number: number; html_url: string }> {
  const res = await ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: params.title,
      body: params.body ?? '',
      head: params.head,
      base: params.base,
    }),
  })
  const data = await res.json() as { number: number; html_url: string }
  return { number: data.number, html_url: data.html_url }
}

// ── Pull Requests ────────────────────────────────────────────

export async function listPullRequests(
  pat: string,
  owner: string,
  repo: string,
  params: { state?: string; sort?: string; direction?: string; perPage?: number },
): Promise<GitHubPullRequest[]> {
  const qs = new URLSearchParams({
    state: params.state ?? 'open',
    per_page: String(params.perPage ?? 20),
  })
  if (params.sort) qs.set('sort', params.sort)
  if (params.direction) qs.set('direction', params.direction)

  const res = await ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${qs}`)
  return await res.json() as GitHubPullRequest[]
}

export async function getPullRequest(
  pat: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<GitHubPullRequest> {
  const res = await ghFetch(pat, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`)
  return await res.json() as GitHubPullRequest
}

// ── Knowledge sync helpers ──────────────────────────────────

export type TreeEntry = {
  path: string
  sha: string
  type: 'blob' | 'tree'
  size?: number
}

/**
 * Fetch the full recursive tree for a commit/branch.
 * Used for initial full sync when no lastSyncedSha exists.
 */
export async function getRepoTree(
  pat: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<TreeEntry[]> {
  const res = await ghFetch(
    pat,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${sha}?recursive=1`,
  )
  const data = await res.json() as { tree: TreeEntry[] }
  return data.tree.filter((t) => t.type === 'blob')
}

export type CompareFile = {
  filename: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
}

/**
 * Compare two commits and return changed files.
 * Used for incremental sync after initial full sync.
 */
export async function compareCommits(
  pat: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<{ headSha: string; files: CompareFile[] }> {
  const res = await ghFetch(
    pat,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${base}...${head}`,
  )
  const data = await res.json() as {
    commits: Array<{ sha: string }>
    files?: CompareFile[]
  }
  const headSha = data.commits.length > 0
    ? data.commits[data.commits.length - 1].sha
    : head
  return { headSha, files: data.files ?? [] }
}

/**
 * Get the HEAD SHA of a branch.
 */
export async function getBranchHead(
  pat: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const res = await ghFetch(
    pat,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
  )
  const data = await res.json() as { object: { sha: string } }
  return data.object.sha
}

// ── Activity feed + repo listing (ingest poller) ─────────────

/** A row from the GitHub events API (`/repos/{owner}/{repo}/events`). */
export type GitHubEvent = {
  id: string
  type: string
  actor: { login: string } | null
  repo: { name: string }
  payload: Record<string, unknown>
  created_at: string
}

/**
 * Repositories the PAT's resource owner can access, most-recently-pushed
 * first. GitHub scopes `/user/repos` to what the token can see — a
 * personal PAT returns the user's repos, an org-scoped fine-grained PAT
 * returns the org's — so this is the natural "owner's repos" default for
 * the ingest poller's repo set.
 */
export async function listOwnerRepos(
  pat: string,
  perPage = 30,
): Promise<GitHubRepo[]> {
  const res = await ghFetch(
    pat,
    `/user/repos?sort=pushed&direction=desc&per_page=${perPage}`,
  )
  return (await res.json()) as GitHubRepo[]
}

/**
 * Recent events for one repo. The GitHub events API has no server-side
 * `since` cursor, so the poller fetches the recent page and filters by
 * event id against its stored per-repo cursor.
 */
export async function listRepoEvents(
  pat: string,
  owner: string,
  repo: string,
  perPage = 30,
): Promise<GitHubEvent[]> {
  const res = await ghFetch(
    pat,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/events?per_page=${perPage}`,
  )
  return (await res.json()) as GitHubEvent[]
}
