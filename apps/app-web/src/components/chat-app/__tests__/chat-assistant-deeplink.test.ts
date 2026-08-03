import { describe, expect, it } from 'vitest'
import { resolveRequestedFreshAssistant } from '../assistant-deeplink'

describe('[COMP:app-web/chat-assistant-deeplink] first-party assistant deep links', () => {
  const assistants = [{ id: 'primary' }, { id: 'teacher' }]

  it('accepts a workspace assistant on a fresh chat', () => {
    expect(resolveRequestedFreshAssistant('teacher', assistants)).toBe('teacher')
  })

  it('rejects missing and cross-workspace assistant ids', () => {
    expect(resolveRequestedFreshAssistant(null, assistants)).toBeNull()
    expect(resolveRequestedFreshAssistant('outside', assistants)).toBeNull()
  })
})
