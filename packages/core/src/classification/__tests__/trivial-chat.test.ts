import {describe,expect,it} from 'vitest'
import {isTrivialChatMessage} from '../trivial-chat.js'

describe('[COMP:classification/trivial-chat] conservative conversation allowlist',()=>{
 it.each(['test',' PING! ','pong','hello there','thanks.','I’m here.','你好','ありがとう'])('recognizes %s',text=>{
  expect(isTrivialChatMessage(text)).toBe(true)
 })
 it.each(['','test my API','ping example.com','compare prices','yes, book it','no reminders tomorrow','你好，幫我搵資料','test'+'!'.repeat(41)])('preserves substantive or unknown input %s',text=>{
  expect(isTrivialChatMessage(text)).toBe(false)
 })
})
