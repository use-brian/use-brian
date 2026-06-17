/**
 * MCP tool classification.
 *
 * Keyword heuristic that classifies external tools as read/write/destructive.
 * ~10 lines regex, following Claude Code's fail-closed pattern.
 */

export type ToolClassification = 'read' | 'write' | 'destructive' | 'unknown'

const READ_PATTERNS = /^(get|list|search|find|read|fetch|query|show|describe|count|check)/i
const WRITE_PATTERNS = /^(create|add|set|update|post|send|save|put|edit|modify|insert|upload)/i
const DESTRUCTIVE_PATTERNS = /^(delete|remove|drop|destroy|clear|purge|reset|revoke|cancel|terminate)/i

/**
 * Classify an MCP tool by its name and description.
 * Fail-closed: unknown tools default to 'unknown' (treated as write).
 */
export function classifyTool(name: string, description?: string): ToolClassification {
  const combined = `${name} ${description ?? ''}`

  if (DESTRUCTIVE_PATTERNS.test(name)) return 'destructive'
  if (WRITE_PATTERNS.test(name)) return 'write'
  if (READ_PATTERNS.test(name)) return 'read'

  // Check description for hints
  if (description) {
    if (/delet|remov|destroy|purg/i.test(description)) return 'destructive'
    if (/creat|updat|modif|send|writ/i.test(description)) return 'write'
    if (/retriev|fetch|list|search|read|get/i.test(description)) return 'read'
  }

  return 'unknown'
}

/**
 * Default policy based on classification.
 * Fail-closed: unknown = ask (confirm before executing).
 */
export function defaultPolicy(classification: ToolClassification): 'allow' | 'ask' | 'block' {
  switch (classification) {
    case 'read': return 'allow'
    case 'write': return 'ask'
    case 'destructive': return 'block'
    case 'unknown': return 'ask'
  }
}
