import { describe, expect, it } from 'vitest';
import {
  MAX_ROOM_RESPONDERS,
  mentionCandidatesFor,
  resolveMentionQuery,
  resolveMentionSpans,
  resolveMentionedAssistants,
  trailingMentionQuery,
  type MentionTarget,
} from '../mention-matching.js';

const roster = [
  { id: 'brian', name: 'Brian' },
  { id: 'hinson', name: 'Hinson' },
  { id: 'sales', name: 'Sales' },
  { id: 'sales-eu', name: 'Sales EU' },
];

/** The shipped shape of the bug: one name is a prefix of another. */
const sharedPrefixRoster = [
  { id: 'blendit', name: 'Blendit' },
  { id: 'blendit-media', name: 'Blendit Media' },
];

/** Walk the popup state the way the composer does: resolve, then feed the
 *  carried dismissal back in on the next keystroke. */
function popup(
  steps: Array<{ text: string; completedInput?: string | null; dismiss?: boolean }>,
) {
  let completedInput: string | null = null;
  let dismissedPrefix: string | null = null;
  let last: ReturnType<typeof resolveMentionQuery> | null = null;
  for (const step of steps) {
    if (step.completedInput !== undefined) completedInput = step.completedInput;
    last = resolveMentionQuery({ text: step.text, completedInput, dismissedPrefix });
    dismissedPrefix = last.dismissedPrefix;
    if (step.dismiss && last.query) {
      dismissedPrefix = step.text.slice(0, last.query.at);
      last = { query: null, dismissedPrefix };
    }
  }
  return last!;
}

