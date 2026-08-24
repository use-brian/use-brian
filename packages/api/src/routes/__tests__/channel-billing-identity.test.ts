// [COMP:api/channel-billing-identity] — which user id the channel pipeline is
// allowed to write into a user column.
//
// The 2026-08-19 incident: every official-Telegram turn logged
//   [overhead-usage] failed to record overhead:classifier:
//   null value in column "user_id" of relation "usage_tracking" violates
//   not-null constraint (23502)
// with `user_id = NULL` and `actor_user_id = <real user>`. The pipeline was
// passing `userId: ownerId`, and `ownerId` is `assistants.owner_user_id`, which
// the ownership XOR flip (migration 089) made NULL for every workspace-owned
// assistant — 67 of 142 in production.
//
// The main turn was unaffected on the same path, because it does not use
// `ownerId` at all: it resolves `billingUserId` once through
// `billingPartyForAssistant`, which consults `workspaces.owner_user_id`. The
// fix is that derivation, mirrored onto every other row the pipeline writes.
//
// Two halves below. The first pins the property the whole fix rests on: the
// derivation is total for a workspace-owned assistant with no personal owner.
// The second is structural, because `processChannelMessage` takes ~50
// dependencies and has no behavioural harness in this package (both existing
// pipeline tests exercise extracted helpers instead) — and because the failure
// mode is a copy-paste one: the next `userId: ownerId` typechecks, unit-tests
// green, and only dies against a real Postgres.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))

import { query } from '../../db/client.js'
import { billingPartyForAssistant } from '../../billing-party.js'

const pipelineSource = readFileSync(new URL('../channel-pipeline.ts', import.meta.url), 'utf8')

/**
 * The structural assertions below have to read CODE, not prose. The comments in
 * this area quote the broken form (`userId: ownerId`) on purpose, so matching
 * the raw file would pass forever on its own explanation of the bug.
 */
const pipelineCode = pipelineSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*)/.test(line))
  .join('\n')

describe('[COMP:api/channel-billing-identity] Channel billing identity', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset()
  })

  it('resolves a workspace-owned assistant with a NULL personal owner to the workspace owner', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ owner_user_id: 'u_workspace_owner' }] } as never)

    const resolved = await billingPartyForAssistant({
      id: 'a_1',
      // What `assistants.owner_user_id` actually holds post-089 — the value the
      // pipeline was writing straight into `usage_tracking.user_id`.
      ownerUserId: null,
      workspaceId: 'ws_1',
    })

    expect(resolved).toBe('u_workspace_owner')
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain('FROM workspaces')
  })

  it('throws rather than returning null when an assistant has neither workspace nor owner', async () => {
    await expect(
      billingPartyForAssistant({ id: 'a_orphan', ownerUserId: null, workspaceId: null }),
    ).rejects.toThrow(/neither team nor owner/)
  })

  it('types ownerId as nullable, because that is what every caller passes', () => {
    // `assistant.ownerUserId` is what the channel routes forward as `ownerId`.
    // It was declared `string` while carrying null for months; the declaration
    // is the only thing that makes the next misuse a compile error.
    expect(pipelineCode).toMatch(/\n\s*ownerId: string \| null\n/)
    expect(pipelineCode).toMatch(/\n\s*ownerUserId: string \| null\n/)
  })

  it('never writes a user column from ownerId', () => {
    // Any of these is the NOT NULL violation coming back.
    expect(pipelineCode).not.toMatch(/userId: ownerId\b/)
    expect(pipelineCode).not.toMatch(/ownerUserId: ownerId\b/)
    expect(pipelineCode).not.toMatch(/actorUserId: ownerId\b/)
  })

  it('bills every overhead call to the resolved billing party and records the actor', () => {
    const calls = pipelineCode.match(/recordOverheadUsage\(\{[\s\S]*?\n(\s*)\}\)/g) ?? []
    // classifier, transcription, session-state diff, memory nudge, and the
    // recovery message at BOTH its call sites — the catch handler, and the
    // `turn_complete` branch where the loop ended cleanly but assembled
    // nothing deliverable and a tool had already run. If a seventh is added,
    // it has to opt into the same identities.
    expect(calls.length).toBe(6)
    for (const call of calls) {
      expect(call).toContain('userId: billingUserId')
      expect(call).toContain('actorUserId: userId')
    }
  })

  it('hands the compaction lane the billing party, not the raw owner', () => {
    // `ProactiveCompactionParams.ownerId` is a usage-attribution field and
    // nothing else: its only readers are the `overhead:extraction` and
    // `overhead:compaction` rows, both `userId: ownerId`. Passing the raw
    // `ownerId` reproduced the same violation one file down.
    expect(pipelineCode).toMatch(/runProactiveCompaction\(\{[\s\S]*?ownerId: billingUserId/)
  })

  it('leaves ownerId with exactly one job: feeding the billing-party resolution', () => {
    const reads = pipelineCode
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\bownerId\b/.test(line))
      // Drop the declaration and any line where `ownerId` is only a property
      // KEY being written (`ownerId: <something else>`), never a value read.
      .filter((line) => !/^ownerId(\?)?: /.test(line))

    // If a third read ever appears, it is writing a possibly-NULL id somewhere.
    expect(reads).toEqual([
      'userId, ownerId, assistant, isIdentified,',
      'ownerUserId: assistant.workspaceId ? null : ownerId,',
    ])
  })
})
