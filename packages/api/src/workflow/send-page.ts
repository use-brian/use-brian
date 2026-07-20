/**
 * `send_page` port implementation — the deterministic verbatim-send pipeline
 * behind page-action buttons (`ExecutorDeps.sendPage`). NO model call
 * anywhere: the email body is the page's markdown export, byte-for-byte what
 * the human read and edited before clicking Send.
 *
 * Pipeline (each exit typed, never silent — the send-step incident rule):
 *   1. page meta (workspace match + title) → `page_not_found`
 *   2. egress clearance gate: page or record `confidential` → `egress_blocked`
 *   3. to/subject from the page's blueprint record fields or literals
 *      → `record_not_found` / `missing_recipient`
 *   4. body = `blocksToMarkdown(page)` (body only; the title feeds nothing —
 *      subject comes from the record/literal) → `empty_page`
 *   5. `page_send_log` claim (at-most-once) → `already_sent` no-op success /
 *      `send_in_flight`
 *   6. Gmail send through the factored seam → `gmail_not_connected`, or
 *      throw (executor maps to `send_failed`); every post-claim failure
 *      releases the claim via `markFailed` so a retry can re-claim
 *   7. ledger `markSent` + best-effort record stamp-back (`status`/`sent_at`,
 *      only keys the record's contract actually declares — never pollutes
 *      `fields` with undeclared keys)
 *
 * The button-trigger gate lives in core (`dispatchSendPage`) off the run row.
 * Connector-action audit emission is a closed-overlay wrap (the open build's
 * durable trail is the ledger row itself); see
 * docs/architecture/features/page-actions.md.
 *
 * [COMP:workflow/send-page-port]
 */

import { createHash } from 'node:crypto'

import {
  blocksToMarkdown,
  type DocPageStore,
  type ExecutorDeps,
  type SendPageResult,
} from '@use-brian/core'

import type { BlueprintRecordStore } from '../db/blueprint-records-store.js'
import type { PageSendLogStore } from '../db/page-send-log-store.js'
import type { AcquireGmailSender } from '../google/send-seam.js'

type PageMetaReader = {
  getById(
    userId: string,
    id: string,
  ): Promise<{ id: string; workspaceId: string; name: string; clearance: string } | null>
}

