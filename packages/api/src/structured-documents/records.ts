import { z } from 'zod';


// Records 1.1 shapes mirror OCR Table Lab records.schema.json. All objects are strict.

const text = z.string().max(100_000);

const id = z.string().min(1).max(512).regex(/^[A-Za-z0-9_:.-]+$/);

const pageSchema = z.object({
  page: z.number().finite().int().safe().min(1),
  width: z.number().finite().int().safe().min(1),
  height: z.number().finite().int().safe().min(1),
}).strict();

const columnSchema = z.object({
  id: id,
  index: z.number().finite().int().safe().min(0),
  label: text,
  header_cell_refs: z.array(text).max(10000),
  header_evidence_refs: z.array(text).max(10000),
}).strict();

const bboxSchema = z.array(z.number().finite()).max(4).min(4);

const nativeSourceSchema = z.object({
  kind: z.literal("engine_table_cell"),
  page: z.number().finite().int().safe().min(1),
  bbox: z.union([bboxSchema, z.null()]),
  ocr_refs: z.array(text).max(10000),
  agreement: z.enum(["matched", "ambiguous", "conflict", "not_matched", "source_only"]),
  table_index: z.number().finite().int().safe().min(1),
  row_index: z.number().finite().int().safe().min(0),
  column_index: z.number().finite().int().safe().min(0),
  rowspan: z.number().finite().int().safe().min(1),
  colspan: z.number().finite().int().safe().min(1),
  bbox_scope: z.enum(["table", "unavailable"]),
}).strict();

const headerCellSchema = z.object({
  id: id,
  row_index: z.number().finite().int().safe().min(0),
  column_index: z.number().finite().int().safe().min(0),
  rowspan: z.number().finite().int().safe().min(1),
  colspan: z.number().finite().int().safe().min(1),
  raw_text: text,
  source: nativeSourceSchema,
}).strict();

const tableSchema = z.object({
  id: id,
  page: z.number().finite().int().safe().min(1),
  origin: z.enum(["engine_table", "spatial_proposal"]),
  columns: z.array(columnSchema).max(10000),
  header_cells: z.array(headerCellSchema).max(10000),
  row_ids: z.array(text).max(10000),
  flags: z.array(text).max(10000),
}).strict();

const typedValueSchema = z.object({
  data_type: z.enum(["unknown", "identifier", "text", "decimal", "date"]),
  decimal_value: z.union([text.regex(new RegExp("^-?[0-9]+(?:\\.[0-9]+)?$")), z.null()]),
  date_value: z.union([text, z.null()]),
  currency: z.union([text, z.null()]),
  currency_raw: z.union([text, z.null()]),
  unit: z.union([text, z.null()]),
  status: z.enum(["parsed", "ambiguous", "text", "unobserved"]),
  warnings: z.array(text).max(10000),
}).strict();

const spatialSourceSchema = z.object({
  kind: z.literal("ocr_region_mapping"),
  page: z.number().finite().int().safe().min(1),
  bbox: z.union([bboxSchema, z.null()]),
  ocr_refs: z.array(text).max(10000),
  agreement: z.enum(["matched", "ambiguous", "conflict", "not_matched", "source_only"]),
  bbox_scope: z.enum(["ocr_region", "parent_ocr_region", "unavailable"]),
  label_refs: z.array(text).max(10000),
}).strict();

const sourceSchema = z.union([nativeSourceSchema, spatialSourceSchema]);

const alternativeSchema = z.object({
  source_ref: id,
  raw_text: text,
  typed_value: typedValueSchema,
}).strict();

const cellSchema = z.object({
  id: id,
  column_ids: z.array(text).max(10000),
  header_refs: z.array(text).max(10000),
  header_text: z.array(text).max(10000),
  raw_text: text,
  typed_value: typedValueSchema,
  source: sourceSchema,
  flags: z.array(text).max(10000),
  alternatives: z.array(alternativeSchema).max(10000),
}).strict();

const recordSchema = z.object({
  id: id,
  table_id: id,
  row_id: id,
  page: z.number().finite().int().safe().min(1),
  row_index: z.union([z.number().finite().int().safe().min(0), z.null()]),
  origin: z.enum(["engine_table", "spatial_proposal"]),
  context_refs: z.array(text).max(10000),
  cells: z.array(cellSchema).max(10000),
  spanning_cell_refs: z.array(text).max(10000),
  flags: z.array(text).max(10000),
  review_status: z.literal("requires_review"),
}).strict();

