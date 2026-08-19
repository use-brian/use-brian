#!/usr/bin/env node
/**
 * Convert a WeChat `conversations.json` export into the `wechat-jsonl` format
 * the brian-message-store importer reads (one WeChatRow per line).
 *
 *   node wechat-export-to-jsonl.mjs <conversations.json> [out.jsonl] [account-wxid]
 *
 * - <conversations.json>  the export file (a list of conversations, each with
 *                         `talker_username`, `is_group`, and `messages[]`).
 * - [out.jsonl]           output path (default: <export-dir>/wechat.jsonl).
 * - [account-wxid]        the exporting account's own wxid. If omitted, it is
 *                         read from the sibling `index.md` (`account: wxid_...`).
 *                         Needed so the owner's own messages map to is_sender=1.
 *
 * Then import (see docs/runbooks/wechat-personal-account-local.md):
 *   brian-message-store import --source wechat-jsonl --file wechat.jsonl \
 *     --instance-id <uuid> --workspace-id <ws> --owner-user-id <owner> \
 *     --database-url "$BRIAN_MESSAGE_STORE_DATABASE_URL"
 *
 * No dependencies (Node >= 18). The importer synthesizes a stable, dedup-safe
 * id from each row (talker + create_time + sender + content), so re-running the
 * whole pipeline is idempotent.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const [, , srcArg, outArg, accountArg] = process.argv
if (!srcArg) {
  console.error('usage: node wechat-export-to-jsonl.mjs <conversations.json> [out.jsonl] [account-wxid]')
  process.exit(2)
}
const src = resolve(srcArg)
const out = outArg ? resolve(outArg) : join(dirname(src), 'wechat.jsonl')

// The exporting account's own wxid: owner-side messages carry is_sender=1.
let account = accountArg
if (!account) {
  const indexMd = join(dirname(src), 'index.md')
  if (existsSync(indexMd)) {
    const m = readFileSync(indexMd, 'utf8').match(/account:\s*([A-Za-z0-9_@.-]+)/)
    if (m) account = m[1]
  }
}
if (!account) {
  console.error('could not determine the exporting account wxid: pass it as the 3rd arg, or add `account: wxid_...` to index.md')
  process.exit(2)
}

// WeChat message types that are system notices, not conversation content.
// Dropped here to match the live channel's behaviour.
const SYSTEM_TYPES = new Set([10000, 10002])

const convs = JSON.parse(readFileSync(src, 'utf8'))
if (!Array.isArray(convs)) {
  console.error('expected the export to be a JSON array of conversations')
  process.exit(2)
}

let written = 0
let skipped = 0
const lines = []
for (const conv of convs) {
  const talker = conv.talker_username || conv.talker || ''
  if (!talker) { skipped += (conv.messages?.length ?? 0); continue }
  for (const msg of conv.messages ?? []) {
    const type = Number(msg.type ?? 1)
    if (SYSTEM_TYPES.has(type)) { skipped++; continue }
    const createTime = Number(msg.timestamp ?? 0)
    if (!createTime) { skipped++; continue }
    const fromMe = msg.from_me === true
    const senderId = fromMe ? account : (msg.sender_username || msg.sender || 'unknown')
    const text = msg.text ?? ''
    lines.push(JSON.stringify({
      local_id: Number(msg.id ?? 0),
      msg_svr_id: 0,                  // 0 -> importer synthesizes a stable dedup id
      talker,                         // conversation id
      sender_id: senderId,
      sender_display: msg.sender || '',
      type,                           // raw WeChat type (1 text, 3 image, 34 voice, 43 video, 47 sticker, 49 appmsg/link)
      sub_type: 0,
      is_sender: fromMe ? 1 : 0,
      create_time: createTime,
      str_content: text,
      body_text: text,
    }))
    written++
  }
}

writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''))
console.log(`wrote ${written} rows, skipped ${skipped} (system/undated) -> ${out}`)
console.log(`account (owner side): ${account}`)
