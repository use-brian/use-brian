// Project a numbered capture migration's reviewed body edits into the portable
// verifier. The caller pins the migration bytes before invoking this function.
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'

const encoded = text => JSON.stringify(text).slice(1, -1).replaceAll("'", "''")
const guardSlot = '__CAPTURE_GUARD_FINGERPRINT__'

export function updateCaptureVerifier(sql, original, numbered, members) {
  const replacements = [...numbered.matchAll(/\$before\$([\s\S]*?)\$before\$,\s*\$after\$([\s\S]*?)\$after\$/g)]
  const used = new Set()
  for (const name of members) {
    const definition = original.split('CREATE OR REPLACE FUNCTION public.' + name + '(')
    if (definition.length !== 2) throw Error('conversation_capture_original_missing')
    const body = definition[1].split('AS $function$')[1].split('$function$;')[0]
    for (const part of body.split(guardSlot)) {
      let updated = part
      for (const replacement of replacements) {
        const [, before, after] = replacement
        if (!updated.includes(before)) continue
        if (used.has(replacement) || updated.split(before).length !== 2) throw Error('conversation_capture_delta_ambiguous')
        used.add(replacement)
        updated = updated.replace(before, () => after)
      }
      if (updated === part) continue
      const reference = encoded(part)
      if (sql.split(reference).length !== 2) throw Error('conversation_capture_reference_changed')
      sql = sql.replace(reference, () => encoded(updated))
    }
  }
  if (!used.size || used.size !== replacements.length) throw Error('conversation_capture_delta_missing')
  assertAuthenticationReadOnly(sql)
  return sql
}
