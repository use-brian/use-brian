import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AttachmentCollector, ContextScopeAccumulator, boundScopeSource, createMailboxTools,
  createSendFileTool, executionToolContext, singleMailboxRouter,
  type MailboxApi, type ScopeSource, type ToolContext,
} from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { addSessionMessage, findOrCreateSession, readSessionById, readSessionMessageScopeSource } from '../sessions.js'
import { findAssistantById } from '../users.js'
import { createFilesApi } from '../../files/files-api.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { createProgrammaticCaptureStore } from '../programmatic-capture-store.js'
import { createDbBrainKeyStore } from '../brain-keys-store.js'
import { withExternalKeyActor } from '../external-key-admission.js'
import { createEngineeringArchivePublisher } from '../../engineering-history/publisher.js'
import { createProgrammaticCaptureRouter } from '../../ingest/programmatic-capture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n')

async function fixture(v2 = true, personal = false, project = false, unbound = false) {
  const workspaceId = randomUUID(), owner = randomUUID(), actor = randomUUID(), assistantId = randomUUID()
  for (const id of [owner, actor]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Conversation file fixture',$2,$3)", [workspaceId, owner, v2])
  for (const [id, role] of [[owner, 'owner'], [actor, 'member']]) {
    await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,\'confidential\')', [workspaceId, id, role])
  }
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance,project_scope_mode) VALUES($1,$2,$3,'Conversation file assistant','standard','confidential','all')", [assistantId, workspaceId, owner])
  const team = await createDbWorkspaceGroupStore().createTeam(owner, workspaceId, { name: 'File fixtures', key: 'file-fixtures' })
  const key = team.compartmentKey!
  for (const user of [owner, actor]) {
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING", [workspaceId, team.id, user])
    await pool.query('UPDATE workspace_members SET home_department_id=$3 WHERE workspace_id=$1 AND user_id=$2', [workspaceId, user, unbound ? null : team.id])
  }
  await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store') ON CONFLICT DO NOTHING", [workspaceId, team.id, assistantId])
  await pool.query('UPDATE assistants SET home_department_id=$2 WHERE id=$1', [assistantId, unbound ? null : team.id])
  const projectId = project ? randomUUID() : null
  if (projectId) {
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'File project','file project',$3)", [projectId, workspaceId, owner])
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)', [projectId, actor])
  }
  // Canonical creation of the historical channel session precedes ready cutover.
  const session = await findOrCreateSession({ assistantId, userId: actor, workspaceId, channelType: 'telegram', channelId: randomUUID(),
    visibility: personal ? 'personal' : 'workspace', effectiveClearance: 'confidential', contextGroupId: unbound ? null : team.id,
    contextProjectId: projectId, contextCompartments: unbound ? [] : [key] })
  await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1", [workspaceId, team.id])
  const message = await addSessionMessage({ sessionId: session.id, role: 'user', content: [{ type: 'text', text: 'Save the attached document.' }],
    scope: { workspaceId, userId: personal ? actor : null, assistantId: null, sensitivity: 'confidential', compartments: unbound ? [] : [key], projectIds: projectId ? [projectId] : [] } })
  const source = (await readSessionMessageScopeSource(workspaceId, message.id))!
  const sources = [source]
  const store = createDbWorkspaceFilesStore(), blobs = new Map<string, Buffer>(), audits: unknown[] = []
  let duringWrite = async () => {}
  const storage = {
    writeBlob: async (name: string, bytes: Buffer) => { blobs.set(name, Buffer.from(bytes)); await duringWrite() },
    deleteBlob: async (name: string) => { blobs.delete(name) },
    readBlob: async (name: string) => blobs.has(name) ? { bytes: blobs.get(name)! } : null,
  }
  const api = createFilesApi({ resolver: { forWorkspace: async () => ({ gcs: storage as never, bucket: 'fixture', byo: true }), forUri: async () => storage as never },
    store, auditStore: { append: async (event: unknown) => { audits.push(event) } } as never })
  const mailbox: MailboxApi = {
    getAttachment: async () => ({ filename: 'synthetic.pdf', mime: 'application/pdf', bytes: pdf }),
    searchMessages: async () => ({ hits: [] }),
    getMessage: async () => { throw new Error('Not used by this fixture') },
    sendMessage: async () => { throw new Error('External sends are not part of this fixture') },
  }
  const saveTool = createMailboxTools(singleMailboxRouter(mailbox, 'mailbox@example.com'), { boundAccountEmail: 'mailbox@example.com', attachments: { filesApi: api } })
    .find(tool => tool.name === 'imapSaveAttachment')!
  const execution = await resolveExecutionContextSystem({ workspaceId, userId: actor, assistant: (await findAssistantById(assistantId))!,
    memberMode: 'member', session: (await readSessionById(session.id))!, sessionAuthority: (await readSessionById(session.id))!,
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: actor } }, ownership: { kind: 'workspace', workspaceId },
    lifecycle: { sessionId: session.id, channelType: 'telegram', channelId: session.channelId, abortSignal: new AbortController().signal } })
  const access = execution.executionContext.security.access
  const context = (): ToolContext => {
    const scopeAccumulator = new ContextScopeAccumulator()
    sources.forEach(item => scopeAccumulator.noteSource(item))
    return { ...executionToolContext(execution.executionContext, { appId: 'fixture' }), scopeAccumulator,
      activeCapabilities: new Set(['files']), outboundAttachments: new AttachmentCollector() }
  }
  const save = () => runWithAgentAccess(access, () => saveTool.execute({ messageId: 'INBOX:1', partId: '2' }, context()))
  const read = (kind = 'session_message', id = message.id, overrides: { actor?: string; acting?: string; workspace?: string } = {}) => runWithAgentAccess(access, async () => {
    const tx = await getAppPool().connect()
    try {
      await tx.query('BEGIN'); await applyRLSGucs(tx, actor)
      if (overrides.actor) await tx.query("SELECT set_config('app.agent_actor_id',$1,true)", [overrides.actor])
      if (overrides.acting) await tx.query("SELECT set_config('app.v2_assistant_id',$1,true)", [overrides.acting])
      if (overrides.workspace) await tx.query("SELECT set_config('app.agent_workspace_id',$1,true)", [overrides.workspace])
      return (await tx.query('SELECT read_entity_derivation_source($1,$2,$3) AS source', [workspaceId, kind, id])).rows[0].source
    } finally { await rollbackAndRelease(tx) }
  })
  const rows = async () => (await pool.query("SELECT * FROM workspace_files WHERE workspace_id=$1 AND path LIKE '/uploads/email/%'", [workspaceId])).rows
  return { workspaceId, owner, actor, assistantId, team, key, projectId, session, message, source, sources, store, api, access, context, save, read, rows, blobs, audits,
    during(fn: () => Promise<void>) { duringWrite = fn } }
}

