// Bootstrap refusal only: an unsigned helper rejects its own signature first.
// No request is sent; stdin stays open. Never evidence of parent authentication.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function bootstrapNegative(binary, { spawnChild = spawn, deadlineMs = 5000, killGraceMs = 1000, maxOutputBytes = 65536 } = {}) {
  return new Promise((resolveResult, reject) => {
    let child, timer, grace, settled = false, stopping = false, failure
    let outputBytes = 0
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(grace)
      // These streams belong only to this test child. Never close stdin on a success path before close.
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy()
      if (error) reject(error)
      else resolveResult({ code: 77, stdoutBytes: 0 })
    }
    function stop(error) {
      if (settled) return
      failure ??= error
      if (stopping) return
      stopping = true
      grace = setTimeout(() => {
        child?.unref?.()
        finish(new Error(`${failure.message}; child close not observed after SIGKILL (pid ${child?.pid ?? 'unknown'}); check locally for a surviving child`))
      }, killGraceMs)
      try {
        if (!child.kill('SIGKILL')) failure = new Error(`${failure.message}; SIGKILL was not delivered`)
      } catch (error) {
        failure = new Error(`${failure.message}; SIGKILL failed: ${error.message}`)
      }
    }
    try {
      child = spawnChild(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    } catch (error) { finish(error); return }
    // Do not retain output or forward arbitrary native output into terminal/logs.
    child.stdout.on('data', data => {
      outputBytes += data.length
      stop(new Error(`Unexpected stdout during bootstrap refusal (${outputBytes} bytes)`))
    })
    child.stderr.on('data', data => {
      outputBytes += data.length
      if (outputBytes > maxOutputBytes) stop(new Error('Bootstrap output limit exceeded'))
    })
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', error => stop(new Error(`Bootstrap stream error: ${error.message}`)))
    }
    // A harness-induced stdin EOF must never turn into a successful refusal.
    child.stdin.on('finish', () => stop(new Error('Bootstrap stdin ended before refusal was established')))
    child.on('error', error => stop(new Error(`Bootstrap spawn/process error: ${error.message}`)))
    // exit is deliberately NOT success: stdout can still arrive before close.
    child.on('close', (code, signal) => {
      if (failure) { finish(failure); return }
      if (code !== 77 || signal != null || child.stdin.writableEnded) {
        finish(new Error(`Expected bootstrap refusal exit 77 with input open; got code ${code}, signal ${signal}`))
      } else finish()
    })
    timer = setTimeout(() => stop(new Error('Bootstrap refusal deadline exceeded')), deadlineMs)
  })
}

export async function bootstrapNegativeCLI(args = process.argv.slice(2)) {
  if (process.platform !== 'darwin') throw new Error('Bootstrap refusal CLI requires macOS; fake-child tests are portable')
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20+ required')
  if (args.length !== 1 || args[0].startsWith('-')) throw new Error('Usage: node bootstrap-negative.mjs /absolute/path/to/brian-native-computer-helper')
  await bootstrapNegative(resolve(args[0]))
  console.log('PASS negative bootstrap refusal: exit 77, no stdout, stdin held open through refusal. NOT proof of parent trust; unsigned self-signature rejects first. No native operational acceptance.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrapNegativeCLI().catch(error => { console.error(error.message); process.exitCode = 1 })
}
