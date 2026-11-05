import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adoptVerifiedLocalOwner } from '../outpost-owner-adoption.js'

const owner = '10000000-0000-4000-a000-000000000001'
const other = '10000000-0000-4000-a000-000000000002'
const email = 'owner@example.com'
const configured = { userId: owner, email }
let db: PGlite
let tail = Promise.resolve()
const pool = {
  async connect() {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>(resolve => { release = resolve })
    await previous
    return { query: db.query.bind(db), release }
  },
} as unknown as Pick<pg.Pool, 'connect'>

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE users(id uuid PRIMARY KEY, email text UNIQUE, auth_provider text,
      auth_provider_id text, auth_version integer NOT NULL DEFAULT 0,
      UNIQUE(auth_provider, auth_provider_id));
    CREATE TABLE auth_sessions(id text PRIMARY KEY, user_id uuid REFERENCES users(id), revoked_at timestamptz);
    CREATE TABLE retained_data(id text PRIMARY KEY, owner_id uuid REFERENCES users(id), payload text);
  `)
}, 30_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec('TRUNCATE auth_sessions, retained_data, users CASCADE')
  await db.query("INSERT INTO users VALUES($1,'owner@local','local','local-owner',0)", [owner])
  await db.query("INSERT INTO auth_sessions VALUES('old-device',$1,NULL)", [owner])
  await db.query("INSERT INTO retained_data VALUES('private-history',$1,'unchanged')", [owner])
})

describe('[COMP:api/outpost-owner-adoption] verified owner adoption (PostgreSQL)', () => {
  it('preserves the owner and retained rows while revoking the old login exactly once', async () => {
    expect(await adoptVerifiedLocalOwner(configured, email, pool)).toBe(owner)
    expect((await db.query('SELECT * FROM users')).rows).toEqual([
      { id: owner, email, auth_provider: 'email', auth_provider_id: email, auth_version: 1 },
    ])
    expect((await db.query('SELECT * FROM retained_data')).rows).toEqual([
      { id: 'private-history', owner_id: owner, payload: 'unchanged' },
    ])
    expect((await db.query<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions')).rows[0]?.revoked).toBe(true)
    await db.query("INSERT INTO auth_sessions VALUES('new-device',$1,NULL)", [owner])
    expect(await adoptVerifiedLocalOwner(configured, email, pool)).toBe(owner)
    expect((await db.query('SELECT auth_version FROM users')).rows).toEqual([{ auth_version: 1 }])
    expect((await db.query("SELECT revoked_at FROM auth_sessions WHERE id='new-device'")).rows).toEqual([{ revoked_at: null }])
  })

  it('does not adopt for a different verified recipient', async () => {
    expect(await adoptVerifiedLocalOwner(configured, 'member@example.com', pool)).toBeNull()
    expect((await db.query('SELECT email, auth_version FROM users')).rows).toEqual([{ email: 'owner@local', auth_version: 0 }])
  })

  it.each(['email', 'provider'])('rejects another user occupying the selected %s identity', async (kind) => {
    await db.query('INSERT INTO users VALUES($1,$2,$3,$4,0)', [other,
      kind === 'email' ? email : 'another@example.com', kind === 'email' ? 'google' : 'email', email])
    await expect(adoptVerifiedLocalOwner(configured, email, pool)).rejects.toThrow('identity_conflict')
    expect((await db.query('SELECT email, auth_version FROM users WHERE id=$1', [owner])).rows).toEqual([{ email: 'owner@local', auth_version: 0 }])
    expect((await db.query('SELECT revoked_at FROM auth_sessions')).rows).toEqual([{ revoked_at: null }])
  })

  it('refuses a missing or changed source instead of creating a replacement', async () => {
    await expect(adoptVerifiedLocalOwner({ ...configured, userId: other }, email, pool)).rejects.toThrow('source_missing')
    await db.query("UPDATE users SET auth_provider='google' WHERE id=$1", [owner])
    await expect(adoptVerifiedLocalOwner(configured, email, pool)).rejects.toThrow('source_changed')
    expect((await db.query('SELECT count(*)::integer AS n FROM users')).rows).toEqual([{ n: 1 }])
  })

  it('rolls back the identity update if session revocation fails', async () => {
    await db.exec(`CREATE FUNCTION reject_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture revocation failure'; END $$;
      CREATE TRIGGER reject_revoke BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION reject_revoke();`)
    try {
      await expect(adoptVerifiedLocalOwner(configured, email, pool)).rejects.toThrow('fixture revocation failure')
      expect((await db.query('SELECT email, auth_version FROM users')).rows).toEqual([{ email: 'owner@local', auth_version: 0 }])
    } finally {
      await db.exec('DROP TRIGGER reject_revoke ON auth_sessions; DROP FUNCTION reject_revoke()')
    }
  })

  it('serializes repeated verified claims without repeating the version bump', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => adoptVerifiedLocalOwner(configured, email, pool)))
    expect(results).toEqual([owner, owner, owner, owner])
    expect((await db.query('SELECT auth_version FROM users')).rows).toEqual([{ auth_version: 1 }])
  })
})
