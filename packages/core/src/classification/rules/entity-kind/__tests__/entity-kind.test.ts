import { describe, expect, it } from 'vitest'

import { createEntityKindClassifier } from '../index.js'
import type { ClassifierCandidate } from '../../../types.js'

const cls = createEntityKindClassifier()

function decideExtraction(c: ClassifierCandidate) {
  return cls.decide(c, 'extraction')
}

describe('[COMP:classification/entity-kind] person rules', () => {
  it('classifies a personal-domain email as person + extracts attributes', () => {
    const d = decideExtraction({ primary: 'alice@gmail.com' })
    expect(d.kind).toBe('override')
    if (d.kind === 'override') {
      expect(d.match.value).toBe('person')
      expect(d.match.rule_id).toBe('person-email-personal-domain')
      expect(d.match.tier).toBe('deterministic')
      expect(d.match.derived?.attributes?.email).toBe('alice@gmail.com')
      expect(d.match.derived?.attributes?.email_domain).toBe('gmail.com')
    }
  })

  it('classifies a corporate-domain email + derives company + works_at edge', () => {
    const d = decideExtraction({ primary: 'alice@acme.com' })
    expect(d.kind).toBe('hint')
    if (d.kind === 'hint') {
      const winner = d.matches[0]
      expect(winner?.value).toBe('person')
      expect(winner?.rule_id).toBe('person-email-corporate-domain')
      expect(winner?.derived?.entities?.[0]?.kind).toBe('company')
      expect(winner?.derived?.entities?.[0]?.canonical_id).toBe('acme.com')
      expect(winner?.derived?.edges?.[0]?.edge_type).toBe('works_at')
    }
  })

  it('classifies LinkedIn profile URL as person', () => {
    const d = decideExtraction({ primary: 'https://www.linkedin.com/in/alice-chen' })
    expect(d.kind).toBe('hint')
    if (d.kind === 'hint') {
      expect(d.matches[0]?.rule_id).toBe('person-linkedin-profile-url')
    }
  })

  it('classifies honorific names as person', () => {
    const d = decideExtraction({ primary: 'Dr. Alice Chen' })
    expect(d.kind).toBe('hint')
    if (d.kind === 'hint') {
      expect(d.matches.some((m) => m.rule_id === 'person-honorific-title')).toBe(true)
    }
  })

  it('classifies two-name-words as weak person', () => {
    const d = decideExtraction({ primary: 'Alice Chen' })
    expect(d.kind).toBe('hint')
    if (d.kind === 'hint') {
      expect(d.matches.some((m) => m.rule_id === 'person-two-name-words')).toBe(true)
    }
  })
})

describe('[COMP:classification/entity-kind] person negative rules', () => {
  it('blocks no-reply mailbox from being classified as person', () => {
    const d = decideExtraction({ primary: 'no-reply@github.com' })
    expect(d.kind).toBe('blocked')
  })

  it('blocks support@ mailbox', () => {
    const d = decideExtraction({ primary: 'support@acme.com' })
    expect(d.kind).toBe('blocked')
  })

  it('blocks notifications@ mailbox', () => {
    const d = decideExtraction({ primary: 'notifications@whatever.io' })
    expect(d.kind).toBe('blocked')
  })
})

describe('[COMP:classification/entity-kind] company rules', () => {
  it('classifies bare corporate domain as company (deterministic)', () => {
    const d = decideExtraction({ primary: 'acme.com' })
    expect(d.kind).toBe('override')
    if (d.kind === 'override') {
      expect(d.match.value).toBe('company')
      expect(d.match.tier).toBe('deterministic')
      expect(d.match.derived?.attributes?.domain).toBe('acme.com')
    }
  })

  it('classifies "Inc." suffix as company', () => {
    const d = decideExtraction({ primary: 'Acme Corp.' })
    expect(d.kind).toBe('hint')
    if (d.kind === 'hint') {
      expect(d.matches.some((m) => m.rule_id === 'company-legal-suffix')).toBe(true)
    }
  })

  it('classifies LinkedIn company URL', () => {
    const d = decideExtraction({ primary: 'https://www.linkedin.com/company/acme' })
    expect(d.kind).toBe('hint')
    if (d.kind === 'hint') {
      expect(d.matches[0]?.value).toBe('company')
    }
  })

  it('classifies $-ticker as company', () => {
    const d = decideExtraction({ primary: '$AAPL' })
    expect(d.kind).toBe('hint')
    if (d.kind === 'hint') {
      expect(d.matches[0]?.derived?.attributes?.ticker).toBe('AAPL')
    }
  })

  it('classifies NASDAQ:GOOG style ticker', () => {
    const d = decideExtraction({ primary: 'NASDAQ:GOOG' })
    expect(d.kind).toBe('hint')
    if (d.kind === 'hint') {
      expect(d.matches[0]?.derived?.attributes?.exchange).toBe('NASDAQ')
      expect(d.matches[0]?.derived?.attributes?.ticker).toBe('GOOG')
    }
  })
})

