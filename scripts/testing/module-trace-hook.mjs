/**
 * Runtime module trace for the M4 import receipt
 * (docs/plans/oss-chat-m4-runtime-separation-plan.md section 5.2).
 *
 *   BRIAN_MODULE_TRACE_DIR=/tmp/trace node --import ./scripts/testing/module-trace-hook.mjs apps/api/dist/index.js --no-workers
 *
 * Registers a synchronous `module.registerHooks` load hook (Node >= 22.15)
 * that records every module URL the process loads, ESM and CommonJS alike.
 * On SIGUSR2 it writes one labelled snapshot to `$BRIAN_MODULE_TRACE_DIR`:
 * `<seq>-<label>.json`. The label is read from `$BRIAN_MODULE_TRACE_DIR/.label`
 * (the driver writes it before signalling), else `snapshot`. The hook never
 * changes what is loaded and adds no timers, so it cannot keep the process
 * alive. Without `BRIAN_MODULE_TRACE_DIR` it is inert.
 *
 * [COMP:invariants/chat-import-graph]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'

const dir = process.env.BRIAN_MODULE_TRACE_DIR
if (dir) {
  if (typeof registerHooks !== 'function') {
    throw new Error(`module-trace-hook needs module.registerHooks (Node >= 22.15); running ${process.version}`)
  }
  mkdirSync(dir, { recursive: true })
  const started = performance.now()
  /** url → first-load order index */
  const loaded = new Map()
  registerHooks({
    load(url, context, nextLoad) {
      if (!loaded.has(url)) loaded.set(url, loaded.size)
      return nextLoad(url, context)
    },
  })

  let seq = 0
  const classify = (url) => {
    if (url.startsWith('node:')) return 'builtin'
    if (url.includes('/node_modules/')) return 'npm'
    return url.startsWith('file:') ? 'workspace' : 'other'
  }
  const npmName = (url) => {
    const tail = url.slice(url.lastIndexOf('/node_modules/') + '/node_modules/'.length).split('/')
    return tail[0].startsWith('@') ? `${tail[0]}/${tail[1]}` : tail[0]
  }

  process.on('SIGUSR2', () => {
    let label = 'snapshot'
    try { label = readFileSync(join(dir, '.label'), 'utf8').trim() || label } catch { /* default */ }
    const urls = [...loaded.keys()].sort()
    const counts = { builtin: 0, npm: 0, workspace: 0, other: 0 }
    const npm = new Set()
    for (const url of urls) {
      const kind = classify(url)
      counts[kind]++
      if (kind === 'npm') npm.add(npmName(url))
    }
    const mem = process.memoryUsage()
    const snapshot = {
      tool: 'use-brian/scripts/testing/module-trace-hook.mjs',
      schema: 1,
      label,
      seq,
      pid: process.pid,
      node: process.version,
      elapsedMs: Math.round(performance.now() - started),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      loadedCount: urls.length,
      counts,
      npmPackages: [...npm].sort(),
      urls,
    }
    const name = `${String(seq).padStart(3, '0')}-${label.replace(/[^\w.-]+/g, '_')}.json`
    seq++
    writeFileSync(join(dir, name), JSON.stringify(snapshot, null, 2) + '\n')
  })
}
