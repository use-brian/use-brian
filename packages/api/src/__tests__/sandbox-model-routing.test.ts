/**
 * §4.14 / computer-use.md §6 — model routing for the computer-use legs:
 *
 *  1. Every leg resolves through the EXISTING tier router (resolveModel),
 *     with the orchestrator pinned to the top agentic tier.
 *  2. Grep invariant: no model id string appears anywhere in the sandbox
 *     module (`packages/core/src/sandbox/`) — the router file is the only
 *     place model ids may live.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MODEL_MAP, SANDBOX_LEG_TIERS, resolveSandboxModel } from '../model-resolution.js'

describe('[COMP:sandbox/model-routing] Sandbox legs ride the tier router (§4.14)', () => {
  it('pins the orchestrator to the top agentic tier and the grounding/leaf legs to the cheap tier', () => {
    expect(SANDBOX_LEG_TIERS.orchestrator).toBe('max')
    expect(resolveSandboxModel('orchestrator', 'max_5x')).toBe(MODEL_MAP.max)
    expect(resolveSandboxModel('browserGrounding', 'max_5x')).toBe(MODEL_MAP.standard)
    expect(resolveSandboxModel('leaf', 'max_5x')).toBe(MODEL_MAP.standard)
  })

  it('honors plan allowances and budget downgrades exactly like chat', () => {
    // Free plan may not use Max — the router downgrades, it never bypasses.
    expect(resolveSandboxModel('orchestrator', 'free')).toBe(MODEL_MAP.standard)
    // Budget exhaustion forces Standard on any leg.
    expect(resolveSandboxModel('orchestrator', 'max_5x', 'downgraded')).toBe(MODEL_MAP.standard)
  })

  it('grep invariant: no model id is hardcoded anywhere in the sandbox module', () => {
    const sandboxDir = resolve(import.meta.dirname, '../../../core/src/sandbox')
    const offenders: string[] = []
    const MODEL_ID_PATTERN = /gemini-|claude-|gpt-[34o]|grok-|deepseek|kimi|qwen|flash-lite|3\.5-flash/i

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry === '__tests__') continue // tests may name models in fixtures
          walk(full)
          continue
        }
        if (!entry.endsWith('.ts')) continue
        const source = readFileSync(full, 'utf8')
        if (MODEL_ID_PATTERN.test(source)) offenders.push(full)
      }
    }
    walk(sandboxDir)
    expect(offenders).toEqual([])
  })
})
