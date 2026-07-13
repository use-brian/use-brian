/**
 * The self-heal distiller — v0 (R2-5): a WATCHED browser-use exploration's
 * trace compiles into a DRAFT logic-block, always automatically. The draft
 * is immediately usable and gated by default (its terminal sends queue as
 * async approvals until granted); hardening is an optional reliability
 * tune-up via Claude Code / the OSS authoring skill — a brittle draft
 * re-gates and re-heals, it never damages.
 *
 * v0 is a deterministic trace→code transformation, no model in the loop:
 *
 *   open     → runner.open(url) + runner.snapshot()
 *   click    → runner.submit(...) when the label is send-like (the terminal
 *              verbs stay terminal in the draft), else runner.find + click
 *   fill     → runner.find + runner.fill (literal text — parameterizing is
 *              a hardening step)
 *   scroll   → runner.scroll
 *   extract  → runner.log (the draft records what BU read; refining the
 *              extraction is hardening)
 *
 * The recording (storyboard) comes from the same trace; the effect contract
 * re-extracts from the generated code at save time.
 */
import { SEND_LIKE_LABEL_PATTERN } from './tools.js'
import type { BrowserSkillRecordingStep } from './browser-skills.js'
import type { BuTraceStep } from './types.js'

function pyString(value: string): string {
  return JSON.stringify(value)
}

export type DistilledBlock = {
  code: string
  recording: BrowserSkillRecordingStep[]
  description: string
}

export function distillTrace(params: {
  trace: BuTraceStep[]
  goal: string
  site: string
}): DistilledBlock {
  const lines: string[] = ['def run(runner, params):']
  const recording: BrowserSkillRecordingStep[] = []
  let emitted = 0
  let step = 0

  const emit = (line: string) => {
    lines.push(`    ${line}`)
    emitted += 1
  }

  for (const t of params.trace) {
    step += 1
    switch (t.action) {
      case 'open': {
        if (!t.url) break
        emit(`runner.open(${pyString(t.url)})`)
        emit('runner.snapshot()')
        recording.push({ step, action: 'open', url: t.url })
        break
      }
      case 'click': {
        if (!t.label) break
        if (SEND_LIKE_LABEL_PATTERN.test(t.label)) {
          // Terminal verbs stay terminal in the draft: the send routes
          // through the gate exactly as it did under watch.
          emit(
            `runner.submit(runner.find(${pyString(t.label)}), ${pyString(
              t.detail ?? `${t.label} (${params.goal.slice(0, 120)})`,
            )})`,
          )
          recording.push({ step, action: 'submit', url: t.url ?? null, detail: t.label })
        } else {
          emit(`runner.click(runner.find(${pyString(t.label)}))`)
          emit('runner.snapshot()')
          recording.push({ step, action: 'click', url: t.url ?? null, detail: t.label })
        }
        break
      }
      case 'fill': {
        if (!t.label) break
        emit(`runner.fill(runner.find(${pyString(t.label)}), ${pyString(t.text ?? '')})`)
        recording.push({ step, action: 'fill', url: t.url ?? null, detail: t.label })
        break
      }
      case 'scroll': {
        emit(`runner.scroll(${Number.parseInt(t.detail ?? '800', 10) || 800})`)
        recording.push({ step, action: 'scroll', url: t.url ?? null })
        break
      }
      case 'extract': {
        emit(`runner.log(${pyString(`extracted: ${(t.text ?? t.detail ?? '').slice(0, 200)}`)})`)
        recording.push({ step, action: 'extract', url: t.url ?? null, detail: t.text?.slice(0, 200) })
        break
      }
      case 'done': {
        if (t.text) emit(`return ${pyString(t.text.slice(0, 500))}`)
        recording.push({ step, action: 'done', detail: t.text?.slice(0, 200) })
        break
      }
    }
  }
  if (emitted === 0) emit('runner.log("empty trace - nothing to replay")')

  return {
    code: `${lines.join('\n')}\n`,
    recording,
    description: `Self-healed draft from a watched exploration: ${params.goal.slice(0, 200)}`,
  }
}

/** A stable, unique-ish block name from the exploration goal. */
export function skillNameFromGoal(goal: string, site: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const host = site.split('.')[0]
  return `${host}-${slug || 'exploration'}`
}
