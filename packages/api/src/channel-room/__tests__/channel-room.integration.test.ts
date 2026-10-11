/**
 * [COMP:api/channel-room] Converged rooms against a migration-replayed
 * database (unified-sessions §9 S4). Env-gated: set
 * CHANNEL_ROOM_TEST_DATABASE_URL to an owner connection of a database the
 * open migration chain has been applied to.
 *
 * Per transport: two senders in one group share one session; an un-addressed
 * message persists as a post and runs no turn; a guest's post lands in the
 * room with no memory rows; a legacy per-user group row is archived when the
 * room is created; the room is hydrated and disclosed exactly once; a ready
 * workspace admits the room through the `channel_room` receipt.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.CHANNEL_ROOM_TEST_DATABASE_URL
const describeIf = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

type Room = typeof import('../room.js')
type Client = typeof import('../../db/client.js')
let room: Room
let db: Client

const W = randomUUID()
const OWNER = randomUUID()
const MEMBER = randomUUID()
const GUEST = randomUUID()
const ASSISTANT = randomUUID()
const integrations = new Map<string, string>()

describeIf('[COMP:api/channel-room] converged rooms (database)', () => {
  beforeAll(async () => {
    room = await import('../room.js')
    db = await import('../../db/client.js')
    const q = db.query
    await q(`INSERT INTO users (id, auth_provider, auth_provider_id, name)
             SELECT u, 'test', 'channel-room-' || u, n FROM unnest($1::uuid[], $2::text[]) AS t(u, n)`,
    [[OWNER, MEMBER, GUEST], ['Owner Example', 'Member Example', null]])
    await q(`INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal) VALUES ($1, 'Rooms', 'test', $2, false)`, [W, OWNER])
    await q(`INSERT INTO workspace_members (workspace_id, user_id, role, clearance) VALUES ($1, $2, 'owner', 'confidential'), ($1, $3, 'member', 'internal')`, [W, OWNER, MEMBER])
    await q(`INSERT INTO assistants (id, name, owner_user_id, workspace_id, clearance) VALUES ($1, 'Brian', $2, $3, 'internal')`, [ASSISTANT, OWNER, W])
    for (const transport of ['slack', 'telegram', 'discord', 'feishu', 'msteams', 'whatsapp']) {
      const channel = (await q<{ id: string }>(
        `INSERT INTO channels (workspace_id, channel_type, display_name) VALUES ($1, $2, $2) RETURNING id`, [W, transport])).rows[0].id
      const integration = (await q<{ id: string }>(
        `INSERT INTO channel_integrations (channel_id, channel_type, credentials) VALUES ($1, $2, '\\x00'::bytea) RETURNING id`,
        [channel, transport])).rows[0].id
      integrations.set(transport, integration)
    }
  })

  afterAll(async () => {
    await db?.query('DELETE FROM workspaces WHERE id = $1', [W]).catch(() => undefined)
    await db?.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[OWNER, MEMBER, GUEST]]).catch(() => undefined)
    await db?.getPool().end().catch(() => undefined)
  })

  for (const transport of ['slack', 'telegram', 'discord', 'feishu', 'msteams', 'whatsapp']) {
    it(`${transport}: two senders share one room; un-addressed posts persist; the legacy row is archived`, async () => {
      const groupId = `group-${randomUUID()}`
      // A per-user group session from before convergence.
      const legacy = (await db.query<{ id: string }>(
        `INSERT INTO sessions (assistant_id, user_id, channel_type, channel_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [ASSISTANT, MEMBER, transport, groupId])).rows[0].id

      const binding = await room.resolveRoomBinding({
        assistant: { id: ASSISTANT, workspaceId: W }, channelType: transport,
        channelIntegrationId: integrations.get(transport), isGroupChat: true,
      })
      expect(binding).toEqual({ workspaceId: W, channelIntegrationId: integrations.get(transport) })

      const notices: string[] = []
      const postNotice = async (text: string) => { notices.push(text) }
      const base = {
        assistant: { id: ASSISTANT, name: 'Brian', workspaceId: W },
        channelType: transport, channelIntegrationId: integrations.get(transport),
        isGroupChat: true, sessionChannelId: groupId, postNotice,
      }
      expect(await room.postPassiveChannelMessage({ ...base, senderUserId: MEMBER, senderName: 'Member Example', text: 'standup at 10', channelMessageId: 'm1' })).toBe(true)
      expect(await room.postPassiveChannelMessage({ ...base, senderUserId: GUEST, senderName: '@guest', text: 'can I join?', channelMessageId: 'm2' })).toBe(true)
      // A provider redelivery is a no-op.
      expect(await room.postPassiveChannelMessage({ ...base, senderUserId: GUEST, senderName: '@guest', text: 'can I join?', channelMessageId: 'm2' })).toBe(true)

      const rooms = (await db.query<{ id: string; visibility: string; anchor_kind: string; effective_clearance: string }>(
        `SELECT id, visibility, anchor_kind, effective_clearance FROM sessions
          WHERE workspace_id = $1 AND channel_type = $2 AND channel_id = $3 AND anchor_kind = 'channel'`,
        [W, transport, groupId])).rows
      expect(rooms).toHaveLength(1)
      expect(rooms[0]).toMatchObject({ visibility: 'workspace', anchor_kind: 'channel', effective_clearance: 'internal' })
      const roomId = rooms[0].id

      const posts = (await db.query<{ sender_user_id: string; role: string; channel_message_id: string }>(
        'SELECT sender_user_id, role, channel_message_id FROM session_messages WHERE session_id = $1 ORDER BY sequence_num', [roomId])).rows
      expect(posts.map((p) => [p.sender_user_id, p.role, p.channel_message_id])).toEqual([
        [MEMBER, 'user', 'm1'], [GUEST, 'user', 'm2'],
      ])
      // No turn ran: nothing answered and the room is idle.
      const status = (await db.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [roomId])).rows[0].status
      expect(status).toBe('idle')
      // A guest gains no memory rows.
      const guestMemories = await db.query('SELECT 1 FROM memories WHERE user_id = $1', [GUEST])
      expect(guestMemories.rows).toHaveLength(0)

      // D16: the per-user row is read-only personal history, never merged.
      const archived = (await db.query<{ archived_at: Date | null; visibility: string }>(
        'SELECT archived_at, visibility FROM sessions WHERE id = $1', [legacy])).rows[0]
      expect(archived.archived_at).not.toBeNull()
      expect(archived.visibility).toBe('personal')
      expect((await db.query('SELECT 1 FROM session_messages WHERE session_id = $1', [legacy])).rows).toHaveLength(0)

      // D4: disclosed once; D16: hydrated once.
      expect(notices).toHaveLength(1)
      expect(await room.claimRoomHydration(roomId)).toBe(true)
      expect(await room.claimRoomHydration(roomId)).toBe(false)

      // An addressed turn from the other sender lands in the same room.
      const { room: again, created } = await room.findOrCreateChannelRoom({
        workspaceId: W, channelIntegrationId: integrations.get(transport)!,
        assistantId: ASSISTANT, channelType: transport, channelId: groupId, starterUserId: OWNER,
      })
      expect(created).toBe(false)
      expect(again.id).toBe(roomId)

      // An unattended delivery writes into the room.
      expect((await room.findRoomForDelivery({ workspaceId: W, channelType: transport, channelId: groupId }))?.id).toBe(roomId)
    })
  }

  it('a group bound to another workspace stays on the per-user path', async () => {
    expect(await room.resolveRoomBinding({
      assistant: { id: ASSISTANT, workspaceId: randomUUID() }, channelType: 'slack',
      channelIntegrationId: integrations.get('slack'), isGroupChat: true,
    })).toBeNull()
    expect(await room.resolveRoomBinding({
      assistant: { id: ASSISTANT, workspaceId: W }, channelType: 'slack',
      channelIntegrationId: integrations.get('slack'), isGroupChat: false,
    })).toBeNull()
  })

  it('a ready workspace admits the room through the channel_room receipt', async () => {
    await db.query(
      `INSERT INTO workspace_access_policies (workspace_id, setup_state, access_mode) VALUES ($1, 'ready', 'departments')
       ON CONFLICT (workspace_id) DO UPDATE SET setup_state = 'ready', access_mode = 'departments'`, [W])
    try {
      // Without the receipt the trigger refuses a workspace channel row.
      await expect(db.query(
        `INSERT INTO sessions (assistant_id, user_id, workspace_id, channel_type, channel_id, visibility, anchor_kind, effective_clearance)
         VALUES ($1, $2, $3, 'slack', 'unreceipted', 'workspace', 'channel', 'internal')`, [ASSISTANT, GUEST, W]),
      ).rejects.toThrow(/workspace_creation_admission_required/)
      // A guest may start the room: the binding is the authority (D15).
      const { room: created, created: isNew } = await room.findOrCreateChannelRoom({
        workspaceId: W, channelIntegrationId: integrations.get('slack')!,
        assistantId: ASSISTANT, channelType: 'slack', channelId: `ready-${randomUUID()}`, starterUserId: GUEST,
      })
      expect(isNew).toBe(true)
      expect(created.anchorKind).toBe('channel')
    } finally {
      await db.query("UPDATE workspace_access_policies SET setup_state = 'legacy' WHERE workspace_id = $1", [W])
    }
  })
})
