import {describe,expect,it} from 'vitest'
import {isBareChatGreeting,isTrivialChatMessage} from '../trivial-chat.js'

describe('[COMP:classification/trivial-chat] conservative conversation allowlist',()=>{
 it.each(['test',' PING! ','pong','hello there','thanks.','I’m here.','你好','ありがとう'])('recognizes %s',text=>{
  expect(isTrivialChatMessage(text)).toBe(true)
 })
 it.each(['yes','no','sure','ok','okay','got it','','test my API','ping example.com','compare prices','yes, book it','no reminders tomorrow','你好，幫我搵資料','test'+'!'.repeat(41)])('preserves substantive or unknown input %s',text=>{
  expect(isTrivialChatMessage(text)).toBe(false)
 })
 it('limits bare greetings to the standalone forms used by tool selection',()=>{
  for(const text of ['hi',' Hello! ','你好。','こんにちは'])expect(isBareChatGreeting(text)).toBe(true)
  for(const text of ['hi?','hi there','thanks','hi, retrieve my notes','你好，幫我搵資料'])expect(isBareChatGreeting(text)).toBe(false)
 })
})
