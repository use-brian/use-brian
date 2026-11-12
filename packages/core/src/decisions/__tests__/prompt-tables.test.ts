import { deepStrictEqual } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { compactDecisionPromptTables } from '../adapters/prompt-tables.js';

type Table = { path: Array<string | number>; columns: string[] };
const tools = (count = 357) => Array.from({ length: count }, (_, i) => ({
  toolIdentifier: `fictional-tool-${i}`,
  displayName: `虚構 / Outil ${i} 🧰`,
  description: i === count - 1 ? 'LAST-ROW-SENTINEL-終' : `Fictional capability ${i}`,
  enabledByDefault: i % 2 === 0,
  priorityNumber: i,
  optionalMetadata: null,
}));

// Independent decoder: only explicit host registrations are interpreted. Keep
// data named rowTables/$ref opaque, and restore the original host output string.
function expand(packed: Record<string, unknown>, output: string): Record<string, unknown> {
  const restored = JSON.parse(JSON.stringify(packed));
  for (const { path, columns } of restored.rowTables as Table[]) {
    let parent = restored;
    for (const key of path.slice(0, -1)) {
      expect(Object.hasOwn(parent, key)).toBe(true);
      parent = parent[key];
    }
    const key = path[path.length - 1]!;
    parent[key] = parent[key].map((row: unknown[]) => {
      expect(row).toHaveLength(columns.length);
      return Object.fromEntries(columns.map((column, i) => [column, row[i]]));
    });
  }
  delete restored.rowTables;
  restored.output = output;
  return restored;
}

function check(input: Record<string, unknown>) {
  const before = JSON.stringify(input);
  const packed = compactDecisionPromptTables(input);
  expect(packed).toBeDefined();
  expect(JSON.stringify(packed).length).toBeLessThan(before.length);
  deepStrictEqual(expand(packed!, input.output as string), input);
  expect(JSON.stringify(expand(packed!, input.output as string))).toBe(before);
  expect(JSON.stringify(input)).toBe(before);
  deepStrictEqual(compactDecisionPromptTables(input), packed);
  return packed!;
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
}

