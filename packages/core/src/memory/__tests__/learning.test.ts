import { describe, expect, it } from 'vitest'
import { memoryActivityFromText, countIndependentMemoryEvidence, deriveMemoryLearning, memoryIsEligible, memoryLearningSchema, memoryLearningProposalSchema, proposeMemoryLearning } from '../learning.js'
const now = new Date('2026-10-01T00:00:00Z')
const established = memoryLearningSchema.parse({ version:1, state:'established', origin:'explicit' })
const observation = { messageId:'m',sessionId:'s',userId:'u',text:'I prefer concise answers.' }
const proposal = (value: Record<string, unknown>) => memoryLearningProposalSchema.parse({intent:'inferred',quote:observation.text,...value})
describe('[COMP:memory/learning] gradual memory policy', () => {
  it('keeps one-off instructions out of durable storage', () => {
    expect(() => proposeMemoryLearning(proposal({intent:'one_off'}),observation,now)).toThrow('memory_one_off')
  })
  it('admits authenticated direct preference but keeps quoted and ungrounded claims tentative', () => {
    expect(proposeMemoryLearning(proposal({intent:'explicit'}),observation,now).state).toBe('established')
    const quoted = {...observation,text:'A colleague said: I prefer concise answers.'}
    expect(proposeMemoryLearning(proposal({intent:'explicit',quote:quoted.text}),quoted,now).state).toBe('candidate')
    expect(() => proposeMemoryLearning(proposal({intent:'explicit'}),undefined,now)).toThrow('memory_source_mismatch')
  })
  it('counts independent recent events, never replays or future observations', () => {
    const event = {eventId:'1',root:'a',at:now.toISOString(),relation:'supports' as const}
    expect(countIndependentMemoryEvidence([event,event,event],now).eligible).toBe(false)
    expect(countIndependentMemoryEvidence([event,{...event,eventId:'2'},{...event,eventId:'3',root:'b'}],now).eligible).toBe(true)
    expect(countIndependentMemoryEvidence([event,{...event,eventId:'2'},{...event,eventId:'3',root:'b'},{...event,eventId:'4',relation:'contradicts'}],now).eligible).toBe(false)
    expect(countIndependentMemoryEvidence([event,{...event,eventId:'2',at:'2026-01-01Z'},{...event,eventId:'3',root:'b',at:'2027-01-01Z'}],now).eligible).toBe(false)
  })
  it('applies state, expiry and all context constraints before recall', () => {
    const scoped = {...established, applicability:{operation:'email' as const,operationKey:'account-a'},appliesUntil:'2026-10-02T00:00:00Z'}
    expect(memoryIsEligible(scoped,{},now)).toBe(false)
    expect(memoryIsEligible(scoped,{operation:'email',operationKey:'account-a'},now)).toBe(true)
    expect(memoryIsEligible(scoped,{operation:'email',operationKey:'account-a'},new Date(scoped.appliesUntil))).toBe(false)
    expect(memoryIsEligible({...established,state:'candidate'}, {}, now)).toBe(false)
    expect(memoryIsEligible({...established,state:'candidate'}, {}, now,true)).toBe(true)
    expect(memoryIsEligible(null,{},now)).toBe(true)
  })
  it('retains earliest expiry and refuses conflicting or tentative summary sources', () => {
    const timed = {...established,appliesUntil:'2026-10-02T00:00:00Z'}
    const contextual = {...established,applicability:{activity:'client_report' as const},appliesUntil:'2026-11-01T00:00:00Z'}
    expect(deriveMemoryLearning([timed,contextual])).toMatchObject({appliesUntil:timed.appliesUntil,applicability:contextual.applicability})
    expect(() => deriveMemoryLearning([contextual,{...established,applicability:{activity:'status_update'}}])).toThrow('memory_applicability_conflict')
    expect(() => deriveMemoryLearning([{...established,state:'candidate'}])).toThrow('memory_source_tentative')
  })
  it('does not count copied origins or extend retention for another observation in the same source group',()=>{
    const e={eventId:'1',root:'chat-a',aliases:['original-a'],at:now.toISOString(),rootStartedAt:'2026-09-10T00:00:00Z',relation:'supports' as const}
    const counts=countIndependentMemoryEvidence([e,{...e,eventId:'2',root:'chat-b'},{...e,eventId:'3',aliases:['original-b']}],now)
    expect(counts.events).toBe(2)
    expect(counts.eligible).toBe(false)
    expect(counts.lastIndependentSupportAt).toBe('2026-09-10T00:00:00.000Z')
  })

  it('selects bounded activities only for an affirmative current request',()=>{
    expect(memoryActivityFromText('Please draft a client report.')).toBe('client_report')
    expect(memoryActivityFromText('Write a status update.')).toBe('status_update')
    expect(memoryActivityFromText('Do not write a status update.')).toBeUndefined()
    expect(memoryActivityFromText('We discussed a client report yesterday.')).toBeUndefined()
  })
  it('retains each inferred source evidence group through summaries',()=>{
    const ids=['00000000-0000-4000-8000-000000000001']
    expect(deriveMemoryLearning([{...established,evidenceGroups:[ids]},established])?.evidenceGroups).toEqual([ids])
  })

})
