import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let pool: pg.Pool
vi.mock('../../db/client.js', () => ({ getPool: () => pool, query: (...args: Parameters<pg.Pool['query']>) => pool.query(...args) }))

const url = process.env.CHANNEL_ROOM_TEST_DATABASE_URL ?? process.env.DATABASE_URL
const suite = url ? describe : describe.skip
const schema = `room_intake_${randomUUID().replaceAll('-', '')}`
const roomId = randomUUID()
const botA = randomUUID()
const botB = randomUUID()
let intake: typeof import('../messages.js')

suite('[COMP:api/channel-room] atomic provider message intake (PostgreSQL)', () => {
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url })
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.end()
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` })
    await pool.query(`CREATE TABLE sessions(id uuid PRIMARY KEY,room_capture boolean DEFAULT true);
      CREATE TABLE assistants(id uuid PRIMARY KEY);
      CREATE TABLE session_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid REFERENCES sessions,
        role text,content jsonb,sequence_num integer,created_at timestamptz DEFAULT now(),reply_to_text text,
        topic_label text,topic_confidence real,channel_message_id text,sender_user_id uuid,sender_assistant_id uuid,
        attachments jsonb,workspace_id uuid,user_id uuid,assistant_id uuid,sensitivity text,compartments text[],
        project_ids uuid[],scope_version bigint,scope_held boolean);
      INSERT INTO sessions VALUES('${roomId}'); INSERT INTO assistants VALUES('${botA}'),('${botB}');`)
    const { readFile } = await import('node:fs/promises')
    await pool.query(await readFile(new URL('../../../migrations/775_channel_message_turn_claims.sql', import.meta.url), 'utf8'))
    intake = await import('../messages.js')
  })
  beforeEach(async () => {
    await pool.query('TRUNCATE channel_message_turn_claims,session_messages')
  })
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await pool.end()
    }
  })

  const input = (id = '3606') => ({ sessionId: roomId, role: 'user' as const, content: [{ type: 'text', text: 'remember these courses' }], channelMessageId: id })

  it('passive first, addressed second reuse one canonical row, while the addressed bot still gets a turn', async () => {
    const passive = await intake.appendChannelRoomMessage(input())
    const active = await intake.appendChannelRoomMessage(input())
    expect(passive.created).toBe(true)
    expect(active.created).toBe(false)
    expect(active.message.id).toBe(passive.message.id)
    expect(await intake.claimChannelRoomTurn({ sessionId: roomId, assistantId: botA, channelMessageId: '3606' })).toBe(true)
    expect(await intake.claimChannelRoomTurn({ sessionId: roomId, assistantId: botA, channelMessageId: '3606' })).toBe(false)
    expect((await pool.query('SELECT * FROM session_messages')).rowCount).toBe(1)
  })

  it('concurrent installations persist one row and provider replays start one turn per addressed assistant', async () => {
    const writes = await Promise.all(Array.from({ length: 8 }, () => intake.appendChannelRoomMessage(input())))
    expect(writes.filter(result => result.created)).toHaveLength(1)
    expect(new Set(writes.map(result => result.message.id)).size).toBe(1)
    const claims = await Promise.all(Array.from({ length: 8 }, () => intake.claimChannelRoomTurn({ sessionId: roomId, assistantId: botA, channelMessageId: '3606' })))
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await intake.claimChannelRoomTurn({ sessionId: roomId, assistantId: botB, channelMessageId: '3606' })).toBe(true)
    expect(await intake.claimChannelRoomTurn({ sessionId: roomId, assistantId: botA, channelMessageId: '3607' })).toBe(true)
  })

  it('preserves legacy duplicates and reuses the earliest row instead of appending a third', async () => {
    const { addSessionMessage } = await import('../../db/sessions.js')
    const first = await addSessionMessage(input())
    await addSessionMessage(input())
    expect((await intake.appendChannelRoomMessage(input())).message.id).toBe(first.id)
    expect((await pool.query('SELECT * FROM session_messages')).rowCount).toBe(2)
  })

  it('uses a supplied archive transaction and retains append semantics when no provider id exists', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await intake.appendChannelRoomMessage(input(), client)
      await client.query('ROLLBACK')
    } finally { client.release() }
    expect((await pool.query('SELECT * FROM session_messages')).rowCount).toBe(0)
    await intake.appendChannelRoomMessage({ ...input(), channelMessageId: null })
    await intake.appendChannelRoomMessage({ ...input(), channelMessageId: null })
    expect((await pool.query('SELECT * FROM session_messages')).rowCount).toBe(2)
  })

  it('publishes and captures a new passive input once, and respects room capture consent', async () => {
    const { configureChannelRooms, postToChannelRoom, captureChannelRoomInput } = await import('../room.js')
    const capture = vi.fn()
    const publish = vi.fn()
    configureChannelRooms({ capturePost: capture, publishSessionEvent: publish })
    const post = { room: { id: roomId, assistantId: botA, effectiveClearance: 'internal', contextCompartments: [], contextProjectId: null } as never,
      workspaceId: randomUUID(), senderUserId: randomUUID(), senderName: 'Fish', text: 'Remember these courses', channelMessageId: '3606' }
    expect(await postToChannelRoom(post)).not.toBeNull()
    expect(await postToChannelRoom(post)).toBeNull()
    expect((await intake.appendChannelRoomMessage(input())).created).toBe(false)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    await pool.query('UPDATE sessions SET room_capture=false WHERE id=$1', [roomId])
    await captureChannelRoomInput({ ...post, text: 'Another addressed message' })
    expect(capture).toHaveBeenCalledTimes(1)
    await pool.query('UPDATE sessions SET room_capture=true WHERE id=$1', [roomId])
  })
})
