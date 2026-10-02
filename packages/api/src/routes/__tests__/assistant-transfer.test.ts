import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
vi.mock('../../db/client.js', () => ({ query: vi.fn(), queryWithRLS: vi.fn(), getPool: vi.fn() }))
vi.mock('../../db/assistant-transfer-admission.js', () => ({ previewAssistantTransfer: vi.fn() }))
vi.mock('../../db/memories.js', () => ({ countWorkspaceMemories: vi.fn(), deleteWorkspaceMemories: vi.fn(),
  transferWorkspaceMemories: vi.fn(), countUnverifiedByWorkspace: vi.fn(), listUnverifiedByWorkspace: vi.fn() }))
import { workspaceRoutes } from '../workspaces.js'
import { previewAssistantTransfer } from '../../db/assistant-transfer-admission.js'
import { countWorkspaceMemories, deleteWorkspaceMemories } from '../../db/memories.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
const actor = '11111111-1111-4111-8111-111111111111'
const workspace = '22222222-2222-4222-8222-222222222222'
const assistant = '33333333-3333-4333-8333-333333333333'
const department = '44444444-4444-4444-8444-444444444444'
const store = { getRole: vi.fn(), adoptAssistant: vi.fn(), removeAssistant: vi.fn() }
const app = () => createTestApp('/api/workspaces', workspaceRoutes({ workspaceStore: store as never }), { userId: actor })
const url = (op: string) => `/api/workspaces/${workspace}/assistants/${assistant}/${op}`
beforeEach(() => { vi.resetAllMocks(); store.getRole.mockResolvedValue('admin') })
describe('assistant transfer HTTP boundary', () => {
  it.each(['delete', 'keep'])('rejects force:%s before any memory side effect or admission', async force => {
    const res = await request(app()).post(url('remove')).send({ force })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('assistant_transfer_review_required')
    expect(countWorkspaceMemories).not.toHaveBeenCalled()
    expect(deleteWorkspaceMemories).not.toHaveBeenCalled()
    expect(store.removeAssistant).not.toHaveBeenCalled()
  })
  it.each(['adopt', 'remove'])('%s forwards validated department and preview revision and preserves policy errors', async op => {
    const method = op === 'adopt' ? store.adoptAssistant : store.removeAssistant
    method.mockRejectedValueOnce(new WorkspaceAccessError('access_policy_conflict', 409))
    const res = await request(app()).post(url(op)).send({ departmentId: department, expectedPolicyRevision: '12' })
    expect(method).toHaveBeenCalledWith(actor, workspace, assistant, department, '12')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('access_policy_conflict')
    expect(deleteWorkspaceMemories).not.toHaveBeenCalled()
  })
  it.each([{}, { expectedPolicyRevision: '0' }, { expectedPolicyRevision: '1', departmentId: 'bad' },
    { expectedPolicyRevision: '1', provenance: 'trusted' }])('rejects invalid/unreviewed selections: %j', async body => {
    expect((await request(app()).post(url('adopt')).send(body)).status).toBe(400)
    expect(store.adoptAssistant).not.toHaveBeenCalled()
  })
  it.each(['adopt', 'remove'])('%s previews with the authenticated actor', async op => {
    vi.mocked(previewAssistantTransfer).mockResolvedValueOnce({ destinationWorkspaceId: workspace, policyRevision: '9',
      mode: 'departments', setupState: 'ready', defaultDepartmentId: department, departments: [{ id: department, name: 'Default' }],
      canTransfer: false, reason: 'assistant_transfer_certification_required' })
    const res = await request(app()).post(url(`${op}/preview`)).send({})
    expect(res.status).toBe(200)
    expect(previewAssistantTransfer).toHaveBeenCalledWith(actor, workspace, assistant, op)
    expect(res.body).toMatchObject({ policyRevision: '9', canTransfer: false })
  })
})
