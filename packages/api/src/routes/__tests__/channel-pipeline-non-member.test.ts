import { describe, it, expect } from 'vitest'
import { buildNonMemberSenderBlock } from '../channel-pipeline.js'

// The 2026-08-18 Slack incident: a sender whose channel email resolved to a
// real account that is not a member of the assistant's workspace got "no
// workflows in this workspace yet" / "task not found" as fact, and the
// assistant could not even name the workspace. The block is the fact +
// remedy travelling with the turn. See channel-user-identity.md →
// "Non-member senders".
describe('[COMP:api/channel-pipeline/non-member-sender] non-member sender block', () => {
  it('names the resolved account, forbids reporting the symptom as fact, and gives both remedies', () => {
    const block = buildNonMemberSenderBlock({
      channelType: 'slack',
      senderEmail: 'ken@company.example',
      senderName: 'Ken',
    })
    expect(block.startsWith('# Sender is not a workspace member')).toBe(true)
    expect(block).toContain('Ken <ken@company.example>')
    expect(block).toContain('resolves to the Use Brian account ken@company.example')
    expect(block).toContain('do NOT report "no workflows"')
    expect(block).toContain('invites that email to the workspace')
    expect(block).toContain('Settings -> Account -> Connected accounts')
    expect(block).not.toContain('—')
  })

  it('handles an email-less shadow sender without inventing an address', () => {
    const block = buildNonMemberSenderBlock({ channelType: 'telegram', senderEmail: null, senderName: null })
    expect(block).toContain('this sender')
    expect(block).toContain('could not be matched to a member of this workspace')
    expect(block).not.toContain('resolves to the Use Brian account')
  })
})
