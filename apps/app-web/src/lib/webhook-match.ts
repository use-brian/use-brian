/**
 * Webhook trigger `match` codec (app-web) — converts between the guided
 * rule-builder UI and the JSONLogic stored in `trigger.match.condition`.
 *
 * The receiver (`packages/api/src/routes/workflow-webhooks.ts`) evaluates
 * `match.condition` against `{ input: <parsed payload> }` with the same
 * vendored JSONLogic the `branch` step uses. The simple editor models the
 * common case — N `field / operator / value` rules combined with AND or OR —
 * and round-trips losslessly; anything it cannot represent (nested logic, an
 * unsupported operator) makes `conditionToRules` return `null`, which the UI
 * uses to fall back to the raw-JSONLogic editor.
 *
 * Field paths are authored WITHOUT the `input.` prefix (the only scope a
 * webhook payload has); the codec adds/strips it. Values stay strings except
 * `true` / `false` / `null` (so a boolean field compares correctly under loose
 * `==`) and the numeric comparators (`>` `>=` `<` `<=`), which coerce a numeric
 * value to a number. Equality values stay strings so an id like `007` is never
 * silently renumbered.
 *
 * [COMP:app-web/workflow]
 */

export type JsonLogic = unknown;

export type WebhookOp = "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains";

export const WEBHOOK_OPS: readonly WebhookOp[] = [
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
] as const;

export type WebhookCombine = "and" | "or";

export type WebhookRule = { path: string; op: WebhookOp; value: string };

const VAR_PREFIX = "input.";
const NUMERIC_OPS: ReadonlySet<WebhookOp> = new Set([">", ">=", "<", "<="]);

export function emptyRule(): WebhookRule {
  return { path: "", op: "==", value: "" };
}

function varPath(path: string): string {
  const p = path.trim();
  return p.startsWith(VAR_PREFIX) ? p : VAR_PREFIX + p;
}

function displayPath(varExpr: string): string {
  return varExpr.startsWith(VAR_PREFIX) ? varExpr.slice(VAR_PREFIX.length) : varExpr;
}

function coerceValue(raw: string, op: WebhookOp): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (NUMERIC_OPS.has(op)) {
    const n = Number(raw);
    if (raw.trim() !== "" && !Number.isNaN(n)) return n;
  }
  return raw;
}

function displayValue(v: unknown): string {
  if (v === true) return "true";
  if (v === false) return "false";
  if (v === null) return "null";
  return String(v);
}

function isLiteral(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function readVar(node: unknown): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const keys = Object.keys(node as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "var") return null;
  const v = (node as Record<string, unknown>).var;
  return typeof v === "string" ? v : null;
}

function ruleToNode(rule: WebhookRule): JsonLogic {
  const v = coerceValue(rule.value, rule.op);
  const varNode = { var: varPath(rule.path) };
  // `contains` ⇒ value is a member/substring of the field: { in: [value, field] }
  if (rule.op === "contains") return { in: [v, varNode] };
  return { [rule.op]: [varNode, v] };
}

function nodeToRule(node: unknown): WebhookRule | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const keys = Object.keys(node as Record<string, unknown>);
  if (keys.length !== 1) return null;
  const op = keys[0];
  const args = (node as Record<string, unknown>)[op];
  if (!Array.isArray(args) || args.length !== 2) return null;

  if (op === "in") {
    const [val, varNode] = args;
    const path = readVar(varNode);
    if (path === null || !isLiteral(val)) return null;
    return { path: displayPath(path), op: "contains", value: displayValue(val) };
  }
  if (["==", "!=", ">", ">=", "<", "<="].includes(op)) {
    const [varNode, val] = args;
    const path = readVar(varNode);
    if (path === null || !isLiteral(val)) return null;
    return { path: displayPath(path), op: op as WebhookOp, value: displayValue(val) };
  }
  return null;
}

/**
 * Build the JSONLogic condition for a rule list. Rules with a blank path are
 * dropped (an in-progress row). Returns `undefined` when nothing usable
 * remains — i.e. no filter, fire on every signed delivery.
 */
export function rulesToCondition(
  rules: WebhookRule[],
  combine: WebhookCombine,
): JsonLogic | undefined {
  const usable = rules.filter((r) => r.path.trim() !== "");
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return ruleToNode(usable[0]);
  return { [combine]: usable.map(ruleToNode) };
}

/**
 * Parse a stored condition back into guided rules. Returns `{ rules: [] }` for
 * an absent filter, and `null` when the condition is valid JSONLogic but too
 * rich for the simple editor (the caller then shows the raw editor).
 */
export function conditionToRules(
  condition: unknown,
): { rules: WebhookRule[]; combine: WebhookCombine } | null {
  if (condition === undefined || condition === null) {
    return { rules: [], combine: "and" };
  }

  const single = nodeToRule(condition);
  if (single) return { rules: [single], combine: "and" };

  if (typeof condition === "object" && !Array.isArray(condition)) {
    const keys = Object.keys(condition as Record<string, unknown>);
    if (keys.length === 1 && (keys[0] === "and" || keys[0] === "or")) {
      const arr = (condition as Record<string, unknown>)[keys[0]];
      if (Array.isArray(arr) && arr.length > 0) {
        const rules: WebhookRule[] = [];
        for (const n of arr) {
          const r = nodeToRule(n);
          if (!r) return null;
          rules.push(r);
        }
        return { rules, combine: keys[0] as WebhookCombine };
      }
    }
  }

  return null;
}
