import { describe, it, expect } from 'vitest'
import { ASSISTANT_PROFILES, assistantProfileById } from '../assistant-profiles.js'
import { CHARTER_FIELD_LIMITS } from '../assistant-charter.js'

describe('[COMP:shared/assistant-profiles] Assistant profile registry', () => {
  it('every profile carries the growth-loop inputs: a mission and a success rubric', () => {
    for (const p of ASSISTANT_PROFILES) {
      expect(p.charter.mission, `${p.id} mission`).toBeTruthy()
      expect(p.charter.success, `${p.id} success`).toBeTruthy()
    }
  })

  it('ids are unique and lookup works, unknown ids return null', () => {
    const ids = ASSISTANT_PROFILES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(assistantProfileById('support')?.emoji).toBeTruthy()
    expect(assistantProfileById('nope-not-a-profile')).toBeNull()
  })

  it('every seed respects the charter field caps', () => {
    for (const p of ASSISTANT_PROFILES) {
      for (const field of ['mission', 'audience', 'success', 'instructions'] as const) {
        const value = p.charter[field]
        if (!value) continue
        expect(value.length, `${p.id}.${field}`).toBeLessThanOrEqual(CHARTER_FIELD_LIMITS[field])
      }
    }
  })

  it('charter seeds are tool-agnostic (the tool-awareness rule, mechanically)', () => {
    // The charter renders into the system prompt verbatim, and the owner may
    // have none of these connected — a profile must never name a tool,
    // service, or connector. Mirrors the verify grep in root CLAUDE.md →
    // "Tool-awareness rule".
    const banned = /\b(gmail|google|notion|calendar|slack|telegram|whatsapp|shopify|discord|mcp_|imap)\b/i
    for (const p of ASSISTANT_PROFILES) {
      for (const field of ['mission', 'audience', 'success', 'instructions'] as const) {
        const value = p.charter[field]
        if (!value) continue
        expect(value, `${p.id}.${field} names a tool/service`).not.toMatch(banned)
      }
    }
  })

  it('every profile carries English fallback card strings and an emoji', () => {
    for (const p of ASSISTANT_PROFILES) {
      expect(p.fallbackTitle.length).toBeGreaterThan(0)
      expect(p.fallbackTagline.length).toBeGreaterThan(0)
      expect(p.emoji.length).toBeGreaterThan(0)
    }
  })
})