const evidenceSchema = z.object({
  id: id,
  page: z.number().finite().int().safe().min(1),
  raw_text: text,
  kind: z.enum(["region", "numeric_span", "label_span"]),
  bbox: bboxSchema,
  confidence: z.union([z.number().finite(), z.null()]),
  bbox_scope: z.enum(["ocr_region", "parent_ocr_region"]),
  parent_ref: id.optional(),
  start: z.number().finite().int().safe().min(0).optional(),
  end: z.number().finite().int().safe().min(0).optional(),
}).strict();

const dateMentionSchema = z.object({
  raw_text: text,
  start: z.number().finite().int().safe().min(0),
  end: z.number().finite().int().safe().min(0),
  date_value: z.union([text, z.null()]),
  status: z.enum(["parsed", "ambiguous"]),
  warnings: z.array(text).max(10000),
}).strict();

const contextSchema = z.object({
  source_ref: id,
  page: z.number().finite().int().safe().min(1),
  raw_text: text,
  bbox: bboxSchema,
  bbox_scope: z.literal("ocr_region"),
  date_mentions: z.array(dateMentionSchema).max(10000),
  semantic_role: z.literal("unassigned"),
  flags: z.array(text).max(10000),
}).strict();

const noteSchema = z.object({
  kind: z.literal("attachment_reference"),
  ref: text,
  page: z.number().finite().int().safe().min(1),
  text: text,
  bbox: bboxSchema,
}).strict();

const candidateSchema = z.object({
  source_ref: id,
  page: z.number().finite().int().safe().min(1),
  raw_text: text,
  disposition: z.enum(["record_value", "unresolved_record_value", "label_candidate", "unresolved_table_value", "unresolved_header_value", "unassigned_context_value"]),
  cell_refs: z.array(text).max(10000),
  entity_refs: z.array(text).max(10000),
}).strict();

const issueSchema = z.object({
  code: text,
  message: text.optional(),
  page: z.number().finite().int().safe().min(1).optional(),
  table_id: id.optional(),
  cell_id: id.optional(),
}).strict();

const reviewSchema = z.object({
  relationship_checked: z.boolean(),
  value_checked: z.boolean(),
  confirmed_empty: z.boolean(),
  correction: z.union([text, z.null()]),
  reason: text,
  reviewed_at: text,
}).strict();

const reviewsSchema = z.record(reviewSchema);

const proposalFieldSchema = z.object({
  id: id,
  section_refs: z.array(text).max(10000),
  row_refs: z.array(text).max(10000),
  column_refs: z.array(text).max(10000),
  value_refs: z.array(text).max(10000),
  unit_refs: z.array(text).max(10000),
  value_type: z.enum(["number", "date", "identifier", "text", "unknown"]),
}).strict();

const proposalSchema = z.object({
  fields: z.array(proposalFieldSchema).max(10000),
}).strict();

const ignoredSchema = z.record(text);

const historySchema = z.object({
  revision: z.number().finite().int().safe().min(0),
  at: text,
  action: z.enum(["replace_proposal", "human_review", "human_ignore"]),
  source: text.optional(),
  previous_proposal: proposalSchema.optional(),
  previous_reviews: reviewsSchema.optional(),
  previous_ignored: ignoredSchema.optional(),
  field_id: text.optional(),
  previous: z.union([reviewSchema, z.null()]).optional(),
  review: reviewSchema.optional(),
  ref: text.optional(),
  reason: text.optional(),
}).strict();

const reviewContextSchema = z.object({
  revision: z.number().finite().int().safe().min(0),
  evidence_digest: text,
  source: text,
  reviews: reviewsSchema,
  proposal: proposalSchema,
  ignored: ignoredSchema,
  history: z.array(historySchema).max(10000),
  applies_to: z.literal("structure_proposal_only"),
  source_images_available: z.boolean(),
  export_ready: z.boolean(),
  blockers: z.array(text).max(10000),
  corrections_applied_to_records: z.literal(false),
}).strict();

