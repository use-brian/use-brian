/** Wire validation deliberately independent of core (extension ships without zod). */
export type FormField =
  | { action: 'fill'; ref: string; value: string }
  | { action: 'select'; ref: string; value: string }
  | { action: 'check'; ref: string; checked: boolean }
export type FillFormResult = { fields: Array<{ ref: string; status: 'success' | 'failed' | 'skipped'; error?: string }> }

export function parseFormFields(args: unknown): FormField[] {
  const invalid = () => { throw new Error('Invalid fillForm arguments: expected 1–50 typed fields.') }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return invalid()
  if (Object.keys(args).some(k => k !== 'fields')) return invalid()
  const fields = (args as { fields?: unknown }).fields
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 50) return invalid()
  const refs = new Set<string>()
  return fields.map(f => {
    if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.ref !== 'string' || !f.ref) return invalid()
    if (refs.has(f.ref)) return invalid()
    refs.add(f.ref)
    const check = f.action === 'check'
    if (!check && f.action !== 'fill' && f.action !== 'select') return invalid()
    if (Object.keys(f).some(k => !['action', 'ref', check ? 'checked' : 'value'].includes(k))) return invalid()
    if (check ? typeof f.checked !== 'boolean' : typeof f.value !== 'string' || f.value.length > 20000) return invalid()
    return check ? { action: 'check', ref: f.ref, checked: f.checked } : { action: f.action, ref: f.ref, value: f.value }
  })
}

/** Runs on the resolved node, using native prototype setters for controlled text inputs.
 * React checkbox/radio onChange commonly depends on click, not input/change.
 * Only validated native checkbox/radio controls may use native click, so React
 * receives its click-driven change event. Never click arbitrary buttons/links/submit
 * controls, and never add synthetic input/change events after native activation.
 */
export function formFieldOperation(
  this: HTMLElement,
  field: FormField,
  mode: 'validate' | 'set' | 'verify',
  resolvedSelectValue?: string,
): string | null | { selectedValue: string } {
  const el = this as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  const win = el.ownerDocument.defaultView!
  if (!el.isConnected || el.ownerDocument !== win.document) return 'Target is no longer attached; take a fresh snapshot.'
  if (el.matches(':disabled') || ('readOnly' in el && el.readOnly)) return 'Target is disabled or read-only.'
  let proto: object
  let expected: string | boolean = field.action === 'check' ? field.checked : field.value
  if (field.action === 'fill') {
    if (el instanceof win.HTMLTextAreaElement) proto = win.HTMLTextAreaElement.prototype
    else if (el instanceof win.HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time'].includes(el.type)) proto = win.HTMLInputElement.prototype
    else return 'Fill requires a native text input or textarea.'
  } else if (field.action === 'select') {
    if (!(el instanceof win.HTMLSelectElement) || el.multiple) return 'Select requires a native single-select.'
    const options = Array.from(el.options)
    const enabled = (o: HTMLOptionElement) => !o.disabled && !o.parentElement?.matches('optgroup:disabled')
    // AX exposes human labels. Prefer exact values; only when no value matches,
    // accept a unique enabled exact label/text match (trim surrounding whitespace).
    // Never reinterpret a disabled value as some other option's label.
    const requested = resolvedSelectValue ?? field.value
    let matches = options.filter(o => o.value === requested)
    if (matches.length === 0 && resolvedSelectValue === undefined) {
      matches = options.filter(o => enabled(o) && (o.label.trim() === requested.trim() || o.text.trim() === requested.trim()))
    }
    if (matches.length > 1) return 'Requested option is ambiguous; use a unique option value.'
    const option = matches[0]
    if (!option || !enabled(option)) return 'Requested option is unavailable.'
    expected = option.value
    proto = win.HTMLSelectElement.prototype
  } else {
    if (!(el instanceof win.HTMLInputElement) || !['checkbox', 'radio'].includes(el.type)) return 'Check requires a native checkbox or radio.'
    if (el.type === 'radio' && !field.checked && el.checked) return 'A checked radio cannot be safely unchecked directly; select another radio instead.'
    proto = win.HTMLInputElement.prototype
  }
  if (mode === 'validate') return null
  const property = field.action === 'check' ? 'checked' : 'value'
  if (mode === 'set') {
    // Preflight/verification never scroll, focus, or install presentation DOM.
    // Instant scrolling avoids a site's smooth-scroll CSS racing the write.
    el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
    el.focus({ preventScroll: true });
    // Focus handlers may replace or disable the retained node. Never retarget.
    const invalid = formFieldOperation.call(el, field, 'validate', resolvedSelectValue);
    if (invalid !== null) return invalid;
    try {
      const cursor = (win as unknown as Record<symbol, { showTarget(target: Element): void } | undefined>)[Symbol.for('use-brian.action-cursor.v1')];
      cursor?.showTarget(el);
    } catch { /* Cosmetic feedback must not prevent a native operation. */ }
    if (field.action === 'check') {
      if ((el as HTMLInputElement).checked !== field.checked) win.HTMLElement.prototype.click.call(el)
    } else {
      Object.getOwnPropertyDescriptor(proto, property)!.set!.call(el, expected)
      el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }))
      el.dispatchEvent(new win.Event('change', { bubbles: true }))
    }
  }
  if (!el.isConnected) return 'Target was replaced during filling; take a fresh snapshot.'
  if ((el as unknown as Record<string, unknown>)[property] !== expected) return 'Field did not retain the requested value.'
  // Keep the concrete value across immediate/final verification; a later label
  // change must not silently redirect verification to a different option.
  return field.action === 'select' && mode === 'set' ? { selectedValue: expected as string } : null
}
