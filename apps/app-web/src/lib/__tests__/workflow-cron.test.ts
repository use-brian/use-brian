/**
 * Cron validator + next-fire preview tests for the workflow trigger
 * editor. Component tag: [COMP:app-web/workflow] (ported from apps/web at the helper-copy deletion).
 *
 * Spec: docs/plans/company-brain/workflow-builder.md → Schedule trigger UI.
 */

import { describe, expect, it } from "vitest"
import { nextFireTimes, validateCron } from "../workflow-cron"

describe("[COMP:app-web/workflow] cron validator", () => {
  it("accepts a basic 5-field expression", () => {
    expect(validateCron("0 9 * * *")).toEqual({ valid: true })
  })

  it("accepts ranges and lists", () => {
    expect(validateCron("0,15,30,45 9-17 * * MON-FRI")).toEqual({ valid: true })
  })

  it("accepts step syntax", () => {
    expect(validateCron("*/15 * * * *")).toEqual({ valid: true })
    expect(validateCron("0 */2 * * *")).toEqual({ valid: true })
  })

  it("accepts month and day-of-week names", () => {
    expect(validateCron("0 9 1 JAN MON")).toEqual({ valid: true })
  })

  it("rejects empty input", () => {
    const r = validateCron("")
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toContain("empty")
  })

  it("rejects too few or too many fields", () => {
    expect(validateCron("0 9 * *").valid).toBe(false)
    expect(validateCron("0 9 * * * *").valid).toBe(false)
  })

  it("rejects out-of-range values", () => {
    expect(validateCron("60 9 * * *").valid).toBe(false)
    expect(validateCron("0 24 * * *").valid).toBe(false)
    expect(validateCron("0 9 32 * *").valid).toBe(false)
    expect(validateCron("0 9 * 13 *").valid).toBe(false)
    expect(validateCron("0 9 * * 7").valid).toBe(false)
  })

  it("rejects reversed ranges", () => {
    expect(validateCron("0 17-9 * * *").valid).toBe(false)
  })

  it("rejects garbage characters", () => {
    expect(validateCron("@daily").valid).toBe(false)
    expect(validateCron("0 9 * * MOON").valid).toBe(false)
  })
})

describe("[COMP:app-web/workflow] cron next-fire preview", () => {
  it("returns exactly the requested number of fire times", () => {
    // 09:00 every day, starting from a known reference.
    const from = new Date(2026, 4, 1, 0, 0, 0) // 2026-05-01 00:00 local
    const fires = nextFireTimes("0 9 * * *", from, 3)
    expect(fires).toHaveLength(3)
    expect(fires[0].getHours()).toBe(9)
    expect(fires[0].getMinutes()).toBe(0)
    // Three consecutive days.
    expect(fires[1].getTime() - fires[0].getTime()).toBe(24 * 60 * 60 * 1000)
    expect(fires[2].getTime() - fires[1].getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it("handles step expressions", () => {
    const from = new Date(2026, 4, 1, 12, 0, 0) // 12:00
    const fires = nextFireTimes("*/15 * * * *", from, 4)
    expect(fires.map((d) => d.getMinutes())).toEqual([15, 30, 45, 0])
  })

  it("returns an empty list for invalid input", () => {
    const from = new Date()
    expect(nextFireTimes("not a cron", from, 3)).toEqual([])
  })

  it("respects weekday restriction", () => {
    // Saturdays only at 10:00. Should land on a Saturday.
    const from = new Date(2026, 4, 1, 0, 0, 0)
    const fires = nextFireTimes("0 10 * * SAT", from, 1)
    expect(fires).toHaveLength(1)
    expect(fires[0].getDay()).toBe(6)
    expect(fires[0].getHours()).toBe(10)
  })
})
