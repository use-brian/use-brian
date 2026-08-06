/**
 * Brand draft editor — the pure record ↔ form conversions.
 *
 * Split out of `studio/brand/page.tsx` so the risky half is unit-testable:
 * app-web's vitest is node-only (no hook renderer), and the failure that
 * actually matters here is a LOSSY ROUND TRIP. The form renders a subset of
 * the record as friendly fields and the rest as JSON; if converting back
 * dropped a group, saving the form would silently delete brand data a
 * colleague entered somewhere else.
 *
 * The guard is structural: `formToPatch` only ever emits the groups the form
 * actually owns, and the page sends a PATCH (`BrandRecordPatchSchema`), not a
 * whole record. A group the form does not render is therefore never in the
 * payload, so the server leaves it alone.
 *
 * Line-based fields use a `|`-separated shape rather than nested inputs. That
 * is a deliberate v1 trade: the record's list items are 3-4 short fields each,
 * a repeater UI for six such lists is a lot of surface for an editor most
 * workspaces touch a handful of times, and a malformed line fails validation
 * server-side with a field path rather than being stored.
 *
 * [COMP:app-web/studio-brand]
 */

/** The record shape this module reads. Structurally typed to avoid a
 *  build-time dependency on the server bundle for a form helper. */
export type BrandRecordLike = {
  naming?: Record<string, unknown>;
  strategy?: Record<string, unknown>;
  messaging?: Record<string, unknown>;
  colors?: unknown[];
  typography?: unknown[];
  logoVariants?: unknown[];
  visual?: Record<string, unknown>;
  applications?: unknown[];
  claims?: unknown[];
  rights?: unknown[];
  governance?: Record<string, unknown>;
  sources?: unknown[];
};

/** Groups the friendly form owns. Everything else rides the JSON editor. */
export const FORM_GROUPS = ["naming", "strategy", "messaging", "colors", "typography"] as const;

/** Groups the JSON editor owns — the long tail, per the v1 scope. */
export const JSON_GROUPS = [
  "logoVariants",
  "visual",
  "applications",
  "claims",
  "rights",
  "governance",
  "sources",
] as const;

export type BrandFormState = {
  name: string;
  publicName: string;
  descriptor: string;
  tagline: string;
  capitalization: string;
  restrictedTerms: string;
  positioning: string;
  audience: string;
  differentiators: string;
  oneLine: string;
  elevator: string;
  voice: string;
  preferred: string;
  avoid: string;
  colors: string;
  typography: string;
  /** The long-tail groups, pretty-printed as one JSON object. */
  advancedJson: string;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join("\n") : "");

/** Split a textarea into trimmed, non-empty lines. */
export function toLines(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Split a `a | b | c` line into trimmed cells, padded to `arity`. */
function cells(line: string, arity: number): string[] {
  const parts = line.split("|").map((c) => c.trim());
  while (parts.length < arity) parts.push("");
  return parts.slice(0, arity);
}

function joinCells(...values: unknown[]): string {
  return values.map((v) => (typeof v === "string" ? v : "")).join(" | ");
}

export function recordToForm(record: BrandRecordLike | null): BrandFormState {
  const naming = record?.naming ?? {};
  const strategy = record?.strategy ?? {};
  const messaging = record?.messaging ?? {};
  const advanced: Record<string, unknown> = {};
  for (const g of JSON_GROUPS) {
    const value = record?.[g];
    // Empty arrays and absent groups both render as "nothing here" rather
    // than as noise the user has to read past every time.
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    advanced[g] = value;
  }
  return {
    name: str(naming.name),
    publicName: str(naming.publicName),
    descriptor: str(naming.descriptor),
    tagline: str(naming.tagline),
    capitalization: str(naming.capitalization),
    restrictedTerms: list(naming.restrictedTerms),
    positioning: str(strategy.positioning),
    audience: list(strategy.audience),
    differentiators: list(strategy.differentiators),
    oneLine: str(messaging.oneLine),
    elevator: str(messaging.elevator),
    voice: Array.isArray(messaging.voice)
      ? messaging.voice
          .map((v) => {
            const t = v as Record<string, unknown>;
            return joinCells(t?.trait, t?.means, t?.avoid);
          })
          .join("\n")
      : "",
    preferred: list(messaging.preferred),
    avoid: list(messaging.avoid),
    colors: Array.isArray(record?.colors)
      ? record.colors
          .map((c) => {
            const t = c as Record<string, unknown>;
            return joinCells(t?.name, t?.token, t?.value, t?.role);
          })
          .join("\n")
      : "",
    typography: Array.isArray(record?.typography)
      ? record.typography
          .map((t0) => {
            const t = t0 as Record<string, unknown>;
            return joinCells(t?.role, t?.family, t?.treatment, t?.fallback);
          })
          .join("\n")
      : "",
    advancedJson: Object.keys(advanced).length > 0 ? JSON.stringify(advanced, null, 2) : "",
  };
}

export type BrandPatchResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: "advanced_json" };

/**
 * Build the PATCH body from the form.
 *
 * Only the five friendly groups plus whatever keys the JSON editor actually
 * contains are emitted. A group the user never touched and the form does not
 * render is absent from the patch, so the server leaves it untouched — that
 * is what makes a partial editor safe against a fuller record.
 *
 * Optional scalar fields are omitted when blank rather than sent as `""`: the
 * record schema requires non-empty strings, so an empty box means "not set",
 * not "set to empty".
 */
export function formToPatch(form: BrandFormState): BrandPatchResult {
  const naming: Record<string, unknown> = { name: form.name.trim() };
  const setIf = (target: Record<string, unknown>, key: string, value: string) => {
    const v = value.trim();
    if (v.length > 0) target[key] = v;
  };
  setIf(naming, "publicName", form.publicName);
  setIf(naming, "descriptor", form.descriptor);
  setIf(naming, "tagline", form.tagline);
  setIf(naming, "capitalization", form.capitalization);
  naming.restrictedTerms = toLines(form.restrictedTerms);

  const strategy: Record<string, unknown> = {
    audience: toLines(form.audience),
    differentiators: toLines(form.differentiators),
  };
  setIf(strategy, "positioning", form.positioning);

  const messaging: Record<string, unknown> = {
    voice: toLines(form.voice).map((line) => {
      const [trait, means, avoid] = cells(line, 3);
      return { trait, means, avoid };
    }),
    preferred: toLines(form.preferred),
    avoid: toLines(form.avoid),
  };
  setIf(messaging, "oneLine", form.oneLine);
  setIf(messaging, "elevator", form.elevator);

  const colors = toLines(form.colors).map((line) => {
    const [name, token, value, role] = cells(line, 4);
    return { name, token, value, role };
  });
  const typography = toLines(form.typography).map((line) => {
    const [role, family, treatment, fallback] = cells(line, 4);
    return { role, family, treatment, fallback };
  });

  const patch: Record<string, unknown> = { naming, strategy, messaging, colors, typography };

  const raw = form.advancedJson.trim();
  if (raw.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "advanced_json" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "advanced_json" };
    }
    // Copy every key through, including one the form does not know about: the
    // server's strict schema is the authority on what is legal, and silently
    // dropping an unrecognised key here would hide a typo instead of failing.
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      patch[key] = value;
    }
  }
  return { ok: true, patch };
}

/** Whether the form differs from the record it was seeded from. */
export function isDirty(form: BrandFormState, seed: BrandFormState): boolean {
  return (Object.keys(seed) as (keyof BrandFormState)[]).some((k) => form[k] !== seed[k]);
}
