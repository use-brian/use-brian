/** Adapter behavior over already-admitted revision fixtures. Real authority/SQL
 * enforcement is exercised by persistent-consumers.integration.test.ts. */
import { beforeEach,describe,it,expect,vi } from 'vitest'
import { bindScopeSource,boundScopeSources,createExecutionContext,ContextScopeAccumulator } from '@use-brian/core'
import type { SessionContextRevision } from '../session-context-revisions.js'
vi.mock('../session-context-revisions.js',()=>({readSessionContextRevisions:vi.fn(),writeSessionContextRevision:vi.fn(),mutateSessionContextParents:vi.fn()}))
import { readSessionContextRevisions,writeSessionContextRevision,mutateSessionContextParents } from '../session-context-revisions.js'
import { createDbEpisodicStore } from '../episodic-store.js'
const store=createDbEpisodicStore(),read=vi.mocked(readSessionContextRevisions),write=vi.mocked(writeSessionContextRevision),mutate=vi.mocked(mutateSessionContextParents)
const execution=createExecutionContext({identity:{kind:'attended',principal:{kind:'workspace_member',userId:'actor-1'}},ownership:{kind:'workspace',workspaceId:'workspace-1'},
  access:{workspaceId:'workspace-1',userId:'actor-1',assistantId:'assistant-1',assistantKind:'standard',clearance:'internal',compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:['assistant-1']},
  writeDefaults:{compartments:[],projectIds:[]},authority:{async assertCurrent(){},async execute(operation){return operation()}},
  lifecycle:{abortSignal:new AbortController().signal,sessionId:'session-1',channelType:'web',channelId:'channel-1'}})
const authority={execution,accumulator:new ContextScopeAccumulator()}
const span={fromSequence:1,toSequence:8,turnCount:4}
function row(over:Partial<SessionContextRevision>={}):SessionContextRevision {
  const source={workspaceId:'workspace-1',userId:null,assistantId:null,sensitivity:'internal' as const,compartments:[],projectIds:[],resourceKind:'session_context_revision',resourceId:over.id??'revision-1',version:'1'}
  return bindScopeSource({id:'revision-1',parentId:'episode-1',sessionId:'session-1',source,content:{topicLabel:'fictional-topic',summary:'Fictional summary',messageSpan:span,entityRefs:null},
    userId:'actor-1',assistantId:'assistant-1',createdAt:new Date('2026-05-15'),lastAccessedAt:new Date('2026-05-15'),accessCount:0,survivalCount:0,...over},source)
}
beforeEach(()=>{vi.resetAllMocks();read.mockResolvedValue([]);mutate.mockResolvedValue(0)})
describe('[COMP:memory/episodic-store] admitted revision adapter',()=>{
  it('marshals the complete semantic payload and retains bound evidence',async()=>{
    const revision=row({content:{topicLabel:'fictional-topic',summary:'Fictional summary',messageSpan:span,entityRefs:['entity-1']}});write.mockResolvedValue(revision)
    const derivation={producer:'fixture:episode',sources:[revision.source]}
    const rec=await store.create({userId:'actor-1',assistantId:'assistant-1',sessionId:'session-1',topicLabel:'fictional-topic',summary:'Fictional summary',messageSpan:span,entityRefs:['entity-1'],authority,derivation})
    expect(rec.messageSpan).toEqual(span);expect(rec.entityRefs).toEqual(['entity-1']);expect(rec.survivalCount).toBe(0)
    expect(boundScopeSources(rec)).toEqual([revision.source])
    expect(write).toHaveBeenCalledWith({sessionId:'session-1',kind:'episodic_memory',content:revision.content,authority,derivation})
  })
  it('uses null entity references when none are supplied',async()=>{
    write.mockResolvedValue(row())
    await store.create({userId:'actor-1',assistantId:'assistant-1',sessionId:'session-1',topicLabel:'fictional-topic',summary:'Fictional summary',messageSpan:span,authority,derivation:{producer:'fixture:episode',sources:[]}})
    expect(write.mock.calls[0][0].content.entityRefs).toBeNull()
  })
  it('matches topics only among admitted entries and defaults to the three most recently accessed',async()=>{
    const rows=[1,2,3,4].map(n=>row({id:`revision-${n}`,parentId:`episode-${n}`,lastAccessedAt:new Date(n*1000)}))
    read.mockResolvedValue([...rows,row({id:'other',content:{...rows[0].content,topicLabel:'other-topic'}})])
    const recs=await store.fetchByTopic({sessionId:'session-1',topicLabel:'fictional-topic',authority})
    expect(recs.map(r=>r.id)).toEqual(['episode-4','episode-3','episode-2']);expect(recs.every(r=>r.accessCount===1)).toBe(true)
    expect(boundScopeSources(recs[0])).toEqual(boundScopeSources(rows[3]))
    expect(mutate).toHaveBeenCalledWith(authority,'episodic_memory',[rows[3],rows[2],rows[1]],'access')
  })
  it('honors an explicit topic limit',async()=>{
    read.mockResolvedValue([row(),row({id:'revision-2',parentId:'episode-2'})])
    expect(await store.fetchByTopic({sessionId:'session-1',topicLabel:'fictional-topic',limit:1,authority})).toHaveLength(1)
  })
  it('fetches the newest fifty admitted session records by default',async()=>{
    read.mockResolvedValue(Array.from({length:51},(_,n)=>row({id:`revision-${n}`,parentId:`episode-${n}`,createdAt:new Date(n*1000)})))
    const rows=await store.fetchBySession({sessionId:'session-1',authority});expect(rows).toHaveLength(50);expect(rows[0].id).toBe('episode-50')
  })
  it('enumerates distinct admitted labels newest first with the topic limit',async()=>{
    read.mockResolvedValue([row(),row({id:'new',createdAt:new Date('2026-05-16'),content:{...row().content,topicLabel:'new-topic'}}),row({id:'duplicate'})])
    expect(await store.listTopicsBySession({sessionId:'session-1',authority})).toEqual(['new-topic','fictional-topic'])
    expect(await store.listTopicsBySession({sessionId:'session-1',authority,limit:1})).toEqual(['new-topic'])
  })
  it('lists all admitted rows oldest first without changing access counters',async()=>{
    read.mockResolvedValue([row(),row({id:'old',parentId:'old',createdAt:new Date('2026-05-10')})])
    expect((await store.listBySession('session-1',authority)).map(r=>r.id)).toEqual(['old','episode-1']);expect(mutate).not.toHaveBeenCalled()
  })
  it('deletes only the matched admitted parent with its original authority',async()=>{
    const value=row();read.mockResolvedValue([value]);await store.deleteById(value.parentId,authority)
    expect(mutate).toHaveBeenCalledWith(authority,'episodic_memory',[value],'delete')
  })
  it('does no work for an empty survival list',async()=>{await store.incrementSurvivalCount([]);expect(read).not.toHaveBeenCalled();expect(mutate).not.toHaveBeenCalled()})
  it('increments only the admitted selected parents',async()=>{
    const first=row(),other=row({id:'other',parentId:'other'});read.mockResolvedValue([first,other]);await store.incrementSurvivalCount([first.parentId],authority)
    expect(mutate).toHaveBeenCalledWith(authority,'episodic_memory',[first],'survive')
  })
})
