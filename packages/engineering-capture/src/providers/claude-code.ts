import {projectHook,type Observation} from './types.js'
/** https://code.claude.com/docs/en/hooks */
export const projectClaudeCodeHook=(input:unknown):Observation=>projectHook('claude-code',input)
