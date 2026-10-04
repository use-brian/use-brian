#!/usr/bin/env node
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const codes = new Set(['native_disabled','configuration_invalid','schema_unavailable','auth_session_denied','scope_denied','policy_denied','device_not_checked','device_busy','relay_unavailable','relay_disabled','accounting_unavailable','runtime_not_checked','model_unavailable','credits_blocked','budget_invalid','provider_unsupported','check_failed'])
const warnings = new Set(['jwt_compatibility_unverified','live_model_unverified','mac_verification_pending','vision_not_checked','vision_image_unsupported','vision_approval_unaccepted','vision_approval_mismatch','vision_budget_insufficient','native_strict_adapter_unverified'])
const fail = () => { throw new Error('Readiness check failed') }
export function parseArguments(args) {
  const values = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (Object.hasOwn(values, key)) fail()
    if (key === '--non-production' || key === '--backend-only') values[key] = true
    else if (['--api','--token-file','--workspace-id','--assistant-id','--conversation-id','--task-id','--device-id'].includes(key) && args[i+1] && !args[i+1].startsWith('--')) values[key] = args[++i]
    else fail()
  }
  if (!values['--non-production'] || !values['--token-file']) fail()
  const url = new URL(values['--api'])
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) fail()
  const context = {}
  for (const [flag, field] of [['workspace','workspaceId'],['assistant','assistantId'],['conversation','conversationId'],['task','taskId']]) {
    const value = values[`--${flag}-id`]
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '')) fail()
    context[field] = value
  }
  if (values['--backend-only']) {
    if (Object.hasOwn(values, '--device-id')) fail()
    context.backendOnly = true
  } else {
    context.deviceId = values['--device-id']
    if (typeof context.deviceId !== 'string' || !context.deviceId.length || context.deviceId.length > 256 || /[\x00-\x1f\x7f]/.test(context.deviceId)) fail()
  }
  return { endpoint: new URL('/api/native-computer/readiness', url), tokenFile: values['--token-file'], context }
}
export async function readToken(file, stdin = process.stdin) {
  let text
  if (file === '-') {
    if (stdin.isTTY) fail() // no echoed interactive credentials
    const chunks = []; let size = 0
    const timer = setTimeout(() => stdin.destroy(new Error('Input timeout')), 5000)
    try { for await (const chunk of stdin) { size += Buffer.byteLength(chunk); if (size > 8192) fail(); chunks.push(Buffer.from(chunk)) }
      text = Buffer.concat(chunks).toString('utf8')
    } finally { clearTimeout(timer) }
  } else {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) || !process.getuid || stat.uid !== process.getuid()) fail()
      const buffer = Buffer.alloc(8193)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 8192) fail()
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally { await handle.close() }
  }
  const token = text.trim()
  if (!token || token.length > 8192 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) fail()
  return token
}
export function validateReport(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'blockers,protocol,ready,warnings' ||
    value.protocol !== 'native-computer-v1' || typeof value.ready !== 'boolean' ||
    !Array.isArray(value.blockers) || value.blockers.length > 20 || value.blockers.some(c => !codes.has(c)) ||
    !Array.isArray(value.warnings) || value.warnings.length > 8 || value.warnings.some(c => !warnings.has(c)) ||
    value.ready !== (value.blockers.length === 0)) fail()
  return value
}
export async function checkReadiness(config, token, fetchImpl = fetch) {
  const response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(config.context), signal: AbortSignal.timeout(10000) })
  if (!response.ok || !response.body) { await response.body?.cancel(); fail() }
  const reader = response.body.getReader(); const chunks = []; let size = 0
  try { while (true) { const { done, value } = await reader.read(); if (done) break
    size += value.byteLength; if (size > 8192) fail(); chunks.push(value) }
  } finally { await reader.cancel() }
  const report = validateReport(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  // Never accept a server that silently treats backend-only as full readiness.
  if (config.context.backendOnly === true && !report.blockers.includes('device_not_checked')) fail()
  return report
}
export async function main(args) {
  try {
    const config = parseArguments(args)
    const report = await checkReadiness(config, await readToken(config.tokenFile))
    console.log(JSON.stringify(report))
    return report.ready ? 0 : 1
  } catch {
    console.error('Native readiness failed: check endpoint, authentication, input and connectivity. No response content retained.')
    return 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2))
