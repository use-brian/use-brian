# Chat reply streaming and reload

Brian must deliver a saved, currently authorized reply both on its live stream
and after a browser reload. A database row alone does not establish that the
current reader may see its source-dependent content.

## Streaming under backpressure

The Codex transport receives notifications independently of the query-loop
consumer. When authorization or delivery is slower than incoming notifications,
combine adjacent queued text deltas of the same kind, up to 4,096 JavaScript
characters per combined delta. Apply this to text and reasoning separately.
Do not add a batching timer, merge across a tool/usage/error boundary, mutate
an already yielded chunk, or alter the final text. Individually larger provider
deltas retain their original size. Tool arguments and lifecycle events keep
their existing order and identity.

Every combined chunk still crosses the existing current source and recipient
authorization checks. There is no permission cache, TTL, or revocation bypass.
This reduces work from one expensive authorization round per provider token to
one round per bounded queued chunk when the consumer is behind.

## Regression coverage

- Burst notifications coalesce under a paused consumer with unchanged text,
  bounded combined chunks, and preserved reasoning/tool/completion order.
- Current source and recipient revocation still blocks the next emitted chunk.
