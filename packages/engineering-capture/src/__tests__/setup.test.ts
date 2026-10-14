import {describe,it,expect} from 'vitest'
import {setupPlan,scopeMatches,CollectorConfigSchema} from '../setup.js'
describe('[COMP:engineering-capture/collector] observe-only setup',()=>{
 it.each(['codex','claude-code'])('EH13 preserves unrelated hooks and emits no control/trust bypass',provider=>{
  const existing={description:'Existing hooks',hooks:{Stop:[{hooks:[{type:'command',command:'existing-hook'}]}],PreToolUse:[{matcher:'Bash',hooks:[]}]}}
  const result=setupPlan({version:1,provider,endpoint:'https://brain.example/api/brain/mcp',credentialEnv:'BRAIN_CAPTURE_KEY',project:'/workspace/example-project'},'/outside-repository/capture.json',existing)
  expect((result.hookConfiguration.hooks.Stop as unknown[])).toHaveLength(2);expect(result.hookConfiguration.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse)
  const encoded=JSON.stringify(result);expect(encoded).not.toContain('bypass-hook-trust');expect(JSON.stringify(result.hookConfiguration)).not.toContain('\"decision\"');expect(encoded).not.toContain('additionalContext')
  expect(existing.hooks.Stop).toHaveLength(1)
 })
 it('EH13 requires explicit scope and credential reference, rejects secret-bearing endpoint configuration',()=>{
  const base={version:1,provider:'codex',endpoint:'https://brain.example/api/brain/mcp',credentialEnv:'BRAIN_CAPTURE_KEY'}
  expect(CollectorConfigSchema.safeParse(base).success).toBe(false)
  expect(CollectorConfigSchema.safeParse({...base,project:'/workspace/example-project',endpoint:'https://secret@brain.example/api/brain/mcp'}).success).toBe(false)
  const c=CollectorConfigSchema.parse({...base,project:'/workspace/example-project'})
  expect(scopeMatches(c,'/workspace/example-project/src','s')).toBe(true);expect(scopeMatches(c,'/workspace/example-project-other','s')).toBe(false)
 })
})
