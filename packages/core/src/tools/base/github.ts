/**
 * GitHub tools — search repos, browse issues/PRs, create issues, comment.
 *
 * Read tools are concurrency-safe; write tools require confirmation.
 * The `api` callback is injected by the API layer so core stays
 * free of network deps.
 *
 * See docs/architecture/integrations/github.md.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import { type Json, asRows, str, num, bool, obj, projectList, mapField } from './_connector-result.js'

// ── Result projections ─────────────────────────────────────────
// GitHub REST objects carry ~100 fields each (URL spam, nested `owner`,
// `_links`). The tool descriptions already promise a concise shape; these
// projections make the implementation honor it so a repo/issue/PR list is a
// few hundred bytes per row, not a few KB. See `_connector-result.ts`.

const repoRow = (r: Json) => ({
  full_name: str(r, 'full_name'),
  description: str(r, 'description'),
  stars: num(r, 'stargazers_count'),
  language: str(r, 'language'),
  url: str(r, 'html_url'),
  updated_at: str(r, 'updated_at'),
  private: bool(r, 'private'),
})

const issueRow = (i: Json) => ({
  number: num(i, 'number'),
  title: str(i, 'title'),
  state: str(i, 'state'),
  labels: mapField(i, 'labels', (l) => str(l, 'name')),
  assignees: mapField(i, 'assignees', (a) => str(a, 'login')),
  comments: num(i, 'comments'),
  user: str(obj(i, 'user'), 'login'),
  url: str(i, 'html_url'),
  updated_at: str(i, 'updated_at'),
  is_pull_request: i.pull_request != null,
})

// `merged_at` is the only field that distinguishes a MERGED pull request from
// one that was closed unmerged — GitHub reports both as `state: 'closed'`.
// Without it a caller asking "what shipped?" has to re-fetch every closed PR
// through `githubGetPullRequest` just to read its boolean `merged`, an N+1 the
// list payload already carries the answer to (null unless merged).
const prRow = (p: Json) => ({
  number: num(p, 'number'),
  title: str(p, 'title'),
  state: str(p, 'state'),
  user: str(obj(p, 'user'), 'login'),
  head: str(obj(p, 'head'), 'ref'),
  base: str(obj(p, 'base'), 'ref'),
  draft: bool(p, 'draft'),
  url: str(p, 'html_url'),
  updated_at: str(p, 'updated_at'),
  merged_at: str(p, 'merged_at'),
})

/** Repo search: `{ total_count, items: [...] }` → concise rows, total preserved. */
function projectRepoSearch(raw: unknown, limit: number) {
  const r = (raw ?? {}) as Json
  return projectList(asRows(r.items), limit, repoRow, num(r, 'total_count'))
}

/** Directory listing (array) or single file (object with decoded/raw content). */
function projectFileContents(raw: unknown) {
  if (Array.isArray(raw)) {
    return projectList(asRows(raw), 200, (e) => ({
      name: str(e, 'name'),
      path: str(e, 'path'),
      type: str(e, 'type'),
      size: num(e, 'size'),
    }))
  }
  const f = (raw ?? {}) as Json
  // Keep the file body (the point of the call); drop `_links` / url spam.
  return {
    name: str(f, 'name'),
    path: str(f, 'path'),
    type: str(f, 'type') ?? 'file',
    size: num(f, 'size'),
    encoding: str(f, 'encoding'),
    content: f.content ?? f.text,
  }
}

export type GitHubApi = {
  searchRepositories(params: {
    query: string
    sort?: string
    order?: string
    perPage?: number
  }): Promise<unknown>

  getRepository(owner: string, repo: string): Promise<unknown>

  listIssues(owner: string, repo: string, params: {
    state?: string
    labels?: string
    sort?: string
    direction?: string
    perPage?: number
  }): Promise<unknown>

  getIssue(owner: string, repo: string, issueNumber: number): Promise<unknown>

  listPullRequests(owner: string, repo: string, params: {
    state?: string
    sort?: string
    direction?: string
    perPage?: number
  }): Promise<unknown>

  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<unknown>

  createIssue(owner: string, repo: string, params: {
    title: string
    body?: string
    labels?: string[]
    assignees?: string[]
  }): Promise<unknown>

  createIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<unknown>

  getFileContents(owner: string, repo: string, path: string, ref?: string): Promise<unknown>

  createOrUpdateFile(owner: string, repo: string, params: {
    path: string
    content: string
    message: string
    branch?: string
  }): Promise<unknown>
}

