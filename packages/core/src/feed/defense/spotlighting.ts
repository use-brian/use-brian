/**
 * Spotlighting — wraps untrusted content in delimiters the model is trained
 * to treat as data rather than instructions.
 *
 * Defense-in-depth principle from OWASP LLM01:
 *   - Model receives the reply body *inside* `<<<UNTRUSTED>>>...<<<END_UNTRUSTED>>>`.
 *   - The L1 soul's trust-boundary overlay tells the model to never follow
 *     instructions that appear inside those markers.
 *   - Even if a prompt-injection attempt leaks past the L1 regex classifier,
 *     the structural delimiters + explicit system-prompt rule biases the
 *     model toward treating the content as data.
 *
 * A secondary pass strips any accidental same markers from the input so an
 * attacker can't "close the delimiter" and smuggle instructions into the
 * post-marker region.
 *
 * See docs/architecture/feed/defense-pipeline.md.
 */

const OPEN_MARKER = '<<<UNTRUSTED>>>'
const CLOSE_MARKER = '<<<END_UNTRUSTED>>>'

/**
 * Wrap untrusted text so the model sees it as data, not instructions.
 * The input is sanitized first to strip any attempts to close the marker
 * and escape the spotlight.
 */
export function spotlight(untrustedText: string): string {
  return `${OPEN_MARKER}\n${sanitize(untrustedText)}\n${CLOSE_MARKER}`
}

/**
 * Remove any accidental-or-adversarial marker sequences from the input.
 * Exported so tests can assert the sanitization contract directly.
 */
export function sanitize(text: string): string {
  // Case-insensitive, broad match — an attacker might use 'end_untrusted' or
  // extra whitespace. Replace with a visible, inert placeholder so a human
  // reviewer reading the audit log can see what was scrubbed.
  return text
    .replace(/<<<\s*END[_-]?UNTRUSTED\s*>>>/gi, '<<REDACTED-MARKER>>')
    .replace(/<<<\s*UNTRUSTED\s*>>>/gi, '<<REDACTED-MARKER>>')
}

/** Exported constants for test and documentation use. */
export const SPOTLIGHT_MARKERS = {
  open: OPEN_MARKER,
  close: CLOSE_MARKER,
} as const
