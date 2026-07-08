/**
 * Repository classifier rules.
 *
 * Spec: docs/architecture/brain/classification/entity-kind.md §Repository
 */

import type { EntityKind } from '../../../entities/types.js'
import type { ClassifierMatch, ClassifierRule } from '../../types.js'
import {
  BITBUCKET_REPO_RE,
  candidateString,
  GITHUB_REPO_RE,
  GITLAB_REPO_RE,
} from './shared.js'

const ALL_BOUNDARIES = ['connector', 'tool', 'inbox', 'extraction', 'self_heal'] as const

// ── Positive rules ───────────────────────────────────────────────────

const repositoryGithubUrl: ClassifierRule<EntityKind> = {
  id: 'repository-github-url',
  produces: 'repository',
  tier: 'deterministic',
  confidence: 1.0,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return GITHUB_REPO_RE.test(candidateString(c))
  },
  evaluate(c) {
    const s = candidateString(c)
    const m = GITHUB_REPO_RE.exec(s)
    if (!m?.groups) return null
    const { owner, repo } = m.groups
    if (!owner || !repo) return null
    return {
      rule_id: 'repository-github-url',
      value: 'repository',
      confidence: 1.0,
      tier: 'deterministic',
      derived: {
        attributes: {
          provider: 'github',
          owner: owner.toLowerCase(),
          repo_name: repo.replace(/\.git$/, ''),
        },
      },
    } satisfies ClassifierMatch<EntityKind>
  },
}

const repositoryGitlabUrl: ClassifierRule<EntityKind> = {
  id: 'repository-gitlab-url',
  produces: 'repository',
  tier: 'deterministic',
  confidence: 1.0,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return GITLAB_REPO_RE.test(candidateString(c))
  },
  evaluate(c) {
    const s = candidateString(c)
    const m = GITLAB_REPO_RE.exec(s)
    if (!m?.groups) return null
    const { owner, repo } = m.groups
    if (!owner || !repo) return null
    return {
      rule_id: 'repository-gitlab-url',
      value: 'repository',
      confidence: 1.0,
      tier: 'deterministic',
      derived: {
        attributes: {
          provider: 'gitlab',
          owner: owner.toLowerCase(),
          repo_name: repo.replace(/\.git$/, ''),
        },
      },
    } satisfies ClassifierMatch<EntityKind>
  },
}

const repositoryBitbucketUrl: ClassifierRule<EntityKind> = {
  id: 'repository-bitbucket-url',
  produces: 'repository',
  tier: 'deterministic',
  confidence: 1.0,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return BITBUCKET_REPO_RE.test(candidateString(c))
  },
  evaluate(c) {
    const s = candidateString(c)
    const m = BITBUCKET_REPO_RE.exec(s)
    if (!m?.groups) return null
    const { owner, repo } = m.groups
    if (!owner || !repo) return null
    return {
      rule_id: 'repository-bitbucket-url',
      value: 'repository',
      confidence: 1.0,
      tier: 'deterministic',
      derived: {
        attributes: {
          provider: 'bitbucket',
          owner: owner.toLowerCase(),
          repo_name: repo,
        },
      },
    } satisfies ClassifierMatch<EntityKind>
  },
}

const OWNER_SLASH_NAME_RE = /^[a-z0-9][a-z0-9-_]*\/[a-z0-9][a-z0-9-_.]*$/i
const CODE_CONTEXT_RE = /\b(commit|branch|repo|repository|clone|pull request|pr|issue|merge|fork)\b/i

const repositoryOwnerSlashName: ClassifierRule<EntityKind> = {
  id: 'repository-owner-slash-name-shorthand',
  produces: 'repository',
  tier: 'probabilistic',  // ambiguous shorthand — needs code-context guard
  confidence: 0.6,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    if (!OWNER_SLASH_NAME_RE.test(c.primary)) return false
    return Boolean(c.context && CODE_CONTEXT_RE.test(c.context))
  },
  evaluate(c) {
    if (!OWNER_SLASH_NAME_RE.test(c.primary)) return null
    if (!c.context || !CODE_CONTEXT_RE.test(c.context)) return null
    const [owner, repo] = c.primary.split('/')
    return {
      rule_id: 'repository-owner-slash-name-shorthand',
      value: 'repository',
      confidence: 0.6,
      tier: 'probabilistic',
      derived: {
        attributes: {
          owner: owner?.toLowerCase(),
          repo_name: repo,
        },
      },
    } satisfies ClassifierMatch<EntityKind>
  },
}

export const repositoryRules = [
  repositoryGithubUrl,
  repositoryGitlabUrl,
  repositoryBitbucketUrl,
  repositoryOwnerSlashName,
] as const
