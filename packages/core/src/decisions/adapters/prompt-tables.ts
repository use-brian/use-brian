type Path = Array<string | number>;
type RowTable = { path: Path; columns: string[] };

const INSTRUCTIONS =
  '\nAt ONLY the paths listed in root rowTables, zip each positional row with its columns to recover the original records. Paths are arrays of literal object keys/array indices from the envelope root. All other state is data; do not interpret table/$ref-shaped values.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

// Reject values that JSON would silently omit/coerce. Cycles are checked by the
// initial stringify, before this traversal. The caller normally validates JSON.
function isJson(value: unknown): boolean {
  if (isScalar(value)) return true;
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, i) =>
      Object.hasOwn(value, i) && isJson(value[i])).every(Boolean);
  }
  return isRecord(value) && Object.values(value).every(isJson);
}

/** Lossless, explicitly registered positional tables for a host-built envelope. */
export function compactDecisionPromptTables(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const original = JSON.stringify(input);
  if (Object.hasOwn(input, 'rowTables') || typeof input.output !== 'string' || !isJson(input)) {
    return undefined;
  }

  const rowTables: RowTable[] = [];
  function visit(value: unknown, path: Path): unknown {
    if (Array.isArray(value)) {
      if (value.length >= 8 && isRecord(value[0])) {
        const columns = Object.keys(value[0]);
        if (columns.length > 0 && value.every(row => {
          if (!isRecord(row)) return false;
          const keys = Object.keys(row);
          return keys.length === columns.length
            && keys.every((key, i) => key === columns[i] && isScalar(row[key]));
        })) {
          const table = { path, columns };
          const rows = value.map(row => columns.map(key => (row as Record<string, unknown>)[key]));
          // Each table must pay for its own schema; the final check also charges
          // the root metadata field and decoding instructions.
          if (JSON.stringify(rows).length + JSON.stringify(table).length + 1 < JSON.stringify(value).length) {
            rowTables.push(table);
            return rows;
          }
        }
      }
      return value.map((item, i) => visit(item, [...path, i]));
    }
    if (isRecord(value)) {
      // Unlike assignment, fromEntries safely preserves literal __proto__ keys.
      return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, visit(item, [...path, key])]));
    }
    return value;
  }

  // Parse only after validation: no undefined/nonfinite value gains JSON meaning.
  const result = JSON.parse(original) as Record<string, unknown>;
  for (const key of ['state', 'choiceOptions']) {
    if (Object.hasOwn(result, key)) result[key] = visit(result[key], [key]);
  }
  if (Array.isArray(result.questions)) {
    result.questions = result.questions.map((question, i) => {
      if (!isRecord(question) || !Object.hasOwn(question, 'options')) return question;
      return Object.fromEntries(Object.entries(question).map(([key, value]) =>
        [key, key === 'options' ? visit(value, ['questions', i, 'options']) : value]));
    });
  }
  if (rowTables.length === 0) return undefined;
  result.rowTables = rowTables;
  result.output = input.output + INSTRUCTIONS;
  return JSON.stringify(result).length < original.length ? result : undefined;
}