describe('[COMP:api/conversation-file-derivation] admitted conversation sources', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it.each([false, true])('saves original attachment bytes with complete confidential lineage (v2=%s)', async v2 => {
    const f = await fixture(v2)
    const role = (await getAppPool().query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    expect(await f.read()).toMatchObject({ ...f.source, held: false })
    const result = await f.save()
    expect(result.isError).not.toBe(true)
    const [file] = await f.rows()
    expect(file).toMatchObject({ sensitivity: 'confidential', compartments: [f.key], project_ids: [], user_id: null })
    expect([...f.blobs.values()]).toEqual([pdf])
    expect((await pool.query('SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1', [file.id])).rows)
      .toContainEqual({ source_kind: 'session_message', source_id: f.message.id, source_version: f.source.version })
    const context = f.context()
    const read = await runWithAgentAccess(f.access, () => f.api.readBytes({ ...context, workspaceId: f.workspaceId }, file.id))
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.value.bytes).toEqual(pdf)
    expect(await runWithAgentAccess(f.access, () => createSendFileTool(f.api).execute({ file: file.id }, context)))
      .toMatchObject({ isError: true, data: expect.stringContaining('confidential') })
    expect(context.outboundAttachments!.drain()).toEqual([])
  })

  it.each(['held', 'stale', 'membership', 'member-department', 'assistant-department', 'assistant-clearance'] as const)(
    'rechecks %s after attachment byte staging and removes only unpublished bytes', async change => {
      const f = await fixture()
      f.during(async () => {
        if (change === 'held') await pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [f.message.id])
        if (change === 'stale') await pool.query("UPDATE session_messages SET content='[{\"type\":\"text\",\"text\":\"Changed request\"}]' WHERE id=$1", [f.message.id])
        if (change === 'membership') await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor])
        if (change === 'member-department') await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor])
        if (change === 'assistant-department') await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2', [f.workspaceId, f.assistantId])
        if (change === 'assistant-clearance') await pool.query("UPDATE department_edges SET clearance='public' WHERE workspace_id=$1 AND assistant_id=$2", [f.workspaceId, f.assistantId])
      })
      const result = await f.save()
      expect(result).toMatchObject({ isError: true, data: expect.stringContaining('scope_source_changed') })
      expect(String(result.data)).not.toContain('file_publication_uncertain')
      expect(await f.rows()).toEqual([])
      expect(f.blobs.size).toBe(0)
      expect(f.audits).toEqual([])
    },
  )

  it.each([false, true])('admits an unbound current chat without inventing a Department or Project floor (v2=%s)', async v2 => {
    const f = await fixture(v2, false, false, true)
    expect(await f.read()).toMatchObject({ compartments: [], projectIds: [] })
    expect((await f.save()).isError).not.toBe(true)
    expect(await f.rows()).toEqual([expect.objectContaining({ sensitivity: 'confidential', compartments: [], project_ids: [] })])
  })

  it('requires coherent actor, workspace, current assistant and a known source kind', async () => {
    const f = await fixture()
    expect(await f.read()).not.toBeNull()
    for (const overrides of [{ actor: f.owner }, { workspace: randomUUID() }, { acting: randomUUID() }]) expect(await f.read('session_message', f.message.id, overrides)).toBeNull()
    expect(await f.read('unrecognized_source', f.message.id)).toBeNull()
  })

  it('keeps private parent ownership even when the message envelope itself is shared', async () => {
    const f = await fixture(true, true)
    expect(await f.read()).not.toBeNull()
    // Deliberately broad message labels cannot stand in for parent ownership.
    await pool.query('UPDATE session_messages SET user_id=NULL WHERE id=$1', [f.message.id])
    expect(await f.read()).toBeNull()
    const tx = await getAppPool().connect()
    try {
      await tx.query('BEGIN'); await applyRLSGucs(tx, f.owner)
      expect((await tx.query("SELECT read_entity_derivation_source($1,'session_message',$2) AS source", [f.workspaceId, f.message.id])).rows[0].source).toBeNull()
    } finally { await rollbackAndRelease(tx) }
  })

  it('refuses a current message missing its parent Department floor instead of restamping its snapshot', async () => {
    const f = await fixture()
    await pool.query("UPDATE session_messages SET compartments='{}' WHERE id=$1", [f.message.id])
    expect(await f.read()).toBeNull()
  })

  it.each([[false, false], [true, false], [true, true]])('retains Project ceilings and rejects an archived parent Project (v2=%s, personal=%s)', async (v2, personal) => {
    const f = await fixture(v2, personal, true)
    expect(await f.read()).toMatchObject({ projectIds: [f.projectId] })
    const tx = await getAppPool().connect()
    try {
      await tx.query('BEGIN'); await applyRLSGucs(tx, f.actor)
      await tx.query("SELECT set_config('app.agent_project_ids','[]',true)")
      expect((await tx.query("SELECT read_entity_derivation_source($1,'session_message',$2) AS source", [f.workspaceId, f.message.id])).rows[0].source).toBeNull()
    } finally { await rollbackAndRelease(tx) }
    await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1", [f.projectId])
    expect(await f.read()).toBeNull()
  })

  it('refuses a current message missing its bound parent Project floor', async () => {
    const f = await fixture(true, true, true)
    await pool.query("UPDATE session_messages SET project_ids='{}' WHERE id=$1", [f.message.id])
    expect(await f.read()).toBeNull()
  })

  it('keeps the page wrapper and expanded page ancestry around conversation-file writes', async () => {
    const f = await fixture(false)
    const page = (await pool.query(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance)
      VALUES($1,$2,'File reference page','tasks','table','{"blocks":[]}','saved','internal') RETURNING page_event_revision`, [f.workspaceId, f.actor])).rows[0]
    const pageSource = (await pool.query("SELECT read_scope_source($1,'page_event_changed',$2) AS source", [f.workspaceId, page.page_event_revision])).rows[0].source as ScopeSource
    const file = await f.store.createDerived(f.actor, { workspaceId: f.workspaceId, path: '/reference.txt', parentPath: '/', name: 'reference.txt',
      mime: 'text/plain', sizeBytes: 1, storageUri: 'fixture://reference', createdByUserId: f.actor, compartments: [f.key], projectIds: [] },
    { producer: 'conversation-file-fixture', sources: [pageSource] })
    f.sources.push(boundScopeSource(file)!)
    const enriched = await f.read('workspace_file', file.id)
    expect(enriched.requiredSources).toEqual(expect.arrayContaining([expect.objectContaining({ resourceKind: 'page_event_changed' })]))
    expect((await f.save()).isError).not.toBe(true)
    const [saved] = await f.rows()
    expect((await pool.query('SELECT s.source_kind FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1', [saved.id])).rows)
      .toEqual(expect.arrayContaining([{ source_kind: 'session_message' }, { source_kind: 'page_event_changed' }]))
  })

  it('refuses operational file copies of an explicitly readable archive through transcript ancestry', async () => {
    const f = await fixture()
    const captureAssistant = randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance,default_compartments) VALUES($1,$2,$3,'Archive fixture assistant','primary','internal',$4)", [captureAssistant, f.workspaceId, f.owner, [f.key]])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store') ON CONFLICT DO NOTHING", [f.workspaceId, f.team.id, captureAssistant])
    const authSession = (await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'Fixture') RETURNING id", [f.owner])).rows[0].id
    const capture = createProgrammaticCaptureStore()
    const profile = await capture.createProfile({ actingUserId: f.owner, authSessionId: authSession, workspaceId: f.workspaceId, name: 'Archive fixture',
      processingMode: 'archive_only', partitionBy: 'session', enabled: true, destination: { kind: 'department', departmentId: f.team.id } })
    await capture.addRule({ actingUserId: f.owner, authSessionId: authSession, workspaceId: f.workspaceId, profileId: profile.id,
      rule: { filterType: 'role_match', filterParams: { values: ['user', 'assistant'] }, routingMode: 'realtime', scopeBindingMode: 'explicit', compartments: [f.key] } })
    const issued = await withExternalKeyActor(f.owner, authSession, () => createDbBrainKeyStore().create({ workspaceId: f.workspaceId, actingUserId: f.owner,
      name: 'Archive fixture', scope: 'read_write', maxClearance: 'internal', contextGroupId: f.team.id, contextProjectId: null, captureAssistantId: captureAssistant, captureProfileId: profile.id }))
    const route = createProgrammaticCaptureRouter({ store: capture, ingest: async () => { throw new Error('Archive fixture must not extract') }, archive: createEngineeringArchivePublisher(f.api).capture })
    const receipt = await route({ workspaceId: f.workspaceId, keyId: issued.id, scope: 'read_write', maxClearance: 'internal', authKind: 'api_key', storeScope: 'none', agentScope: 'none',
      actingUserId: f.owner, captureAssistantId: captureAssistant, captureProfileId: profile.id },
    { eventId: randomUUID(), content: 'Synthetic archived engineering history', sessionId: 'fixture-history', role: 'user', metadata: { provider: 'codex' } })
    expect(receipt).toMatchObject({ outcome: 'archived' })
    const fileId = (receipt as { fileId: string }).fileId
    expect((await runWithAgentAccess(f.access, () => f.api.readBytes({ ...f.context(), workspaceId: f.workspaceId }, fileId))).ok).toBe(true)
    const archive = (await pool.query("SELECT read_scope_source($1,'workspace_file',$2) AS source", [f.workspaceId, fileId])).rows[0].source as ScopeSource
    let source = archive
    for (let hop = 0; hop < 2; hop++) {
      const message = await addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: [{ type: 'text', text: 'Synthetic historical context' }],
        derivation: { producer: 'archive-transcript-fixture', sources: [source] } })
      source = (await readSessionMessageScopeSource(f.workspaceId, message.id))!
      expect(await f.read('session_message', message.id)).toBeNull()
    }
    f.sources.splice(0, f.sources.length, source)
    f.audits.length = 0
    const retained = f.blobs.size
    expect(await f.save()).toMatchObject({ isError: true, data: expect.stringContaining('scope_source_changed') })
    expect(await f.rows()).toEqual([])
    expect(f.blobs.size).toBe(retained)
    expect(f.audits).toEqual([])
  })

  it('upgrades a warmed source-reader chain without replacing the page or archive facades', async () => {
    const f = await fixture(false)
    const migration = (await readFile(new URL('../../../migrations/772_conversation_file_derivation.sql', import.meta.url), 'utf8'))
      .replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '')
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN'); await applyRLSGucs(tx, f.actor)
      const facade = (await tx.query("SELECT oid::text,prosrc FROM pg_proc WHERE oid='read_entity_derivation_source(uuid,text,uuid)'::regprocedure")).rows[0]
      await tx.query('DROP FUNCTION read_media_parent_snapshot(uuid,text,uuid)')
      await tx.query('ALTER FUNCTION read_media_parent_snapshot_before_conversation(uuid,text,uuid) RENAME TO read_media_parent_snapshot')
      await tx.query('DROP FUNCTION read_entity_derivation_source_before_page(uuid,text,uuid)')
      await tx.query('ALTER FUNCTION read_entity_derivation_source_before_conversation(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_page')
      const read = () => tx.query("SELECT read_entity_derivation_source($1,'session_message',$2) AS source", [f.workspaceId, f.message.id])
      const media = () => tx.query("SELECT read_media_parent_snapshot($1,'session_message',$2) AS source", [f.workspaceId, f.message.id])
      expect((await read()).rows[0].source).toBeNull()
      expect((await media()).rows[0].source).toBeNull()
      await tx.query(migration)
      expect((await read()).rows[0].source).toMatchObject(f.source)
      expect((await media()).rows[0].source).toMatchObject(f.source)
      expect((await tx.query("SELECT oid::text,prosrc FROM pg_proc WHERE oid='read_entity_derivation_source(uuid,text,uuid)'::regprocedure")).rows[0]).toEqual(facade)
      expect(facade.prosrc).toContain('engineering_archive')
    } finally { await rollbackAndRelease(tx) }
  })
})
