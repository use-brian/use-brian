// Authorship NOT NULL enforcement at the store insert layer
// (company-brain WU-4.5). See docs/plans/company-brain/permissions.md
// → "Authorship and audit": every brain-primitive row records
// `created_by_user_id` (NOT NULL), `created_by_assistant_id?`,
// `source_episode_id?`. Migration 128 added the universal column set
// but deliberately left the column nullable at the DB level so the
// migration could apply against legacy rows with no recoverable
// author. WU-4.5 closes the gap at the application boundary —
// every in-scope insert helper calls `assertAuthorshipPresent` at
// its head, rejecting `undefined`, `null`, empty, or whitespace-only
// values before any SQL fires.

export function assertAuthorshipPresent(
  helperName: string,
  createdByUserId: string | null | undefined,
): asserts createdByUserId is string {
  if (typeof createdByUserId !== 'string' || createdByUserId.trim() === '') {
    throw new TypeError(
      `${helperName}: createdByUserId is required (WU-4.5 authorship enforcement)`,
    )
  }
}
