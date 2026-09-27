import { describe, expect, it, vi } from 'vitest'
import type { MemoryRecord, MemoryStore } from '../../memory/types.js'
import { runLightConsolidation, runREMConsolidation, runTeamLightConsolidation } from '../phases.js'

function row(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id,workspaceId: 'workspace-a',userId: 'user-a',assistantId: 'assistant-a',scopeVersion: '1',
    scope: 'shared',summary: 'A repeated process fact',detail: 'Input detail',confidence: 0.8,
    tags: ['process'],sensitivity: 'internal',compartments: ['team:product'],projectIds: [],...overrides }
}
function fixture(rows: MemoryRecord[]) {
  const creates = vi.fn(async (input: Parameters<MemoryStore['create']>[0]) => row('created',input))
  const update = vi.fn(async (id: string, patch: Parameters<MemoryStore['update']>[1]) => ({ ...rows.find(r => r.id === id)!,...patch,id: `${id}-new` }))
  const store = {
    getIndexSystem: async () => rows,getWorkspaceIndexSystem: async () => rows,
    getByIdSystem: async (id: string) => rows.find(r => r.id === id) ?? null,
    create: creates,update,deleteMemory: vi.fn(),logConsolidation: vi.fn(),logWorkspaceConsolidation: vi.fn(),
  } as unknown as MemoryStore
  return { store, creates, update }
}
const batch = (prefix: string, overrides: Partial<MemoryRecord> = {}) => Array.from({ length: 15 },(_, i) => row(
  `${prefix}${String(i).padStart(4,'0')}-0000-4000-8000-000000000000`,
  { summary: `${prefix} input ${i}`,tags: [['process','project','decision'][i % 3]],...overrides },
))
const pattern = (inputs: MemoryRecord[]) => `SUMMARY: Reusable department pattern\nDETAIL: A derived process\nCONNECTS: ${inputs[0].id.slice(0,8)}, ${inputs[1].id.slice(0,8)}`

describe('[COMP:consolidation/department-isolation] full source envelopes', () => {
  it('A03 Light never merges semantic duplicates across any scope dimension', async () => {
    for (const differing of [
      { workspaceId: 'workspace-b' }, { userId: 'user-b' }, { assistantId: 'assistant-b' },
      { sensitivity: 'confidential' as const },{ compartments: ['team:finance'] },{ projectIds: ['project-b'] },
    ]) {
      const f = fixture([row('a'),row('b',differing)])
      await runLightConsolidation(f.store,'assistant-a','user-a')
      await runTeamLightConsolidation(f.store,'assistant-a','workspace-a')
      expect(f.update).not.toHaveBeenCalled()
    }
  })

  it('A02 compatible departmental Light merges record both source snapshots', async () => {
    const f = fixture([row('a'),row('b',{ detail: 'Additional detail' })])
    await runLightConsolidation(f.store,'assistant-a','user-a')
    expect(f.update).toHaveBeenCalledWith('a',expect.objectContaining({
      detail: 'Input detail\nAdditional detail',
      derivation: { producer: 'consolidation:light',sources: [expect.objectContaining({ resourceId: 'a',version: '1' }),expect.objectContaining({ resourceId: 'b',version: '1' })] },
    }))
    expect(f.update).toHaveBeenCalledWith('b',{ confidence: 0 })
  })

  it('A03 routine REM uses separate model calls for department buckets', async () => {
    const product = batch('aaaa'),finance = batch('bbbb',{ compartments: ['team:finance'] })
    const f = fixture([...product,...finance])
    const prompts: string[] = []
    await runREMConsolidation(f.store,'assistant-a','user-a',async prompt => {
      prompts.push(prompt)
      return pattern(prompt.includes('aaaa input') ? product : finance)
    })
    expect(prompts).toHaveLength(2)
    for (const prompt of prompts) expect(prompt.includes('aaaa input') && prompt.includes('bbbb input')).toBe(false)
    expect(f.creates).toHaveBeenCalledTimes(2)
    expect(f.creates.mock.calls.map(([p]) => p.compartments)).toEqual([['team:product'],['team:finance']])
  })

  it('A04 includes uncited examples in evidence and never trusts citations to lower scope', async () => {
    const inputs = batch('aaaa',{ sensitivity: 'confidential',projectIds: ['project-a'] })
    const example = row('dddd0000-0000-4000-8000-000000000000',{ tags: ['consolidation:rem'],summary: 'A different previous pattern',sensitivity: 'confidential',projectIds: ['project-a'] })
    const f = fixture([...inputs,example])
    await runREMConsolidation(f.store,'assistant-a','user-a',async () => pattern(inputs))
    const created = f.creates.mock.calls[0][0]
    expect(created).toMatchObject({ sensitivity: 'confidential',compartments: ['team:product'],projectIds: ['project-a'] })
    expect(created.derivation?.sources).toHaveLength(16)
    expect(created.derivation?.sources.map(s => s.resourceId)).toContain(example.id)
  })

  it('A04 withholds missing labels before the model sees any input', async () => {
    const inputs = batch('aaaa').map(memory => { delete memory.compartments; return memory })
    const f = fixture(inputs), model = vi.fn(), onEvent = vi.fn()
    const result = await runREMConsolidation(f.store,'assistant-a','user-a',model,{ onEvent })
    expect(model).not.toHaveBeenCalled()
    expect(f.creates).not.toHaveBeenCalled()
    expect(result.summary).toContain('scope_evidence_missing')
    expect(onEvent).toHaveBeenCalledWith({ type: 'scope_withheld',reason: 'scope_evidence_missing',count: 15 })
  })

  it('does not remove a memory on the strength of an unclassified KB summary', async () => {
    const f = fixture([row('a')]), onEvent = vi.fn()
    await runLightConsolidation(f.store,'assistant-a','user-a',{ knowledgeSummaries: [{ summary: 'A repeated process fact' }],onEvent })
    expect(f.update).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith({ type: 'scope_withheld',reason: 'scope_evidence_missing',count: 1 })
  })
})