const sourceLineSchema = z.object({
  source_ref: id,
  start: z.number().finite().int().safe().min(0),
  end: z.number().finite().int().safe().min(1),
  raw_text: text.min(1),
  bbox: z.union([bboxSchema, z.null()]),
  bbox_scope: z.enum(["ocr_region", "parent_ocr_region", "table", "unavailable"]),
}).strict();

const entitySchema = z.object({
  id: id,
  kind: z.enum(["name", "address", "date"]),
  page: z.number().finite().int().safe().min(1),
  raw_text: text.min(1),
  lines: z.array(sourceLineSchema).max(10000).min(1),
  normalized_value: z.union([text.regex(new RegExp("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")), z.null()]),
  label_refs: z.array(text).max(10000),
  context_refs: z.array(text).max(10000),
  linked_cell_ids: z.array(text).max(10000),
  origin: z.enum(["header_cell", "labeled_text", "organization_pattern", "person_pattern", "address_pattern", "date_literal"]),
  flags: z.array(text).max(10000).refine(values => values.includes("entity_kind_proposed")),
  semantic_role: z.literal("unassigned"),
  review_status: z.literal("requires_review"),
}).strict();

const sourceRecordsSchema = z.object({
  schema_version: z.literal("1.1"),
  generator: z.literal("source-records/1.1"),
  status: z.literal("unreviewed_extraction"),
  document: z.object({
  id: id,
  source_ref: z.union([text, z.null()]),
  source_sha256: text.regex(new RegExp("^[0-9a-f]{64}$")),
  digest_scope: z.literal("normalized OCR snapshot, not PDF bytes"),
  pages: z.array(pageSchema).max(10000),
}).strict(),
  tables: z.array(tableSchema).max(10000),
  records: z.array(recordSchema).max(10000),
  evidence: z.array(evidenceSchema).max(10000),
  context: z.array(contextSchema).max(10000),
  document_notes: z.array(noteSchema).max(10000),
  coverage: z.object({
  numeric_candidates: z.array(candidateSchema).max(10000),
  unresolved_refs: z.array(text).max(10000),
}).strict(),
  issues: z.array(issueSchema).max(10000),
  review_context: z.union([reviewContextSchema, z.null()]),
  limitations: z.array(text).max(10000),
  entities: z.array(entitySchema).max(4000),
}).strict();

export type SourceRecords = z.infer<typeof sourceRecordsSchema>;

export type SourceReference =
  | { kind: 'cell'; recordId: string; cellId: string }
  | { kind: 'entity'; entityId: string };
export interface ResolvedObservation {
  valueType: 'string' | 'number' | 'date';
  rawText: string;
  decimalValue?: string;
  dateValue?: string;
  flags: string[];
  page: number;
  sourceRefs: string[];
  currency?: string | null;
}
export class SourceRecordsError extends Error {
  constructor(public readonly code: string) {
    super(`Structured source records rejected (${code}).`);
    this.name = 'SourceRecordsError';
  }
}
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new SourceRecordsError('invalid_records');
}

// Bound work BEFORE Zod recursively visits the input. No truncation, cycles,
// exotic prototypes, accessors or non-JSON values; errors contain no source text.
function checkBudget(input: unknown) {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number) {
    requireValid(++nodes <= 400_000 && depth <= 32);
    if (typeof value === 'string') { bytes += Buffer.byteLength(value, 'utf8'); requireValid(value.length <= 100_000); }
    else if (value !== null && typeof value === 'object') {
      requireValid(!ancestors.has(value));
      requireValid(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
      ancestors.add(value);
      const keys = Object.keys(value);
      requireValid(keys.length <= 20_000);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireValid(descriptor && 'value' in descriptor);
        bytes += Buffer.byteLength(key, 'utf8');
        visit(descriptor.value, depth + 1);
      }
      ancestors.delete(value);
    } else requireValid(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)));
    requireValid(bytes <= 16 * 1024 * 1024);
  }
  visit(input, 0);
}
function unique(values: string[]) { requireValid(new Set(values).size === values.length); }
function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
// Python producer offsets count Unicode code points, not UTF-16 code units.
function sourceSlice(raw: string, start: number, end: number, expected: string) {
  const points = Array.from(raw);
  requireValid(start < end && end <= points.length && points.slice(start, end).join('') === expected);
}

