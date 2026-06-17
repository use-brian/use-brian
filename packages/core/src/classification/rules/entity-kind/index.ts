/**
 * Entity-kind classifier — composes all per-kind rule bundles into
 * a single `Classifier<EntityKind>` for use at every write boundary.
 *
 * Spec: docs/architecture/brain/classification/entity-kind.md
 */

import type { EntityKind } from '../../../entities/types.js'
import { createClassifierRegistry } from '../../registry.js'
import type { RegistryOptions } from '../../registry.js'
import type { Classifier } from '../../types.js'

import { companyRules } from './company.js'
import { personRules } from './person.js'
import { projectRules } from './project.js'
import { repositoryRules } from './repository.js'

export function createEntityKindClassifier(options: RegistryOptions = {}): Classifier<EntityKind> {
  return createClassifierRegistry<EntityKind>(
    [
      ...personRules,
      ...companyRules,
      ...repositoryRules,
      ...projectRules,
    ],
    options,
  )
}

export {
  companyBareDomain,
  companyCrunchbaseUrl,
  companyLegalSuffix,
  companyLinkedinUrl,
  companyRules,
  companyTicker,
  notCompanyPersonalDomain,
} from './company.js'
export {
  notPersonSystemMailbox,
  personEmailCorporateDomain,
  personEmailPersonalDomain,
  personHonorific,
  personLinkedinProfile,
  personRules,
  personTwoNameWords,
} from './person.js'
export {
  notProjectBareDomain,
  notProjectBitbucketUrl,
  notProjectEmail,
  notProjectGithubUrl,
  notProjectGitlabUrl,
  projectRules,
} from './project.js'
export {
  normalizeBitbucketUrl,
  normalizeGithubUrl,
  normalizeGitlabUrl,
  repositoryBitbucketUrl,
  repositoryGithubUrl,
  repositoryGitlabUrl,
  repositoryOwnerSlashName,
  repositoryRules,
} from './repository.js'
