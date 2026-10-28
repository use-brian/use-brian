import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

describe('[COMP:api/sessions-list] archive persistence', () => {
  it('isolates viewer markers under RLS and cascades them without deleting conversation data', async () => {
    const db = new PGlite()
    const viewer = '11111111-1111-4111-8111-111111111111'
    const other = '22222222-2222-4222-8222-222222222222'
    const session = '33333333-3333-4333-8333-333333333333'
    try {
      await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE sessions(id uuid PRIMARY KEY, title text);
        INSERT INTO users VALUES('${viewer}'),('${other}');
        INSERT INTO sessions VALUES('${session}','Fictional planning');`)
      await db.exec(readFileSync(new URL('../../../migrations/8139_session_archives.sql', import.meta.url), 'utf8'))
      await db.exec(`CREATE ROLE archive_viewer;
        GRANT SELECT,INSERT,DELETE ON session_archives TO archive_viewer;
        SET ROLE archive_viewer;
        SELECT set_config('app.current_user_id','${viewer}',false);`)
      await db.query('INSERT INTO session_archives(user_id,session_id) VALUES($1,$2)', [viewer, session])
      await expect(db.query('INSERT INTO session_archives(user_id,session_id) VALUES($1,$2)', [other, session])).rejects.toThrow(/row-level security/)
      expect((await db.query('SELECT session_id FROM session_archives')).rows).toHaveLength(1)
      await db.query("SELECT set_config('app.current_user_id',$1,false)", [other])
      expect((await db.query('SELECT session_id FROM session_archives')).rows).toHaveLength(0)
      await db.query('DELETE FROM session_archives WHERE session_id=$1', [session])
      await db.exec('RESET ROLE')
      expect((await db.query('SELECT session_id FROM session_archives')).rows).toHaveLength(1)
      expect((await db.query('SELECT title FROM sessions')).rows).toEqual([{ title: 'Fictional planning' }])
      await db.query('DELETE FROM users WHERE id=$1', [viewer])
      expect((await db.query('SELECT session_id FROM session_archives')).rows).toHaveLength(0)
      await db.query('INSERT INTO session_archives(user_id,session_id) VALUES($1,$2)', [other, session])
      await db.query('DELETE FROM sessions WHERE id=$1', [session])
      expect((await db.query('SELECT session_id FROM session_archives')).rows).toHaveLength(0)
    } finally { await db.close() }
  }, 15_000)
})