describe('[COMP:classification/entity-kind] company negative rules', () => {
  it('blocks gmail.com bare domain from being a company', () => {
    const d = decideExtraction({ primary: 'gmail.com' })
    expect(d.kind).toBe('blocked')
  })

  it('blocks outlook.com from being a company', () => {
    const d = decideExtraction({ primary: 'outlook.com' })
    expect(d.kind).toBe('blocked')
  })
})

describe('[COMP:classification/entity-kind] repository rules', () => {
  it('classifies github.com/<owner>/<repo> URL as repository (deterministic)', () => {
    const d = decideExtraction({ primary: 'https://github.com/whatever/belvedere' })
    expect(d.kind).toBe('override')
    if (d.kind === 'override') {
      expect(d.match.value).toBe('repository')
      expect(d.match.rule_id).toBe('repository-github-url')
      expect(d.match.tier).toBe('deterministic')
      expect(d.match.derived?.attributes?.provider).toBe('github')
      expect(d.match.derived?.attributes?.owner).toBe('whatever')
      expect(d.match.derived?.attributes?.repo_name).toBe('belvedere')
    }
  })

  it('classifies github.com without https://', () => {
    const d = decideExtraction({ primary: 'github.com/MeshJS/multisig' })
    expect(d.kind).toBe('override')
    if (d.kind === 'override') {
      expect(d.match.value).toBe('repository')
    }
  })

  it('classifies .git suffix correctly (strips it)', () => {
    const d = decideExtraction({ primary: 'github.com/whatever/belvedere.git' })
    expect(d.kind).toBe('override')
    if (d.kind === 'override') {
      expect(d.match.derived?.attributes?.repo_name).toBe('belvedere')
    }
  })

  it('does NOT classify a GitHub PR URL as a repository (has sub-path)', () => {
    const d = decideExtraction({ primary: 'https://github.com/whatever/belvedere/pull/42' })
    // The github-repo regex requires no sub-path after <owner>/<repo>
    // — so this should not fire as repository. No other positive rule
    // matches either; could still be blocked by negative rules.
    expect(d.kind === 'no_signal' || d.kind === 'blocked').toBe(true)
  })

  it('classifies gitlab and bitbucket URLs similarly (deterministic)', () => {
    expect(decideExtraction({ primary: 'https://gitlab.com/whatever/y' }).kind).toBe('override')
    expect(decideExtraction({ primary: 'https://bitbucket.org/whatever/y' }).kind).toBe('override')
  })

  it('classifies <owner>/<name> shorthand only with code context', () => {
    const withoutContext = decideExtraction({ primary: 'whatever/belvedere' })
    const withContext = decideExtraction({
      primary: 'whatever/belvedere',
      context: 'opened a pull request in whatever/belvedere',
    })
    expect(withContext.kind).toBe('hint')
    // Without code context, the shorthand rule doesn't fire — but no other
    // positive rule fires either, and no negative rule blocks; result is
    // no_signal.
    expect(withoutContext.kind).toBe('no_signal')
  })
})

describe('[COMP:classification/entity-kind] project negative rules', () => {
  it('blocks GitHub URL from being project (would-be misclassification)', () => {
    // No positive rule produces 'project'; this verifies the negative
    // rule fires when the URL shape is github-like.
    const matches = cls.classify({ primary: 'https://github.com/whatever/belvedere' }, 'extraction')
    expect(matches.some((m) => m.value === 'project')).toBe(false)
    // Repository is what wins:
    expect(matches.some((m) => m.value === 'repository')).toBe(true)
  })

  it('blocks bare domain from being project', () => {
    const matches = cls.classify({ primary: 'acme.com' }, 'extraction')
    expect(matches.some((m) => m.value === 'project')).toBe(false)
    expect(matches.some((m) => m.value === 'company')).toBe(true)
  })
})

describe('[COMP:classification/entity-kind] integration — real-data cases', () => {
  it('5 known github-as-project misclassifications resolve to repository (deterministic)', () => {
    // From production scan (docs/architecture/brain/classification/entity-kind.md)
    const cases = [
      'https://github.com/deltadefi-protocol/tonic',
      'github.com/MeshJS/multisig',
      'github.com/sidan-lab/sidanclaw',
      'https://github.com/sidan-lab/DRep',
      'github.com/sidan-lab/DRep',
    ]
    for (const cid of cases) {
      const d = decideExtraction({ primary: cid })
      expect(d.kind).toBe('override')
      if (d.kind === 'override') {
        expect(d.match.value).toBe('repository')
      }
    }
  })

  it('acme.com cross-kind collision: classifier picks company, blocks project', () => {
    const matches = cls.classify({ primary: 'acme.com' }, 'extraction')
    expect(matches.find((m) => m.value === 'company')).toBeDefined()
    expect(matches.find((m) => m.value === 'project')).toBeUndefined()
  })
})

describe('[COMP:classification/entity-kind] unclassified', () => {
  it('returns no_signal for completely opaque inputs', () => {
    const d = decideExtraction({ primary: 'random-thing-xyz' })
    expect(d.kind).toBe('no_signal')
  })

  it('returns no_signal for a single capitalized word', () => {
    const d = decideExtraction({ primary: 'Postgres' })
    expect(d.kind).toBe('no_signal')
  })
})
