import {projectHook,type Observation} from './types.js'
/** https://learn.chatgpt.com/docs/hooks */
export const projectCodexHook=(input:unknown):Observation=>projectHook('codex',input)
