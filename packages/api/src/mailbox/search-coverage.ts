/** Provider arrival-day evidence for indexed recent mailbox search. */
import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import type { MailboxSearchParams } from '@use-brian/core/tools/base/mailbox.js'
import type { ImapClientLike } from './imap-session.js'
import { syncableFolders } from './imap-session.js'
import type { MailboxAccountSettings } from './types.js'

const DAY_MS = 86_400_000
const MAX_AGE_MS = 10 * 60_000
const MAX_FOLDERS = 16
const MAX_FOLDER_MESSAGES = 10_000
const MAX_RECENT_UIDS = 800
const STATUS_FIELDS = { messages: true, uidNext: true, uidValidity: true } as const

const uid = z.number().int().positive().max(4_294_967_295)
const uidList = z.array(uid).max(MAX_RECENT_UIDS)
const folderCoverage = z.object({
  uidValidity: z.string().regex(/^[1-9]\d*$/),
  verifiedAt: z.string(),
  days: z.record(uidList),
  futureUids: uidList,
}).strict()

export const mailboxSearchCoverageSchema = z.object({
  version: z.literal(1),
  ownerUserId: z.string().min(1),
  accountKey: z.string().min(1),
  archivedAfter: z.string().datetime(),
  completeRoster: z.boolean(),
  listedFolders: z.array(z.string()),
  folders: z.record(folderCoverage),
}).strict()

export type MailboxSearchCoverage = z.infer<typeof mailboxSearchCoverageSchema>

export const mailboxArchiveAccountSchema = z.object({
  accountKey: z.string().min(1),
  archivedAfter: z.string().datetime(),
  replaced: z.boolean(),
  seal: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export type MailboxArchiveAccount = z.infer<typeof mailboxArchiveAccountSchema>

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    const fields = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1)
    return '{' + fields.map(([name, entry]) => JSON.stringify(name) + ':' + canonicalJson(entry)).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function sealMailboxArchiveProof(
  key: Buffer, instanceId: string, purpose: 'account' | 'coverage', value: unknown,
): string {
  return createHmac('sha256', key).update(canonicalJson(['use-brian/mailbox-archive-v1', purpose, instanceId, value])).digest('hex')
}

export function readVerifiedMailboxArchiveAccount(raw: unknown, sign: (value: unknown) => string | null | undefined): MailboxArchiveAccount | null {
  const parsed = mailboxArchiveAccountSchema.safeParse(raw)
  if (!parsed.success) return null
  const { seal, ...claim } = parsed.data
  return sign(claim) === seal ? parsed.data : null
}

export function mailboxSearchAccountKey(settings: Pick<MailboxAccountSettings, 'email' | 'imapHost' | 'imapPort'>): string {
  return createHash('sha256').update(JSON.stringify([
    settings.email.trim().toLowerCase(), settings.imapHost.trim().toLowerCase(), settings.imapPort,
  ])).digest('hex')
}

function dateFromDay(day: string | undefined): Date | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const value = new Date(`${day}T00:00:00.000Z`)
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === day ? value : null
}

function dayString(date: number): string {
  return new Date(date).toISOString().slice(0, 10)
}

type FolderStatus = Awaited<ReturnType<ImapClientLike['status']>>
type FolderProof = z.infer<typeof folderCoverage>