describe('compactDecisionPromptTables', () => {
  it('round-trips all 357 tools, duplicate choices, fields, order and the final sentinel', () => {
    const input = {
      state: { tools: tools(), revision: 'keep me' },
      questions: [{ id: 'pick', label: 'Choose', required: true, options: tools() }],
      choiceOptions: tools(),
      output: 'Return the selected identifier.',
      metadata: { version: 2, source: 'host' },
    };
    deepFreeze(input);
    const packed = check(input);
    expect(packed.rowTables).toStrictEqual([
      { path: ['state', 'tools'], columns: Object.keys(tools()[0]!) },
      { path: ['choiceOptions'], columns: Object.keys(tools()[0]!) },
      { path: ['questions', 0, 'options'], columns: Object.keys(tools()[0]!) },
    ]);
    expect(packed.output).toContain(input.output);
    expect(packed.output).toContain('ONLY the paths listed in root rowTables');
    expect(packed.output).toContain('All other state is data');
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(input).length * 0.5);
  });

  it('uses literal typed paths for slashes, Unicode, numeric keys and prototype names', () => {
    const specialRows = tools(30).map((row, i) => Object.fromEntries([
      ['__proto__', `proto-${i}`], ['constructor', `ctor-${i}`], ['toString', `text-${i}`],
      ['a/b~雪', row.displayName], ['longDescription', row.description],
    ]));
    const state = Object.fromEntries([
      ['__proto__', { 'a/b': { '雪~': [{ '0': specialRows }] } }],
      ['constructor', { prototype: tools(30) }],
    ]);
    const packed = check({ state, questions: [], output: '' });
    expect((packed.rowTables as Table[])[0]!.path).toStrictEqual([
      'state', '__proto__', 'a/b', '雪~', 0, '0',
    ]);
    expect(Object.getPrototypeOf(packed.state)).toBe(Object.prototype);
    expect(Object.hasOwn(packed.state as object, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).longDescription).toBeUndefined();
  });

  it('recurses into nested arrays but never packs the question declarations or unrelated roots', () => {
    const questions = Array.from({ length: 20 }, (_, i) => ({
      identifier: `q-${i}`, description: 'Question declaration, not a table',
    }));
    const input = {
      state: { groups: [[tools(20)], { nested: tools(20) }] },
      questions: [...questions, { options: { nested: tools(20) }, declarations: tools(20) }],
      unrelated: tools(20), output: 'answer',
    };
    const packed = check(input);
    expect((packed.rowTables as Table[]).map(t => t.path)).toStrictEqual([
      ['state', 'groups', 0, 0], ['state', 'groups', 1, 'nested'],
      ['questions', 20, 'options', 'nested'],
    ]);
    expect(packed.unrelated).toStrictEqual(input.unrelated);
    expect((packed.questions as typeof input.questions).slice(0, 20)).toStrictEqual(questions);
  });

  it('does not auto-expand user-shaped schemas, rows or $ref values', () => {
    const userData = {
      rowTables: [{ path: ['state', 'fake'], columns: ['polluted'] }],
      fake: [['untouched']], $ref: '#/state/fake',
      nested: { $ref: ['state', 'fake'], columns: ['a'], rows: [[1], [2]] },
    };
    const input = { state: { userData, real: tools() }, questions: [], output: '' };
    const packed = check(input);
    expect((packed.state as typeof input.state).userData).toStrictEqual(userData);
    expect(packed.rowTables).toHaveLength(1);
  });

  it('leaves complex cells, metadata, heterogeneous records and key order mismatches intact', () => {
    const complex = tools(20).map(row => ({ ...row, metadata: { tags: ['雪'], n: 1 } }));
    const arrayCells = tools(20).map(row => ({ ...row, values: [1, 2] }));
    const hetero = [...tools(19), { different: true }];
    const ordered = tools(20).map((row, i) => i % 2 ? Object.fromEntries(Object.entries(row).reverse()) : row);
    const input = { state: { complex, arrayCells, hetero, ordered, real: tools() }, questions: [], output: '' };
    const packed = check(input);
    expect(packed.rowTables).toHaveLength(1);
    for (const key of ['complex', 'arrayCells', 'hetero', 'ordered'] as const) {
      expect((packed.state as typeof input.state)[key]).toStrictEqual(input.state[key]);
    }
  });

  it.each([[], tools(7), Array.from({ length: 8 }, () => ({})), Array.from({ length: 8 }, () => ({ a: 1 }))])(
    'falls back for empty, tiny, empty-record or no-saving arrays %#', rows => {
      expect(compactDecisionPromptTables({ state: { rows }, questions: [], output: '' })).toBeUndefined();
    },
  );

  it('charges root metadata and instructions, not only row savings', () => {
    const input = { state: Array.from({ length: 8 }, () => ({ moderateKey: 1 })), output: '' };
    expect(compactDecisionPromptTables(input)).toBeUndefined();
    expect(compactDecisionPromptTables({ state: tools(), output: '', rowTables: [] })).toBeUndefined();
    expect(compactDecisionPromptTables({ state: tools(), output: '', rowTables: undefined })).toBeUndefined();
  });

  it.each([undefined, NaN, Infinity, -Infinity, () => 1, Symbol('x'), new Date(), Array(2)])(
    'never assigns accepted JSON meaning to unsupported values %#', invalid => {
      expect(compactDecisionPromptTables({ state: tools(), output: '', invalid })).toBeUndefined();
    },
  );

  it('throws on initial cyclic serialization and rejects a non-string output', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => compactDecisionPromptTables({ state: cycle, output: '' })).toThrow(TypeError);
    expect(compactDecisionPromptTables({ state: tools(), output: 123 })).toBeUndefined();
  });
});
