import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { episodeEnvelopeSchema } from '../../../schemas.js'
import {
  GithubSignatureError,
  githubAdapter,
  githubDefaultRules,
  githubFilterImplementations,
  normalizeGithubWebhook,
  toEpisodeEnvelope,
  verifyGithubSignature,
} from '../index.js'
import type {
  GithubDeliveryContext,
  GithubNormalizedEvent,
  GithubWebhookInput,
} from '../types.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
}

const SECRET = 'shhh-it-is-a-secret'

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

function makeCtx(overrides: Partial<GithubDeliveryContext> = {}): GithubDeliveryContext {
  return {
    workspace_id: 'ws-1',
    user_id: 'u-1',
    assistant_id: null,
    created_by_user_id: 'u-1',
    created_by_assistant_id: null,
    connector_id: 'gh-instance-1',
    default_branch: 'main',
    hmac_secret: SECRET,
    ...overrides,
  }
}

function makeInput(opts: {
  fixture: string
  event: string
  delivery?: string
  signature?: string
  ctx?: Partial<GithubDeliveryContext>
}): GithubWebhookInput {
  const rawBody = loadFixture(opts.fixture)
  return {
    rawBody,
    headers: {
      'x-github-event': opts.event,
      'x-github-delivery': opts.delivery ?? 'd-1',
      'x-hub-signature-256': opts.signature ?? sign(rawBody),
    },
    deliveryContext: makeCtx(opts.ctx),
  }
}

const RECEIVED_AT = new Date('2026-05-14T20:00:00.000Z')

function normalize(opts: { fixture: string; event: string; delivery?: string }) {
  const input = makeInput(opts)
  return normalizeGithubWebhook(input, RECEIVED_AT)
}

