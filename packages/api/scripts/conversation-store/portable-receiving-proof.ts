/**
 * [COMP:platform/managed-postgres-transfer] Receiving proof for a transferred
 * brain, run through the real runtime against a disposable probe clone of the
 * admitted-candidate database (spec: portable-brain-restore.md → "Existing-brain
 * transfer"). Spawned by the managed composition entry as an IPC child whose only
 * database settings are the probe's owner (`DATABASE_URL`) and `app_user`
 * (`DATABASE_URL_APP`) DSNs, so no proof write can reach the instance that will
 * be published.
 *
 * Checks: (1) every user's protected reads as `app_user` under RLS equal the
 * embedded source's reads of the same relations; (2) every selected conversation
 * opens for its starter through `resolveSessionTitleAuthority` and
 * `readAdmittedSessionQuery`, with admitted rows equal to the restored rows;
 * (3) a follow-up assistant turn persists through the canonical publisher and
 * reopens with the earlier history.
 */
import pg from 'pg'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { getAppPool, getPool } from '../../src/db/client.js'
import { authSessionStore } from '../../src/db/auth-session-store.js'
import { publishNativeSessionMessageBatch, readAdmittedSessionQuery } from '../../src/db/conversation-store.js'
import { resolveSessionTitleAuthority } from '../../src/routes/session-title-authority.js'

type Reads = Record<string, { rows: number; sha256: string }>
type Input = { users: string[]; sessions: { sessionId: string; actorUserId: string }[]; expectedReads: Reads; followUpText: string }
type Check = { name: string; passed: boolean; detail?: string }

const source = (await import(new URL('./pglite-portable-source.mjs', import.meta.url).href)) as {
  protectedReadObservations: (client: pg.Client, users: string[]) => Promise<Reads>
}

async function prove(input: Input): Promise<{ status: 'passed' | 'failed'; checks: Check[] }> {
  const checks: Check[] = []
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP, application_name: 'usebrian-transfer-receiving' })
  await app.connect()
  try {
    const role = (await app.query<{ u: string; s: boolean; b: boolean }>('SELECT current_user::text u,rolsuper s,rolbypassrls b FROM pg_roles WHERE rolname=current_user')).rows[0]
    checks.push({ name: 'runtime-role', passed: role.u === 'app_user' && !role.s && !role.b, detail: role.u })
    const actual = await source.protectedReadObservations(app, input.users)
    for (const key of [...new Set([...Object.keys(input.expectedReads), ...Object.keys(actual)])].sort()) {
      const passed = JSON.stringify(input.expectedReads[key]) === JSON.stringify(actual[key])
      checks.push({ name: 'protected-read:' + key, passed, detail: `${input.expectedReads[key]?.rows ?? 'none'} -> ${actual[key]?.rows ?? 'none'}` })
    }
  } finally { await app.end() }

  const owner = getPool()
  let followUp: { sessionId: string; actorUserId: string; through: number } | null = null
  for (const target of input.sessions) {
    const name = 'session-open:' + target.sessionId
    try {
      const device = await authSessionStore.create(target.actorUserId, { deviceLabel: 'Transfer receiving proof', userAgent: null, ipAddress: null })
      if (!device) throw new Error('auth session not created')
      const claims = { userId: target.actorUserId, sessionId: device.id, authVersion: device.authVersion }
      const rows = (await owner.query<{ id: string; sequence_num: number; content: unknown }>(
        'SELECT id::text,sequence_num,content FROM session_messages WHERE session_id=$1 ORDER BY sequence_num', [target.sessionId])).rows
      const through = rows.at(-1)?.sequence_num ?? 0
      const authority = await resolveSessionTitleAuthority({ claims, sessionId: target.sessionId, readOnly: true })
      const captured = await readAdmittedSessionQuery({ sessionId: target.sessionId, throughSequence: through, authority })
      const restored = new Map(rows.map((row) => [row.id, row]))
      const equal = captured.history.length > 0 && captured.history.every((message) =>
        restored.has(message.id) && JSON.stringify(restored.get(message.id)!.content) === JSON.stringify(message.content))
      checks.push({ name, passed: equal, detail: `${captured.history.length} admitted of ${rows.length} restored` })
      if (equal && !followUp) followUp = { ...target, through }
    } catch (error) {
      checks.push({ name, passed: false, detail: (error as Error).message.slice(0, 300) })
    }
  }

  if (followUp) {
    const name = 'follow-up-turn:' + followUp.sessionId
    try {
      const device = (await authSessionStore.create(followUp.actorUserId, { deviceLabel: 'Transfer receiving proof', userAgent: null, ipAddress: null }))!
      const claims = { userId: followUp.actorUserId, sessionId: device.id, authVersion: device.authVersion }
      const session = (await owner.query<{ assistant_id: string }>('SELECT assistant_id::text FROM sessions WHERE id=$1', [followUp.sessionId])).rows[0]
      const authority = await resolveSessionTitleAuthority({ claims, sessionId: followUp.sessionId, readOnly: false })
      const captured = await readAdmittedSessionQuery({ sessionId: followUp.sessionId, throughSequence: followUp.through, authority })
      const replies = await publishNativeSessionMessageBatch({
        sessionId: followUp.sessionId, authority,
        derivation: { producer: 'fixture:managed-transfer-receiving', sources: boundScopeSources(captured) },
        messages: [{ role: 'assistant', senderAssistantId: session.assistant_id, content: [{ type: 'text', text: input.followUpText }] }],
      })
      const reopened = await readAdmittedSessionQuery({
        sessionId: followUp.sessionId, throughSequence: replies.at(-1)!.sequenceNum,
        authority: await resolveSessionTitleAuthority({ claims, sessionId: followUp.sessionId, readOnly: false }),
      })
      const text = JSON.stringify(reopened.history)
      checks.push({ name, passed: text.includes(input.followUpText) && reopened.history.length > captured.history.length, detail: `${reopened.history.length} after follow-up` })
    } catch (error) {
      checks.push({ name, passed: false, detail: (error as Error).message.slice(0, 300) })
    }
  } else if (input.sessions.length) checks.push({ name: 'follow-up-turn', passed: false, detail: 'no conversation opened' })

  return { status: checks.length && checks.every((check) => check.passed) ? 'passed' : 'failed', checks }
}

if (!process.send) throw new Error('The receiving proof runs only as an IPC child of the managed composition entry')
process.once('message', (input) => {
  void prove(input as Input).then(
    (result) => ({ type: 'result', result }),
    (error: Error) => ({ type: 'error', message: error.message.slice(0, 1000) }),
  ).then(async (message) => {
    await Promise.allSettled([getAppPool().end(), getPool().end()])
    process.send!(message, undefined, {}, () => process.exit(0))
  })
})
process.on('disconnect', () => process.exit(1))