type Cell = SourceRecords['records'][number]['cells'][number];
type Source = Cell['source'];
function validateIntegrity(data: SourceRecords) {
  requireValid(data.document.id === `sha256:${data.document.source_sha256}`);
  requireValid(data.document.pages.length > 0 && data.document.pages.length <= 10 && data.tables.length <= 100 && data.entities.length <= 4000);
  unique(data.document.pages.map(p => String(p.page)));
  const pages = new Map(data.document.pages.map(p => [p.page, p]));
  requireValid(data.document.pages.every(p => p.page <= 10));
  const cells = data.records.flatMap(r => r.cells);
  const headers = data.tables.flatMap(t => t.header_cells);
  requireValid(cells.length + headers.length <= 10_000);
  unique([...data.tables, ...data.tables.flatMap(t => t.columns), ...data.records, ...cells, ...headers, ...data.evidence, ...data.entities].map(v => v.id));
  const evidence = new Map(data.evidence.map(e => [e.id, e]));
  const cellMap = new Map(cells.map(c => [c.id, c]));
  const observedCells = new Map([...cells, ...headers].map(c => [c.id, c]));
  const rows = new Map(data.records.map(r => [r.id, r]));
  const tables = new Map(data.tables.map(t => [t.id, t]));
  const entityMap = new Map(data.entities.map(e => [e.id, e]));
  const registry = new Map<string, { page: number; raw_text: string; bbox: number[] | null; bbox_scope: string }>(data.evidence.map(e => [e.id, e]));
  for (const cell of [...cells, ...headers]) registry.set(cell.id, { ...cell.source, raw_text: cell.raw_text });
  function refs(values: string[], map: ReadonlyMap<string, unknown>, page?: number) {
    unique(values);
    for (const value of values) {
      requireValid(map.has(value));
      if (page !== undefined) requireValid((map.get(value) as {page: number}).page === page);
    }
  }
  function geometry(page: number, box: number[] | null) {
    const p = pages.get(page); requireValid(p);
    if (box) requireValid(box[0]! >= 0 && box[1]! >= 0 && box[0]! < box[2]! && box[1]! < box[3]! && box[2]! <= p.width && box[3]! <= p.height);
  }
  function typed(value: z.infer<typeof typedValueSchema>) {
    if (value.date_value !== null) requireValid(calendarDate(value.date_value));
    if (value.decimal_value !== null) requireValid(value.data_type === 'decimal' && value.status === 'parsed' && value.date_value === null);
    if (value.date_value !== null) requireValid(value.data_type === 'date' && value.status === 'parsed');
    if (value.status === 'parsed') requireValid(value.data_type === 'decimal' ? value.decimal_value !== null : value.data_type === 'date' && value.date_value !== null);
  }
  function source(value: Source, page: number) {
    requireValid(value.page === page);
    geometry(page, value.bbox);
    requireValid((value.bbox === null) === (value.bbox_scope === 'unavailable'));
    refs(value.ocr_refs, evidence, page);
    if (value.kind === 'ocr_region_mapping') refs(value.label_refs, evidence, page);
  }
  for (const e of data.evidence) {
    geometry(e.page, e.bbox);
    if (e.kind === 'region') requireValid(e.parent_ref === undefined && e.start === undefined && e.end === undefined && e.bbox_scope === 'ocr_region');
    else {
      const parent = e.parent_ref && evidence.get(e.parent_ref);
      requireValid(parent && parent.kind === 'region' && parent.page === e.page && e.start !== undefined && e.end !== undefined && e.bbox_scope === 'parent_ocr_region');
      sourceSlice(parent.raw_text, e.start, e.end, e.raw_text);
      requireValid(JSON.stringify(parent.bbox) === JSON.stringify(e.bbox));
    }
  }
  for (const table of data.tables) {
    geometry(table.page, null);
    refs(table.row_ids, rows, table.page);
    requireValid(table.row_ids.every(r => rows.get(r)!.table_id === table.id));
    unique(table.columns.map(c => String(c.index)));
    const tableHeaders = new Map(table.header_cells.map(h => [h.id, h]));
    for (const col of table.columns) { refs(col.header_cell_refs, tableHeaders); refs(col.header_evidence_refs, evidence, table.page); }
    for (const h of table.header_cells) {
      source(h.source, table.page);
      requireValid(h.row_index === h.source.row_index && h.column_index === h.source.column_index && h.rowspan === h.source.rowspan && h.colspan === h.source.colspan);
    }
  }
  for (const row of data.records) {
    const table = tables.get(row.table_id);
    requireValid(table && table.page === row.page && table.row_ids.includes(row.id) && row.id === row.row_id && table.origin === row.origin);
    refs(row.context_refs, registry, row.page);
    refs(row.spanning_cell_refs, cellMap);
    for (const ref of row.spanning_cell_refs) requireValid(data.records.some(r => r.table_id === row.table_id && r.row_index !== null && row.row_index !== null && r.row_index < row.row_index && r.cells.some(c => c.id === ref && c.source.kind === 'engine_table_cell' && c.source.row_index + c.source.rowspan > row.row_index!)));
    const columns = new Map(table.columns.map(c => [c.id, c]));
    for (const c of row.cells) {
      refs(c.column_ids, columns); requireValid(c.column_ids.length > 0);
      refs(c.header_refs, c.source.kind === 'engine_table_cell' ? new Map(table.header_cells.map(h => [h.id, h])) : evidence);
      source(c.source, row.page); typed(c.typed_value);
      if (c.source.kind === 'engine_table_cell') {
        const native = c.source;
        requireValid(row.origin === 'engine_table' && row.row_index === native.row_index);
        const covered = table.columns.filter(col => col.index >= native.column_index && col.index < native.column_index + native.colspan).map(col => col.id).sort();
        requireValid(covered.length === native.colspan && JSON.stringify(covered) === JSON.stringify([...c.column_ids].sort()));
      }
      else requireValid(row.origin === 'spatial_proposal');
      for (const a of c.alternatives) { refs([a.source_ref], registry, row.page); typed(a.typed_value); requireValid(registry.get(a.source_ref)!.raw_text === a.raw_text); }
    }
  }
  unique(data.context.map(c => c.source_ref));
  for (const c of data.context) {
    refs([c.source_ref], evidence, c.page); geometry(c.page, c.bbox);
    requireValid(evidence.get(c.source_ref)!.raw_text === c.raw_text && JSON.stringify(evidence.get(c.source_ref)!.bbox) === JSON.stringify(c.bbox));
    for (const date of c.date_mentions) {
      sourceSlice(c.raw_text, date.start, date.end, date.raw_text);
      requireValid(date.status === 'parsed' ? date.date_value !== null && calendarDate(date.date_value) : date.date_value === null);
    }
  }
  for (const n of data.document_notes) { refs([n.ref], evidence, n.page); geometry(n.page, n.bbox); requireValid(evidence.get(n.ref)!.raw_text === n.text && JSON.stringify(evidence.get(n.ref)!.bbox) === JSON.stringify(n.bbox)); }
  for (const e of data.entities) {
    requireValid(pages.has(e.page) && (e.kind !== 'address' || e.lines.length <= 8));
    requireValid(e.kind === 'date' ? e.normalized_value === null || calendarDate(e.normalized_value) : e.normalized_value === null);
    requireValid(e.lines.length === 1 || e.flags.includes('source_fragments_joined'));
    requireValid(e.raw_text === e.lines.map(l => l.raw_text).join('\n'));
    refs(e.label_refs, registry, e.page); refs(e.context_refs, registry, e.page); refs(e.linked_cell_ids, cellMap);
    for (const cid of e.linked_cell_ids) requireValid(cellMap.get(cid)!.source.page === e.page);
    for (const line of e.lines) {
      const original = registry.get(line.source_ref);
      requireValid(original && original.page === e.page);
      sourceSlice(original.raw_text, line.start, line.end, line.raw_text);
      requireValid(JSON.stringify(line.bbox) === JSON.stringify(original.bbox));
      requireValid(line.bbox_scope === original.bbox_scope || (original.bbox_scope === 'ocr_region' && line.bbox_scope === 'parent_ocr_region'));
    }
  }
  unique(data.coverage.numeric_candidates.map(c => c.source_ref));
  for (const c of data.coverage.numeric_candidates) {
    refs([c.source_ref], evidence, c.page); requireValid(evidence.get(c.source_ref)!.raw_text === c.raw_text);
    refs(c.cell_refs, cellMap); refs(c.entity_refs, entityMap, c.page);
    for (const cid of c.cell_refs) requireValid(cellMap.get(cid)!.source.page === c.page);
  }
  refs(data.coverage.unresolved_refs, evidence);
  const unresolved = data.coverage.numeric_candidates.filter(c => /^(unresolved|unassigned)/.test(c.disposition)).map(c => c.source_ref).sort();
  requireValid(JSON.stringify(unresolved) === JSON.stringify([...data.coverage.unresolved_refs].sort()));
  if (data.review_context) {
    const review = data.review_context;
    const validateProposal = (proposal: z.infer<typeof proposalSchema>) => {
      unique(proposal.fields.map(f => f.id));
      for (const field of proposal.fields) {
        for (const values of [field.section_refs, field.row_refs, field.column_refs, field.value_refs, field.unit_refs]) refs(values, evidence);
      }
    };
    validateProposal(review.proposal);
    refs(Object.keys(review.ignored), evidence);
    refs(Object.keys(review.reviews), new Map(review.proposal.fields.map(f => [f.id, f])));
    for (const event of review.history) {
      if (event.previous_proposal) validateProposal(event.previous_proposal);
      if (event.previous_ignored) refs(Object.keys(event.previous_ignored), evidence);
      if (event.ref) refs([event.ref], evidence);
    }
  }
  for (const issue of data.issues) {
    if (issue.page !== undefined) requireValid(pages.has(issue.page));
    if (issue.table_id !== undefined) refs([issue.table_id], tables, issue.page);
    if (issue.cell_id !== undefined) { refs([issue.cell_id], observedCells); if (issue.page !== undefined) requireValid(observedCells.get(issue.cell_id)!.source.page === issue.page); }
  }
}

