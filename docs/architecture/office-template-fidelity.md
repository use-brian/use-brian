# Office template export fidelity

The existing Office workflow imports editable DOCX templates into the canonical
document model, fills their placeholders, and exports through the existing DOCX
and LibreOffice PDF generators. Reference PDFs are comparison inputs only.

## Sections

DOCX import retains each paragraph section boundary and the final body section.
The section properties describe the content before that boundary. Mixed page
sizes, margins, header/footer edge distances, and section-local header/footer
relationships survive import and native export. Missing header/footer references
inherit the preceding section's selected part; an explicitly empty part clears
it. A blank paragraph used solely to carry a section boundary must not become an
extra body paragraph. A final empty section is retained for intentional blank
pages. Legacy snapshots without edge distances keep the existing export defaults.

The canonical model renders sections on separate pages. Other DOCX section-break
types are diagnosed as normalized rather than silently claimed to be preserved.

## Table row heights

Fixed DOCX row heights retain an explicit `heightRule: exact` alongside the
existing `minHeightPt` numeric height. Missing rules keep legacy minimum-height
behavior. Native export writes the corresponding Word height rule. Layout uses
the fixed height without expanding it for text, and previews clip overflowing
cell contents in rows whose full span has fixed heights. This keeps following
rows and paragraphs at their authored positions.

## Verification

Generic document construction sends a closed JSON Schema to the provider. The
root object permits exactly `title` and `values`; the nested `values` object
permits exactly the template's discovered placeholder names. Both objects set
`additionalProperties: false`, and every discovered name is listed in `required`.
An optional value remains an empty string rather than an omitted key. This
keeps the Office request compatible with strict structured-output providers and
the constructor's existing exact-field validation.

Regression fixtures exercise mixed page sizes, distinct and inherited footers,
empty final sections, and native XML after removing the canonical custom part.
For template acceptance, export through Office, render every PDF page, compare
against the reference at a fixed resolution, and adjust the editable template or
existing generator. Semantic round-trip success alone is not visual equality.