async function captureFolder(input: {
  client: ImapClientLike
  path: string
  uidValidity: string
  observedAt: Date
  remaining: number
}): Promise<{ proof: FolderProof; status: FolderStatus } | null> {
  const { client, path, uidValidity, observedAt, remaining } = input
  const initial = await client.status(path, STATUS_FIELDS)
  if (!validStatus(initial, uidValidity)) return null
  const today = dateFromDay(dayString(observedAt.getTime()))!.getTime()
  const yesterday = today - DAY_MS
  const tomorrow = today + DAY_MS
  const lock = await client.getMailboxLock(path)
  try {
    // BEFORE the window and SINCE its end complete the disjoint partitions.
    // A failed, truncated or overlapping answer cannot agree with STATUS.
    const olderQuery = { before: new Date(yesterday) }
    let olderCount = await client.countSearch?.(olderQuery)
    let olderUids: Set<number> | undefined
    if (olderCount === undefined) {
      if (initial.messages > MAX_FOLDER_MESSAGES) return null
      const older = await client.search(olderQuery, { uid: true })
      if (!older) return null
      olderUids = new Set(older)
      olderCount = olderUids.size
      if (olderCount !== older.length) return null
    }
    if (olderCount === false || !Number.isSafeInteger(olderCount) || olderCount < 0
      || initial.messages - olderCount > remaining || olderCount > initial.messages) return null
    const previous = await client.search({ since: new Date(yesterday), before: new Date(today) }, { uid: true })
    const current = await client.search({ since: new Date(today), before: new Date(tomorrow) }, { uid: true })
    const future = await client.search({ since: new Date(tomorrow) }, { uid: true })
    if (!previous || !current || !future) return null
    const recent = [...previous, ...current, ...future]
    if (olderCount + recent.length !== initial.messages || new Set(recent).size !== recent.length
      || recent.some((id) => !Number.isSafeInteger(id) || id <= 0 || id >= initial.uidNext || olderUids?.has(id))) return null
    const final = await client.status(path, STATUS_FIELDS)
    if (!sameStatus(initial, final, uidValidity)) return null
    return { status: final, proof: {
      uidValidity,
      verifiedAt: observedAt.toISOString(),
      days: { [dayString(yesterday)]: previous, [dayString(today)]: current },
      futureUids: future,
    } }
  } finally {
    lock.release()
  }
}

function validStatus(status: FolderStatus, uidValidity: string): status is FolderStatus & { messages: number; uidNext: number } {
  return /^[1-9]\d*$/.test(uidValidity) && String(status.uidValidity) === uidValidity
    && typeof status.messages === 'number' && Number.isSafeInteger(status.messages) && status.messages >= 0
    && typeof status.uidNext === 'number' && Number.isSafeInteger(status.uidNext) && status.uidNext > 0
}

function sameStatus(first: FolderStatus, current: FolderStatus, uidValidity: string): boolean {
  return validStatus(current, uidValidity) && first.messages === current.messages && first.uidNext === current.uidNext
}

export async function captureMailboxSearchCoverage(input: {
  client: ImapClientLike
  listed: Awaited<ReturnType<ImapClientLike['list']>>
  paths: string[]
  getUidValidity(path: string): string | undefined
  ownerUserId: string
  settings: MailboxAccountSettings
  observedAt: Date
  archivedAfter: string
  now: () => Date
}): Promise<MailboxSearchCoverage | undefined> {
  if (input.paths.length === 0 || input.paths.length > MAX_FOLDERS || input.listed.length > 4 * MAX_FOLDERS) return
  const captured = new Map<string, { proof: FolderProof; status: FolderStatus }>()
  let remaining = MAX_RECENT_UIDS
  for (const path of input.paths) {
    const uidValidity = input.getUidValidity(path)
    if (!uidValidity) continue
    const result = await captureFolder({ client: input.client, path, uidValidity, observedAt: input.observedAt, remaining }).catch(() => null)
    if (!input.client.usable) return
    if (!result) continue
    const { proof } = result
    remaining -= Object.values(proof.days).reduce((sum, uids) => sum + uids.length, proof.futureUids.length)
    captured.set(path, result)
  }
  if (captured.size === 0) return
  const listedFolders = [...new Set(input.listed.map((folder) => folder.path))].sort()
  const observedAgain = await input.client.list()
  const samePaths = (first: string[], second: string[]) => JSON.stringify([...new Set(first)].sort()) === JSON.stringify([...new Set(second)].sort())
  if (!samePaths(listedFolders, observedAgain.map((folder) => folder.path))
    || !samePaths(syncableFolders(input.listed).map((folder) => folder.path), syncableFolders(observedAgain).map((folder) => folder.path))) return
  // All first observations precede this point and the final status sweep.
  // Matching endpoints give the entire retained cohort a common observation
  // time, including moves between folders during the initial pass.
  const commonAt = input.now()
  if (dayString(commonAt.getTime()) !== dayString(input.observedAt.getTime())) return
  const folders: Array<[string, FolderProof]> = []
  for (const [path, { proof, status }] of captured) {
    const final = await input.client.status(path, STATUS_FIELDS).catch(() => null)
    if (!input.client.usable) return
    if (final && sameStatus(status, final, proof.uidValidity)) folders.push([path, { ...proof, verifiedAt: commonAt.toISOString() }])
  }
  if (folders.length === 0) return
  return {
    version: 1,
    ownerUserId: input.ownerUserId,
    accountKey: mailboxSearchAccountKey(input.settings),
    archivedAfter: input.archivedAfter,
    completeRoster: folders.length === input.paths.length,
    listedFolders: [...new Set([...listedFolders, ...input.paths])],
    folders: Object.fromEntries(folders),
  }
}

