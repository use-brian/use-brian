import {describe,expect,it} from 'vitest'
import {privateTranscriptText} from '../private-transcript.js'
describe('[COMP:api/private-transcript] historical upload identity',()=>{
 it('keeps a file-only user turn without importing the embedded body as current evidence',()=>{
  const text=privateTranscriptText([{type:'text',text:'<attached_file id="file-1" name="notes.txt" type="text/plain">SECRET_BODY</attached_file>'}],'user')
  expect(text).toContain('file-1');expect(text).toContain('notes.txt');expect(text).not.toContain('SECRET_BODY')
 })
 it('strips a file body split across text blocks and retains surrounding dialogue',()=>{
  const text=privateTranscriptText([{type:'text',text:'Please read <attached_file id="file-1" name="notes.txt">SECRET_'},
   {type:'text',text:'BODY</attached_file> and compare.'}],'user')
  expect(text).toContain('Please read');expect(text).toContain('and compare.');expect(text).toContain('file-1');expect(text).not.toContain('SECRET')
 })
 it('does not expose truncated headers or tool-result carriers',()=>{
  expect(privateTranscriptText('<attached_file id="file-1" SECRET','user')).toBeNull()
  expect(privateTranscriptText([{type:'text',text:'PRIVATE'},{type:'tool_result',toolUseId:'t',content:'PRIVATE'}],'user')).toBeNull()
 })
})
