import { runWithAgentAccess } from '../agent-access-context.js'
import { describe, expect, it } from 'vitest'
import { buildAccessPredicate } from '../access-predicate.js'
import { buildMemoryAccessPredicate } from '../memory-access-predicate.js'

const ordinary = {
  workspaceId: 'ws-1',
  userId: 'user-a',
  assistantId: 'assistant-studio',
  assistantKind: 'standard' as const,
  clearance: 'public' as const,
  compartments: [] as string[],
}

describe('[COMP:brain/client-self-memory] memory access predicate', () => {
  it('adds holding protection without changing the ordinary authority parameters', () => {
    const predicate = buildMemoryAccessPredicate(ordinary)
    const universal = buildAccessPredicate(ordinary)
    expect(predicate.params.slice(0,universal.params.length)).toEqual(universal.params)
    expect(predicate.sql).toContain(`(${universal.sql}) AND scope_held = false AND public.application_memory_field_ancestry_allows(workspace_id,id,scope_version::text)`)
    expect(predicate.sql).toContain('public.memory_learning_allows(learning,')
    expect(predicate.sql).toContain('learning_exception')
  })

  it('adds one exact internal self branch without widening the ordinary ceiling', () => {
    const predicate = buildMemoryAccessPredicate({
      ...ordinary,
      clientSelfMemory: { compartment: 'client:studio-client:alice' },
    }, { alias: 'm', startIdx: 2 })

    expect(predicate.sql).toContain('sensitivity_rank(m.sensitivity) <= sensitivity_rank($5)')
    expect(predicate.sql).toContain('m.compartments <@ $6::text[]')
    expect(predicate.sql).toContain(' OR ')
    expect(predicate.sql).toContain('m.workspace_id = $17')
    expect(predicate.sql).toContain('m.user_id = $18')
    expect(predicate.sql).toContain('m.assistant_id = $19')
    expect(predicate.sql).toContain('sensitivity_rank(m.sensitivity) <= sensitivity_rank($20)')
    expect(predicate.sql).toContain('m.compartments = ARRAY[$21]::text[]')
    expect(predicate.params.slice(-5)).toEqual([
      'ws-1',
      'user-a',
      'assistant-studio',
      'internal',
      'client:studio-client:alice',
    ])
    expect(predicate.nextIdx).toBe(22)
    expect(predicate.sql).toMatch(/\) AND m\.scope_held = false AND public\.application_memory_field_ancestry_allows\(m\.workspace_id,m\.id,m\.scope_version::text\)/)
  })

  it('refuses an operator compartment in the client-only branch', () => {
    expect(() => buildMemoryAccessPredicate({
      ...ordinary,
      clientSelfMemory: { compartment: 'sales' },
    })).toThrow(/client:/)
  })
})


describe('[COMP:brain/client-self-memory] delegated visibility',()=>{
  it('fences both ordinary and self-memory branches under an inherited visibility ceiling',()=>{
    runWithAgentAccess({workspaceId:'ws-1',userId:'other-actor',clearance:'internal',compartments:null,visibilityAssistantIds:[]},()=>{
      const result=buildMemoryAccessPredicate({...ordinary,clientSelfMemory:{compartment:'client:fixture'}})
      expect(result.sql.match(/assistant_id = ANY/g)).toHaveLength(4)
      expect(result.params.slice(-2)).toEqual(['other-actor',[]])
    })
  })
})


describe('[COMP:memory/learning] semantic reads and review',()=>{
  it('binds semantic context separately from the audience and never disables holding',()=>{
    const p=buildMemoryAccessPredicate({...ordinary,memoryContext:{activity:'client_report'}})
    expect(p.params).toContain('{"activity":"client_report"}')
    expect(p.sql).toContain('learning_exception.learning')
    const review=buildMemoryAccessPredicate({...ordinary,memoryReview:true})
    expect(review.sql).not.toContain('memory_learning_allows')
    expect(review.sql).toContain('scope_held = false')
    expect(review.params).toEqual(buildAccessPredicate(ordinary).params)
  })
})