export function createGitHubTools(api: GitHubApi): Tool[] {
  const searchRepositories = buildTool({
    name: 'githubSearchRepositories',
    description:
      'Search GitHub repositories by keyword. Returns repo name, description, stars, language, and URL.',
    inputSchema: z.object({
      query: z.string().describe('Search query (e.g. "rust web framework", "owner:facebook language:python").'),
      sort: z.enum(['stars', 'forks', 'updated', 'help-wanted-issues']).optional().describe('Sort field.'),
      order: z.enum(['asc', 'desc']).optional().describe('Sort order (default: desc).'),
      perPage: z.number().optional().describe('Results per page (default 10, max 100).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.searchRepositories(input)
        return { data: projectRepoSearch(data, input.perPage ?? 10) }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getRepository = buildTool({
    name: 'githubGetRepository',
    description: 'Get details of a specific GitHub repository including description, stars, forks, and language.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner (user or organization).'),
      repo: z.string().describe('Repository name.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getRepository(input.owner, input.repo)
        const r = (data ?? {}) as Json
        return { data: {
          ...repoRow(r),
          forks: num(r, 'forks_count'),
          open_issues: num(r, 'open_issues_count'),
          default_branch: str(r, 'default_branch'),
          topics: r.topics,
        } }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listIssues = buildTool({
    name: 'githubListIssues',
    description:
      'List issues for a GitHub repository. Returns issue title, state, labels, assignees, and comment count. ' +
      'Note: the GitHub API returns pull requests in the issues endpoint — filter by the `pull_request` field if needed.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state (default: open).'),
      labels: z.string().optional().describe('Comma-separated label names to filter by.'),
      sort: z.enum(['created', 'updated', 'comments']).optional().describe('Sort field.'),
      direction: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
      perPage: z.number().optional().describe('Results per page (default 20, max 100).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const { owner, repo, ...params } = input
        const data = await api.listIssues(owner, repo, params)
        return { data: projectList(asRows(data), input.perPage ?? 20, issueRow) }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getIssue = buildTool({
    name: 'githubGetIssue',
    description: 'Get details of a specific GitHub issue including body, comments, labels, and assignees.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      issueNumber: z.number().describe('Issue number.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getIssue(input.owner, input.repo, input.issueNumber)
        const i = (data ?? {}) as Json
        return { data: { ...issueRow(i), body: str(i, 'body'), created_at: str(i, 'created_at') } }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listPullRequests = buildTool({
    name: 'githubListPullRequests',
    description:
      'List pull requests for a GitHub repository. Returns PR title, state, author, head/base branches, draft status, and `merged_at`. ' +
      'A closed PR is only MERGED when `merged_at` is present — a closed PR without it was abandoned, not shipped. ' +
      'To find what shipped since a date, list with state=closed sort=updated direction=desc and keep the rows whose `merged_at` is after that date; no follow-up call per PR is needed.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state (default: open).'),
      sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional().describe('Sort field.'),
      direction: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
      perPage: z.number().optional().describe('Results per page (default 20, max 100).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const { owner, repo, ...params } = input
        const data = await api.listPullRequests(owner, repo, params)
        return { data: projectList(asRows(data), input.perPage ?? 20, prRow) }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getPullRequest = buildTool({
    name: 'githubGetPullRequest',
    description: 'Get details of a specific pull request including title, body, diff stats, and merge status.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pullNumber: z.number().describe('Pull request number.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getPullRequest(input.owner, input.repo, input.pullNumber)
        const p = (data ?? {}) as Json
        return { data: {
          ...prRow(p),
          body: str(p, 'body'),
          merged: bool(p, 'merged'),
          mergeable: bool(p, 'mergeable'),
          additions: num(p, 'additions'),
          deletions: num(p, 'deletions'),
          changed_files: num(p, 'changed_files'),
        } }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createIssueTool = buildTool({
    name: 'githubCreateIssue',
    description:
      'Create a new GitHub issue. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      title: z.string().describe('Issue title.'),
      body: z.string().optional().describe('Issue body (Markdown).'),
      labels: z.array(z.string()).optional().describe('Labels to add.'),
      assignees: z.array(z.string()).optional().describe('GitHub usernames to assign.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const { owner, repo, ...params } = input
        const data = await api.createIssue(owner, repo, params)
        const c = (data ?? {}) as Json
        return { data: { number: num(c, 'number'), title: str(c, 'title'), state: str(c, 'state'), url: str(c, 'html_url') } }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createIssueCommentTool = buildTool({
    name: 'githubCreateIssueComment',
    description:
      'Add a comment to a GitHub issue or pull request. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      issueNumber: z.number().describe('Issue or PR number.'),
      body: z.string().describe('Comment body (Markdown).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.createIssueComment(input.owner, input.repo, input.issueNumber, input.body)
        const c = (data ?? {}) as Json
        return { data: { id: num(c, 'id'), url: str(c, 'html_url') } }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getFileContentsTool = buildTool({
    name: 'githubGetFileContents',
    description:
      'Get the contents of a file or directory from a GitHub repository. ' +
      'For files, returns the decoded text content. For directories, returns a listing of entries. ' +
      'Use this to read source code, configs, READMEs, or browse repository structure.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      path: z.string().describe('File or directory path (e.g. "src/index.ts", "docs/", or "" for root).'),
      ref: z.string().optional().describe('Git ref (branch, tag, or commit SHA). Defaults to the default branch.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getFileContents(input.owner, input.repo, input.path, input.ref)
        return { data: projectFileContents(data) }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const writeFileTool = buildTool({
    name: 'githubWriteFile',
    description:
      'Create or update a file in a GitHub repository — commits the new ' +
      'contents on the chosen branch. Call this tool directly — the user ' +
      'will see an Approve/Deny prompt.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      path: z.string().describe('File path within the repo (e.g. "docs/spec.md").'),
      content: z.string().describe('Full new file contents (UTF-8 text).'),
      message: z.string().optional().describe('Commit message. Defaults to "Update <path>".'),
      branch: z.string().optional().describe('Target branch. Defaults to the repo default branch.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const { owner, repo, path, content, branch } = input
        const data = await api.createOrUpdateFile(owner, repo, {
          path,
          content,
          message: input.message ?? `Update ${path}`,
          branch,
        })
        const c = (data ?? {}) as Json
        return { data: { path: str(obj(c, 'content'), 'path'), commit: str(obj(c, 'commit'), 'sha') } }
      } catch (err) {
        return { data: `GitHub error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [
    searchRepositories,
    getRepository,
    listIssues,
    getIssue,
    listPullRequests,
    getPullRequest,
    createIssueTool,
    createIssueCommentTool,
    getFileContentsTool,
    writeFileTool,
  ]
}
