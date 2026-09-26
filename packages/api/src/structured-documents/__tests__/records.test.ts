import { describe, it, expect } from 'vitest';
import { parseSourceRecords, resolveObservation } from '../records.js';
import { recordsFixture, cellRef, entityRef, setCellText, setEntityText } from './fixtures.js';

describe('[COMP:api/structured-documents] records 1.1', () => {
  it('preserves the full contract and exact identifier/text observations', () => {
    const f = recordsFixture();
    expect(parseSourceRecords(f)).toEqual(f);
    expect(resolveObservation(f, cellRef)).toMatchObject({ valueType: 'string', rawText: '00123', page: 1, flags: ['requires_review'], sourceRefs: ['c1', 'o1'] });
    expect(resolveObservation(f, entityRef)).toMatchObject({ valueType: 'string', rawText: 'Fictional Ltd' });
    setCellText(f, '=HYPERLINK("fictional")');
    expect(resolveObservation(f, cellRef).rawText).toBe('=HYPERLINK("fictional")');
  });
  it('preserves address slices, Unicode code-point offsets, and whitespace', () => {
    const f = recordsFixture();
    setEntityText(f, '😀 Fictional Ltd');
    expect(resolveObservation(f, entityRef).rawText).toBe('😀 Fictional Ltd');
    setEntityText(f, ' 12 Fictional Road\nUnit 03 ');
    f.entities[0]!.kind = 'address';
    expect(resolveObservation(f, entityRef).rawText).toBe(' 12 Fictional Road\nUnit 03 ');
  });
  it.each(['unobserved', 'ambiguous'] as const)('rejects %s status', status => {
    const f = recordsFixture(); f.records[0]!.cells[0]!.typed_value.status = status;
    expect(() => resolveObservation(f, cellRef)).toThrow();
  });
  it.each(['conflicting_source_text', 'partial_numeric_observation', 'header_scale_not_applied', 'duplicate_source_assignment', 'overlapping_entity_candidates', 'competing_entity_kinds', 'multiple_date_literals'])('rejects unsafe %s but not generic review', flag => {
    const f = recordsFixture(); f.records[0]!.cells[0]!.flags.push(flag);
    expect(() => resolveObservation(f, cellRef)).toThrow();
    f.records[0]!.cells[0]!.flags = ['requires_review'];
    expect(resolveObservation(f, cellRef).flags).toContain('requires_review');
  });
  it('retains exact decimals without converting precision and rejects partial/scaled/currency interpretations', () => {
    const f = recordsFixture();
    const typed = f.records[0]!.cells[0]!.typed_value;
    Object.assign(typed, { data_type: 'decimal', status: 'parsed', decimal_value: '12345678901234567890.12' });
    setCellText(f, '12,345,678,901,234,567,890.12');
    expect(resolveObservation(f, cellRef).decimalValue).toBe('12345678901234567890.12');
    setCellText(f, '12,345,678,901,234,567,890.12 million');
    expect(() => resolveObservation(f, cellRef)).toThrow();
    setCellText(f, '10'); typed.decimal_value = '100';
    expect(() => resolveObservation(f, cellRef)).toThrow();
    setCellText(f, '$100'); typed.currency_raw = '$'; typed.unit = '$';
    expect(() => resolveObservation(f, cellRef)).toThrow();
  });
  it('supports explicit supported currencies and clear dates only', () => {
    const f = recordsFixture(); setCellText(f, 'RM 1,234.50');
    Object.assign(f.records[0]!.cells[0]!.typed_value, { data_type: 'decimal', status: 'parsed', decimal_value: '1234.50', currency: 'MYR', currency_raw: 'RM', unit: 'MYR' });
    expect(resolveObservation(f, cellRef)).toMatchObject({ valueType: 'number', decimalValue: '1234.50', currency: 'MYR' });
    setEntityText(f, '31 December 2025'); f.entities[0]!.kind = 'date'; f.entities[0]!.normalized_value = '2025-12-31';
    expect(resolveObservation(f, entityRef)).toMatchObject({ valueType: 'date', dateValue: '2025-12-31', rawText: '31 December 2025' });
    setEntityText(f, '01/02/2025'); f.entities[0]!.normalized_value = '2025-01-02';
    expect(() => resolveObservation(f, entityRef)).toThrow();
    f.entities[0]!.normalized_value = '2025-02-30';
    expect(() => parseSourceRecords(f)).toThrow();
  });
  it('detects overlapping and competing entities even without producer flags', () => {
    const f = recordsFixture();
    const duplicate = structuredClone(f.entities[0]!); duplicate.id = 'e2'; f.entities.push(duplicate);
    expect(() => resolveObservation(f, entityRef)).toThrow();
    duplicate.kind = 'address';
    expect(() => resolveObservation(f, entityRef)).toThrow();
  });
  it('detects duplicate source assignments even without producer flags', () => {
    const f = recordsFixture();
    const row = structuredClone(f.records[0]!); row.id = row.row_id = 'r2'; row.row_index = 2;
    row.cells[0]!.id = 'c2';
    if (row.cells[0]!.source.kind === 'engine_table_cell') row.cells[0]!.source.row_index = 2;
    f.records.push(row); f.tables[0]!.row_ids.push('r2');
    expect(parseSourceRecords(f)).toBeDefined();
    expect(() => resolveObservation(f, cellRef)).toThrow();
  });
  it.each([
    (f: ReturnType<typeof recordsFixture>) => { f.schema_version = '1.0' as '1.1'; },
    (f: ReturnType<typeof recordsFixture>) => { f.entities[0]!.lines[0]!.end = 200; },
    (f: ReturnType<typeof recordsFixture>) => { f.entities[0]!.lines[0]!.raw_text = 'invented'; },
    (f: ReturnType<typeof recordsFixture>) => { f.entities[0]!.lines[0]!.source_ref = 'missing'; },
    (f: ReturnType<typeof recordsFixture>) => { f.entities[0]!.page = 2; },
    (f: ReturnType<typeof recordsFixture>) => { f.records[0]!.cells[0]!.source.bbox = [5, 0, 1, 10]; },
    (f: ReturnType<typeof recordsFixture>) => { f.records[0]!.cells[0]!.source.ocr_refs = ['missing']; },
    (f: ReturnType<typeof recordsFixture>) => { f.records.push(f.records[0]!); },
    (f: ReturnType<typeof recordsFixture>) => { f.coverage.unresolved_refs.push('o1'); },
    (f: ReturnType<typeof recordsFixture>) => { f.evidence[0]!.raw_text = 'x'.repeat(100_001); },
    (f: ReturnType<typeof recordsFixture>) => { Object.assign(f.entities[0]!, { modelValue: 'forged' }); },
  ])('rejects malformed/provenance/budget failures %# without source text', mutate => {
    const f = recordsFixture(); mutate(f);
    expect(() => parseSourceRecords(f)).toThrow('Structured source records rejected (invalid_records).');
  });
  it('rejects cyclic, excessively deep, and non-JSON inputs', () => {
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    expect(() => parseSourceRecords(cycle)).toThrow();
    let deep: unknown = {}; for (let i = 0; i < 40; i++) deep = { child: deep };
    expect(() => parseSourceRecords(deep)).toThrow();
    const getter = { get schema_version() { throw new Error('sensitive'); } };
    expect(() => parseSourceRecords(getter)).toThrow('invalid_records');
  });
  it('rejects unknown/mismatched references and model-authored extras', () => {
    const f = recordsFixture();
    expect(() => resolveObservation(f, { ...cellRef, recordId: 'missing' })).toThrow();
    expect(() => resolveObservation(f, { ...entityRef, entityId: 'missing' })).toThrow();
    expect(() => resolveObservation(f, { ...cellRef, value: '42' } as typeof cellRef)).toThrow();
  });
  it('rejects conflicting source literals and coverage even when diagnostic flags are omitted', () => {
    const f = recordsFixture(); f.evidence[0]!.raw_text = '00999'; f.coverage.numeric_candidates[0]!.raw_text = '00999';
    expect(() => resolveObservation(f, cellRef)).toThrow('unsafe_observation');
    setCellText(f, '00123'); f.coverage.numeric_candidates[0]!.disposition = 'unresolved_record_value'; f.coverage.unresolved_refs = ['o1'];
    expect(() => resolveObservation(f, cellRef)).toThrow('unsafe_observation');
  });
  it('does not bypass a conflicting cell by removing entity linked_cell_ids', () => {
    const f = recordsFixture();
    f.records[0]!.cells[0]!.flags = ['conflicting_source_text'];
    const entity = f.entities[0]!;
    entity.raw_text = '00123'; entity.lines = [{ source_ref: 'o1', start: 0, end: 5, raw_text: '00123', bbox: [0, 0, 100, 20], bbox_scope: 'ocr_region' }];
    expect(() => resolveObservation(f, entityRef)).toThrow('unsafe_observation');
  });
  it('rejects parent/spans with wrong offsets while retaining valid partial observations for browsing', () => {
    const f = recordsFixture();
    f.evidence.push({ id: 'span1', page: 1, raw_text: '123', kind: 'numeric_span', bbox: [0, 0, 100, 20], confidence: null, bbox_scope: 'parent_ocr_region', parent_ref: 'o1', start: 2, end: 5 });
    expect(parseSourceRecords(f)).toEqual(f);
    f.evidence[2]!.start = 1;
    expect(() => parseSourceRecords(f)).toThrow('invalid_records');
  });
  it.each(['December 31, 2025', '31Dec.2025', '31 December 2025'])('accepts clear producer date spelling %s without changing it', raw => {
    const f = recordsFixture(); setEntityText(f, raw); f.entities[0]!.kind = 'date'; f.entities[0]!.normalized_value = '2025-12-31';
    expect(resolveObservation(f, entityRef)).toMatchObject({ rawText: raw, dateValue: '2025-12-31' });
  });

});
