/**
 * Unit tests for the class-level naming validator (S10).
 *
 * Six anti-pattern categories per spec — all must reject. Anything else
 * must accept. Empty / over-length cases test the bounds.
 */

import { describe, it, expect } from 'vitest'
import { validateClassLevelName } from '../class-name-validator.js'

describe('[COMP:skills/class-name-validator] validateClassLevelName', () => {
  it('accepts a clean class-level umbrella name', () => {
    const r = validateClassLevelName('weekly-status-update')
    expect(r.ok).toBe(true)
  })

  it('accepts a name with mixed case + plain English', () => {
    const r = validateClassLevelName('Customer Onboarding')
    expect(r.ok).toBe(true)
  })

  // ── 1. fix-* prefix ──

  it('rejects fix-* prefix with corrective reason', () => {
    const r = validateClassLevelName('fix-stripe-webhook-403')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/class of task/i)
      expect(r.reason).toMatch(/fix-/)
    }
  })

  it('rejects fix_* (underscore separator)', () => {
    const r = validateClassLevelName('fix_stripe_webhook')
    expect(r.ok).toBe(false)
  })

  it('rejects "Fix " (with space, mixed case)', () => {
    const r = validateClassLevelName('Fix stripe webhook')
    expect(r.ok).toBe(false)
  })

  // ── 2. debug-* prefix ──

  it('rejects debug-* prefix', () => {
    const r = validateClassLevelName('debug-oauth-redirect-loop')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/investigation/i)
  })

  // ── 3. audit-* prefix ──

  it('rejects audit-* prefix', () => {
    const r = validateClassLevelName('audit-permissions-2026')
    expect(r.ok).toBe(false)
  })

  // ── 4. today-* prefix ──

  it('rejects today-* prefix', () => {
    const r = validateClassLevelName('today-monitoring-followup')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/temporal|single day/i)
  })

  // ── 5. dated prefix (year) ──

  it('rejects names starting with a year', () => {
    expect(validateClassLevelName('2026-incident-response').ok).toBe(false)
    expect(validateClassLevelName('2025_onboarding_plan').ok).toBe(false)
    expect(validateClassLevelName('2024 retrospective').ok).toBe(false)
  })

  it('accepts a year that appears mid-name', () => {
    // Mid-name year is OK — e.g. "office-365-setup". The validator only
    // rejects when the year is the prefix.
    const r = validateClassLevelName('migrate-to-office-365')
    expect(r.ok).toBe(true)
  })

  // ── 6. PR-numbered ──

  it('rejects PR-numbered names', () => {
    expect(validateClassLevelName('pr-123-cleanup').ok).toBe(false)
    expect(validateClassLevelName('PR#42-retro').ok).toBe(false)
    expect(validateClassLevelName('#1024-followup').ok).toBe(false)
    expect(validateClassLevelName('pr/9-quick-fix').ok).toBe(false)
  })

  // ── 7. error-* prefix + error substrings ──

  it('rejects error-* prefix', () => {
    expect(validateClassLevelName('error-handling-econnreset').ok).toBe(false)
  })

  it('rejects names containing literal error strings', () => {
    expect(validateClassLevelName('handle-econnreset').ok).toBe(false)
    expect(validateClassLevelName('cope-with-cannot-read-property').ok).toBe(false)
    expect(validateClassLevelName('out-of-memory-recovery').ok).toBe(false)
    expect(validateClassLevelName('stack-overflow-mitigation').ok).toBe(false)
  })

  // ── Edge cases ──

  it('rejects an empty string', () => {
    const r = validateClassLevelName('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/non-empty/i)
  })

  it('rejects whitespace-only input', () => {
    const r = validateClassLevelName('   ')
    expect(r.ok).toBe(false)
  })

  it('rejects a name longer than 80 chars', () => {
    const r = validateClassLevelName('x'.repeat(81))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/80 characters/i)
  })

  it('rejects non-string input', () => {
    // @ts-expect-error — runtime guard against bad upstream input
    const r = validateClassLevelName(42)
    expect(r.ok).toBe(false)
  })
})
