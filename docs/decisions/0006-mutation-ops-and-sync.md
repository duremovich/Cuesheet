# 0006: Mutation ops, versions and broadcast for show data

- **Status:** accepted
- **Date:** 2026-09-30

## Context

R22 asks for real-time editing with last-write-wins per cell and history showing both
sides; R1 asks for stable manual order (decision 0003). Each show already lives in one
Durable Object (decision 0005), which serialises every write to that show. We need a write
format that the grid can apply optimistically, the DO can validate and log, and every
other open client can replay.

## Decision

- **Ops.** All show-data writes are batches of typed ops (`src/shared/ops.ts`): `create`,
  `update` (partial; `custom` merged key by key), `delete`, `move`, `link`, `unlink`.
  Clients generate record ids (UUIDv7, `src/shared/ids.ts`). Placement for create/move is
  `after`/`before` a neighbour, never a raw key.
- **One transaction per batch.** `POST /api/shows/:id/mutate {clientId, ops}` → the Worker
  checks membership and passes `{userId, role}` to `ShowDO.mutate`, which applies the whole
  batch in `transactionSync`: validation (field types, select options, referenced rows,
  role), order keys from neighbours (`fractional-indexing`, `src/shared/order.ts`),
  timestamps, cascades. Any error rolls back the batch: 400/403 `{error, opIndex}`.
- **Resolved ops.** The DO returns and broadcasts what it actually applied: creates carry
  the full stored row, updates the changed fields plus `updated_*` and server-set fields,
  moves the new `order_key`, links the final position. A delete is expanded into its
  cascade (unlinks, reference nulling) followed by the delete, so clients replay it
  without knowing the cascade rules.
- **History and versions.** Every changed field writes one `changes` row (create/delete:
  one row with field `*` and the whole row as JSON). `changes.version` is an
  autoincrement; a batch's version is the highest one it wrote, and messages carry
  `prevVersion` too. A batch that changes nothing keeps the version and isn't broadcast.
- **Broadcast.** After commit the DO sends `{type:"ops", prevVersion, version, clientId,
  ops}` to every socket, the sender's included. Batches whose message would exceed 256 KB
  (imports) send `{type:"version", version}` instead. Each new socket gets `version` right
  after `hello`.
- **Client.** `src/web/lib/show-store.ts` keeps the confirmed state plus pending local
  batches (visible = pending over confirmed). It resolves ops locally with the same shared
  order-key function, sends one batch at a time, applies an `ops` message only when its
  `prevVersion` equals the local version, treats its own echo as confirmation, and
  refetches the snapshot on any gap or on a `version` ahead of it. On a server error it
  drops the batch (rollback) and rethrows.

## Consequences

- Last write wins per field: two users editing the same cell both succeed in commit order;
  history has both values. There is no merge of text within a field.
- Concurrent inserts at the same spot get the same key; `id` (time-ordered) breaks the tie,
  and the server never hands out a key already in use for later inserts there.
- Recovery is always "refetch the whole snapshot". Fine at show scale (hundreds of rows);
  a delta endpoint (`changes since version`) can replace it if snapshots get large.
- Versions jump by the number of changed fields, not by one per batch, which is why
  messages carry `prevVersion`.
- Roles are enforced per op in the DO from the role the Worker read from D1 on that
  request, so role changes apply on the next write without touching open sockets.
- Validation lives on the server only; the client's local resolution can briefly show a
  change the server then rejects (rolled back with the error).
