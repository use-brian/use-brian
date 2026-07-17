-- 333_blueprint_record_citations.sql
--
-- Typed CITATIONS for blueprint record fields -- the queryable half of the
-- provenance a synthesized brief already carries as prose.
--
-- A recording fill writes fields whose text is full of `[0:47:21]` citations the
-- model copied from the transcript. Since the render-time decoration those are
-- clickable, but they are still just characters: you cannot count them, ask
-- which the model invented, or join a decision back to the segment it came from.
-- `field_citations` is that join, resolved at write time and validated against
-- the transcript (see shared/src/transcript-citations.ts).
--
-- Shape -- a SIDECAR keyed by the same field keys as `fields`:
--
--   { "decisions": [ { "startMs": 2841000, "segmentIndex": 38,
--                      "speaker": "Priya", "confidence": "parsed" } ] }
--
-- WHY A SEPARATE COLUMN, not `fields: { value, citations }`.
--   The nested shape is tempting (no migration -- `fields` is already jsonb) and
--   it is a silent-corruption trap. `fields` is a PURE key -> value map and four
--   live readers depend on that: `blueprintRecordToBlocks` projects it onto the
--   brief page, `getBlueprintRecord` hands it to a model, `send-page.ts` resolves
--   `recordField` into an email recipient/subject, and `{{lastRun.output.*}}`
--   templates it into workflows. Every one of them does `String(value)` on
--   whatever it finds. Nesting turns all four into "[object Object]" -- not a
--   crash, not a test failure: a brief page, an email address, and a workflow
--   variable that are quietly wrong. A sidecar keeps `fields` exactly what every
--   reader already believes it is, and citations are additive: absent for every
--   non-recording fill, and for every record written before today.
--
-- No backfill. Old records keep their prose citations, which still linkify at
-- render (the decoration parses text, not this column). Re-filling a recording
-- populates them; a one-shot backfill over the same extractor stays possible.
--
-- Store: sidanclaw/packages/api/src/db/blueprint-records-store.ts.
-- Spec: docs/architecture/brain/structural-synthesis.md -> "Citations".

BEGIN;

ALTER TABLE public.blueprint_records
    ADD COLUMN field_citations jsonb DEFAULT '{}'::jsonb NOT NULL;

COMMENT ON COLUMN public.blueprint_records.field_citations IS
    'Sidecar to `fields`, same keys: field key -> FieldCitation[] resolved at write time. Never nest citations into `fields` -- readers there assume a pure value map.';

COMMIT;