export type SendPagePortDeps = {
  savedViewStore: PageMetaReader
  docPageStore: Pick<DocPageStore, 'getVersionedPage'>
  blueprintRecordStore: Pick<BlueprintRecordStore, 'getByPageId' | 'mergeFields'>
  pageSendLog: PageSendLogStore
  acquireGmailSender: AcquireGmailSender
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function createSendPagePort(deps: SendPagePortDeps): NonNullable<ExecutorDeps['sendPage']> {
  return async (params): Promise<SendPageResult> => {
    const { userId, workspaceId, pageId } = params

    // 1. Page meta — RLS proves visibility; workspace must match the run's.
    const view = await deps.savedViewStore.getById(userId, pageId)
    if (!view || view.workspaceId !== workspaceId) {
      return {
        status: 'blocked',
        reason: 'page_not_found',
        message: `Page ${pageId} was not found in this workspace.`,
      }
    }

    // 2. Egress clearance gate (page side; the record side is checked below).
    if (view.clearance === 'confidential') {
      return {
        status: 'blocked',
        reason: 'egress_blocked',
        message: `"${view.name}" is confidential and cannot be sent outside the workspace.`,
      }
    }

    // 3. Recipient + subject. recordField values resolve against the page's
    // blueprint record; literals arrive pre-interpolated from the executor.
    const needsRecord = 'recordField' in params.to || 'recordField' in params.subject
    const record = needsRecord
      ? await deps.blueprintRecordStore.getByPageId(userId, workspaceId, pageId)
      : null
    if (needsRecord && !record) {
      return {
        status: 'blocked',
        reason: 'record_not_found',
        message: `"${view.name}" has no blueprint record, so recordField values cannot resolve. Save the record (or use literal to/subject).`,
      }
    }
    if (record && record.sensitivity === 'confidential') {
      return {
        status: 'blocked',
        reason: 'egress_blocked',
        message: `The record behind "${view.name}" is confidential and cannot be sent outside the workspace.`,
      }
    }

    const resolveValue = (
      src: { recordField: string } | { literal: string },
      what: 'recipient' | 'subject',
    ): { ok: true; value: string } | { ok: false; message: string } => {
      if ('literal' in src) {
        const v = src.literal.trim()
        return v
          ? { ok: true, value: v }
          : { ok: false, message: `The ${what} literal resolved to an empty string.` }
      }
      const raw = record?.fields?.[src.recordField]
      const v = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
      return v
        ? { ok: true, value: v }
        : {
            ok: false,
            message: `Record field "${src.recordField}" is empty on "${view.name}" — cannot resolve the ${what}.`,
          }
    }

    const to = resolveValue(params.to, 'recipient')
    if (!to.ok) return { status: 'blocked', reason: 'missing_recipient', message: to.message }
    if (!EMAIL_RE.test(to.value)) {
      return {
        status: 'blocked',
        reason: 'missing_recipient',
        message: `"${to.value}" is not an email address.`,
      }
    }
    const subject = resolveValue(params.subject, 'subject')
    if (!subject.ok) {
      return { status: 'blocked', reason: 'missing_recipient', message: subject.message }
    }

    // 4. Body — the page content, verbatim.
    const doc = await deps.docPageStore.getVersionedPage(userId, pageId)
    if (!doc) {
      return {
        status: 'blocked',
        reason: 'page_not_found',
        message: `Page ${pageId} has no document content.`,
      }
    }
    const body = blocksToMarkdown(doc.page).trim()
    if (!body) {
      return {
        status: 'blocked',
        reason: 'empty_page',
        message: `"${view.name}" is empty — nothing to send.`,
      }
    }

    // 5. At-most-once claim, BEFORE any network call.
    const claim = await deps.pageSendLog.claim(userId, {
      workspaceId,
      pageId,
      workflowId: params.workflowId,
      runId: params.runId,
      recipient: to.value,
      subject: subject.value,
      bodyHash: createHash('sha256').update(body).digest('hex'),
    })
    if (claim.outcome === 'already_sent') {
      return { status: 'already_sent', recipient: claim.recipient, sentAt: claim.sentAt }
    }
    if (claim.outcome === 'in_flight') {
      return {
        status: 'blocked',
        reason: 'send_in_flight',
        message: `A send for "${view.name}" is already in flight.`,
      }
    }

    // 6. Send. Every failure past this point releases the claim.
    try {
      const sender = await deps.acquireGmailSender({
        userId,
        ...(params.instanceId ? { instanceId: params.instanceId } : {}),
      })
      if (!sender.ok) {
        await deps.pageSendLog.markFailed(userId, claim.claimId, sender.message)
        return { status: 'blocked', reason: 'gmail_not_connected', message: sender.message }
      }
      const sent = await sender.send({ to: to.value, subject: subject.value, body })

      // 7. Ledger + best-effort stamp-back (contract-declared keys only).
      await deps.pageSendLog.markSent(userId, claim.claimId, sent.id ?? null)
      if (record) {
        const declared = new Set(record.specSnapshot.map((f) => f.key))
        const stamp: Record<string, unknown> = {}
        if (declared.has('status')) stamp.status = 'sent'
        if (declared.has('sent_at')) stamp.sent_at = new Date().toISOString().slice(0, 10)
        if (Object.keys(stamp).length > 0) {
          await deps.blueprintRecordStore
            .mergeFields(userId, record.id, stamp)
            .catch((err) => console.warn('[send-page] record stamp-back failed:', err))
        }
      }
      return {
        status: 'sent',
        recipient: to.value,
        subject: subject.value,
        externalId: sent.id ?? null,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await deps.pageSendLog
        .markFailed(userId, claim.claimId, message)
        .catch((e) => console.error('[send-page] failed to release claim:', e))
      throw err
    }
  }
}
