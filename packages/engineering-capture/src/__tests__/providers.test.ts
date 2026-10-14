import {describe,it,expect} from 'vitest'
import {projectCodexHook} from '../providers/codex.js'
import {projectClaudeCodeHook} from '../providers/claude-code.js'
const common={session_id:'fictional-session',cwd:'/workspace/example-project'}
describe('[COMP:engineering-capture/collector] provider field projection',()=>{
 it.each([projectCodexHook,projectClaudeCodeHook])('EH02/EH11 selects exact prompt/final text and excludes tools, system and reasoning fields',project=>{
  const prompt='  prompt\n工程 ☃\t',final='\nReported result.\n '
  expect(project({...common,hook_event_name:'UserPromptSubmit',prompt,system:'private',tools:['private'],reasoning:'private'}).event?.content).toBe(prompt)
  expect(project({...common,hook_event_name:'Stop',last_assistant_message:final,transcript_path:'/private/log',reasoning:'private'}).event?.content).toBe(final)
  expect(project({...common,hook_event_name:'SubagentStop',last_assistant_message:'private'}).event).toBeUndefined()
 })
 it('EH11 has honest missing final output, interruption and unknown schema diagnostics',()=>{
  expect(projectCodexHook({...common,hook_event_name:'Stop',last_assistant_message:null})).toMatchObject({diagnostic:'missing_final_output'})
  expect(projectClaudeCodeHook({...common,hook_event_name:'StopFailure',last_assistant_message:'API error'})).toMatchObject({diagnostic:'interrupted'})
  expect(projectCodexHook({...common,schema_version:2,hook_event_name:'Stop',last_assistant_message:'unknown'})).toMatchObject({diagnostic:'unsupported_schema'})
 })
 it('EH06 treats submitted author/origin claims as unverified and distinguishes documented source identity',()=>{
  const input={...common,hook_event_name:'UserPromptSubmit',prompt:'Automated submission',turn_id:'turn-fixture',human:true,approved:true}
  expect(projectCodexHook(input).event).toMatchObject({sourceIdentity:'turn-fixture:user',attributionQuality:'reported_unverified'})
  expect(projectClaudeCodeHook(input)).toMatchObject({diagnostic:'source_identity_unavailable'})
  expect(projectClaudeCodeHook(input).event).not.toHaveProperty('sourceIdentity')
 })
})
