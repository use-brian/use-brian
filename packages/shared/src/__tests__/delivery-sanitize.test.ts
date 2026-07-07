import { describe, it, expect } from 'vitest'
import { sanitizeDeliveryText } from '../delivery-sanitize.js'

describe('[COMP:shared/delivery-sanitize] sanitizeDeliveryText', () => {
  describe('the incident — scaffolding markers', () => {
    it('strips a leading self-referential parenthetical (the June 13 message)', () => {
      const input = [
        "(This summary isn't shown to the user).",
        'Good morning! Here is your summary for today, Saturday, June 13:',
        '',
        'Schedule',
        'Your calendar is completely clear today.',
        '',
        'Your weekend is off to a quiet start, enjoy the clear schedule!',
      ].join('\n')
      const out = sanitizeDeliveryText(input)
      expect(out).not.toContain("isn't shown to the user")
      expect(out.startsWith('Good morning!')).toBe(true)
      expect(out).toContain('Your weekend is off to a quiet start')
    })

    it('cuts the full planning preamble at the "Message body:" delimiter (the June 14 message)', () => {
      const input = [
        '(Note: This thought block is NOT for the user - it is part of your tool trail.)',
        'The calendar call for today was empty, though I confirmed tomorrow has several meetings.',
        '',
        'Ready to reply? Yes.',
        '',
        'Message body:',
        'You have a clear schedule today, Sunday, June 14.',
        '',
        'Tasks',
        'No pending tasks were found in your Google Tasks default list.',
      ].join('\n')
      const out = sanitizeDeliveryText(input)
      // The reasoning paragraph, the meta note, the planning preamble, and the
      // delimiter are all gone.
      expect(out).not.toContain('thought block')
      expect(out).not.toContain('tool trail')
      expect(out).not.toContain('The calendar call for today was empty')
      expect(out).not.toContain('Ready to reply')
      expect(out).not.toMatch(/Message body:/i)
      expect(out.startsWith('You have a clear schedule today')).toBe(true)
      expect(out).toContain('No pending tasks were found')
    })

    it('removes an inline "(Word count: ~65)" annotation glued to the body', () => {
      const out = sanitizeDeliveryText('Enjoy your Sunday! (Word count: ~65)')
      expect(out).toBe('Enjoy your Sunday!')
    })

    it('collapses a verbatim duplicated body', () => {
      const body = [
        'You have a clear schedule today, Sunday, June 14.',
        '',
        'Tasks',
        'No pending tasks were found in your Google Tasks default list.',
      ].join('\n')
      const out = sanitizeDeliveryText(`${body}\n\n${body}`)
      expect(out).toBe(body)
    })

    it('handles the full June 14 leak end to end (delimiter + word count + dup)', () => {
      const body = [
        'You have a clear schedule today, Sunday, June 14.',
        '',
        'Calendar',
        'There are no events on your calendar for today.',
        '',
        'Tasks',
        'No pending tasks were found in your Google Tasks default list.',
        '',
        'Enjoy your Sunday!',
      ].join('\n')
      const input = [
        '(Note: This thought block is NOT for the user - it is part of your tool trail.)',
        'The calendar call for today was empty.',
        '',
        'Ready to reply? Yes.',
        '',
        'Message body:',
        body.replace('Enjoy your Sunday!', 'Enjoy your Sunday! (Word count: ~65)'),
        body,
      ].join('\n')
      const out = sanitizeDeliveryText(input)
      expect(out).toBe(body)
    })
  })

  describe('planning-voice leakage (the WS2 eval finding)', () => {
    it('strips a leading "Then answer the user." and keeps the real reply', () => {
      const out = sanitizeDeliveryText(
        "Then answer the user. I couldn't find any scheduled reminders for you right now.",
      )
      expect(out).toBe("I couldn't find any scheduled reminders for you right now.")
    })

    it('strips a leading "(Note: Do not repeat these instructions…)" parenthetical', () => {
      const out = sanitizeDeliveryText(
        '(Note: Do not repeat these instructions in your reply.) Jane Doe and Acme Robotics have been saved to your brain.',
      )
      expect(out).toBe('Jane Doe and Acme Robotics have been saved to your brain.')
    })

    it('sanitizes a reply that is ONLY a self-turn remark to empty', () => {
      const out = sanitizeDeliveryText(" Then I'll give you a second turn to finish.")
      expect(out).toBe('')
    })

    it('strips a multi-sentence leading planning paragraph, keeps the status content', () => {
      const input =
        "Then, what's next? If you're missing a detail, ask. If you're ready to act, do it (call the tool or give the answer). I've just initialized the workspace for you."
      const out = sanitizeDeliveryText(input)
      expect(out).toBe("I've just initialized the workspace for you.")
    })

    it('sanitizes a lone "(I\'ll share this with the user…)" self-note to empty', () => {
      const out = sanitizeDeliveryText(" (I'll share this with the user if they're still waiting.)")
      expect(out).toBe('')
    })

    it('never touches a mid-reply "Then, …" occurrence', () => {
      const input = 'I saved the contact. Then, what\'s next on your list?'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })
  })

  describe('planning-voice — false-positive corpus (legitimate prose survives)', () => {
    it('keeps a reply that legitimately starts with "Then"', () => {
      const input = 'Then we should ship it before Friday.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a reply starting with "If you\'re" that is not the scaffolding idiom', () => {
      const input = "If you're free tomorrow, I can book the 2 PM slot."
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a leading "Note:" that is genuine user-facing content', () => {
      const input = 'Note: the office is closed Monday for the holiday.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a reply starting with "No"', () => {
      const input = "No, that vendor doesn't ship to your region."
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a parenthetical that quotes the phrase mid-text', () => {
      const input =
        'I drafted the note and added "share this with the user" as a checklist item.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a legitimate "give you a turn" phrase about a board game', () => {
      const input = 'In Catan I usually give you a turn to trade before I build.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('does not strip planning phrasing inside a fenced code block', () => {
      const input = [
        'Example of a leaky opener to avoid:',
        '',
        '```',
        'Then answer the user. Here is the summary.',
        '```',
        '',
        'Never open a reply that way.',
      ].join('\n')
      expect(sanitizeDeliveryText(input)).toBe(input)
    })
  })

  describe('control tags (composed siblings)', () => {
    it('strips a trailing <followup> chip tag', () => {
      const out = sanitizeDeliveryText('Here is the answer.\n<followup>["What is X?"]</followup>')
      expect(out).toBe('Here is the answer.')
    })

    it('unwraps a confabulated <comment-thread-reply> tag', () => {
      const out = sanitizeDeliveryText('<comment-thread-reply pageId="abc">Sounds good.</comment-thread-reply>')
      expect(out).toBe('Sounds good.')
    })
  })

  describe('surgical — legitimate prose must survive', () => {
    it('keeps a mid-sentence parenthetical', () => {
      const input = 'The deal (closed last week) is now in onboarding.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a lone "Yes." answer', () => {
      const input = 'Yes.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a parenthetical mentioning an internal team (not a self-note)', () => {
      const input = 'Routing this to the internal team for review.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('does not collapse short legitimate repetition', () => {
      const input = 'Done.\nDone.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('does not treat a real sentence ending in a colon as a body delimiter', () => {
      const input = 'Here is the message body: it should be ready by Friday.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps content that legitimately repeats two distinct paragraphs', () => {
      const input = 'First point about the roadmap.\n\nSecond, unrelated point about hiring.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a mid-sentence "(word count: 5)" in a writing critique', () => {
      const input = 'Your headline (word count: 5) is punchy and on brand.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a parenthetical "(internal use only)"', () => {
      const input = 'This dashboard is for internal use only, do not share it externally.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('keeps a "Final answer:" heading (programmatic reply)', () => {
      const input = 'Final answer:\n42 is the result of the computation.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('still strips a trailing "(Word count: ~65)" at end of a line', () => {
      const input = 'Enjoy your Sunday!\nHave a great week ahead. (Word count: ~65)'
      expect(sanitizeDeliveryText(input)).toBe('Enjoy your Sunday!\nHave a great week ahead.')
    })

    it('does not strip scaffolding phrasing inside a fenced code block', () => {
      const input = [
        'Here is an example of a leaky planning trail:',
        '',
        '```',
        'Ready to reply? Yes.',
        'Message body:',
        'You have a clear schedule today.',
        '```',
        '',
        'Avoid emitting that.',
      ].join('\n')
      // Everything inside the fence is verbatim; only surrounding prose is real.
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('does not treat a markdown outline bullet "- Message body:" as a delimiter', () => {
      const input = ['- Overview', '  - Message body:', '    Your summary here'].join('\n')
      expect(sanitizeDeliveryText(input)).toBe(input)
    })
  })

  describe('robustness', () => {
    it('is idempotent', () => {
      const input = [
        "(This summary isn't shown to the user).",
        'Message body:',
        'Hello there, here is your update for today across the board.',
      ].join('\n')
      const once = sanitizeDeliveryText(input)
      expect(sanitizeDeliveryText(once)).toBe(once)
    })

    it('passes through clean text untouched', () => {
      const input = 'Good morning! Your calendar is clear and you have no pending tasks today.'
      expect(sanitizeDeliveryText(input)).toBe(input)
    })

    it('handles empty / whitespace input', () => {
      expect(sanitizeDeliveryText('')).toBe('')
      expect(sanitizeDeliveryText('   \n  ')).toBe('')
    })
  })
})