export function selectMailboxSearchCoverage(input: {
  raw: unknown
  ownerUserId: string
  accountKey: string
  params: MailboxSearchParams
  now: Date
}): { coverage: MailboxSearchCoverage; verifiedAt: string; refs: Array<{ folder: string; id: string }> } | null {
  const parsed = mailboxSearchCoverageSchema.safeParse(input.raw)
  if (!parsed.success) return null
  const coverage = parsed.data
  if (coverage.ownerUserId !== input.ownerUserId || coverage.accountKey !== input.accountKey) return null
  if (input.params.live || input.params.archiveSince === null || input.params.from?.trim() || input.params.subject?.trim()
    || input.params.keywords?.some((term) => term.trim())) return null
  const { folder, before } = input.params
  const since = dateFromDay(input.params.since)
  const end = before === undefined ? null : dateFromDay(before)
  if (!since || before !== undefined && !end || end && end <= since) return null
  const names = folder ? [folder] : Object.keys(coverage.folders)
  if (names.length === 0 || names.length > MAX_FOLDERS || (!folder && !coverage.completeRoster)) return null
  if (names.some((name) => !coverage.listedFolders.includes(name))) return null

  const refs: Array<{ folder: string; id: string }> = []
  let oldest = input.now.getTime()
  for (const name of names) {
    if (!Object.hasOwn(coverage.folders, name)) return null
    const proof = coverage.folders[name]
    const observedAt = Date.parse(proof.verifiedAt)
    if (!Number.isFinite(observedAt) || observedAt > input.now.getTime() || input.now.getTime() - observedAt > MAX_AGE_MS) return null
    oldest = Math.min(oldest, observedAt)
    const today = dateFromDay(dayString(observedAt))!.getTime()
    const nextDay = today + DAY_MS
    const firstDay = since.getTime()
    const finalDay = end?.getTime() ?? nextDay
    if (firstDay < today - DAY_MS || firstDay > today || finalDay > nextDay) return null
    const uids = new Set<number>()
    for (let day = firstDay; day < finalDay; day += DAY_MS) {
      const selected = proof.days[dayString(day)]
      if (!selected) return null
      for (const id of selected) {
        if (uids.has(id)) return null
        uids.add(id)
      }
    }
    if (!end) {
      for (const id of proof.futureUids) {
        if (uids.has(id)) return null
        uids.add(id)
      }
    }
    for (const id of uids) refs.push({ folder: name, id: `${name}:${id}` })
    if (refs.length > MAX_RECENT_UIDS) return null
  }
  return { coverage, verifiedAt: new Date(oldest).toISOString(), refs }
}
