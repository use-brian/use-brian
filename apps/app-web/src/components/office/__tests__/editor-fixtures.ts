import type { DocumentSnapshot, OfficeRichTextRun, PresentationSnapshot } from "@use-brian/office-model";
export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const run = (n: number, text: string): OfficeRichTextRun => ({ id: uid(n), text, style: { fontFamily: "Arial", fontSizePt: 12, bold: false, italic: false, underline: false, strike: false, color: "#111111" } });
const common = { schemaVersion: 1 as const, capabilityVersion: 1 as const, artifactId: uid(1), workspaceId: uid(2), locale: "en", defaultLanguage: "en", templateVersionId: uid(3), rootId: uid(4), title: "Quarterly plan", resources: [{ id: uid(50), kind: "image" as const, hash: "a".repeat(64), mime: "image/png", sensitivity: "internal" as const }, { id: uid(51), kind: "video" as const, hash: "b".repeat(64), mime: "video/mp4", sensitivity: "internal" as const }], accessibility: { title: "Quarterly plan" } };
export function documentFixture(): DocumentSnapshot { return { ...common, family: "document", sections: [{ id: uid(5), page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: "portrait" }, header: [run(6, "Header")], footer: [run(7, "Footer")], showPageNumber: true, nodes: [
  { id: uid(10), kind: "heading", level: 1, styleName: "Heading 1", runs: [run(11, "Summary")] },
  { id: uid(12), kind: "paragraph", styleName: "Body", alignment: "start", runs: [run(13, "Body copy")] },
  { id: uid(14), kind: "list", ordered: false, level: 0, items: [{ id: uid(15), runs: [run(16, "Item")] }] },
  { id: uid(17), kind: "table", headerRows: 1, rows: [{ id: uid(18), cells: [{ id: uid(19), runs: [run(20, "Cell")], rowSpan: 1, colSpan: 1 }] }] },
  { id: uid(21), kind: "image", resourceId: uid(50), altText: "Chart image", decorative: false, widthPt: 100, heightPt: 80 },
  { id: uid(22), kind: "chart", chartType: "bar", title: "Revenue", categories: ["Q1"], series: [{ name: "ARR", values: [1] }], altText: "Revenue chart" },
  { id: uid(23), kind: "video", resourceId: uid(51), posterResourceId: uid(50), altText: "Demo", transcript: "Demo transcript", recipientAccessibleUrl: "https://example.com/demo" },
  { id: uid(24), kind: "pageBreak" }, { id: uid(25), kind: "sectionBreak" },
] }] }; }
export function presentationFixture(): PresentationSnapshot { const masterId = uid(60), layoutId = uid(61); return { ...common, family: "presentation", slideSize: { widthPt: 960, heightPt: 540 }, themeId: uid(62), masters: [{ id: masterId, name: "Master", lockedObjectIds: [] }], layouts: [{ id: layoutId, masterId, name: "Layout", placeholderIds: [] }], slides: [{ id: uid(63), title: "Slide", masterId, layoutId, notes: [run(64, "Notes")], objects: [
  { id: uid(70), kind: "text", geometry: { xPt: 10, yPt: 10, widthPt: 200, heightPt: 50, rotationDeg: 0 }, locked: false, runs: [run(71, "Title")], alignment: "start", verticalAlignment: "top" },
  { id: uid(72), kind: "shape", geometry: { xPt: 10, yPt: 70, widthPt: 100, heightPt: 50, rotationDeg: 0 }, locked: false, shape: "rectangle", fill: "#FFFFFF", stroke: "#111111", strokeWidthPt: 1, text: [run(73, "Shape")], altText: "Shape" },
  { id: uid(74), kind: "connector", geometry: { xPt: 120, yPt: 70, widthPt: 100, heightPt: 1, rotationDeg: 0 }, locked: false, connector: "straight", stroke: "#111111" },
  { id: uid(75), kind: "image", geometry: { xPt: 10, yPt: 130, widthPt: 100, heightPt: 80, rotationDeg: 0 }, locked: false, resourceId: uid(50), altText: "Image", decorative: false },
  { id: uid(76), kind: "chart", geometry: { xPt: 120, yPt: 130, widthPt: 160, heightPt: 90, rotationDeg: 0 }, locked: false, chartType: "bar", title: "Revenue", categories: ["Q1"], series: [{ name: "ARR", values: [1] }], altText: "Revenue chart" },
  { id: uid(77), kind: "table", geometry: { xPt: 300, yPt: 130, widthPt: 160, heightPt: 90, rotationDeg: 0 }, locked: false, headerRows: 1, rows: [{ id: uid(78), cells: [{ id: uid(79), runs: [run(80, "Cell")], rowSpan: 1, colSpan: 1 }] }] },
  { id: uid(81), kind: "video", geometry: { xPt: 470, yPt: 130, widthPt: 160, heightPt: 90, rotationDeg: 0 }, locked: false, resourceId: uid(51), posterResourceId: uid(50), altText: "Video", transcript: "Transcript" },
], readingOrder: [uid(70),uid(72),uid(74),uid(75),uid(76),uid(77),uid(81)] }] }; }
