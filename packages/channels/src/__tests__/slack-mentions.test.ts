import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildMentionIndex,
  clearMentionDirectoryCache,
  hasMentionCandidates,
  resolveMentionsCached,
  resolveMentionsInText,
  type SlackMember,
} from '../slack/mentions.js'

const MEMBERS: SlackMember[] = [
  { id: 'U01HINSON', handle: 'hinson.wong', displayName: 'Hinson', realName: 'Hinson Wong' },
  { id: 'U02AWCJACK', handle: 'awcjack', displayName: 'awcjack', realName: 'Jack Wong' },
  { id: 'U03TOM', handle: 'yanyuk.tom', displayName: 'Tom', realName: 'Tom Yan' },
]

describe('[COMP:channels/slack-mentions] outbound mention resolution', () => {
  beforeEach(() => clearMentionDirectoryCache())

  it('rewrites <@handle> (handle inside id syntax — the literal-<@awcjack> bug) to the real id', () => {
    expect(resolveMentionsInText('ping <@awcjack> about the CLA bot', MEMBERS)).toBe(
      'ping <@U02AWCJACK> about the CLA bot',
    )
  })

  it('leaves a real member id mention untouched', () => {
    expect(resolveMentionsInText('hi <@U02AWCJACK>!', MEMBERS)).toBe('hi <@U02AWCJACK>!')
  })

  it('rewrites plain @handle tokens (dotted handles included)', () => {
    expect(resolveMentionsInText('cc @hinson.wong and @yanyuk.tom', MEMBERS)).toBe(
      'cc <@U01HINSON> and <@U03TOM>',
    )
  })

  it('rewrites @DisplayName on a unique match', () => {
    expect(resolveMentionsInText('over to @Hinson now', MEMBERS)).toBe('over to <@U01HINSON> now')
  })

  it('keeps trailing sentence punctuation outside the mention', () => {
    expect(resolveMentionsInText('thanks @awcjack.', MEMBERS)).toBe('thanks <@U02AWCJACK>.')
  })

  it('leaves unknown plain @names as typed', () => {
    expect(resolveMentionsInText('ask @nobody.known about it', MEMBERS)).toBe(
      'ask @nobody.known about it',
    )
  })

  it('strips an unresolvable <@name> to plain @name (never ship the literal)', () => {
    expect(resolveMentionsInText('ping <@ghost.user>', MEMBERS)).toBe('ping @ghost.user')
    // Same cleanup with NO directory at all (users.list failed).
    expect(resolveMentionsInText('ping <@ghost.user>', [])).toBe('ping @ghost.user')
  })

  it('never rewrites an ambiguous name (two members sharing it)', () => {
    const dup: SlackMember[] = [
      ...MEMBERS,
      { id: 'U04HINSON2', handle: 'hinson2', displayName: 'Hinson', realName: 'Hinson Chan' },
    ]
    // "Hinson" now maps to two members → left as typed.
    expect(resolveMentionsInText('over to @Hinson now', dup)).toBe('over to @Hinson now')
    // The unambiguous full names still resolve.
    expect(resolveMentionsInText('over to @hinson.wong now', dup)).toBe('over to <@U01HINSON> now')
  })

  it('does not touch email addresses', () => {
    expect(resolveMentionsInText('mail hinson.wong@example.com please', MEMBERS)).toBe(
      'mail hinson.wong@example.com please',
    )
  })

  it('matches real names with dots/spaces normalized both ways', () => {
    // "@Hinson Wong" is two tokens — only the first is a candidate — but the
    // dotted single-token form of the real name resolves.
    expect(resolveMentionsInText('cc @hinson-wong', MEMBERS)).toBe('cc <@U01HINSON>')
  })

  it('hasMentionCandidates gates cheaply — only tokens that need work count', () => {
    expect(hasMentionCandidates('no mentions present')).toBe(false)
    // Already-valid ids need no directory — no fetch.
    expect(hasMentionCandidates('one <@U123ABC> already valid')).toBe(false)
    expect(hasMentionCandidates('plain @name present')).toBe(true)
    expect(hasMentionCandidates('broken <@handle> present')).toBe(true)
    // Broadcast keywords are never resolution candidates.
    expect(hasMentionCandidates('heads up @here and @channel and @everyone')).toBe(false)
  })

  it('never rewrites broadcast keywords (would enable accidental mass pings)', () => {
    const withHere: SlackMember[] = [
      ...MEMBERS,
      // Even a member literally named "here" must not hijack @here.
      { id: 'U05HERE', handle: 'here', displayName: 'Here', realName: 'H Ere' },
    ]
    expect(resolveMentionsInText('ping @here and @channel', withHere)).toBe(
      'ping @here and @channel',
    )
  })

  it('buildMentionIndex marks colliding forms null and keeps distinct ones', () => {
    const index = buildMentionIndex([
      { id: 'U1', handle: 'sam', displayName: 'Sam', realName: 'Sam One' },
      { id: 'U2', handle: 'sam2', displayName: 'Sam', realName: 'Sam Two' },
    ])
    expect(index.get('sam')).toBeNull()
    expect(index.get('sam one')).toBe('U1')
    expect(index.get('sam two')).toBe('U2')
  })

  it('resolveMentionsCached fetches the directory once per cache key and survives fetch failure', async () => {
    let fetches = 0
    const fetchMembers = async () => {
      fetches++
      return MEMBERS
    }
    expect(await resolveMentionsCached('hi @awcjack', 'token-a', fetchMembers)).toBe('hi <@U02AWCJACK>')
    expect(await resolveMentionsCached('yo @Hinson', 'token-a', fetchMembers)).toBe('yo <@U01HINSON>')
    expect(fetches).toBe(1)

    // No candidates → no fetch at all (plain text, valid ids, broadcasts).
    expect(await resolveMentionsCached('plain text', 'token-b', fetchMembers)).toBe('plain text')
    expect(await resolveMentionsCached('hi <@U02AWCJACK>', 'token-b', fetchMembers)).toBe('hi <@U02AWCJACK>')
    expect(await resolveMentionsCached('cc @here', 'token-b', fetchMembers)).toBe('cc @here')
    expect(fetches).toBe(1)

    // A throwing fetch still applies the dependency-free cleanup.
    const boom = async (): Promise<SlackMember[]> => {
      throw new Error('missing_scope')
    }
    expect(await resolveMentionsCached('ping <@ghost>', 'token-c', boom)).toBe('ping @ghost')
  })
})