/** Validates a decoded JSON object; retains notes/context/review annotations unchanged.
 * Limits: 16 MiB aggregate text, 400k nodes, depth 32, 100k characters/string,
 * 10 pages, 100 tables, 10k cells/headers and 4k entities. Never truncates.
 */
export function parseSourceRecords(input: unknown): SourceRecords {
  try {
    checkBudget(input);
    const result = sourceRecordsSchema.safeParse(input);
    requireValid(result.success);
    validateIntegrity(result.data);
    return result.data;
  } catch { throw new SourceRecordsError('invalid_records'); }
}

const referenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cell'), recordId: id, cellId: id }).strict(),
  z.object({ kind: z.literal('entity'), entityId: id }).strict(),
]);
const unsafeFlag = /ambiguous|conflict|unobserved|partial|scal|duplicate|overlap|competing|multiple|unparseable|invalid|unresolved|unsupported/i;
function copyable(flags: string[]) {
  if (flags.some(f => unsafeFlag.test(f))) throw new SourceRecordsError('unsafe_observation');
}
function failCopy(): never { throw new SourceRecordsError('unsafe_observation'); }

export function resolveObservation(records: SourceRecords, ref: SourceReference): ResolvedObservation {
  // Revalidate at the trust boundary, including callers passing a cast or mutated object.
  const data = parseSourceRecords(records);
  if (!referenceSchema.safeParse(ref).success) throw new SourceRecordsError('invalid_reference');
  const allCells = data.records.flatMap(r => r.cells);
  const evidence = new Map(data.evidence.map(e => [e.id, e]));
  function span(sourceRef: string, start = 0, end?: number) {
    const cell = allCells.find(c => c.id === sourceRef);
    if (cell?.source.ocr_refs.length === 1 && evidence.get(cell.source.ocr_refs[0]!)?.raw_text === cell.raw_text) sourceRef = cell.source.ocr_refs[0]!;
    const e = evidence.get(sourceRef);
    return { root: e?.parent_ref ?? sourceRef, start: (e?.start ?? 0) + start, end: (e?.start ?? 0) + (end ?? Array.from(e?.raw_text ?? allCells.find(c => c.id === sourceRef)?.raw_text ?? '').length) };
  }
  function overlaps(a: ReturnType<typeof span>, b: ReturnType<typeof span>) { return a.root === b.root && Math.max(a.start, b.start) < Math.min(a.end, b.end); }
  function resolveCell(cell: Cell) {
    const row = data.records.find(r => r.cells.some(c => c.id === cell.id))!;
    const table = data.tables.find(t => t.id === row.table_id)!;
    const flags = [...new Set([...table.flags, ...row.flags, ...cell.flags, ...cell.typed_value.warnings, 'requires_review', ...data.issues.filter(i => i.cell_id === cell.id || (!i.cell_id && i.table_id === table.id)).map(i => i.code)])];
    copyable(flags);
    if (data.coverage.numeric_candidates.some(c => c.cell_refs.includes(cell.id) && (c.disposition !== 'record_value' || c.cell_refs.length !== 1))) failCopy();
    if (!cell.raw_text.trim() || cell.alternatives.length || ['ambiguous', 'conflict'].includes(cell.source.agreement)) failCopy();
    if (cell.source.kind === 'ocr_region_mapping' && cell.source.ocr_refs.length !== 1) failCopy();
    // A claimed match cannot erase a different literal observation. Whitespace
    // differences remain conservatively non-copyable rather than guessing joins.
    if (cell.source.ocr_refs.some(r => evidence.get(r)!.raw_text.trim() !== cell.raw_text.trim())) failCopy();
    // Do not trust missing producer flags for duplicate/overlapping source assignments.
    for (const other of allCells) {
      if (other.id === cell.id) continue;
      if (cell.source.ocr_refs.some(a => other.source.ocr_refs.some(b => overlaps(span(a), span(b))))) failCopy();
      if (cell.source.kind === 'engine_table_cell' && other.source.kind === 'engine_table_cell' && cell.source.page === other.source.page && cell.source.table_index === other.source.table_index &&
          Math.max(cell.source.row_index, other.source.row_index) < Math.min(cell.source.row_index + cell.source.rowspan, other.source.row_index + other.source.rowspan) &&
          Math.max(cell.source.column_index, other.source.column_index) < Math.min(cell.source.column_index + cell.source.colspan, other.source.column_index + other.source.colspan)) failCopy();
    }
    if (row.cells.some(c => c.id !== cell.id && c.column_ids.some(col => cell.column_ids.includes(col)))) failCopy();
    const typed = cell.typed_value;
    if (typed.status === 'ambiguous' || typed.status === 'unobserved' || typed.data_type === 'unknown') failCopy();
    const base = { rawText: cell.raw_text, flags, page: row.page, sourceRefs: [...new Set([cell.id, ...cell.source.ocr_refs])] };
    if (typed.data_type === 'text' || typed.data_type === 'identifier') return { ...base, valueType: 'string' as const };
    if (typed.status !== 'parsed') failCopy();
    if (typed.data_type === 'date') {
      if (!typed.date_value || !clearDate(cell.raw_text, typed.date_value)) failCopy();
      return { ...base, valueType: 'date' as const, dateValue: typed.date_value };
    }
    if (/\b(?:thousands?|millions?|billions?|000)\b/i.test(cell.header_text.join(' '))) failCopy();
    if (!typed.decimal_value || typed.unit === 'percent' || typed.unit === '%' || cell.source.ocr_refs.some(r => evidence.get(r)?.kind === 'numeric_span')) failCopy();
    if (typed.currency !== null && !['USD', 'EUR', 'GBP', 'MYR', 'SGD', 'HKD', 'CNY', 'JPY', 'AUD', 'CAD', 'CHF', 'INR'].includes(typed.currency)) failCopy();
    if (typed.unit !== null && typed.unit !== typed.currency && typed.unit !== typed.currency_raw) failCopy();
    if (!observedDecimal(cell.raw_text, typed.decimal_value, typed.currency, typed.currency_raw)) failCopy();
    return { ...base, valueType: 'number' as const, decimalValue: typed.decimal_value, currency: typed.currency };
  }
  if (ref.kind === 'cell') {
    const row = data.records.find(r => r.id === ref.recordId);
    const cell = row?.cells.find(c => c.id === ref.cellId);
    if (!cell) throw new SourceRecordsError('unknown_reference');
    // Competing entity kinds linked to a cell cannot be bypassed by choosing cell mode.
    const linked = data.entities.filter(e => e.linked_cell_ids.includes(cell.id));
    linked.forEach(e => copyable(e.flags));
    if (new Set(linked.map(e => e.kind)).size > 1) failCopy();
    return resolveCell(cell);
  }
  const entity = data.entities.find(e => e.id === ref.entityId);
  if (!entity) throw new SourceRecordsError('unknown_reference');
  const flags = [...new Set([...entity.flags, 'requires_review'])];
  copyable(flags);
  const spans = entity.lines.map(l => span(l.source_ref, l.start, l.end));
  if (spans.some((a, i) => spans.some((b, j) => i !== j && overlaps(a, b)))) failCopy();
  for (const other of data.entities) {
    if (other.id !== entity.id && other.lines.some(l => spans.some(s => overlaps(s, span(l.source_ref, l.start, l.end))))) failCopy();
  }
  const linkedCells = allCells.filter(c => entity.linked_cell_ids.includes(c.id) || entity.lines.some(l => l.source_ref === c.id) || c.source.ocr_refs.some(r => spans.some(s => overlaps(s, span(r)))));
  for (const cell of linkedCells) {
    const result = resolveCell(cell);
    flags.push(...result.flags);
  }
  const base = { rawText: entity.raw_text, flags: [...new Set(flags)], page: entity.page, sourceRefs: [...new Set(entity.lines.map(l => l.source_ref))] };
  if (entity.kind !== 'date') return { ...base, valueType: 'string' };
  if (!entity.normalized_value || !clearDate(entity.raw_text, entity.normalized_value)) failCopy();
  return { ...base, valueType: 'date', dateValue: entity.normalized_value };
}

