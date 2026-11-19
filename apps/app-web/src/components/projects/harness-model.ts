import type { HarnessDefinition, HarnessEvidence, HarnessRevision, HarnessRun, HarnessScope, HarnessTree, VerificationResult, ResultStatus } from "@/lib/api/project-harness";
export const emptyDefinition: HarnessDefinition = { schemaVersion: 1, rules: [], codeChecks: [], acceptanceScenarios: [] };
export const definitionText = (definition: HarnessDefinition) => JSON.stringify(definition, null, 2);
export function scopeArchived(tree: HarnessTree, scope: HarnessScope): boolean {
  if (scope.kind === "project") return false;
  if (tree.products.find(p => p.id === scope.productId)?.status !== "active") return true;
  return scope.kind === "component" && tree.components.find(c => c.id === scope.componentId && c.productId === scope.productId)?.status !== "active";
}
export function canApprove(revision: HarnessRevision | null, viewerId: string, owner: boolean, archived: boolean): boolean {
  return !!revision && !!revision.createdBy && revision.createdBy !== viewerId && owner && !archived;
}
/** Persist user insertions/deletion offsets, never an automatic server snapshot. */
type TextEdit = { start: number; removed: number; inserted: string };
export type AuthoredPatch = TextEdit & { revision: number; revisionId: string | null; edits?: TextEdit[] };
export function authoredPatch(base: string, edited: string, revision: number, revisionId: string | null): AuthoredPatch {
  let start = 0;
  while (start < base.length && start < edited.length && base[start] === edited[start]) start++;
  let end = 0;
  while (end < base.length - start && end < edited.length - start && base[base.length - 1 - end] === edited[edited.length - 1 - end]) end++;
  return { revision, revisionId, start, removed: base.length - start - end, inserted: edited.slice(start, edited.length - end) };
}
export function readPatch(raw: string): AuthoredPatch | null {
  try {
    const p = JSON.parse(raw) as AuthoredPatch;
    const validEdit = (e: TextEdit) => e && Number.isInteger(e.start) && e.start >= 0 && Number.isInteger(e.removed) && e.removed >= 0 && typeof e.inserted === "string";
    return Number.isInteger(p.revision) && p.revision >= 0 && (p.revisionId === null || typeof p.revisionId === "string") && validEdit(p) && (p.edits === undefined || Array.isArray(p.edits) && p.edits.every(validEdit)) ? p : null;
  } catch { return null; }
}
export function applyPatch(base: string, patch: AuthoredPatch): string {
  return [patch, ...(patch.edits ?? [])].reduce((text, edit) => text.slice(0, edit.start) + edit.inserted + text.slice(edit.start + edit.removed), base);
}
/** Each input event records only its changed span, not unchanged server text between distant edits. */
export function extendAuthoredPatch(base: string, edited: string, revision: number, revisionId: string | null, previous: AuthoredPatch | null): AuthoredPatch {
  if (!previous) return authoredPatch(base, edited, revision, revisionId);
  const { start, removed, inserted } = authoredPatch(applyPatch(base, previous), edited, revision, revisionId);
  return { ...previous, edits: [...(previous.edits ?? []), { start, removed, inserted }] };
}
/** Reusing offsets is safe only when the protected base is byte-identical. Otherwise
 * fail closed: no whole-document diff or replacement may enter durable storage.
 * The caller keeps the old patch and exposes its authored insertions for recovery. */
export function rebaseAuthoredPatch(base: string, nextBase: string, patch: AuthoredPatch, revision: number, revisionId: string | null): AuthoredPatch | null {
  return base === nextBase ? { ...patch, revision, revisionId } : null;
}
/** Basic shape check only. New optional contracts survive untouched; API validates them. */
export function parseDefinition(text: string): HarnessDefinition | null {
  try {
    const d = JSON.parse(text);
    return d && d.schemaVersion === 1 && Array.isArray(d.rules) && Array.isArray(d.codeChecks) && Array.isArray(d.acceptanceScenarios) ? d : null;
  } catch { return null; }
}
export type ChecklistAnswer = { status: ResultStatus; reason: string };
export function checklistResult(run: HarnessRun, answers: Record<string, ChecklistAnswer>, evidence: HarnessEvidence[]): VerificationResult | null {
  if (run.executor !== "human" || !run.preview.scenario.criteria.length) return null;
  const criteria: VerificationResult["criteria"] = [];
  const used: VerificationResult["evidence"] = [];
  for (const criterion of run.preview.scenario.criteria) {
    const answer = answers[criterion.key];
    if (!answer) return null;
    const own = evidence.filter(e => e.runId === run.id && e.criterionKey === criterion.key && e.provenance === "human_reported");
    if (answer.status === "passed" ? !own.length : !answer.reason.trim()) return null;
    criteria.push({ criterionKey: criterion.key, status: answer.status, evidenceIds: own.map(e => e.id), ...(answer.reason.trim() ? { reason: answer.reason.trim() } : {}) });
    used.push(...own.map(e => ({ id: e.id, criterionKey: e.criterionKey, kind: e.kind, reference: e.id })));
  }
  const p = run.preview;
  return { binding: { runId: run.id, packetSha256: p.packetSha256, specification: p.specification, build: p.build, scenarioKey: p.scenario.key }, status: (["failed", "blocked", "inconclusive", "passed"] as const).find(s => criteria.some(c => c.status === s))!, criteria, evidence: used };
}
