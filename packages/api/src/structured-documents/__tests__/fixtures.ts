import type { SourceRecords } from '../records.js';

/** Compact fictional records 1.1 fixture, never real customer/OCR data. */
export function recordsFixture(): SourceRecords {
  const bbox = [0, 0, 100, 20];
  const raw = '00123';
  return {
    schema_version: '1.1', generator: 'source-records/1.1', status: 'unreviewed_extraction',
    document: { id: `sha256:${'a'.repeat(64)}`, source_ref: null, source_sha256: 'a'.repeat(64), digest_scope: 'normalized OCR snapshot, not PDF bytes', pages: [{ page: 1, width: 200, height: 200 }] },
    tables: [{ id: 't1', page: 1, origin: 'engine_table', columns: [{ id: 'col1', index: 0, label: 'Account ID', header_cell_refs: [], header_evidence_refs: [] }], header_cells: [], row_ids: ['r1'], flags: [] }],
    records: [{ id: 'r1', row_id: 'r1', table_id: 't1', page: 1, row_index: 1, origin: 'engine_table', context_refs: [], spanning_cell_refs: [], flags: [], review_status: 'requires_review', cells: [{
      id: 'c1', column_ids: ['col1'], header_refs: [], header_text: ['Account ID'], raw_text: raw,
      typed_value: { data_type: 'identifier', status: 'text', decimal_value: null, date_value: null, currency: null, currency_raw: null, unit: null, warnings: [] },
      source: { kind: 'engine_table_cell', page: 1, bbox, bbox_scope: 'table', ocr_refs: ['o1'], agreement: 'matched', table_index: 1, row_index: 1, column_index: 0, rowspan: 1, colspan: 1 }, flags: [], alternatives: [],
    }] }],
    evidence: [{ id: 'o1', page: 1, raw_text: raw, kind: 'region', bbox, confidence: 0.9, bbox_scope: 'ocr_region' }, { id: 'o2', page: 1, raw_text: 'Fictional Ltd', kind: 'region', bbox: [0, 30, 100, 50], confidence: null, bbox_scope: 'ocr_region' }],
    entities: [{ id: 'e1', kind: 'name', page: 1, raw_text: 'Fictional Ltd', lines: [{ source_ref: 'o2', start: 0, end: 13, raw_text: 'Fictional Ltd', bbox: [0, 30, 100, 50], bbox_scope: 'ocr_region' }], normalized_value: null, label_refs: [], context_refs: ['o2'], linked_cell_ids: [], origin: 'organization_pattern', flags: ['entity_kind_proposed'], semantic_role: 'unassigned', review_status: 'requires_review' }],
    context: [{ source_ref: 'o2', page: 1, raw_text: 'Fictional Ltd', bbox: [0, 30, 100, 50], bbox_scope: 'ocr_region', date_mentions: [], semantic_role: 'unassigned', flags: ['opaque_new_warning'] }],
    document_notes: [{ kind: 'attachment_reference', ref: 'o2', page: 1, text: 'Fictional Ltd', bbox: [0, 30, 100, 50] }],
    coverage: { numeric_candidates: [{ source_ref: 'o1', page: 1, raw_text: raw, disposition: 'record_value', cell_refs: ['c1'], entity_refs: [] }], unresolved_refs: [] },
    issues: [{ code: 'requires_review' }], review_context: null, limitations: ['Unreviewed fictional observations.'],
  };
}
export const cellRef = { kind: 'cell', recordId: 'r1', cellId: 'c1' } as const;
export const entityRef = { kind: 'entity', entityId: 'e1' } as const;
export function setCellText(f: SourceRecords, raw: string) {
  f.records[0]!.cells[0]!.raw_text = raw;
  f.evidence[0]!.raw_text = raw;
  f.coverage.numeric_candidates[0]!.raw_text = raw;
}
export function setEntityText(f: SourceRecords, raw: string) {
  f.entities[0]!.raw_text = raw;
  Object.assign(f.entities[0]!.lines[0]!, { raw_text: raw, end: Array.from(raw).length });
  f.evidence[1]!.raw_text = raw;
  f.context[0]!.raw_text = raw;
  f.document_notes[0]!.text = raw;
}