// Syntax checks only, no floating-point conversion or interpretation of scale/FX.
function observedDecimal(raw: string, decimal: string, currency: string | null, marker: string | null): boolean {
  let value = raw.trim();
  if (currency !== null) {
    const markers: Record<string, string[]> = { USD: ['USD', 'US$'], EUR: ['EUR', '€'], GBP: ['GBP', '£'], MYR: ['MYR', 'RM'], SGD: ['SGD', 'S$'], HKD: ['HKD', 'HK$'], CNY: ['CNY', 'RMB'], JPY: ['JPY'], AUD: ['AUD', 'A$'], CAD: ['CAD', 'C$'], CHF: ['CHF'], INR: ['INR', '₹'] };
    if (!marker || !markers[currency]?.includes(marker)) return false;
    if (value.startsWith(marker)) value = value.slice(marker.length).trim();
    else if (value.endsWith(marker)) value = value.slice(0, -marker.length).trim();
    else return false;
  } else if (marker !== null) return false;
  const negative = value.startsWith('(') && value.endsWith(')');
  if (negative) value = value.slice(1, -1).trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value) || (negative && /^[+-]/.test(value))) return false;
  value = (negative ? '-' : '') + value.replaceAll(',', '').replace(/^\+/, '');
  const canonical = (v: string) => v.replace(/^(-?)0+(?=\d)/, '$1').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^-0$/, '0');
  return canonical(value) === canonical(decimal);
}
function clearDate(raw: string, normalized: string): boolean {
  if (!calendarDate(normalized)) return false;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value === normalized;
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const dayFirst = /^(\d{1,2})\s*([A-Za-z]+\.?)\s*(\d{4})$/.exec(value);
  const monthFirst = /^([A-Za-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
  if (!dayFirst && !monthFirst) return false; // Producer marks ALL slash dates ambiguous.
  const day = dayFirst?.[1] ?? monthFirst![2]!;
  const token = (dayFirst?.[2] ?? monthFirst![1]!).toLowerCase();
  const year = dayFirst?.[3] ?? monthFirst![3]!;
  const monthName = token.replace(/\.$/, '');
  const month = full.findIndex(m => m === monthName || m.slice(0, 3) === monthName || (m === 'september' && monthName === 'sept')) + 1;
  if (!month || (token.endsWith('.') && (monthName.length > 4 || ['may', 'june', 'july'].includes(monthName)))) return false;
  return `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}` === normalized;
}
