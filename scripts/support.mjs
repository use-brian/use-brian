#!/usr/bin/env node

/**
 * Headless companion to Settings → Privacy → Support Mode.
 *
 * The API must already be running (`pnpm start`). The script authenticates as
 * the local OSS owner through the same local-session endpoint as app-web; it
 * never reads or prints the persisted JWT secret.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const API_URL = process.env.API_URL || 'http://localhost:4000'
const args = process.argv.slice(2)
const command = args[0] || 'status'

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function has(name) {
  return args.includes(name)
}

async function request(path, init = {}) {
  const response = await fetch(`${API_URL}${path}`, init)
  if (response.ok) return response
  const body = await response.json().catch(() => ({}))
  throw new Error(body.error || `Request failed (${response.status})`)
}

async function authenticate() {
  const response = await request('/auth/local-session', { method: 'POST' })
  const body = await response.json()
  if (!body.accessToken) throw new Error('The local owner session returned no access token')
  return body.accessToken
}

async function resolveWorkspace(accessToken) {
  const explicit = option('--workspace')
  if (explicit) return explicit
  const response = await request('/api/workspaces', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const body = await response.json()
  const workspaces = Array.isArray(body) ? body : body.workspaces
  if (!Array.isArray(workspaces) || !workspaces[0]?.id) {
    throw new Error('No workspace found. Open Use Brian once to provision the local workspace.')
  }
  return workspaces[0].id
}

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
}

function printHelp() {
  console.log(`Usage:
  pnpm support status [--workspace ID]
  pnpm support start [--duration 1|24|168] [--include-content] [--workspace ID]
  pnpm support preview [--workspace ID]
  pnpm support download [--output FILE] [--workspace ID]
  pnpm support stop [--workspace ID]

Support Mode is local-only. Downloading a capsule ends the capture and deletes
its stored diagnostic events.`)
}

if (command === 'help' || has('--help') || has('-h')) {
  printHelp()
  process.exit(0)
}

try {
  const accessToken = await authenticate()
  const workspaceId = await resolveWorkspace(accessToken)
  const headers = authHeaders(accessToken)

  if (command === 'status') {
    const response = await request(
      `/api/support-diagnostics/status?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers },
    )
    const status = await response.json()
    if (!status.active) {
      console.log('Support Mode is not active.')
    } else {
      console.log(`Support Mode is active until ${status.capture.expiresAt}.`)
      console.log(`${status.capture.eventCount} sanitized log events captured.`)
      console.log(`Session content: ${status.capture.includeContent ? 'included' : 'omitted'}.`)
    }
  } else if (command === 'start') {
    const durationHours = Number(option('--duration') || '24')
    if (![1, 24, 168].includes(durationHours)) {
      throw new Error('--duration must be 1, 24, or 168')
    }
    const response = await request('/api/support-diagnostics/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId,
        durationHours,
        includeContent: has('--include-content'),
      }),
    })
    const status = await response.json()
    console.log(`Support Mode started. It ends at ${status.capture.expiresAt}.`)
    console.log('Reproduce the problem, then run `pnpm support preview`.')
  } else if (command === 'preview') {
    const response = await request('/api/support-diagnostics/capsule/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceId }),
    })
    const preview = await response.json()
    console.log(`Content: ${preview.includeContent ? 'selected session content included' : 'message content omitted'}`)
    for (const category of preview.categories) {
      console.log(`  ${category.name}: ${category.count}`)
    }
    console.log('Run `pnpm support download` to save the capsule and end Support Mode.')
  } else if (command === 'download') {
    const response = await request('/api/support-diagnostics/capsule', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceId }),
    })
    const disposition = response.headers.get('content-disposition') || ''
    const suggested = disposition.match(/filename="([^"]+)"/)?.[1] ||
      `brian-support-capsule-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    const output = resolve(option('--output') || suggested)
    writeFileSync(output, Buffer.from(await response.arrayBuffer()), { flag: 'wx' })
    console.log(`Capsule saved to ${output}`)
    console.log('Support Mode ended and the local capture was deleted.')
  } else if (command === 'stop') {
    await request('/api/support-diagnostics/active', {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ workspaceId }),
    })
    console.log('Support Mode stopped and its local capture was deleted.')
  } else {
    printHelp()
    process.exitCode = 1
  }
} catch (error) {
  console.error(`[support] ${error?.message || error}`)
  console.error(`Make sure the OSS API is running at ${API_URL}.`)
  process.exitCode = 1
}