describe('[COMP:shared/mention-matching] mention matcher', () => {
  it('returns every distinct mentioned assistant in textual order', () => {
    expect(
      resolveMentionedAssistants('@HINSON and @Brian, what do you both know? @hinson', roster)
        .map((assistant) => assistant.id),
    ).toEqual(['hinson', 'brian']);
  });

  it('uses the longest overlapping assistant name', () => {
    expect(
      resolveMentionedAssistants('Ask @Sales EU, then @Sales.', roster)
        .map((assistant) => assistant.id),
    ).toEqual(['sales-eu', 'sales']);
  });

  it('does not treat a longer word as a mention', () => {
    expect(resolveMentionedAssistants('@Brianna', roster)).toEqual([]);
  });

  it('bounds one response group to MAX_ROOM_RESPONDERS', () => {
    const largeRoster = Array.from({ length: 10 }, (_, index) => ({
      id: `assistant-${index}`,
      name: `Assistant ${index}`,
    }));
    const message = largeRoster.map((assistant) => `@${assistant.name}`).join(' ');

    expect(resolveMentionedAssistants(message, largeRoster)).toHaveLength(MAX_ROOM_RESPONDERS);
    expect(MAX_ROOM_RESPONDERS).toBe(8);
  });

  it("reports each mention's range so the composer can chip it", () => {
    expect(
      resolveMentionSpans('Ask @Sales EU, then @Sales.', roster),
    ).toMatchObject([
      { assistant: { id: 'sales-eu' }, start: 4, end: 13 },
      { assistant: { id: 'sales' }, start: 20, end: 26 },
    ]);
    // What is painted is what is addressed: a repeat still highlights, but the
    // assistant answers once.
    const repeated = '@Brian and @Brian again';
    expect(resolveMentionSpans(repeated, roster)).toHaveLength(2);
    expect(resolveMentionedAssistants(repeated, roster)).toHaveLength(1);
  });

  it('finds the trailing `@` query, spaces and all', () => {
    expect(trailingMentionQuery('ask @sales e')).toEqual({
      at: 4,
      partial: 'sales e',
    });
    expect(trailingMentionQuery('no mention here')).toBeNull();
    // An `@` glued to a word is an address, not a mention query.
    expect(trailingMentionQuery('mail me@example.com')).toBeNull();
  });

  it('keeps the trailing partial when a space is typed (space does not terminate the token)', () => {
    expect(trailingMentionQuery('hi @Jane ')).toEqual({ at: 3, partial: 'Jane ' });
  });

  it('stops offering a mention the user already confirmed', () => {
    // The reported bug: picking @Blendit left @Blendit Media hanging, because
    // the completion still looks like a trailing query.
    const completed = '@Blendit ';
    expect(mentionCandidatesFor(trailingMentionQuery(completed), sharedPrefixRoster))
      .toHaveLength(1);
    expect(popup([{ text: completed, completedInput: completed }]).query).toBeNull();

    // Typing on is prose, not a longer query.
    expect(
      popup([
        { text: completed, completedInput: completed },
        { text: '@Blendit Media please' },
      ]).query,
    ).toBeNull();

    // A NEW `@` after it opens the popup again.
    expect(
      popup([
        { text: completed, completedInput: completed },
        { text: '@Blendit and @Sal' },
      ]).query,
    ).toEqual({ at: 13, partial: 'Sal' });

    // Deleting back INTO the name is how you extend it to the longer name.
    expect(
      popup([
        { text: completed, completedInput: completed },
        { text: '@Blendit' },
      ]).query,
    ).toEqual({ at: 0, partial: 'Blendit' });
  });

  it('keeps the popup closed for the `@` the user dismissed', () => {
    // Escape (or a click outside) at "ask @sa" — typing on does not reopen it.
    expect(popup([{ text: 'ask @sa', dismiss: true }, { text: 'ask @sal' }]).query)
      .toBeNull();
    // A different `@` is a different question.
    expect(
      popup([{ text: 'ask @sa', dismiss: true }, { text: 'ask @sal @hi' }]).query,
    ).toEqual({ at: 9, partial: 'hi' });
    // Dropping the `@` clears the anchor, so the next one opens fresh.
    expect(
      popup([
        { text: 'ask @sa', dismiss: true },
        { text: 'ask ' },
        { text: 'ask @sa' },
      ]).query,
    ).toEqual({ at: 4, partial: 'sa' });
  });

  it('filters the roster by what was typed after the `@`', () => {
    expect(
      mentionCandidatesFor({ at: 0, partial: 'sales ' }, roster).map((a) => a.id),
    ).toEqual(['sales-eu']);
    // An empty query offers the whole roster.
    expect(mentionCandidatesFor({ at: 0, partial: '' }, roster)).toHaveLength(4);
    expect(mentionCandidatesFor(null, roster)).toHaveLength(0);
  });

  describe('room human mentions (docs/plans/room-human-mentions.md T-H5)', () => {
    // MentionTarget is deliberately NOT discriminated (see the type's doc
    // comment). PH3's composer merges assistants + members into a roster
    // shaped like this locally; the matcher never needs to know about it.
    type RoomMentionTarget = MentionTarget & { mentionKind: 'assistant' | 'member' };

    const humanRoster: RoomMentionTarget[] = [
      { id: 'jane-doe', name: 'Jane Doe', mentionKind: 'member' },
    ];

    it('resolves a full-name mention', () => {
      expect(resolveMentionedAssistants('@Jane Doe can you take a look?', humanRoster))
        .toEqual([humanRoster[0]]);
    });

    it('does not match a partial first name against a longer full name', () => {
      // The full display name is required — `@Jane` matches nothing unless
      // that IS someone's display name (D-H3).
      expect(resolveMentionedAssistants('@Jane can you take a look?', humanRoster))
        .toEqual([]);
    });

    it('resolves the full name over the short name when both exist', () => {
      const both: RoomMentionTarget[] = [
        { id: 'jane', name: 'Jane', mentionKind: 'member' },
        { id: 'jane-doe', name: 'Jane Doe', mentionKind: 'member' },
      ];
      expect(resolveMentionedAssistants('@Jane Doe, thoughts?', both).map((t) => t.id))
        .toEqual(['jane-doe']);
    });

    it('does not match a name inside a longer name (`@Jane` vs `@Janet`)', () => {
      const withJanet: RoomMentionTarget[] = [
        { id: 'jane', name: 'Jane', mentionKind: 'member' },
        { id: 'janet', name: 'Janet', mentionKind: 'member' },
      ];
      expect(resolveMentionedAssistants('@Janet, are you around?', withJanet).map((t) => t.id))
        .toEqual(['janet']);
    });

    it('keeps a trailing partial mention across a space (does not terminate the token)', () => {
      expect(trailingMentionQuery('hi @Jane ')).toEqual({ at: 3, partial: 'Jane ' });
    });

    it('still offers the full name as a candidate on a trailing partial with a space', () => {
      expect(
        mentionCandidatesFor(trailingMentionQuery('hi @Jane '), humanRoster).map((t) => t.id),
      ).toEqual(['jane-doe']);
    });

    it('picks the assistant over a member on an exact name tie, when assistants are ordered first', () => {
      const tied: RoomMentionTarget[] = [
        { id: 'brian-assistant', name: 'Brian', mentionKind: 'assistant' },
        { id: 'brian-member', name: 'Brian', mentionKind: 'member' },
      ];
      const spans = resolveMentionSpans('@Brian, can you help?', tied);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.assistant.id).toBe('brian-assistant');
    });

    it('is generic: a richer roster type comes back with its own discriminator intact', () => {
      // MentionTarget carries no `kind`/discriminator of its own — this is
      // what PH3 depends on: pass a roster shaped however the caller likes,
      // get that same shape back. `mentionKind` here is arbitrary caller
      // vocabulary, not something the matcher special-cases.
      const roomRoster: RoomMentionTarget[] = [
        { id: 'ops', name: 'Ops', mentionKind: 'assistant' },
        { id: 'jane-doe', name: 'Jane Doe', mentionKind: 'member' },
      ];
      const spans = resolveMentionSpans('@Ops and @Jane Doe, please review', roomRoster);
      expect(spans.map((s) => s.assistant.mentionKind)).toEqual(['assistant', 'member']);

      const resolved = resolveMentionedAssistants('@Ops and @Jane Doe, please review', roomRoster);
      expect(resolved.map((t) => t.mentionKind)).toEqual(['assistant', 'member']);
    });
  });
});
