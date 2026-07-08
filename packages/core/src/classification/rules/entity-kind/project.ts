/**
 * Project classifier rules — almost entirely negative.
 *
 * Project is the "left-over" kind. There's no positive shape that
 * cleanly says "this is a project"; the rules here block shapes that
 * shouldn't be classified as project so the dumping-ground problem
 * shrinks.
 *
 * Spec: docs/architecture/brain/classification/entity-kind.md §Project
 */

import type { EntityKind } from '../../../entities/types.js'
import type { ClassifierNegativeRule } from '../../types.js'
import {
  BITBUCKET_REPO_RE,
  candidateString,
  GITHUB_REPO_RE,
  GITLAB_REPO_RE,
  isBareDomainShape,
  isEmailShape,
} from './shared.js'

const ALL_BOUNDARIES = ['connector', 'tool', 'inbox', 'extraction', 'self_heal'] as const

const notProjectGithubUrl: ClassifierNegativeRule<EntityKind> = {
  id: 'not-project-github-url',
  blocks: ['project'],
  tier: 'deterministic',
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return GITHUB_REPO_RE.test(candidateString(c))
  },
  reason: 'GitHub repository URL — should be classified as repository',
}

const notProjectGitlabUrl: ClassifierNegativeRule<EntityKind> = {
  id: 'not-project-gitlab-url',
  blocks: ['project'],
  tier: 'deterministic',
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return GITLAB_REPO_RE.test(candidateString(c))
  },
  reason: 'GitLab repository URL — should be classified as repository',
}

const notProjectBitbucketUrl: ClassifierNegativeRule<EntityKind> = {
  id: 'not-project-bitbucket-url',
  blocks: ['project'],
  tier: 'deterministic',
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return BITBUCKET_REPO_RE.test(candidateString(c))
  },
  reason: 'Bitbucket repository URL — should be classified as repository',
}

const notProjectBareDomain: ClassifierNegativeRule<EntityKind> = {
  id: 'not-project-bare-domain',
  blocks: ['project'],
  tier: 'deterministic',
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return isBareDomainShape(candidateString(c))
  },
  reason: 'bare domain — likely a company, not a project',
}

const notProjectEmail: ClassifierNegativeRule<EntityKind> = {
  id: 'not-project-email',
  blocks: ['project'],
  tier: 'deterministic',
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return isEmailShape(candidateString(c))
  },
  reason: 'email address — likely a person, not a project',
}

// ── Bundle ───────────────────────────────────────────────────────────

export const projectRules = [
  notProjectGithubUrl,
  notProjectGitlabUrl,
  notProjectBitbucketUrl,
  notProjectBareDomain,
  notProjectEmail,
] as const
