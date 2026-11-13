import {describe,expect,it} from 'vitest'
import {sessionTopicGraduationPresentation} from '../session-context-revisions.js'

describe('episode graduation topic presentation',()=>{
 it('uses a neutral summary and tags for opaque identities',()=>{
  const key='topic:v2:'+'a'.repeat(64)
  const presentation=sessionTopicGraduationPresentation(key)
  expect(presentation).toEqual({summary:'Recurring topic from session history',tags:['episodic-graduation','recurring-topic']})
  expect(JSON.stringify(presentation)).not.toContain(key)
 })
 it('preserves human-readable legacy summaries and tags exactly',()=>{
  expect(sessionTopicGraduationPresentation('Travel planning')).toEqual({summary:'Recurring topic: Travel planning',tags:['episodic-graduation','Travel planning']})
 })
})
