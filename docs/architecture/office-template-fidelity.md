# Office template export fidelity

The existing Office workflow imports editable DOCX templates into the canonical
document model, fills their placeholders, and exports through the existing DOCX
and LibreOffice PDF generators. Reference PDFs are comparison inputs only.

## Chat template discovery

Native attended personal web chats create template-derived Office jobs through
one app-role transaction, rather than the legacy shell/job pair. The host checks
the execution identity and live persisted chat binding, records its bounded
authoring authority and source fingerprint, and revalidates those at claim and
publication. A General template's inherited placement stays General when the
turn adds no department; this does not grant membership in the assistant's home.
Department and Project floors, private sources, and turn evidence remain binding.
Changed chat context, revoked membership, held/changed sources or a narrower
current authoring ceiling prevent publication. Human form jobs retain their
authenticated-session binding; chat jobs cannot manufacture that proof.
The session authority lease exposes a detached host-only native credential
snapshot separately from durable source evidence. A first user turn may still
have an unlocked construction snapshot: Office checks the live, now-locked chat
inside its transaction and the original authority lease again. This does not
make an invocation-only source eligible for generic durable replay.

Chat exposes a read-only `listOfficeTemplates` tool for finding currently
published templates by family and name. It returns registry and published-version
IDs separately; `createOfficeArtifact.templateId` binds the published-version ID,
never the registry or editable draft ID. Discovery uses current application-role
RLS and the active turn's clearance, department and Project ceilings across the
template, draft, bundle and referenced resources. It returns bounded metadata,
not bundle bytes or unpublished drafts, and contributes the returned scopes to
the turn's evidence. It grants no new access.

Creation tool descriptions direct named-template requests through discovery.
An unavailable source gives an actionable discovery instruction rather than an
opaque exception. A read-only inspection or failed creation is never described
as a queued or completed document. Discovery does not reserve quote numbers;
monthly numbering requires existing records or an explicit user-supplied number.

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

The live document editor retains the row height rule in its collaborative
schema. Pasting text into one table-cell paragraph replaces text directly in
that paragraph, preserving its destination typography and cell boundary, even
when the clipboard also supplies HTML. Multiline text inserts literal line breaks;
it must not promote pasted cell paragraphs into body content or treat CSS strings
as canonical run formatting.

## Verification

Local Document editing preserves a canonical run through cell paragraph splits,
full-cell deletion, and Find/Replace to an empty value. A split keeps the source
typography on empty paragraphs and restores a fresh `officeRun` stored mark after
changing paragraph attributes. An emptied local text block retains an empty run
as its style anchor. Native typing into an empty Office block consumes that
anchor and creates a fresh marked run. Existing unmarked saved or remote text is
never repaired by this editor behavior; the persistence decoder remains strict.

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

Document PDF failures keep their underlying renderer cause in server diagnostics.
The member-facing receipt contains only Brian's existing failure code and safe
message. The shared renderer already bounds vendor stderr to its final 2000
characters; retaining that cause makes service-only startup failures diagnosable
without exposing vendor output in the document UI.

Native PDF export restores canonical page dimensions when LibreOffice rounds or
snaps a custom size by at most half a point. The correction changes page boxes
only and retains the original upper-left content origin, fonts, vectors, and
annotation coordinates. It never rescales page content. Larger size differences,
rotated pages, and deliberately cropped pages are outside this rounding repair.

A cell's explicit `wrapText: false` survives native DOCX export as `w:noWrap`.
The editable canonical part alone is insufficient: external office renderers
must receive the wrapping policy in the ordinary WordprocessingML cell properties.

An admitted template keeps its linked active authoring draft editable for the
next version. Routing reads and reviewed routing saves accept both draft and
admitted registry states, subject to the same linked artifact and current SQL
read/mutation authority. Deprecated, trashed, retained, purged, missing or held
sources remain unavailable. Saving draft routing does not modify the current
admitted version's field schema or bundle. Publishing appends another immutable
version and advances the registry head through the existing compile checks.

Office's page setup exposes the existing footer edge distance and a signed left
indent for the footer paragraph. The indent changes the footer text area while
retaining the page margins and body layout. Native DOCX, canonical/Yjs editing,
and preview layout preserve it. Table controls expose minimum/exact row height
so templates can clip an overflowing field in its own row without moving the
following date or location row. Clipboard text remains ordinary editable text.
The paragraph spacing menu accepts fractional point values for exact line height
and space before/after a paragraph, including paragraphs inside table cells.
Numeric edits retain input focus and the collaborative selection while updating
the canonical paragraph attributes. Escape closes spacing and table menus even
when a numeric input is focused; tall menus scroll within the available viewport.

For a no-wrap cell, native Word text uses typographic no-break spaces while the
canonical part retains the original value. Explicit paragraph and line breaks
remain intact. An exact row height controls clipping of excess lines.
