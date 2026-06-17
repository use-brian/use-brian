/**
 * Tiny `{name}` interpolation helper. Mirrors
 * `apps/web/src/lib/i18n/format.ts`.
 */
export function format(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined ? `{${key}}` : String(value);
  });
}
