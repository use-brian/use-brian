/** CLI entrypoint for the offline-first decision evaluator. */

import { runDecisionEvaluationCli } from '../src/decision-evaluation.js'

void runDecisionEvaluationCli().then(
  (code) => { process.exitCode = code },
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  },
)
