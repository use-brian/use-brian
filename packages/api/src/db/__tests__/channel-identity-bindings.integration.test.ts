/**
 * Canonical WeChat identity bindings against a migration-replayed PostgreSQL
 * 18 (scripts/crm/local-fixture.mjs): transactions and races, transport
 * generations, persisted limits, RLS through the NOBYPASSRLS application
 * role, and the guarantee that linking never rewrites history.
 * Spec: docs/architecture/channels/wechat.md → "Staff identity".
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../client.js'
import {
  createChannelIdentityBindingStore,
  isWechatReceiptCurrentSystem,
  isWechatRecipientCurrentSystem,
  wechatSessionChannelId,
  LINK_CODE_FAILURE_LIMIT,
  LINK_CODE_MINT_LIMIT,
} from '../channel-identity-bindings.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const key = randomBytes(32)
const store = createChannelIdentityBindingStore(key)

type Role = 'owner' | 'admin' | 'member'

async function user(): Promise<string> {
  const id = randomUUID()
  await pool.query(`INSERT INTO users(id, auth_provider_id, name, email) VALUES ($1::uuid, $1::text, 'Fixture person', $1::text || '@example.com')`, [id])
  return id
}

async function workspace(members: Record<string, Role>) {
  const ids = Object.keys(members)
  const owner = ids.find((id) => members[id] === 'owner')!
  const workspaceId = randomUUID()
  await pool.query(`INSERT INTO workspaces(id, name, owner_user_id) VALUES ($1, 'Identity fixture', $2)`, [workspaceId, owner])
  for (const id of ids) {
    await pool.query(`INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ($1, $2, $3)`, [workspaceId, id, members[id]])
  }
  return workspaceId
}

async function world() {
  const owner = await user(), admin = await user(), alice = await user(), bob = await user()
  const workspaceId = await workspace({ [owner]: 'owner', [admin]: 'admin', [alice]: 'member', [bob]: 'member' })
  return { owner, admin, alice, bob, workspaceId }
}

const bot = () => `${randomUUID().slice(0, 12)}@im.bot`
const sender = () => `${randomUUID().slice(0, 16)}@im.wechat`
const creds = (botId: string, boundUserId?: string) => ({
  botToken: `token-${randomUUID()}`, baseUrl: 'https://ilink.example', ilinkBotId: botId,
  ...(boundUserId ? { boundUserId } : {}),
})

describe('[COMP:api/channel-identity-bindings] canonical WeChat bindings on PostgreSQL', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('self pairing binds the creator once; a retry with the same pairing is idempotent', async () => {
    const w = await world()
    const botId = bot(), scanner = sender(), pairingId = randomUUID()
    const first = await store.provisionWechatTransport({
      workspaceId: w.workspaceId, actorUserId: w.alice, mode: 'self', pairingId,
      defaultAssistantId: null, credentials: creds(botId, scanner),
    })
    expect(first).toMatchObject({ ok: true, reused: false, idempotent: false, generation: 1 })
    if (!first.ok) throw new Error('unreachable')
    expect(first.binding).toMatchObject({ accountId: w.alice, botId, senderId: scanner, transportGeneration: 1 })
    const proof = await pool.query(`SELECT proof, created_by FROM identity_bindings WHERE id = $1`, [first.binding!.bindingId])
    expect(proof.rows[0]).toEqual({ proof: 'qr_pair', created_by: w.alice })

    const retry = await store.provisionWechatTransport({
      workspaceId: w.workspaceId, actorUserId: w.alice, mode: 'self', pairingId,
      defaultAssistantId: null, credentials: creds(botId, scanner),
    })
    expect(retry).toMatchObject({ ok: true, idempotent: true, generation: 1, channelId: first.channelId })
    expect(retry.ok && retry.binding?.bindingId).toBe(first.binding!.bindingId)
    expect(await isWechatReceiptCurrentSystem(first.binding!)).toBe(true)
    expect(await store.resolveWechatSender({ channelId: first.channelId, botId, senderId: scanner }))
      .toEqual({ kind: 'bound', receipt: first.binding })
    expect(await store.resolveWechatSender({ channelId: first.channelId, botId, senderId: sender() }))
      .toEqual({ kind: 'unbound' })
  })

  it('admin preparation never binds the admin; members cannot prepare; missing sender writes nothing', async () => {
    const w = await world()
    const botId = bot()
    const prepared = await store.provisionWechatTransport({
      workspaceId: w.workspaceId, actorUserId: w.admin, mode: 'admin_prepare', pairingId: randomUUID(),
      defaultAssistantId: null, credentials: creds(botId, sender()),
    })
    expect(prepared).toMatchObject({ ok: true, binding: null })
    const bindings = await pool.query(`SELECT 1 FROM identity_bindings WHERE channel_id = $1`, [prepared.ok && prepared.channelId])
    expect(bindings.rowCount).toBe(0)

    expect(await store.provisionWechatTransport({
      workspaceId: w.workspaceId, actorUserId: w.alice, mode: 'admin_prepare', pairingId: randomUUID(),
      defaultAssistantId: null, credentials: creds(bot(), sender()),
    })).toEqual({ ok: false, reason: 'forbidden' })

    const noSenderBot = bot()
    expect(await store.provisionWechatTransport({
      workspaceId: w.workspaceId, actorUserId: w.alice, mode: 'self', pairingId: randomUUID(),
      defaultAssistantId: null, credentials: creds(noSenderBot),
    })).toEqual({ ok: false, reason: 'missing_sender' })
    const none = await pool.query(`SELECT 1 FROM channel_integrations WHERE bot_user_id = $1`, [noSenderBot])
    expect(none.rowCount).toBe(0)

    const outsider = await user()
    expect(await store.provisionWechatTransport({
      workspaceId: w.workspaceId, actorUserId: outsider, mode: 'self', pairingId: randomUUID(),
      defaultAssistantId: null, credentials: creds(bot(), sender()),
    })).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('a bot has one owning workspace; concurrent provisioning yields exactly one winner', async () => {
    const a = await world(), b = await world()
    const botId = bot(), scanner = sender()
    const results = await Promise.all([
      store.provisionWechatTransport({ workspaceId: a.workspaceId, actorUserId: a.alice, mode: 'self',
        pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) }),
      store.provisionWechatTransport({ workspaceId: b.workspaceId, actorUserId: b.alice, mode: 'self',
        pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) }),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'other_workspace' }])
    const rows = await pool.query(`SELECT 1 FROM channel_integrations WHERE bot_user_id = $1`, [botId])
    expect(rows.rowCount).toBe(1)
  })

  it('re-pairing rotates the generation, revokes old receipts, and never overwrites another account', async () => {
    const w = await world()
    const botId = bot(), scanner = sender()
    const first = await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.alice,
      mode: 'self', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) })
    if (!first.ok || !first.binding) throw new Error('setup')
    // Another account cannot take the bot over by pairing it again.
    expect(await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.bob,
      mode: 'self', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) }))
      .toEqual({ ok: false, reason: 'binding_conflict' })
    // Nor can an admin silently re-prepare a linked bot.
    expect(await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.admin,
      mode: 'admin_prepare', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) }))
      .toEqual({ ok: false, reason: 'binding_conflict' })
    // The same account re-pairing gets a new generation and a new binding version.
    const again = await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.alice,
      mode: 'self', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) })
    if (!again.ok || !again.binding) throw new Error('re-pair')
    expect(again).toMatchObject({ reused: true, generation: 2, channelId: first.channelId })
    expect(again.binding.version).toBeGreaterThan(first.binding.version)
    expect(await isWechatReceiptCurrentSystem(first.binding)).toBe(false)
    expect(await isWechatReceiptCurrentSystem(again.binding)).toBe(true)
    // A cursor write is not a credential change.
    expect(await store.persistWechatCursor(first.channelId, 1, 'stale-loop')).toBe(false)
    expect(await store.persistWechatCursor(first.channelId, 2, 'cursor-1')).toBe(true)
    expect(await store.getWechatTransportGeneration(first.channelId)).toBe(2)
    expect(await isWechatReceiptCurrentSystem(again.binding)).toBe(true)
    // Delete-time invalidation revokes the receipt before any cascade.
    await store.invalidateWechatTransport(first.channelId)
    expect(await isWechatReceiptCurrentSystem(again.binding)).toBe(false)
  })

  it('link codes need the exact bot, sender, channel, generation and an unexpired unclaimed code', async () => {
    const w = await world()
    const botId = bot(), scanner = sender()
    const prepared = await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.admin,
      mode: 'admin_prepare', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) })
    const otherBot = bot(), otherScanner = sender()
    const other = await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.admin,
      mode: 'admin_prepare', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(otherBot, otherScanner) })
    if (!prepared.ok || !other.ok) throw new Error('setup')
    const channelId = prepared.channelId

    const minted = await store.mintWechatLinkCode({ accountId: w.alice, workspaceId: w.workspaceId, channelId })
    if (!minted.ok) throw new Error('mint')
    expect(minted.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/)
    const stored = await pool.query(`SELECT code_digest FROM channel_identity_challenges WHERE channel_id = $1`, [channelId])
    expect(stored.rows[0].code_digest.toString('utf8')).not.toContain(minted.code)

    // Wrong sender, wrong channel, wrong bot, rotated generation: all refused.
    expect(await store.claimWechatLinkCode({ channelId, botId, senderId: sender(), code: minted.code }))
      .toEqual({ ok: false, reason: 'wrong_sender' })
    expect(await store.claimWechatLinkCode({ channelId: other.channelId, botId: otherBot, senderId: otherScanner, code: minted.code }))
      .toEqual({ ok: false, reason: 'invalid' })
    expect(await store.claimWechatLinkCode({ channelId, botId: otherBot, senderId: scanner, code: minted.code }))
      .toEqual({ ok: false, reason: 'transport_inactive' })
    // Another workspace cannot mint for this channel.
    const foreign = await world()
    expect(await store.mintWechatLinkCode({ accountId: foreign.alice, workspaceId: foreign.workspaceId, channelId }))
      .toEqual({ ok: false, reason: 'not_found' })

    const claimed = await store.claimWechatLinkCode({ channelId, botId, senderId: scanner, code: minted.code })
    expect(claimed).toMatchObject({ ok: true, idempotent: false, receipt: { accountId: w.alice, senderId: scanner, transportGeneration: 1 } })
    // Replay of a consumed code fails.
    expect(await store.claimWechatLinkCode({ channelId, botId, senderId: scanner, code: minted.code }))
      .toEqual({ ok: false, reason: 'invalid' })

    // Expired codes fail.
    const bobCode = await store.mintWechatLinkCode({ accountId: w.bob, workspaceId: w.workspaceId, channelId: other.channelId })
    if (!bobCode.ok) throw new Error('mint bob')
    await pool.query(`UPDATE channel_identity_challenges SET expires_at = now() - interval '1 second' WHERE channel_id = $1`, [other.channelId])
    expect(await store.claimWechatLinkCode({ channelId: other.channelId, botId: otherBot, senderId: otherScanner, code: bobCode.code }))
      .toEqual({ ok: false, reason: 'invalid' })

    // A code minted under generation 1 dies with a re-pair (generation 2).
    const carolCode = await store.mintWechatLinkCode({ accountId: w.bob, workspaceId: w.workspaceId, channelId: other.channelId })
    if (!carolCode.ok) throw new Error('mint again')
    await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.admin, mode: 'admin_prepare',
      pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(otherBot, otherScanner) })
    expect(await store.claimWechatLinkCode({ channelId: other.channelId, botId: otherBot, senderId: otherScanner, code: carolCode.code }))
      .toEqual({ ok: false, reason: 'invalid' })
  })

  it('concurrent claims by two accounts produce exactly one binding; the loser cannot overwrite it', async () => {
    const w = await world()
    const botId = bot(), scanner = sender()
    const prepared = await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.admin,
      mode: 'admin_prepare', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) })
    if (!prepared.ok) throw new Error('setup')
    const channelId = prepared.channelId
    const a = await store.mintWechatLinkCode({ accountId: w.alice, workspaceId: w.workspaceId, channelId })
    const b = await store.mintWechatLinkCode({ accountId: w.bob, workspaceId: w.workspaceId, channelId })
    if (!a.ok || !b.ok) throw new Error('mint')
    const results = await Promise.all([
      store.claimWechatLinkCode({ channelId, botId, senderId: scanner, code: a.code }),
      store.claimWechatLinkCode({ channelId, botId, senderId: scanner, code: b.code }),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'linked_elsewhere' }])
    const active = await pool.query(`SELECT account_id FROM identity_bindings WHERE channel_id = $1 AND revoked_at IS NULL`, [channelId])
    expect(active.rowCount).toBe(1)
    const winner = active.rows[0].account_id as string
    const loser = winner === w.alice ? w.bob : w.alice
    expect(await store.mintWechatLinkCode({ accountId: loser, workspaceId: w.workspaceId, channelId }))
      .toEqual({ ok: false, reason: 'linked_elsewhere' })
  })

  it('mint and failed-claim limits persist across a restarted store; removed members cannot claim', async () => {
    const w = await world()
    const botId = bot(), scanner = sender()
    const prepared = await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.admin,
      mode: 'admin_prepare', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) })
    if (!prepared.ok) throw new Error('setup')
    const channelId = prepared.channelId
    for (let i = 0; i < LINK_CODE_MINT_LIMIT; i += 1) {
      expect((await store.mintWechatLinkCode({ accountId: w.alice, workspaceId: w.workspaceId, channelId })).ok).toBe(true)
    }
    const restarted = createChannelIdentityBindingStore(key)
    expect(await restarted.mintWechatLinkCode({ accountId: w.alice, workspaceId: w.workspaceId, channelId }))
      .toEqual({ ok: false, reason: 'rate_limited' })

    const bobCode = await restarted.mintWechatLinkCode({ accountId: w.bob, workspaceId: w.workspaceId, channelId })
    if (!bobCode.ok) throw new Error('mint bob')
    for (let i = 0; i < LINK_CODE_FAILURE_LIMIT; i += 1) {
      expect(await store.claimWechatLinkCode({ channelId, botId, senderId: scanner, code: 'ABCDEFGH' }))
        .toEqual({ ok: false, reason: 'invalid' })
    }
    const restartedAgain = createChannelIdentityBindingStore(key)
    expect(await restartedAgain.claimWechatLinkCode({ channelId, botId, senderId: scanner, code: bobCode.code }))
      .toEqual({ ok: false, reason: 'rate_limited' })

    await pool.query(`DELETE FROM channel_identity_claim_failures WHERE channel_id = $1`, [channelId])
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [w.workspaceId, w.bob])
    expect(await store.claimWechatLinkCode({ channelId, botId, senderId: scanner, code: bobCode.code }))
      .toEqual({ ok: false, reason: 'not_member' })
    expect(await store.mintWechatLinkCode({ accountId: w.bob, workspaceId: w.workspaceId, channelId }))
      .toEqual({ ok: false, reason: 'not_member' })
  })

  it('RLS: callers see and revoke only their own bindings; the app role cannot write or read challenges', async () => {
    const w = await world()
    const botId = bot(), scanner = sender()
    const paired = await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.alice,
      mode: 'self', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) })
    if (!paired.ok || !paired.binding) throw new Error('setup')
    const role = await getAppPool().query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`)
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false })

    expect((await store.listOwnWechatBindings(w.alice, w.workspaceId)).map((b) => [b.bindingId, b.state]))
      .toEqual([[paired.binding.bindingId, 'linked']])
    expect(await store.listOwnWechatBindings(w.bob, w.workspaceId)).toEqual([])
    expect((await queryWithRLS(w.bob, `SELECT id FROM identity_bindings WHERE channel_id = $1`, [paired.channelId])).rowCount).toBe(0)
    expect((await queryWithRLS(w.bob, `SELECT id FROM identities WHERE tenant_key = $1`, [botId])).rowCount).toBe(0)
    expect((await queryWithRLS(w.admin, `SELECT id FROM identity_bindings WHERE channel_id = $1`, [paired.channelId])).rowCount).toBe(1)
    const foreign = await world()
    expect((await queryWithRLS(foreign.owner, `SELECT id FROM identity_bindings WHERE channel_id = $1`, [paired.channelId])).rowCount).toBe(0)
    await store.mintWechatLinkCode({ accountId: w.bob, workspaceId: w.workspaceId, channelId: paired.channelId })
    expect((await queryWithRLS(w.bob, `SELECT id FROM channel_identity_challenges`, [])).rowCount).toBe(0)
    const identityId = (await pool.query(`SELECT identity_id FROM identity_bindings WHERE id = $1`, [paired.binding.bindingId])).rows[0].identity_id
    await expect(queryWithRLS(w.bob, `INSERT INTO identity_bindings (identity_id, account_id, workspace_id, channel_id, transport_generation, proof)
      VALUES ($1, $2, $3, $4, 1, 'link_code')`, [identityId, w.bob, w.workspaceId, paired.channelId])).rejects.toThrow()
    expect((await queryWithRLS(w.bob, `UPDATE identity_bindings SET account_id = $1 WHERE id = $2 RETURNING id`, [w.bob, paired.binding.bindingId])).rowCount).toBe(0)

    expect(await store.revokeOwnWechatBinding(w.bob, paired.binding.bindingId)).toBe(false)
    expect(await isWechatReceiptCurrentSystem(paired.binding)).toBe(true)
    expect(await store.revokeOwnWechatBinding(w.alice, paired.binding.bindingId)).toBe(true)
    expect(await store.revokeOwnWechatBinding(w.alice, paired.binding.bindingId)).toBe(true)
    expect(await isWechatReceiptCurrentSystem(paired.binding)).toBe(false)
    expect((await store.listOwnWechatBindings(w.alice, w.workspaceId))[0].state).toBe('revoked')
    const summary = await store.listWorkspaceWechatIdentitySummary(w.workspaceId)
    expect(summary).toEqual([expect.objectContaining({ channelId: paired.channelId, state: 'revoked', account: null })])
  })

  it('linking reassigns no history: existing sessions and users keep their owners', async () => {
    const w = await world()
    const assistantId = randomUUID()
    await pool.query(`INSERT INTO assistants(id, workspace_id, owner_user_id, name, kind, clearance, team_scope_mode)
      VALUES ($1, $2, $3, 'Fixture', 'primary', 'confidential', 'all')`, [assistantId, w.workspaceId, w.owner])
    const botId = bot(), scanner = sender()
    const sessionId = randomUUID()
    await pool.query(`INSERT INTO sessions(id, assistant_id, user_id, channel_type, channel_id) VALUES ($1, $2, $3, 'wechat', $4)`,
      [sessionId, assistantId, w.owner, scanner])
    const users = Number((await pool.query(`SELECT count(*) FROM users`)).rows[0].count)
    const prepared = await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.owner,
      mode: 'admin_prepare', pairingId: randomUUID(), defaultAssistantId: assistantId, credentials: creds(botId, scanner) })
    if (!prepared.ok) throw new Error('setup')
    const code = await store.mintWechatLinkCode({ accountId: w.alice, workspaceId: w.workspaceId, channelId: prepared.channelId })
    if (!code.ok) throw new Error('mint')
    expect((await store.claimWechatLinkCode({ channelId: prepared.channelId, botId, senderId: scanner, code: code.code })).ok).toBe(true)
    const session = await pool.query(`SELECT user_id FROM sessions WHERE id = $1`, [sessionId])
    expect(session.rows[0].user_id).toBe(w.owner)
    expect(Number((await pool.query(`SELECT count(*) FROM users`)).rows[0].count)).toBe(users)
    const routed = await pool.query(`SELECT assistant_id FROM channel_assistants WHERE channel_id = $1`, [prepared.channelId])
    expect(routed.rows).toEqual([{ assistant_id: assistantId }])
  })

  it('duplicate transport ownership is a visible conflict, never execution', async () => {
    const a = await world(), b = await world()
    const botId = bot(), scanner = sender()
    const paired = await store.provisionWechatTransport({ workspaceId: a.workspaceId, actorUserId: a.alice,
      mode: 'self', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) })
    if (!paired.ok || !paired.binding) throw new Error('setup')
    // A legacy duplicate predating the provisioning guard.
    const channel = await pool.query<{ id: string }>(`INSERT INTO channels(workspace_id, channel_type, enabled_capabilities, display_name)
      VALUES ($1, 'wechat', ARRAY['chat'], 'Legacy duplicate') RETURNING id`, [b.workspaceId])
    await pool.query(`INSERT INTO channel_integrations(channel_id, channel_type, team_name, bot_user_id, credentials, status)
      SELECT $1, 'wechat', team_name, bot_user_id, credentials, 'active' FROM channel_integrations WHERE channel_id = $2`,
      [channel.rows[0].id, paired.channelId])
    expect(await store.resolveWechatSender({ channelId: paired.channelId, botId, senderId: scanner })).toEqual({ kind: 'conflict' })
    expect(await isWechatReceiptCurrentSystem(paired.binding)).toBe(false)
    const transports = (await store.listActiveWechatTransportsSystem()).filter((t) => t.botId === botId)
    expect(transports.map((t) => t.conflict)).toEqual([true, true])
    expect(await store.mintWechatLinkCode({ accountId: a.bob, workspaceId: a.workspaceId, channelId: paired.channelId }))
      .toEqual({ ok: false, reason: 'conflict' })
    expect((await store.listWorkspaceWechatIdentitySummary(a.workspaceId))[0].state).toBe('conflict')
  })

  it('the recipient rule requires the exact binding version in the session key', async () => {
    const w = await world()
    const botId = bot(), scanner = sender()
    const paired = await store.provisionWechatTransport({ workspaceId: w.workspaceId, actorUserId: w.alice,
      mode: 'self', pairingId: randomUUID(), defaultAssistantId: null, credentials: creds(botId, scanner) })
    if (!paired.ok || !paired.binding) throw new Error('setup')
    const base = { workspaceId: w.workspaceId, accountId: w.alice, peerId: scanner }
    expect(await isWechatRecipientCurrentSystem({ ...base, sessionChannelId: wechatSessionChannelId(paired.binding) })).toBe(true)
    expect(await isWechatRecipientCurrentSystem({ ...base, sessionChannelId: scanner })).toBe(false)
    expect(await isWechatRecipientCurrentSystem({ ...base, accountId: w.bob, sessionChannelId: wechatSessionChannelId(paired.binding) })).toBe(false)
    expect(await isWechatRecipientCurrentSystem({ ...base, peerId: sender(), sessionChannelId: wechatSessionChannelId(paired.binding) })).toBe(false)
    expect(await isWechatRecipientCurrentSystem({ ...base,
      sessionChannelId: wechatSessionChannelId({ ...paired.binding, version: paired.binding.version + 1 }) })).toBe(false)
    await store.revokeOwnWechatBinding(w.alice, paired.binding.bindingId)
    expect(await isWechatRecipientCurrentSystem({ ...base, sessionChannelId: wechatSessionChannelId(paired.binding) })).toBe(false)
  })

  it('the scope guard trigger refuses default or transport-less WeChat bindings', async () => {
    const w = await world()
    const identity = await pool.query<{ id: string }>(`INSERT INTO identities(provider, tenant_key, subject) VALUES ('wechat', $1, $2) RETURNING id`, [bot(), sender()])
    await expect(pool.query(`INSERT INTO identity_bindings(identity_id, account_id, workspace_id, proof) VALUES ($1, $2, NULL, 'link_code')`,
      [identity.rows[0].id, w.alice])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`INSERT INTO identity_bindings(identity_id, account_id, workspace_id, proof) VALUES ($1, $2, $3, 'link_code')`,
      [identity.rows[0].id, w.alice, w.workspaceId])).rejects.toMatchObject({ code: '23514' })
    // Other providers keep room for default bindings (foundation plan §2).
    const feishu = await pool.query<{ id: string }>(`INSERT INTO identities(provider, tenant_key, subject) VALUES ('feishu', 'tenant', $1) RETURNING id`, [sender()])
    await pool.query(`INSERT INTO identity_bindings(identity_id, account_id, workspace_id, proof) VALUES ($1, $2, NULL, 'link_code')`,
      [feishu.rows[0].id, w.alice])
  })
})
