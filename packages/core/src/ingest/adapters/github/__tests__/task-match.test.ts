import { describe, it, expect } from 'vitest'
import {
  buildGithubTaskMatchPrompt,
  githubPrRef,
  parseGithubTaskMatch,
} from '../task-match.js'

describe('[COMP:brain/github-task-match] PR → task judge (pure half)', () => {
  it('parses a well-formed high-confidence match', () => {
    expect(
      parseGithubTaskMatch('{"match_index": 1, "confidence": "high", "explanation": "same work"}', 3),
    ).toEqual({ matchIndex: 1, confidence: 'high', explanation: 'same work' })
  })

  it('parses an explicit no-match', () => {
    expect(
      parseGithubTaskMatch('{"match_index": null, "confidence": "low", "explanation": "unrelated"}', 3),
    ).toEqual({ matchIndex: null, confidence: 'low', explanation: 'unrelated' })
  })

  it('rejects an out-of-range index rather than acting on it', () => {
    expect(
      parseGithubTaskMatch('{"match_index": 3, "confidence": "high", "explanation": "x"}', 3),
    ).toBeNull()
    expect(
      parseGithubTaskMatch('{"match_index": -1, "confidence": "high", "explanation": "x"}', 3),
    ).toBeNull()
  })

  it('rejects malformed output instead of throwing', () => {
    expect(parseGithubTaskMatch('not json', 3)).toBeNull()
    expect(parseGithubTaskMatch('{"confidence": "high"}', 3)).toBeNull()
    expect(
      parseGithubTaskMatch('{"match_index": 0, "confidence": "sure", "explanation": "x"}', 3),
    ).toBeNull()
  })

  it('prompts with indexed candidates and the PR facts', () => {
    const prompt = buildGithubTaskMatchPrompt(
      { repo: 'acme/widget', number: 41, title: 'Fix login redirect', body: 'Reworks the callback.', branch: 'login-redirect' },
      [
        { id: 't-1', title: 'Fix the login redirect bug', description: 'Users bounce back to /login.' },
        { id: 't-2', title: 'Ship pricing page' },
      ],
    )
    expect(prompt).toContain('acme/widget')
    expect(prompt).toContain('#41')
    expect(prompt).toContain('0. Fix the login redirect bug')
    expect(prompt).toContain('1. Ship pricing page')
    expect(prompt).toContain('Branch: login-redirect')
  })

  it('builds the pr-kind external ref backlink', () => {
    expect(githubPrRef('acme/widget', 41)).toEqual({
      provider: 'github',
      repo: 'acme/widget',
      kind: 'pr',
      number: 41,
    })
  })
})
