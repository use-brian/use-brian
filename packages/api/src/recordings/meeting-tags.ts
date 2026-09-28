/** User-controlled meeting tagging. Spec: media/live-capture.md. [COMP:recordings/meeting-tags] */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

const label = z.string().trim().min(1).max(64)
const phrases = z.array(z.string().trim().min(2).max(120)).min(1).max(8)
export const meetingTagCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set-tags'), tags: z.array(label).max(30) }),
  z.object({ kind: z.literal('create-rule'), tag: label, phrases }),
  z.object({ kind: z.literal('accept-rule'), id: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('dismiss-rule'), id: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('delete-rule'), id: z.string().uuid() }),
])
export type MeetingTagCommand = z.infer<typeof meetingTagCommand>
export type TagRule = { id: string; tag: string; phrases: string[] }
export type TagState = {
  tags: Array<{ name: string; source: 'manual' | 'rule' }>
  suppressed: string[]
  rules: TagRule[]
  dismissed: string[]
}
export type TagSuggestion = TagRule & { pageIds: string[] }
export type TagExample = { pageId: string; text: string; tags: TagState['tags'] }
export const emptyTagState = (): TagState => ({ tags: [], suppressed: [], rules: [], dismissed: [] })
export const tagKey = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase()

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = tagKey(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // CJK phrases are naturally substrings; Latin phrases must not match inside words.
  const boundary = /^[\p{Script=Latin}\d\s-]+$/u.test(phrase)
  return new RegExp(boundary ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, 'u').test(tagKey(text))
}
export function applyTagRules(state: TagState, rules: TagRule[], text: string): TagState {
  const tags = [...state.tags]
  for (const rule of rules) {
    if (tags.length >= 30) break
    const key = tagKey(rule.tag)
    if (state.suppressed.includes(key) || tags.some((tag) => tagKey(tag.name) === key)) continue
    if (rule.phrases.length && rule.phrases.every((phrase) => containsPhrase(text, phrase))) {
      tags.push({ name: rule.tag, source: 'rule' })
    }
  }
  return { ...state, tags }
}
export function setManualTags(state: TagState, names: string[]): TagState {
  const unique = [...new Map(names.map((name) => [tagKey(name), name.trim()])).values()]
  const keys = new Set(unique.map(tagKey))
  return {
    ...state,
    tags: unique.map((name) => state.tags.find((tag) => tagKey(tag.name) === tagKey(name)) ?? { name, source: 'manual' as const }),
    suppressed: [...new Set([...state.suppressed, ...state.tags.filter((tag) => !keys.has(tagKey(tag.name))).map((tag) => tagKey(tag.name))])].filter((key) => !keys.has(key)),
  }
}
const STOP_WORDS = new Set(('meeting notes note weekly daily speaker summary decisions action items update team discussion discussed about after again also been before being between could every first from have into just more most other over same some than that their them then there these they this those through today under very were what when where which while will with would your next said want need should because things going really know think yeah okay agreed discuss').split(' '))
function terms(text: string): Set<string> {
  const words = new Intl.Segmenter(undefined, { granularity: 'word' }).segment(tagKey(text).slice(0, 12000))
  return new Set([...words].filter((word) => word.isWordLike).map((word) => word.segment)
    .filter((word) => !STOP_WORDS.has(word) && !/\d/u.test(word) && (/\p{Script=Latin}/u.test(word) ? word.length >= 4 : word.length >= 2)))
}
/** Suggestions are recomputed from manual evidence and never assign tags. */
export function suggestTagRules(examples: TagExample[], folder: TagState): TagSuggestion[] {
  const termsByPage = new Map(examples.map((row) => [row.pageId, terms(row.text)]))
  const groups = new Map<string, { tag: string; rows: TagExample[] }>()
  for (const row of examples) for (const tag of row.tags.filter((tag) => tag.source === 'manual')) {
    const key = tagKey(tag.name)
    const group = groups.get(key) ?? { tag: tag.name, rows: [] }
    if (!group.rows.some((prior) => prior.pageId === row.pageId)) group.rows.push(row)
    groups.set(key, group)
  }
  const result: TagSuggestion[] = []
  for (const [key, group] of groups) {
    if (group.rows.length < 2 || folder.rules.some((rule) => tagKey(rule.tag) === key)) continue
    const shared = [...termsByPage.get(group.rows[0].pageId)!].filter((term) => group.rows.every((row) => termsByPage.get(row.pageId)!.has(term)))
      .sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 3).sort()
    if (!shared.length) continue
    const id = createHash('sha256').update(JSON.stringify([key, shared])).digest('hex')
    if (!folder.dismissed.includes(id)) result.push({ id, tag: group.tag, phrases: shared, pageIds: group.rows.map((row) => row.pageId) })
  }
  return result.slice(0, 10)
}
export function changeRules(state: TagState, command: Exclude<MeetingTagCommand, { kind: 'set-tags' }>, suggestions: TagSuggestion[]): TagState {
  if (command.kind === 'delete-rule') return { ...state, rules: state.rules.filter((rule) => rule.id !== command.id) }
  if (command.kind === 'dismiss-rule') return { ...state, dismissed: [...new Set([...state.dismissed, command.id])].slice(-200) }
  const proposal = command.kind === 'accept-rule' ? suggestions.find((rule) => rule.id === command.id) : command
  if (!proposal) throw new Error('Suggestion is no longer supported by visible manual tags. Refresh before retrying.')
  if (state.rules.length >= 50) throw new Error('This folder already has 50 rules. Remove one before adding another.')
  if (state.rules.some((rule) => tagKey(rule.tag) === tagKey(proposal.tag) && JSON.stringify(rule.phrases) === JSON.stringify(proposal.phrases))) return state
  return { ...state, rules: [...state.rules, { id: randomUUID(), tag: proposal.tag, phrases: proposal.phrases }] }
}
