import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import { createWorkspaceMigrationTools } from '../migration-tools.js'
import { WorkspaceAccessError } from '../policy.js'
const mocks = vi.hoisted(() => ({ createMigrationPlan: vi.fn(), getMigrationPlan: vi.fn(), listMigrationPlans: vi.fn(), prepareMigrationItem: vi.fn(), getMigrationItemReview: vi.fn(), applyMigrationItem: vi.fn(), setMigrationPlanState: vi.fn(), getWorkspaceAccessMode: vi.fn() }))
vi.mock('../migration-service.js', async original => ({ ...await original<typeof import('../migration-service.js')>(), ...mocks }))
vi.mock('../mode-policy.js', () => ({ getWorkspaceAccessMode: mocks.getWorkspaceAccessMode }))
const id = '10000000-0000-4000-8000-000000000001'
const confirmation = Object.freeze({ type: 'access.command.apply', reviewId: id, payloadHash: 'a'.repeat(64) })
const item = { planId: id, itemId: id }
const proposal = { targetMode: 'simple', idempotencyKey: id, items: [{ command: { type: 'department.member.set', teamId: id, userId: id, enabled: true }, reason: 'Pilot' }] }
const context: ToolContext = { userId: 'billing-owner', workspaceActorUserId: 'verified-human', workspaceId: 'workspace', assistantId: 'assistant', sessionId: 'session', appId: 'app', channelType: 'web', channelId: 'web', abortSignal: new AbortController().signal }
beforeEach(() => { vi.resetAllMocks(); mocks.createMigrationPlan.mockResolvedValue({ id }); mocks.getMigrationPlan.mockResolvedValue({ id }); mocks.getMigrationItemReview.mockResolvedValue({ command: { type: 'department.member.set' }, changes: [{ field: 'Department', before: [{ value: 'None' }], after: [{ value: 'Research' }] }], expiresAt: '2030-01-01' }) })
describe('migration native tools', () => {
  it('uses the verified human, never the billing owner, across every operation', async () => {
    const [inspect, prepare, review, apply, manage] = createWorkspaceMigrationTools()
    await inspect.execute({}, context)
    expect(mocks.getWorkspaceAccessMode).toHaveBeenCalledWith('workspace', 'verified-human')
    expect(mocks.listMigrationPlans).toHaveBeenCalledWith('workspace', 'verified-human', undefined)
    await inspect.execute({ planId: id }, context)
    await prepare.execute(proposal, context)
    expect(mocks.createMigrationPlan).toHaveBeenCalledWith('workspace', 'verified-human', proposal)
    expect(mocks.getMigrationPlan).toHaveBeenCalledWith('workspace', 'verified-human', id)
    await review.execute(item, context)
    expect(mocks.prepareMigrationItem).toHaveBeenCalledWith('workspace', 'verified-human', id, id)
    expect(mocks.applyMigrationItem).not.toHaveBeenCalled()
    await apply.execute({ ...item, confirmation }, context)
    expect(mocks.applyMigrationItem).toHaveBeenCalledWith('workspace', 'verified-human', id, id, confirmation)
    await manage.execute({ planId: id, state: 'paused' }, context)
    expect(mocks.setMigrationPlanState).toHaveBeenCalledWith('workspace', 'verified-human', id, 'paused')
  })
  it('refuses billing-only/public, system-read and programmatic contexts before any service call', async () => {
    for (const patch of [{ workspaceActorUserId: undefined }, { systemRead: true }, { programmaticPrincipal: { kind: 'brain_key' as const, credentialId: 'key' } }, { workspaceId: undefined }]) {
      for (const tool of createWorkspaceMigrationTools()) {
        expect(await tool.execute({}, { ...context, ...patch })).toMatchObject({ isError: true, data: { error: 'admin_required' } })
        if (tool.describeConfirmation) await expect(tool.describeConfirmation({ ...item, confirmation }, { ...context, ...patch })).rejects.toThrow('admin_required')
      }
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled()
  })
  it('requires per-call confirmation for authority writes and describes only the immutable exact review', async () => {
    const [, , , apply, manage] = createWorkspaceMigrationTools()
    for (const tool of [apply, manage]) { expect(tool.requiresConfirmation).toBe(true); expect(tool.allowPersistentApproval).toBe(false); expect(tool.isReadOnly).toBe(false) }
    const input = Object.freeze({ ...item, confirmation })
    expect((await apply.describeConfirmation!(input, context))?.join(' ')).toContain('None → Research')
    expect(mocks.getMigrationItemReview).toHaveBeenCalledWith('workspace', 'verified-human', id, id, confirmation)
    expect(mocks.prepareMigrationItem).not.toHaveBeenCalled()
    expect(mocks.applyMigrationItem).not.toHaveBeenCalled()
    mocks.getMigrationItemReview.mockRejectedValueOnce(new WorkspaceAccessError('access_review_changed', 409))
    await expect(apply.describeConfirmation!(input, context)).rejects.toThrow('access_review_changed')
    mocks.getMigrationItemReview.mockResolvedValueOnce({ alreadyApplied: true })
    expect((await apply.describeConfirmation!(input, context))?.join(' ')).toContain('does not repeat')
  })
  it('describes the saved RESOURCE confirmation, without preparing or applying a replacement',async()=>{
    const [,prepare,,apply]=createWorkspaceMigrationTools()
    const command={type:'resource.scope',resourceKind:'memory',resourceId:id,action:'assign_team',targetTeamId:id}
    expect(prepare.inputSchema.safeParse({...proposal,items:[{command,reason:'Exact root'}]}).success).toBe(true)
    for(const change of [{resourceIds:[id]},{envelope:{}},{action:'release'},{targetTeamId:undefined}]){
      expect(prepare.inputSchema.safeParse({...proposal,items:[{command:{...command,...change},reason:'Exact root'}]}).success).toBe(false)
    }
    const proof={kind:'resource',reviewId:id,expectedVersion:'1',payloadHash:'a'.repeat(64),expiresAt:'2030-01-01T00:00:00.000Z'}
    mocks.getMigrationItemReview.mockResolvedValueOnce({kind:'resource',alreadyApplied:false,expiresAt:proof.expiresAt,review:{action:'assign_team',resourceKind:'memory',reason:'Exact root',targetTeamId:id,items:[{resourceId:id,impact:{version:2,descendants:[],dependents:{}}}]}})
    const lines=await apply.describeConfirmation!({...item,confirmation:proof},context)
    expect(lines?.join(' ')).toContain('Read and edit are distinct')
    expect(mocks.getMigrationItemReview).toHaveBeenCalledWith('workspace','verified-human',id,id,proof)
    expect(mocks.prepareMigrationItem).not.toHaveBeenCalled()
    expect(mocks.applyMigrationItem).not.toHaveBeenCalled()
    const {expiresAt:_,...incomplete}=proof
    expect(apply.inputSchema.safeParse({...item,confirmation:incomplete}).success).toBe(false)
  })
  it('rejects injected actors, raw mode changes and incomplete or altered confirmation shapes', () => {
    const [inspect, prepare, review, apply, manage] = createWorkspaceMigrationTools()
    for (const [tool, input] of [[inspect, {}], [prepare, proposal], [review, item], [apply, { ...item, confirmation }], [manage, { planId: id, state: 'paused' }]] as const) {
      expect(tool.inputSchema.safeParse(input).success).toBe(true)
      expect(tool.inputSchema.safeParse({ ...input, actorUserId: id }).success).toBe(false)
      expect(tool.inputSchema.safeParse({ mode: 'simple' }).success).toBe(false)
    }
    for (const input of [item, { ...item, confirmation: { ...confirmation, payloadHash: 'bad' } }, { ...item, confirmation: { ...confirmation, command: proposal.items[0].command } }]) expect(apply.inputSchema.safeParse(input).success).toBe(false)
  })
})
