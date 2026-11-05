# Bounded session publication completion

Native transcript publication validates its dependency graph again through
deferred database constraints. This final proof must run before the transaction
releases its workspace and session locks, and no saved-message event may be
emitted until the transaction commits.

For non-owner session publication transactions, run `SET CONSTRAINTS ALL
IMMEDIATE` after the callback has written its rows and before the final live
authority and abort checks. This fires every pending deferred check as an
ordinary statement, under the connection's configured `statement_timeout`.
Leaving this work to PostgreSQL's transaction-end processing can hold the
session lock beyond the query deadline, preventing heartbeats and the Stop
request from updating that same row.

No constraint is disabled, no source proof is reused, and no success is reported
for a timed-out completion. Failure rolls the transaction back and releases its
connection. Abort, authority, and source-accumulator checks still run after the
deferred proof and before COMMIT. Record its duration as
`publication_constraints`, separately from `publication_commit`.

Regression coverage must exercise an actual deferred constraint that exceeds a
short fixture deadline, prove the message rows roll back, and prove another
connection can acquire the session row afterward. Unit coverage also verifies
that an abort or authority change during completion cannot reach COMMIT.
