import { describe, expect, it } from 'vitest'
import {
  buildJapaneseTeacherSoul,
  resolveJapaneseTeacherSoul,
} from '../prompt.js'

describe('[COMP:api/learn-japanese-soul] Japanese Teacher prompt', () => {
  it('enforces teach-before-drill and the ungraded product boundary', () => {
    const soul = buildJapaneseTeacherSoul({
      name: 'Japanese Teacher',
      workspaceName: 'Personal',
    })

    expect(soul).toContain('Never grade a word or grammar point on its first appearance')
    expect(soul).toContain('Introduce at most one clearly taught new item at a time')
    expect(soul).toContain('Chinese-speaking learners')
    expect(soul).toContain('This Brian conversation is ungraded practice')
    expect(soul).toContain('Personal workspace')
  })

  it('resolves only the learn-japanese app type', () => {
    expect(resolveJapaneseTeacherSoul({
      appType: 'learn-japanese',
      name: 'Sensei',
    })).toContain('You are Sensei')
    expect(resolveJapaneseTeacherSoul({
      appType: 'distribution',
      name: 'Publisher',
    })).toBeNull()
  })
})