describe('[COMP:brain/source-adapters/github] GitHub source adapter', () => {
  describe('signature verification', () => {
    it('accepts a valid HMAC-SHA256 signature', () => {
      const body = 'hello'
      const header = sign(body)
      expect(verifyGithubSignature(body, header, SECRET)).toBe(true)
    })

    it('rejects a bad signature', () => {
      const body = 'hello'
      const header = sign(body, 'wrong-secret')
      expect(verifyGithubSignature(body, header, SECRET)).toBe(false)
    })

    it('rejects a missing header', () => {
      expect(verifyGithubSignature('hello', undefined, SECRET)).toBe(false)
    })

    it('rejects a wrong-prefix header (sha1=…)', () => {
      const body = 'hello'
      const hex = createHmac('sha256', SECRET).update(body).digest('hex')
      expect(verifyGithubSignature(body, 'sha1=' + hex, SECRET)).toBe(false)
    })
  })

  describe('normalize — event_type derivation', () => {
    it('push to default branch → event_type "push"', () => {
      const ev = normalize({ fixture: 'push-default.json', event: 'push' })
      expect(ev?.event_type).toBe('push')
      expect(ev?.push?.default_branch).toBe(true)
    })

    it('pull_request opened → "pull_request.opened"', () => {
      const ev = normalize({ fixture: 'pr-opened.json', event: 'pull_request' })
      expect(ev?.event_type).toBe('pull_request.opened')
    })

    it('pull_request closed && merged === true → "pull_request.merged"', () => {
      const ev = normalize({ fixture: 'pr-merged.json', event: 'pull_request' })
      expect(ev?.event_type).toBe('pull_request.merged')
    })

    it('pull_request closed && merged === false → "pull_request.closed"', () => {
      const ev = normalize({ fixture: 'pr-closed-unmerged.json', event: 'pull_request' })
      expect(ev?.event_type).toBe('pull_request.closed')
    })

    it('issues opened (plural webhook) → "issue.opened" (singular per spec)', () => {
      const ev = normalize({ fixture: 'issue-opened.json', event: 'issues' })
      expect(ev?.event_type).toBe('issue.opened')
    })

    it('release published → "release.published"', () => {
      const ev = normalize({ fixture: 'release-published.json', event: 'release' })
      expect(ev?.event_type).toBe('release.published')
    })

    it('security_advisory published → "security_alert" (matches spec rule token)', () => {
      const ev = normalize({ fixture: 'security-advisory.json', event: 'security_advisory' })
      expect(ev?.event_type).toBe('security_alert')
    })

    it('dependabot push remains event_type "push" but actor flagged is_bot', () => {
      const ev = normalize({ fixture: 'dependabot-push.json', event: 'push' })
      expect(ev?.event_type).toBe('push')
      expect(ev?.actor.login).toBe('dependabot[bot]')
      expect(ev?.actor.is_bot).toBe(true)
    })
  })

  describe('envelope — source_kind routing', () => {
    it('push to default branch → "github_sync" envelope with content-ref shape', () => {
      const ev = normalize({ fixture: 'push-default.json', event: 'push' })!
      const envelope = toEpisodeEnvelope(ev, makeCtx())
      expect(envelope.source_kind).toBe('github_sync')
      expect(envelope.source_ref).toMatchObject({
        source_kind: 'github_sync',
        repo: 'acme/widget',
        commit_from: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commit_to: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      })
      expect(envelope.source_ref.files_changed).toEqual(
        expect.arrayContaining(['src/index.ts', 'README.md', 'docs/new.md']),
      )
      // Round-trips through the universal envelope schema.
      expect(() => episodeEnvelopeSchema.parse(envelope)).not.toThrow()
    })

    it('push to feature branch → "connector_action" envelope', () => {
      const ev = normalize({ fixture: 'push-feature.json', event: 'push' })!
      const envelope = toEpisodeEnvelope(ev, makeCtx())
      expect(envelope.source_kind).toBe('connector_action')
      expect(envelope.source_ref).toMatchObject({
        connector_id: 'gh-instance-1',
        action_kind: 'push',
        branch: 'feat/awesome',
      })
    })

    it('PR merged → "connector_action" envelope with action_kind + external_id (PR number)', () => {
      const ev = normalize({ fixture: 'pr-merged.json', event: 'pull_request' })!
      const envelope = toEpisodeEnvelope(ev, makeCtx())
      expect(envelope.source_kind).toBe('connector_action')
      expect(envelope.source_ref).toMatchObject({
        connector_id: 'gh-instance-1',
        action_kind: 'pull_request.merged',
        external_id: '42',
      })
      expect(() => episodeEnvelopeSchema.parse(envelope)).not.toThrow()
    })
  })

  describe('filter implementations', () => {
    function fakeEvent(overrides: Partial<GithubNormalizedEvent> = {}): GithubNormalizedEvent {
      return {
        event_type: 'pull_request.merged',
        delivery_id: 'd',
        occurred_at: RECEIVED_AT,
        repo: 'acme/widget',
        branch: 'main',
        actor: { login: 'dependabot[bot]', is_bot: true },
        payload: {},
        ...overrides,
      }
    }

    it('event_type matches the rule values', () => {
      expect(
        githubFilterImplementations.event_type(fakeEvent(), {
          values: ['pull_request.merged', 'release.published'],
        }),
      ).toBe(true)
      expect(
        githubFilterImplementations.event_type(fakeEvent(), { values: ['issue.opened'] }),
      ).toBe(false)
    })

    it('repo_match matches and misses', () => {
      expect(
        githubFilterImplementations.repo_match(fakeEvent(), { values: ['acme/widget'] }),
      ).toBe(true)
      expect(
        githubFilterImplementations.repo_match(fakeEvent(), { values: ['acme/other'] }),
      ).toBe(false)
    })

    it('actor_match matches a bot login from the default rule', () => {
      expect(
        githubFilterImplementations.actor_match(fakeEvent(), {
          values: ['dependabot[bot]', 'renovate[bot]'],
        }),
      ).toBe(true)
    })

    it('branch_match matches "main" and rejects when branch is null', () => {
      expect(githubFilterImplementations.branch_match(fakeEvent(), { values: ['main'] })).toBe(
        true,
      )
      expect(
        githubFilterImplementations.branch_match(fakeEvent({ branch: null }), {
          values: ['main'],
        }),
      ).toBe(false)
    })
  })

  describe('default rules — verbatim from ingest.md §GitHub', () => {
    it('match the spec rule order, count, and notable structural points', () => {
      expect(githubDefaultRules).toHaveLength(5)
      expect(githubDefaultRules[0]).toMatchObject({
        filter_type: 'event_type',
        routing_mode: 'realtime',
        alert: true,
      })
      expect(githubDefaultRules[3]).toMatchObject({
        filter_type: 'actor_match',
        routing_mode: 'drop',
      })
      expect(githubDefaultRules[3].params).toEqual({
        values: ['dependabot[bot]', 'renovate[bot]'],
      })
      expect(githubDefaultRules[4]).toMatchObject({
        filter_type: 'always',
        routing_mode: 'scheduled',
        routing_schedule: '0 18 * * 1-5',
      })
    })
  })

  describe('adapter.receive — orchestration', () => {
    it('returns [] for unknown webhook event types', async () => {
      const rawBody = '{}'
      const input: GithubWebhookInput = {
        rawBody,
        headers: {
          'x-github-event': 'ping',
          'x-github-delivery': 'd-ping',
          'x-hub-signature-256': sign(rawBody),
        },
        deliveryContext: makeCtx(),
      }
      await expect(githubAdapter.receive(input)).resolves.toEqual([])
    })

    it('throws GithubSignatureError on a bad signature', async () => {
      const rawBody = loadFixture('pr-opened.json')
      const input: GithubWebhookInput = {
        rawBody,
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'd-1',
          'x-hub-signature-256': sign(rawBody, 'wrong-secret'),
        },
        deliveryContext: makeCtx(),
      }
      await expect(githubAdapter.receive(input)).rejects.toBeInstanceOf(GithubSignatureError)
    })

    it('round-trips the delivery_id into source_ref for downstream idempotency', async () => {
      const input = makeInput({
        fixture: 'pr-opened.json',
        event: 'pull_request',
        delivery: 'abc-123',
      })
      const [envelope] = await githubAdapter.receive(input)
      expect(envelope.source_ref).toMatchObject({ delivery_id: 'abc-123' })
    })
  })
})
