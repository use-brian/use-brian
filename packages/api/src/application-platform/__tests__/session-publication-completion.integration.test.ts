import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { getAppPool, getPool, rollbackAndRelease } from '../../db/client.js'
import { readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { publishNativeSessionMessageBatch } from '../../db/conversation-store.js'
import { withSessionMessagePublication } from '../../db/session-context-revisions.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/session-publication-completion] real deferred timeout', () => {
  afterAll(async () => { await getAppPool().end(); await getPool().end() })
  it('times out deferred work, rolls back the reply and releases the session row', async () => {
    const f = await persistentContextFixture()
    const name = `publication_completion_${randomUUID().replaceAll('-', '')}`
    try {
      await f.history()
      const authority = await f.modelContext(f.firstId)
      const input = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: 3, authority })
      const sources = boundScopeSources(input)
      // A separate fixture relation leaves the canonical native-trigger contract
      // intact. Its deferred check is pending alongside the real reply proof.
      await f.pool.query(`CREATE TABLE ${name}(id integer);
        GRANT INSERT ON ${name} TO app_user;
        CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fixture$
          BEGIN PERFORM pg_sleep(1.5); RETURN NULL; END $fixture$;
        CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON ${name}
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`)
      const measurements: string[] = []
      const measure = async <T>(counter: string, run: () => Promise<T>): Promise<T> => { measurements.push(counter); return run() }
      await expect(withSessionMessagePublication(authority, sources, async db => {
        await publishNativeSessionMessageBatch({ sessionId: f.session.id, messages: [{ role: 'assistant', content: 'Fictional reply that must roll back' }],
          derivation: { producer: 'fixture:completion-timeout', sources }, derivationTarget: f.envelope, authority }, db)
        await db.query(`INSERT INTO ${name}(id) VALUES(1)`)
        await db.query("SET LOCAL statement_timeout='500ms'")
      }, { measure })).rejects.toMatchObject({ code: '57014' })
      expect(measurements).toContain('publication_constraints')
      expect(measurements).not.toContain('publication_commit')
      expect((await f.pool.query('SELECT count(*)::integer AS n FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].n).toBe(3)
      expect((await f.pool.query(`SELECT count(*)::integer AS n FROM ${name}`)).rows[0].n).toBe(0)
      const probe = await f.pool.connect()
      try {
        await probe.query('BEGIN')
        expect((await probe.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE NOWAIT', [f.session.id])).rowCount).toBe(1)
      } finally { await rollbackAndRelease(probe) }
    } finally {
      await f.pool.query(`DROP TABLE IF EXISTS ${name}; DROP FUNCTION IF EXISTS ${name}()`)
      await f.cleanup()
    }
  })
  it.each(['committed','aborted'] as const)('reconciles a lost %s acknowledgement without replaying publication', async outcome => {
    const f=await persistentContextFixture()
    try {
      await f.history()
      const authority=await f.modelContext(f.firstId)
      const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
      const sources=boundScopeSources(input)
      let writes=0,commits=0
      const measure=async<T>(counter:string,run:()=>Promise<T>):Promise<T>=>{
        if(counter!=='publication_commit')return run()
        commits++
        if(outcome==='committed')await run()
        throw new Error('fixture_commit_acknowledgement_lost')
      }
      const publication=withSessionMessagePublication(authority,sources,async db=>{
        writes++
        await publishNativeSessionMessageBatch({sessionId:f.session.id,messages:[{role:'assistant',content:'Synthetic durable reply'}],
          derivation:{producer:'fixture:commit-outcome',sources},derivationTarget:f.envelope,authority},db)
        return {completed:true}
      },{measure})
      if(outcome==='committed')await expect(publication).resolves.toEqual({completed:true})
      else await expect(publication).rejects.toMatchObject({message:'fixture_commit_acknowledgement_lost',retrySafe:false,operationMayHaveExecuted:true})
      expect(writes).toBe(1)
      expect(commits).toBe(1)
      expect((await f.pool.query('SELECT count(*)::integer AS n FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].n)
        .toBe(outcome==='committed'?4:3)
      if(outcome==='committed'){
        const reopened=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:4,authority})
        expect(reopened.history.at(-1)?.content).toBe('Synthetic durable reply')
      }
    } finally { await f.cleanup() }
  })

})
