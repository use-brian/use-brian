import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('[COMP:api/decision-playbook-context] prompt-path wiring', () => {
  it('routes every interactive prompt family through the scoped loader', () => {
    for (const relative of ['../chat.ts', '../channel-pipeline.ts', '../public-turn.ts']) {
      const text = source(relative)
      expect(text).toContain("from '../decision-learning/playbook-context.js'")
      expect(text.match(/loadDecisionPlaybookContext\s*\(/g)).toHaveLength(1)
      expect(text).not.toMatch(/listActivePlaybookRules\s*\(/)
    }
  })

  it('keeps application ids out of prompt text and freezes the exact id on approvals', () => {
    const chat = source('../chat.ts')
    expect(chat).toContain('playbookRules = decisionPlaybookContext.playbookRules')
    expect(chat).toContain('{ decisionApplicationId: decisionPlaybookContext.decisionApplicationId }')
    expect(chat).not.toContain('playbookRules: decisionPlaybookContext.appliedRuleIds')
  })

  it('loads scoped rules for workflow assistant calls and returns attribution out of band', () => {
    const executor = source('../../inter-assistant/executor.ts')
    const boot = source('../../boot.ts')
    expect(executor).toContain("operationKind: 'workflow_assistant_call'")
    expect(executor).toContain('params.onDecisionApplication?.(playbook.decisionApplicationId)')
    expect(boot).toContain("name: 'decision-playbook-application'")
    expect(boot).toContain('data: { applicationId: decisionApplicationId }')
  })
})
