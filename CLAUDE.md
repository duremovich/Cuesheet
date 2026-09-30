# Notes for Claude

The project has left the spec-only phase: M0 (the application scaffold), M1a (the show
data layer: core tables, ops, sync, history, members, Airtable import), M1b (the generic
`DataGrid`), M1c (the show workspace: a grid tab per core table on the live store, ⌘K),
M2a (saved views and conditional formatting), M2b (notes panel, editable row panel with
history, tech mode, phone quick-add, the show's current session), M3a (content versions,
attachments in R2 with thumbnails, the gallery layout), M3b (surfaces, measurement /
pixel-size / formula fields with unit conversion, the surface calculator), M4a (the script
data model, text extraction and the anchoring engine; see "Script") and M4b (the script
reader UI, the calling-script print and the generic Print view; see "Script view" and
"Print layouts"), M5a (custom fields and custom tables, formula fields, shot lists,
CSV export, show templates, bulk edit; see "Custom fields and custom tables", "Shots" and
"Export, templates, bulk edit") and M5b (read-only share links, roles polish, login rate
limiting, sliding sessions, password change/reset, print presets, production deploy; see
"Share links", "Account security", "Print layouts" and "Deploy and security headers") are
built. The stack is decided in
`docs/decisions/0005-cloudflare-platform.md`; don't relitigate it without a
new decision record. Build milestone by milestone; don't pull later-milestone features
(e.g. the cue grid) into an earlier one.

## Spec and examples

- The spec lives in `docs/spec/`. Keep `open-questions.md` current: add
  questions as they come up, and move answers into the relevant spec file.
- `examples/` contains real show data exported from Airtable. Treat it as
  reference for how the team structures cues and content; don't rewrite it.
- Record settled decisions in `docs/decisions/` using the template there.
- Requirements have IDs (R1, S1, L1) in `docs/spec/requirements.md`; refer to them by ID.
- The example base in `examples/` is *Some Like It Hot*; `examples/README.md` describes each CSV.

## Commands

| Command | Use |
| --- | --- |
| `pnpm dev` | App + Worker under workerd (applies local D1 migrations first) |
| `pnpm build` / `pnpm preview` | Production build / serve the built Worker locally |
| `pnpm check` | typecheck + lint + unit/worker tests. Run before every commit |
| `pnpm e2e` | Playwright headless (builds and starts its own server on :4317; `E2E_ORIGIN=http://localhost:<port>` picks another port) |
| `pnpm e2e:stress` | The e2e suite with each test 3× on 6 workers, for flake hunting (see "E2E reliability") |
| `pnpm test` | Vitest only (`--project unit`, `--project dom` or `--project worker` to narrow) |
| `pnpm format` | Biome autofix (formatting + import order) |
| `pnpm db:generate` | Drizzle SQL migrations for both D1 and the ShowDO |
| `pnpm db:migrate:local` | Apply D1 migrations to `.wrangler/state` |
| `pnpm cf-typegen` | Regenerate `src/worker/worker-configuration.d.ts` (the `Env` type) after changing `wrangler.jsonc` or `.dev.vars` keys |
| `pnpm seed:example` | With `pnpm dev` running: create "Some Like It Hot" and import `examples/*.csv` (`SEED_URL` overrides `http://localhost:5173`) |

Before finishing any task: `pnpm check && pnpm e2e`.

## Layout

- `src/shared/`: code used by both Worker and web: `api.ts` DTOs, `ws.ts` socket messages,
  `tables.ts` (core table field specs + row types), `ops.ts` (op/resolved-op/snapshot
  types), `order.ts` (order keys), `ids.ts` (UUIDv7), `views.ts` (saved view config type,
  validation, per-table defaults), `units.ts` (lengths and pixel sizes: parse/format),
  `formula/` (the formula language), `script.ts` + `script-anchor/` (script text types and
  the anchoring engine; see "Script"). No runtime dependencies except
  `fractional-indexing` in `order.ts`, which must run identically on both sides.
- `src/worker/do/ops-engine.ts`: applies op batches to the ShowDO's SQLite.
  `src/worker/import/airtable.ts`: CSVs → ops.
- `src/web/lib/show-store.ts` (+ pure `show-state.ts`): the client store for one show.
- `src/worker/`: `index.ts` (entry: `/api/*` → the Hono app, every other path → the
  assets with security headers via `security.ts`; the weekly `scheduled` backup; exports
  DO classes), `app.ts` (Hono app under `/api`), `routes/`, `auth/`, `do/ShowDO.ts`,
  `share-filter.ts` (what a share link's viewer receives), `db/d1/` (D1 schema +
  migrations), `db/do/` (ShowDO schema + migrations).
- `src/web/`: `main.tsx` (router), `pages/`, `features/` (see "Table views"), `components/`,
  `lib/` (api client, auth, theme, `useShowSocket`, show store + `show-selectors.ts`),
  `styles/` (`theme.css`, `global.css`). CSS modules per component.
- `test/worker/`: Vitest tests running inside workerd. `e2e/`: Playwright.
- Unit tests sit next to the code as `*.test.ts` and run in plain Node. React component
  tests are `*.test.tsx` and run in jsdom (the `dom` project; helpers in `src/web/test/dom.ts`,
  no testing-library).
- `src/web/pages/dev/`: developer-only pages (`/dev/grid`, `/dev/script-extract`). Registered via `devRoutes` in
  `main.tsx`; present in `pnpm dev` and in builds with `VITE_DEV_PAGES=1` (the e2e build sets
  it), and compiled out of production builds along with the example data they embed.

## Conventions

- **Where data lives.** Anything belonging to one show (scenes, cues, content, notes, ...)
  goes in that show's `ShowDO` SQLite (`src/worker/db/do/schema.ts`). Only cross-show
  things (users, sessions, shows, memberships, invites) go in D1. All writes to show data go
  through the DO, which serialises them and broadcasts to connected sockets.
- **Show name source of truth.** D1 `shows.name` is authoritative. The ShowDO `meta` row is
  a cache: the Worker passes the D1 name into `ShowDO.sync(showId, name)` when a show is
  created and every time it's opened (`GET /api/shows/:id`), and the DO refreshes its copy.
  Renames (`PATCH /api/shows/:id`, owner) write D1 only and broadcast `{type:"show"}`;
  the DO copy refreshes on the next open. `current_session` follows the same pattern (see
  "Session model"). Apply it to any other show-level fields that must be listable across
  shows.
- **Passwords.** PBKDF2-HMAC-SHA256 via WebCrypto, 100,000 iterations, 16-byte salt, stored
  as `pbkdf2$<iterations>$<salt b64>$<hash b64>` (`src/worker/auth/password.ts`).
  **Hosted Cloudflare Workers cap WebCrypto PBKDF2 at 100,000 iterations** (below OWASP's
  210,000); local workerd does not enforce the cap, so tests won't catch exceeding it. Don't
  raise `DEFAULT_ITERATIONS` unless Cloudflare lifts the cap. Verify reads the parameters from
  the stored string, and login re-hashes any hash where `needsRehash()` is true, so raising
  the default later upgrades users as they sign in.
- **Rate limiting** (R24): see "Account security".
- **DO code.** `src/worker/do/ShowDO.ts`. Expose operations as RPC methods on the class
  (the Worker calls `env.SHOW.get(env.SHOW.idFromName(showId)).method()`); only WebSockets
  go through `fetch`. The Worker checks auth + membership before calling the DO; the DO
  trusts its caller. **Never forward client headers to the DO**: the socket route builds a
  fresh `Headers` (identity in `X-Cuesheet-*` plus the `X-Cuesheet-Internal` marker), and
  `ShowDO.fetch` refuses `X-Cuesheet-*` headers without the marker. Use the Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`,
  `webSocketClose`); don't keep per-socket state in memory, use
  `serializeAttachment`. New DO classes need a `migrations` entry in `wrangler.jsonc`
  (`new_sqlite_classes`) and an export from `src/worker/index.ts`.
- **Adding a table + migration.**
  1. Edit `src/worker/db/d1/schema.ts` (cross-show) or `src/worker/db/do/schema.ts` (per show).
  2. `pnpm db:generate` (optionally `pnpm exec drizzle-kit generate --config drizzle.do.config.ts --name <what>`
     for a readable file name). Commit the generated SQL, snapshot and journal; never edit
     applied migrations.
  3. D1: `pnpm db:migrate:local` (also runs on `pnpm dev`). DO: nothing; the constructor
     applies pending migrations in `blockConcurrencyWhile`.
  4. Add or extend a test in `test/worker/`.
  D1 changes that drizzle can't see (e.g. a new enum value, a data fix) go in a custom
  migration: `pnpm exec drizzle-kit generate --config drizzle.d1.config.ts --custom --name <what>`.
- **Adding an API route.** Add a handler in the relevant `src/worker/routes/*.ts` (or a new
  file mounted in `app.ts`). Put request/response types in `src/shared/api.ts`, add a method
  to `src/web/lib/api.ts`, and cover it in `test/worker/api.test.ts`. Protect it with
  `requireAuth` / `requireAdmin` (exported from `src/worker/auth/middleware.ts`). Routes
  under `/shows/:id` also use `requireMembership`, a middleware local to
  `src/worker/routes/shows.ts` (not exported) that loads the show + the caller's role into
  `c.var.show` / `c.var.role`; put show routes in that file, or export it if another file
  needs it. Errors are JSON `{ error }`; show-not-found and not-a-member are both 404.
  Hono's typed `c.json` recurses forever on the recursive `Json` type (custom values), so
  responses containing rows use `jsonBody()` from `routes/util.ts`, and the DO returns the
  snapshot pre-serialised (`snapshotJson()`).
  Browser clients must send JSON (the CSRF middleware rejects cross-origin form posts).
  `GET /api/me` is the one exception to "401 when signed out": it returns `{ user: null }`.
- **WebSockets.** `GET /api/shows/:id/ws` requires `Origin` to equal the request's own
  origin (403 otherwise), because upgrades bypass CORS and carry the SameSite=Lax cookie.
  Heartbeats use the exact `PING_FRAME`/`PONG_FRAME` strings from `src/shared/ws.ts`, which
  the DO answers via `setWebSocketAutoResponse` without waking from hibernation. The client
  (`useShowSocket`) retries network drops with backoff but stops with status
  `unauthorized` when the upgrade was refused (it probes `GET /api/shows/:id` to tell the two
  apart, since browsers hide the upgrade's HTTP status).
- **Client API errors.** `src/web/lib/api.ts` throws `ApiError`, and `UnauthorizedError` for
  401. Signed-in pages pass caught errors to `useApiErrorHandler()` (`lib/auth.tsx`): a 401
  signs the client out, so `RequireAuth` redirects to `/login?next=<current path>`. Post-login
  `next` values go through `lib/safeNext.ts`.
- **Show data: the op model** (decision 0006). Every write to show data is a batch of ops
  (`src/shared/ops.ts`): `create {table, id, fields, after?, before?}`, `update {table, id,
  fields}`, `delete`, `move {table, id, after?, before?}`, `link`/`unlink {table, id, field,
  targetId, position?}`, and `meta {fields: {default_unit}}` for show-level settings kept in
  the DO's `meta` row (editors; resolves to itself, logged in `changes` as table `meta`,
  record `show`; in the snapshot as `meta`; typed `AnyOp`/`AnyResolvedOp`, while `Op`/
  `ResolvedOp` stay row ops). Send them with `store.mutate(ops)` on the client (or
  `POST /api/shows/:id/mutate {clientId, ops}`, max 1000 ops); never write show tables any
  other way. The DO (`ops-engine.ts`) applies a batch in one transaction, validates field
  types / select options (`field_options`) / referenced ids / role, computes `order_key`
  from neighbours (`after: null` = start, neither = end), fills timestamps and `created_by`,
  expands deletes into explicit cascade ops (links removed; references to a deleted scene,
  content or person set to null; cues/content of a deleted scene become Unassigned), logs
  one `changes` row per changed field (create/delete: one row, field `*`), and broadcasts
  `{type:"ops", prevVersion, version, clientId, ops}` with the *resolved* ops (or
  `{type:"version"}` when over 256 KiB of UTF-8). Errors: 400/403 `{error, opIndex}`,
  whole batch rolled back. Limits: ids must be lowercase UUIDv7 (`newId()`); request
  bodies over 4 MB get 413 (`readJsonObjectLimited` in `routes/util.ts`); a row may not
  exceed 512 KiB as JSON; `custom` keys `__proto__`/`constructor`/`prototype` are
  rejected (by the Worker before the RPC, and again in the engine). A create whose
  `after`/`before` row no longer exists falls back to the other neighbour, then the end of
  its scene (cues/content), then the end of the table (`effectivePlacement` in
  `shared/order.ts`, used by client and server); resolved creates carry the `placement`
  actually used. Concurrent inserts after the same row: both kept; the one applied second
  lands directly after the anchor, before the first. Field names on the wire are the snake_case storage names; row types are in
  `src/shared/tables.ts`. `GET /snapshot` returns everything (ordered tables sorted by
  `order_key`, then `id`); `GET /history?table=&id=&limit=` returns changes newest first
  with `userName`. Order keys are compared as plain strings (byte order), never
  `localeCompare`.
- **Client store** (`src/web/lib/show-store.ts`). `<ShowStoreProvider showId userId>` (in
  `ShowPage`) creates the store, loads the snapshot and feeds it from the show socket.
  Read with `useShowStore(selector)` (selectors must return values from the state, not
  new objects), `useRow(table, id)`, `useOrderedRows(table)`; write with `useMutate()`.
  State: `version`, `status`, `tables` (Map by id per table, including `views`; read a
  table's saved views with `useViewsFor(table, userId)`), `order` (ids in show order for
  scenes/cues/content), `joins` (`cueContent`, `cueAssignees`, `noteCues`,
  `noteAssignees`: from-id → target ids), `fieldOptions` (`"cues.status"` → options).
  `mutate` is optimistic (applies at once, including order keys and delete cascades, via
  `show-state.ts`), sends one batch at a time, and on error rolls back and rethrows (an
  `ApiError` with `opIndex`). Untouched rows keep object identity across updates,
  and a snapshot refetch (version gap, reconnect, import) is structurally shared
  (`fromSnapshot(snap, prev)`: deep-equal rows, unchanged tables, order lists and join
  lists keep their identity), so only changed rows re-render. `show-selectors.ts`:
  `groupByScene` (Unassigned first; the `UNASSIGNED` sentinel group id ↔ `scene_id = null`
  via `sceneIdForGroup`), `reverseJoin`, and `ViewCache` (one derived view object per row,
  rebuilt only when its dependency list changes).
- **Adding a field to a core table.** (1) Column in `src/worker/db/do/schema.ts` +
  `pnpm db:generate` (nullable, or with a default, since existing shows have rows). (2) The
  field spec in `FIELDS` and the row interface in `src/shared/tables.ts` (type drives
  validation: text/number/bool/select/multiselect/ref/json, `measurement` (REAL meters,
  ≥ 0) and `pixel_size` (`{w, h}` JSON text); see "Units, formulas and surfaces"). (3) For a select: seed its options
  in a custom DO migration (`drizzle-kit generate --config drizzle.do.config.ts --custom`),
  like `0002_seed_field_options.sql`. (4) If Airtable has the column, map it in
  `src/worker/import/airtable.ts`. (5) Extend `test/worker/ops.test.ts` (and the import
  test). New *link* fields also need a join table and an entry in `LINKS`.
- **Roles** (`memberships.role`): `owner` (the creator; manages members), `editor`
  (everything), `commenter` (read all; create notes, and update/delete/link only notes
  they created), `viewer` (read only). **Exception:** every member, viewers and
  commenters included, may create/update/delete their own *personal* views
  (`views.owner_user_id` = themselves); shared views are editors/owners only and nobody
  touches someone else's personal view. Enforced per op in the DO (`checkRole` in
  `ops-engine.ts`) from the role the Worker read on that request, so `/mutate` lets viewers
  through and the engine answers 403 for anything but their own views. Members: `GET/POST /api/shows/:id/members`,
  `PATCH/DELETE .../members/:userId` (owner only; the user must already have an account;
  the owner can't be changed or removed), `POST .../transfer {userId}` (owner: that member
  becomes the owner, you an editor; both get `{type:"role"}`), `POST .../leave` (anyone
  but the owner; closes their sockets). **Presence** (R22): the DO keeps each socket's name
  (`X-Cuesheet-Name`, URI-encoded; share visitors "Guest (read-only)") and sends
  `hello`/`presence` with `{clients, readOnly, users: [{id, name, readOnly}]}` (one entry
  per user or share link; members by name, guests last). Share visitors get the counts
  without `users`. The pill keeps the count; hovering names people, clicking lists them
  (`presence-list`). Show settings → Members
  (`show/ShareSettingsMembers.tsx`) has the role descriptions, "Make owner" (confirm),
  "Leave this show", and, when an added email has no account, "Create invite link" (an
  invite that joins this show with the chosen role). Presence counts read-only sockets
  (viewers and share links: `readOnly` in `hello`/`presence`, an eye in the indicator;
  the Worker passes the role in `X-Cuesheet-Role`, `notifyRole` updates it). Removal calls
  `ShowDO.disconnectUser(userId)`, which sends `{type:"revoked"}` to that user's sockets
  and closes them with code 4003; `useShowSocket` treats `revoked` as terminal (status
  `unauthorized`, "No access") and doesn't reconnect. Logout does the same only to the
  sockets **that session** opened (`ShowDO.disconnectSession(sessionId)`: the Worker
  passes the session id, the SHA-256 of the cookie token, and the DO tags each socket
  `session:<id>`), so the user's other browsers and devices stay live.
- **Airtable import** (`POST /api/shows/:id/import/airtable`, multipart CSV files; editors
  and owners; 4 MB max). A show that already has rows in any core or custom table gets 409
  `{error:"Show already has data"}` unless the request has `?append=1` (the UI asks for
  confirmation first; appended rows are added, not merged). Files are recognised by
  Airtable's `<Table>-<View>.csv` name or by their
  headers; the five core tables and Surfaces are imported, every other CSV becomes a
  custom table (M5a; see "Custom fields and custom tables" for types, the preview and
  `mapping`).
  Surfaces: Name, Channel Name, `Width (<unit>)`/`Height (<unit>)` (the header's unit;
  meters when none), blank rows skipped (the example has 16 rows → 15 surfaces); a
  region's parent comes from its channel (`CH02.1` → `CH02`), set in the create when the
  parent comes first in the CSV, else by an update after; Breakdown.Surfaces links by
  surface name or channel. Surfaces are created first so scenes can link them. The import is
  one op batch (so history and broadcast work; `allowCreatedAt` lets it keep note
  `Created Time`). CSV order becomes show order. Links resolve by primary text among the
  imported rows; multi-value cells are CSV-parsed (Airtable quotes values with commas).
  Assignee/creator names missing from Personnel get a new person (name only), reused on
  later matches. Created people, unresolved links, duplicate cue numbers (first match
  wins), dropped extra scene/content links on notes, and scene inference are reported as
  `warnings`. The Cue List export has no Scene column: a cue's scene comes from its linked
  content's scene when all agree (content's scene: its Scene column, else its `SSS-` name
  prefix); a cue still without one takes the scene when the nearest scene-bearing cues
  before and after it (CSV order) agree, else stays Unassigned. Note `created by` names go
  to `custom.created_by_name`; `Created Time` is read as UTC. A content row's `Version`
  ("2.0") becomes one current `content_versions` record labelled "V02" (`versionLabel`),
  status Available.
- **Writing an e2e test.** Add `e2e/<feature>.spec.ts`. Use helpers in `e2e/helpers.ts`
  (`login`, `createShow`, `openShow`, `waitForShowReady`, `uniqueName`). Tests run in
  parallel against one server whose DB persists for the run, so make data unique
  (`uniqueName`) and don't assume an empty DB. Prefer role/label locators; use
  `data-testid` for things without a good accessible name. Use separate
  `browser.newContext()`s to simulate multiple users. Read "E2E reliability" below.
- **Writing a worker test.** Use `test/worker/helpers.ts` (`api`, `post`, `loginAdmin`,
  `newUser`, `createShow`, `connectDO`, `collect`, `isType`). `api()` adds a same-origin
  `Origin` to non-GET requests like a browser does (the CSRF check needs it on bodyless
  and multipart requests). Example CSVs import as text with `?raw`.
- **Every feature gets a test** (unit, worker or e2e).
- TypeScript strict everywhere (`noUncheckedIndexedAccess` on). Biome formats and lints
  with `"rules": { "preset": "recommended" }` (Biome 2.5's replacement for the deprecated
  `recommended: true`). Don't disable rules globally; if you run `biome migrate`, check it
  didn't turn the linter's rules off.

## E2E reliability

The suite runs `fullyParallel` on 3 workers (locally and in CI, 4 cores), 60 s per test,
5 s per `expect`, traces kept for failures (`test-results/**/trace.zip`). CI retries once
for a second trace, but `failOnFlakyTests` still fails the run.

- **No sleeps.** Never `waitForTimeout` to let something happen, and never a retry
  annotation. Wait on a web-first assertion (`toHaveText`, `toHaveAttribute`,
  `expect.poll`) of the state you need. The only accepted sleep checks that something
  does *not* happen within a window (no reconnect after "No access"); say so in a comment.
- **Wait on state attributes, not timing.** The app exposes them: `data-store-status`
  (`loading`/`ready`/`error`) on `show-workspace` (use `waitForShowReady` / `openShow`),
  `data-status` / `data-clients` on `presence`, `data-scroll-offset` on `grid-scroll`
  (the offset the grid last laid out: after setting `scrollTop`, wait for it to match
  before measuring rows or the stuck header). Missing one? Add it to the component
  rather than guessing a delay. Presence counts come from server broadcasts that can
  arrive in either order (an old socket's close after a new one's hello): assert the
  settled value with a retrying matcher.
- **Read a layout once, settled.** Don't compute an expected value from the DOM and then
  assert against a later DOM; wait for the settle signal, then read both from one
  `evaluate`.
- **Unique data, fresh contexts.** Every test makes its own show (`uniqueName`) and its own
  `browser.newContext()` (fresh cookies and localStorage); never rely on another test's
  data or order. All tests share the one admin user, so never do anything to it that
  reaches other sessions (a logout only closes its own session's sockets; see "Roles").
- **Hunting a flake:** `pnpm e2e:stress` (each test 3× on 6 workers), or narrow it:
  `pnpm exec playwright test e2e/x.spec.ts -g "name" --repeat-each=20 --workers=6`.
  CPU throttling makes render races show up: `(await page.context().newCDPSession(page))
  .send("Emulation.setCPUThrottlingRate", {rate: 6})`. Fix the app when the race is in
  the app.
- **Rate limits are shared.** Failed logins and bad invite/reset/share tokens count toward
  per-IP limits (sign-in: 50 an hour per IP; tokens: 10 a minute), and every test's IP is
  the same locally. Keep deliberate
  failures to one or two per test; a test that needs more (or a worker test) sends its own
  `CF-Connecting-IP` header. Never fail logins for the shared admin's email.
- **Parallel runs.** Each run wipes and uses `.wrangler/e2e-state-<port>`. Another run
  (another checkout) holding :4317? Use `E2E_ORIGIN=http://localhost:4391 pnpm e2e`.
  Only one run per checkout at a time: runs share `dist/`.

## Grid

Every table UI uses the generic `DataGrid` in `src/web/components/grid/`. Read its
[README](src/web/components/grid/README.md) before wiring a table: props, value shapes per
column type, ordering rules (show order vs live sort with the focused row held until blur),
the keyboard map and an integration example. The grid never fetches or persists; it calls
`onEdit` / `onInsert` / `onMove` / `onDelete` and renders what it's given. `RecordPicker`
(find-or-create, R5a) is exported for reuse outside the grid. Try it at `/dev/grid`.

## Table views (`src/web/features/`)

The show page (`/shows/:id`) is a workspace (`features/show/ShowWorkspace.tsx`): header
(title, presence, theme), tabs (`features/show/tabs.ts`: Cues, Scenes, Content, Surfaces,
Shots, Notes, People → `/shows/:id/<tab>`, then one per custom table →
`/shows/:id/tables/<id>`; `/shows/:id` and unknown tabs redirect to `cues`; the
**Script** tab after Cues is not a table tab, see "Script view"), Show
settings (import, members), the ⌘K palette (`features/search/`) and toasts. Tabs read
`useWorkspace()` (role, `canEdit`/`canComment`, member names, `toast(message, kind,
{action?, actions?, duration?})`/`reportError`, `sortCuesNow`, `openImport`). Everything about how a grid is
shown (columns, filters, sort, grouping, colors) comes from its saved view (see "Saved
views" below).

- **One folder per table**: `features/<table>/columns.ts` (the `Column<View>[]` in display
  order, plus `<table>EditOps(view, key, value) → Op[]`) and the tab component. A tab
  builds **view objects** (the row plus its links resolved to `PickerItem`s) with a
  `ViewCache`, so a view keeps its identity until its inputs change (the grid memoizes rows
  on the object). Scenes, Content, Notes and People use the generic
  `features/shared/TableGrid.tsx` (config: columns, rows or groups, `editOps`,
  `createOps`, `moveOps`, `deleteOps`, panel); the cue list (`features/cues/CueGrid.tsx`)
  has its own component for number hints and Sort now. Read-only: `editable: false`
  columns (or a per-row function, as notes do for commenters) and no
  `createOps`/`moveOps`/`deleteOps` (the grid then offers no insert/drag/delete).
- **Grid callbacks → ops** (`features/shared/ops.ts`): `onEdit` → the table's edit ops
  (text `""` → `null`; link lists via `linkDiffOps`: minimal link/unlink with positions).
  `onInsert({afterRowId, beforeRowId, groupId})` → one `create` with
  `placementFor(pos, groupOrder(groups))`: the display neighbour as `after`/`before` (under
  a live sort this places the row in show order next to the row it was inserted beside);
  with only a group, after that group's last row (empty group: after the nearest earlier
  group's last row). `scene_id` comes from the group id (`sceneIdForGroup`), else from the
  neighbour. `onMove` → `move` (+ an `update` of `scene_id` when the group changed), one
  batch. Inserts return the new id synchronously (the store applies optimistically);
  their errors go to `reportError` (a toast). `onEdit` returns the mutate promise so the
  grid's `onError` sees rejections. "Sort now" (`features/cues/sortNow.ts`) moves every
  out-of-place cue to the end in target order (short keys; a section stays above the cue
  that followed it; unnumbered cues go last, after a confirm).
- **Cue numbers** (`features/cues/cueNumbers.ts`): ghost = midpoint of the numbered display
  neighbours (`suggestCueNumber`); duplicates (14.2 = 14.20) and unusual numbers warn.
  The hints map is value-compared so `cellDecoration` keeps its identity.
- **Pickers** (`features/shared/pickers.ts`): searches read `store.getState()` at call time
  (so columns don't depend on data); `createContent` names new content with the
  `SSS-NNN-` prefix (`features/content/contentName.ts`; content items carry their name
  without the prefix as a picker `alias`, so typing "VAMP" doesn't offer to create
  another), and so does "+ Add content item" (the name starts as `SSS-NNN-`);
  `createPerson`; `createScene` ("106A Train" → number 106A, name Train; at the end).
  Changing a cue's scene in its Scene cell also moves it to the end of that scene's group
  (one batch). A missing `?<param>=<id>` row toasts and drops the param; a row deleted by
  someone else while you edit it toasts that the edit was discarded.
- **Live role changes**: `PATCH /members/:userId` calls `ShowDO.notifyRole`, which sends
  `{type:"role", role}` to that user's sockets; the store keeps it in `state.role` and the
  workspace uses it over the role the show was opened with, so editability flips live.
- **URL state**: the active row is `?<param>=<id>` (`cue`, `scene`, `content`,
  `surface`, `note`, `person`; `tabs.ts`), written with `replace`. On load, or on a navigation carrying router
  state `{ focus: id }` (⌘K), the tab calls `grid.focusRow(id)` once the row exists
  (`features/shared/useTableChrome.ts`); the open view is `?view=<id>`. Per-browser prefs
  (`features/shared/prefs.ts`, localStorage): collapsed groups per user+show+view and the
  last view opened per user+show+table.
- **Row panel** (`features/shared/RowPanel.tsx`, R18): Space / expand icon; follows the
  active row. Props: `table`, `recordId`, the grid's `columns`, and `onEdit(key, value)`
  (the tab's own grid `onEdit` for that row, so the panel writes exactly the grid's ops;
  omit it for read-only). Tabs: **Fields** (`FieldEditor`: one editor per column type,
  reusing the grid's value shapes, `parseText` and `RecordPicker`; `panelFields.ts`
  decides editability from `column.editable` and skips unchanged or unparsable values; a
  text draft is local while focused, so remote edits don't clobber it; Enter or blur
  commits, Escape reverts), **Notes** (cues, content, scenes: `NotesPanel`), **Content**
  (cues: `CueContentCards`, link/unlink through the content picker; cards show the
  content's thumbnail and current version), **Versions** (content: see "Content
  versions"; attachment columns show full width in Fields with add / remove / reorder,
  see "Attachments"), a table's own tabs after Fields (`extraTabs` / TableGrid's
  `panelTabs`: the Surfaces **Calculator**) and **History**
  (`PanelHistory`: `GET /history?table=&id=&limit=`, newest first, formatted by
  `history.ts`; "Load more" raises the limit by 50 up to the server's 1000; "Refresh"
  refetches; otherwise it refetches 400 ms after a change touches this record, i.e. its
  row or its link lists change identity in the store, not on every version bump). The panel handles keys with React
  `onKeyDown` (so child editors can `stopPropagation`): ↑/↓ outside text fields and tabs
  move the grid's active row (`grid.stepRow`); Escape in a field leaves it (the field
  reverts), Escape elsewhere or × closes it and refocuses the active cell; ←/→ move
  between tabs. Field labels are plain `<dt>` text (inputs use `aria-label`), so clicking
  a label keeps focus on the panel (`tabIndex=-1`). Width: drag the left edge or ←/→ on
  it (300–900 px), stored per user (`cuesheet.panelWidth.<userId>`). At ≤ 760 px it's a
  bottom sheet at 60% height whose handle (click, or drag up/down) toggles full height.
  Escape in the grid closes the panel too when the grid has nothing else to cancel (the
  grid's `onEscape`). Grid undo covers cell edits only; inserts, moves, deletes and Sort
  now aren't undoable yet.
- **Notes panel** (`features/notes/`, R6): `NotesPanel({subject})` = `NoteList` (open
  first, newest first; `notesFor` in `compose.ts`: a cue's linked notes, content's
  `content_id` notes, a scene's `scene_id` notes plus notes on its cues) + `NoteCompose`.
  Cards: a status chip button (click cycles Open → In progress → Done via `nextStatus`;
  the server sets `completed_by/at`), type chips, `P<n>`, assignee initials, session,
  author · time; ✎ or double-click edits the body in place (Enter saves, Escape cancels;
  if someone else deletes the note meanwhile, a toast says the edit was discarded and
  focus goes to `NoteFocusContext`, the tech compose box), × deletes at once with an
  "Undo" toast for 8 s (`noteRestoreOps`: recreate with the same id, fields and links,
  plus `attachmentRestoreOps` for its photos, whose files the server still keeps). A note's session defaults to the show's current session and is editable per
  note (the Session column / the note's Fields tab). Editability is `canEditNote` (editors: all notes; commenters: their own;
  viewers: none), mirroring the server; viewers get no compose box.
- **Compose grammar** (`parseNoteText` in `features/notes/compose.ts`): Enter saves,
  Shift+Enter is a newline. An **explicit** cue prefix links that cue instead of the
  panel's record: `q8.5 `, `Q8.5 `, `#8.5 ` or `8.5: ` (each followed by whitespace, so
  `10:30 fix projector` and `2:1 ratio` stay text);
  matched with `cueNumberKey`, so 8.5 = 8.50; several matches → the one nearest the
  current cue in show order. A bare leading number (`3 people in the wings`) is just text,
  and so is a prefix naming no cue. A leading `*` makes a general note (no cue, content or scene). `@name`
  tokens naming a person (full name without spaces, or a unique first name) assign them
  and drop out of the body; typing `@` at a word start opens the person picker: type the
  name, Enter picks (the assignee shows as a chip), then Enter in the box saves; Escape
  puts the `@` back at the caret. A live "→ Cue 14.20" line shows where the note will go. Type chips
  toggle (default: the types you used last, per user: `cuesheet.noteTypes.<userId>`);
  ⌥1–5 (read from `KeyboardEvent.code`) or the P select sets priority. Saving waits for
  the server: the box (text, types, priority, assignees) clears and "Saved to …" shows
  only once `store.mutate` resolves; on failure everything stays and the error shows
  under the box. Images (any allowed file) pasted or dropped into the box wait as chips
  under it (a file of a type the server refuses, e.g. HEIC, or an empty one is refused
  there with the reason under the box) and are uploaded to the note once it's saved; a
  note may be just photos (its body is then null) (`NoteComposeHandle.addFiles` for
  the quick-add camera); note cards show their photos as a thumbnail strip. Bodies are capped at 100,000 characters (a counter appears near the
  limit). `requireTarget` (quick-add) only saves an unattached note when it says where it
  goes (`*` or a cue prefix). A new note is one batch (`noteCreateOps`: create with status Open and the show's current session, then
  `link` ops for cues and assignees); links come from `subjectLinks` / `resolveLinks` (a
  cue brings its content when it has exactly one, and its scene).
- **Session model**: `shows.current_session` in D1 (show-level and shared, like the
  name). `PATCH /api/shows/:id {name?, current_session?}` (name: owner; session: editors
  and owner; `""`/null clears; ≤ 100 chars) writes D1, then `ShowDO.notifyShow({name,
  currentSession})` broadcasts `{type:"show", name, currentSession}` (the DO stores
  nothing). `GET /api/shows/:id` returns `show.currentSession`; `ShowStoreProvider` takes
  it as `show`, and the store keeps `state.show` (updated by `show` messages, and by
  `store.setShow` right after your own PATCH). The header shows `SessionControl` (an
  input with suggestions for editors, a label for others); it hides at ≤ 600 px and on
  `/tech` and `/quick`, which show their own. The input shows the live value until you
  type (then it's dirty), and commits on Enter, a picked suggestion, or blur when dirty.
- **Tech mode** (`features/tech/`, R7), `/shows/:id/tech?cue=<id>`: the header's "Tech"
  link, ⌘K "Tech mode", or ⌘/Ctrl+Shift+. (period) anywhere in the show
  (`useTechShortcut` in `ShowWorkspace`, capture phase, matched on `KeyboardEvent.code`
  "Period"; a cell being edited is blurred first, so the edit commits as it would on
  focus leaving the grid). There is deliberately no bare-letter shortcut: type-to-edit in
  the grid wins. Left: a
  compact, virtualized cue list (`techRows`: scene headers with open-note counts, section
  dividers, rows with number, description, trigger, status dot, open-note count); right:
  the current cue's notes, or "Scene open notes", or "Content", above a compose box that
  keeps focus. Keys in the compose box: ↓/↑ and Space/Shift+Space move the current cue
  **only while the box is empty**; ⌘/Ctrl+G opens a "Go to cue" prompt (`goToCue`: exact
  number, else prefix; IME-safe); Enter saves on the current cue; Tab / Shift+Tab cycle a
  single type chip, until Escape "releases" Tab so it moves focus normally (reset when
  the box is focused again; a "Skip to controls" button does the same; WCAG 2.1.2);
  ⌥1–5, `@`, `*` and `8.5: ` / `#8.5 ` as in the compose grammar. While tech mode is
  mounted a document-level keydown listener handles keys outside inputs, textareas,
  selects, buttons, links and contenteditable (viewers; after clicking a note): ↓/↑ and
  Space move the cue, ⌘G opens the prompt, a typed character refocuses the compose box;
  a mousedown on anything that isn't a control also refocuses it. The current cue is
  local state plus a ref that `step` updates synchronously (so rapid ↓↓↓↓↓ never skips),
  mirrored to `?cue=` (replace; the cue list's own parameter, so "Cue list" / "Tech"
  round-trip it; a `?cue=` we didn't write is adopted). Without `?cue=`, the last tech cue
  of the show is used (`cuesheet.techCue.<userId>.<showId>`). A current cue deleted by
  someone else (or a stale id) falls back to the cue now at its position in the list
  (its nearest neighbour), with a toast; the draft stays. "Follow" (per user) keeps the
  current cue scrolled to the middle. "Scene open notes" uses the scene definition above
  (linked to the scene or to any of its cues). Viewers: list only; commenters: compose.
- **Quick-add** (`features/quick/QuickAddPage.tsx`), `/shows/:id/quick?cue=<id>`: the
  header's "＋" link on phones, ⌘K "Quick add a note". Cue search (recent picks first,
  per user and show), the compose box, the session control, and a camera button (`<input
  type=file accept=image/* capture=environment>`: the photos are attached to the next
  saved note); saving shows "Saved to Cue …" and keeps the cue. A photo with no text
  is a note. With no cue picked, Add note is disabled unless the note starts with `*`
  (or a cue prefix). The
  type chips are one horizontally scrolling row at ≤ 600 px.
- **E2E**: set up data through the API (`apiLogin`, `apiCreateShow`, `importExamples` in
  `e2e/helpers.ts`); the grid virtualizes rows, so open a far-down row with `?cue=<id>`
  instead of expecting it in the DOM.

## Saved views (`src/web/features/views/`, R16/R17)

- **Data.** The ShowDO table `views` (migration `0003_views`): `table` (a data table,
  immutable), `name`, `owner_user_id` (null = shared; else that user's personal view,
  immutable), `is_default` (shared only; setting it clears the table's other shared defaults
  in the same batch, server-side, mirrored optimistically in `show-state.ts`), `position`,
  `config` (JSON, field type `json`). It's a normal table in the op engine (`TABLE_NAMES`
  includes `views`; `DATA_TABLES` is the five data tables, used for "show has data" and
  what a view can be for). The engine refuses (400) deleting a table's **last shared view**
  and more than **50 personal views** per user and table (`MAX_PERSONAL_VIEWS`).
  **Personal views are private:** `GET /snapshot` (`snapshotJson(userId)`) and `/history`
  return shared views plus the caller's own; the DO sends ops on a personal view only to
  its owner's sockets (tagged by user id) and everyone else gets the same `ops` message
  without them (possibly empty), so versions stay gap-free (`Batch.viewOwners`,
  `ShowDO.broadcastBatch`). **Defaults:** `seedDefaultViews` runs when the DO starts and
  gives a data table with no shared view (a show created before views existed) its shared
  default ("All cues" grouped by scene, "All notes" by status, "All content" by scene,
  scenes/people ungrouped), without logging a change or bumping the version. Since the last
  shared view can't be deleted, that only happens once per table.
- **Config** (`src/shared/views.ts`): `{filters, filterMode, sorts, sortMode: live|none,
  group: {key, collapsedByDefault?}, fields: {key, width?, hidden?}[], rowHeight,
  frozenCount, colorRules: {when: Filter[], mode, target: "row" | {cell}, color}[],
  forkedFrom?}`. Keys are the grid's column keys (plus extra filter fields such as the cue
  list's `open_notes`, and `custom.<key>` for custom fields: `viewFieldsFor`, see "Custom
  fields and custom tables"), declared per table in `VIEW_FIELDS` with their kind
  (`viewFields.test.ts` checks it against each tab's `columns.ts`: update both when a
  column changes). The server rebuilds every config it stores from known keys only
  (`sanitizeViewConfig`: unknown keys are dropped; 400 for unknown fields, an operator the
  field's kind doesn't take (`OPS_BY_KIND`), a value of the wrong shape for its operator,
  grouping by a non-select/link field, duplicate sort keys, or frozenCount above the column
  count). `fields` lists order/width/hidden; unlisted columns follow in default order,
  shown, so new columns appear in old views. The client reads configs with
  `normalizeViewConfig` (lenient; bad parts fall back to the table default).
- **Where it runs.** All on the client, over the store rows the tab already builds:
  `useViewConfig(setup)` (one hook per tab; `CueGrid` and `TableGrid` call it) picks the
  view (`?view=<id>`, else the last one opened, else the shared default, else the built-in
  default; a `?view=` you can't see is dropped with a toast), keeps the working config,
  and returns what the grid needs (`columns` laid out, `rows`/`groups`, `sort` +
  `sortColumns` (every column, so a view can sort by a hidden field), `rowHeight`,
  `colorRules`, `collapsed`, `onColumnResize`) plus the `toolbar` (`ViewBar`: switcher +
  Filter/Sort/Group/Fields/Row height/Color popovers). ⌘K lists "Switch view: <name>" for
  the tab you're on. `evaluate.ts` compiles filters and color rules against
  `Column.getValue` (typed: numbers; cue numbers by `compareNumericText` from the grid's
  `ordering.ts`, the one comparator the grid's sort also uses: decimal first, then the
  letter suffix, 14.25 < 14.3 < 14.3A; dates for `dateFields`; selects by value; links by
  **record id** with `Filter.labels` caching the picked labels for display, so renames
  don't break filters; `contains` on a link matches labels); incomplete filters are
  skipped. Filters saved with labels (before ids) resolve to ids on read
  (`migrateLinkFilters`) and are stored as ids on the next save. `grouping.ts` groups by
  any select/multiselect/link/multilink (empty group first; multi-valued fields group by
  combination, Airtable-style); the tab's own groups are used when the view groups by its
  `nativeGroupKey` (`views/tableDefaults.ts`: cues/content → scene, notes → status). A
  filter hides groups left empty. Inserting/dragging into a view-made group maps the
  position to a neighbour (`mapPosition`) and sets the field with the tab's edit ops
  (`groupOps`). Cue-number ghosts and duplicate warnings are computed over **all** cues
  (`hintOrder`: show order, or each group fully sorted under a live sort), never the
  filtered display.
- **Saving.** Personal views save as you go (debounced 400 ms). The pending save is sent
  with `fetch(…, {keepalive: true})` (`api.mutate(…, {keepalive})`) on `pagehide` and
  when the page is hidden, and through the store when you leave the tab; a save that
  can't reach the server keeps its draft in localStorage and is retried when the socket
  reconnects (the store's optimistic change is rolled back meanwhile; the draft is shown).
  A shared view changed by an editor is a draft (`drafts.ts`, localStorage
  `cuesheet.viewdraft.<user>.<show>.<view>`, with the base config and the view's
  `updated_at` it started from; drafts older than 7 days are dropped) until **Save view** /
  **Discard**. If the view was saved by someone else since, the draft shows "This view
  changed since your draft" with **Rebase** (`rebaseDraft`: each top-level config key you
  changed, onto the new saved config) / **Discard**; Save never writes over it.
  Viewers/commenters on a shared view: column widths and frozen count are their own
  localStorage overlay (`cuesheet.viewlayout.<user>.<show>.<view>`,
  `differsOnlyInLayout`), never a copy; any other change (filter, sort, group, hidden
  fields, row height, color) goes to their personal copy of that view, made once ("<name>
  (mine)", `config.forkedFrom` = the shared view's id; later changes reuse it). An
  editor's overlay (from migrated M1c widths) gives way for columns they size in the view.
- **Layout** (R19): `config.layout` is `"gallery"` or absent (the grid). Tables that pass
  `gallery` to `TableGrid` (Content: the first image, titled by name) get a **Gallery**
  toggle in the view bar and a "+ Content gallery" preset under My views
  (`actions.createPersonal`). `views/Gallery.tsx` renders the same rows/groups, filters,
  sorts and row colors as cards: the image large (or a placeholder with the name), the
  view's first four visible fields beneath, virtualized rows of cards, columns from
  `galleryColumns(width)` (`views/gallery.ts`: 160 px minimum, so 390 px phones get two).
  Keys: arrows / Home / End, Enter opens the image in the lightbox (else the panel), Space
  or a click opens the row panel. It implements the grid's handle, so URL focus and the
  panel work unchanged. The grid stays the default.
- **Switching views is immediate** (`select`): the router applies `?view=` in a
  transition, so the view just picked wins until the URL catches up (`picked` in
  `useViewConfig`). Without it a change that switched views (a viewer's edit going to
  their copy) rendered once with the old view's config and a controlled checkbox/radio in
  the open panel snapped back under the click.
- **Filter holds.** A row you insert or are editing stays visible while it's the active row
  even if it no longer matches (including after a remote change); when you leave it
  (another row, Enter moving down, or focus moving to another control outside the grid and
  its pickers; focus merely dropping to `<body>` doesn't count) it's hidden and a toast
  "Hidden by the current filter" offers **Keep shown** (shows it again and puts you in it,
  until you leave it) / **Clear filters**. Opening a hidden row from the URL or ⌘K holds and
  shows it with the same toast (`reveal`, asked by `useTableChrome` before focusing). Call
  `hold(id)` before inserting and `trackActive(id)` from `onActiveRowChange`; wrap the grid
  in `wrapProps`.
- **Popovers** (`Popover.tsx`): focus starts on the first control that doesn't remove or
  clear (`data-destructive` marks those), Tab/Shift+Tab wrap inside (one stop per radio
  group), Escape always closes and refocuses the button; "+ Add filter" focuses the new
  row's field. Below 600 px they're bottom sheets (the Fields sheet puts frozen columns
  first).
- **Adding a filter operator:** add it to `FILTER_OPS` (and `VALUELESS_OPS`/`LIST_OPS` if it
  takes no value / a list) and to the kinds in `OPS_BY_KIND` in `src/shared/views.ts` (and
  its value shape in `sanitizeViewConfig`), give it a label in `OP_LABELS` (`evaluate.ts`),
  implement it in `matchesFilter`, and add cases to `evaluate.test.ts` and
  `test/worker/views.test.ts`. The value editor is picked by field kind in
  `FilterEditor.tsx`.
- **Adding a color preset:** return it from `colorPresets(table, fields)` in `presets.ts`
  (a label and the `ColorRule[]` it appends; `rowsBySelect(field)` colors rows by a select's
  option colors). Every other select column already gets "Color rows by <field>".
- **Migration of M1c prefs** (`legacy.ts`): on first open per table, old localStorage
  column widths become your layout overlay on the shared view you're on, collapsed groups
  move to the per-view key, the old live sort is dropped, and the old keys are removed.

## Content versions (R10)

- **Data.** ShowDO table `content_versions` (migration `0005_versions_attachments`, which
  also seeds `content_versions.status`: Rendering / Available / In Millumin / Superseded):
  `content_id` (ref, `cascade: true`, immutable: deleting the content deletes its versions
  as explicit delete ops), `version` (text, "V03"), `date` (`YYYY-MM-DD`), `rendered_by`
  (ref → persons, cleared when the person goes), `changes`, `file_path`, `is_current`,
  `status`, `position`. **Exactly one current version per content item whenever it has
  any** (none when it has none), kept by the engine like `views.is_default`: a create or
  update that sets `is_current` clears it on the content's other versions in the same
  batch; the first version of a content item is made current; deleting the current
  version, or setting `is_current: false` on it, makes the newest other one (highest
  `position`) current, and un-currenting the only version is refused (400).
  `show-state.ts` mirrors all of this optimistically. Editors and the owner only.
- **Client** (`features/content/versions.ts`): `currentVersions(table)` (content id →
  current row, cached per map, so it's a stable memo dep), `versionsOf` (newest first),
  `nextVersionLabel` ("V03" → "V04"), `addVersionOps` (next Vnn, today, your person when a
  person's `user_id` is you, Available, current), `restoreVersionOps` (Undo). Shown as the
  Content grid's read-only **Version** column, `105-001-VAMP · V03` on the cue list's
  content chips (`PickerItem.badge`; display only, never matched), the cue panel's content
  cards and the content panel's **Versions** tab (`ContentVersions.tsx`: add, set current,
  edit in place, delete with an Undo toast).

## Attachments (R13, S4)

- **Data.** ShowDO table `attachments`: `table`, `record_id`, `field` (default
  "attachments"), `filename`, `content_type`, `size`, `r2_key`, `width`, `height`,
  `thumb_key`, `position`. Which fields exist is `ATTACHMENT_FIELDS` in
  `src/shared/tables.ts` (`content.attachments`, `notes.attachments`, `surfaces.images`, `script_versions.source_file`;
  field type `attachment`, not a column), plus `custom` (`original_size`, `caption`). Rows
  go through the op engine (history, broadcast), but **only the upload route creates new
  ones** (`MutationContext.upload`; a client `create` gets 403, except a restore, below);
  clients may update `position` (reorder) and `custom.caption`, and delete. `/history`
  never shows `r2_key`/`thumb_key` (stripped from attachment rows' old/new values).
  Permissions follow the record: editors/owner anything, commenters only files on notes
  they created, viewers nothing. Deleting a record deletes its attachments (explicit
  delete ops).
- **Deletes are deferred in R2, so Undo works.** Deleting an attachment row (directly or
  by cascade) never deletes its R2 objects synchronously: the engine records it in the DO
  table `pending_r2_deletes` (`attachment_id`, `r2_key`, `size`, `deleted_at`, and `row`:
  the whole deleted row as JSON) and the ShowDO schedules its alarm. **Undo** (of a file
  delete, or of a note delete with photos) is a client `create` of the attachment with
  its old id (`attachmentRestoreOps`); the engine accepts it only while the id is pending,
  **rebuilds the row from the stored one** (whatever fields the client sent are ignored,
  so a restore can't point a row at another object, record or size), checks the role
  against the original record (a commenter can only restore files on their own notes),
  and removes it from the list. The alarm (`ShowDO.alarm` → `purgeDeletedFiles(now)`,
  `dueR2Deletes`) takes entries older than **24 h** (`R2_DELETE_DELAY_MS`) off the list
  first (so a concurrent restore can no longer claim them), then deletes the file and its
  thumbnail from R2, gives their bytes back to D1 `shows.storage_bytes` (only then), and
  reschedules itself for the next one. So clients send deletes at once; Undo is offered for 8 s (the toast), and the
  server would accept it for a day.
- **Routes** (`routes/attachments.ts`, registered in `shows.ts` behind
  `requireMembership`): `POST /api/shows/:id/attachments/upload-url {table, recordId,
  field?, filename, contentType, size, originalSize?}` checks role, record, type, size
  (0 bytes: 400) and the storage cap, cleans the name (`cleanFilename`: path parts,
  control and bidi-override characters) and makes its extension match the stored type
  (`withExtension`: `photo` → `photo.jpg`, `a.exe` as text → `a.exe.txt`), and reserves
  an id in the DO (`reserveUpload`, 1 h, only for that user) with the file's **position
  fixed at reserve time** (after the record's files and live reservations), so a
  multi-file drop keeps its order however the PUTs finish → `{attachmentId, uploadUrl,
  contentType}`. R2 presigned URLs need API credentials we
  don't have locally, so `uploadUrl` is our own `PUT /api/shows/:id/attachments/:aid`,
  which claims the reservation, atomically adds `Content-Length` to D1
  `shows.storage_bytes` (413 over **2 GB per show**; D1 migration `0003_storage_bytes`),
  streams the body into R2 through a `FixedLengthStream` (**25 MB** max, 411 without a
  length, 413 over the limit, 400 unless it is exactly the size reserved), reads an image's size from its first 64 KB (`imageSize`; for a JPEG whose EXIF
  Orientation turns it a quarter, the upright size), then creates the row
  (and undoes the put and the bytes if that fails, e.g. the record was deleted meanwhile).
  `GET …/attachments/:aid` streams the file (`?download=1`: as a download; ETag / 304,
  byte ranges (`Range: bytes=…` → 206 + `Content-Range`, 416 when unsatisfiable; always
  `Accept-Ranges: bytes`) for video seeking and PDF viewers, `private, immutable` caching, `nosniff`, a sandboxing CSP except for PDFs); `GET
  …/:aid/thumb` the thumbnail; `GET /api/shows/:id/storage` → `{usedBytes, limitBytes}` (Show settings shows
  it). **Types** (`checkAttachmentType` in `src/shared/attachments.ts`): PNG, JPEG, GIF,
  WebP (thumbnailed), PDF, MP4/MOV, plain text/CSV/Markdown, Word `.docx` (script sources); HEIC gets 415 "export as JPEG
  or PNG"; SVG/HTML and anything else 415. **R2 keys**: `shows/<showId>/<attachmentId>/
  <filename>`; thumbnail `shows/<showId>/<attachmentId>/__thumb`.
- **Thumbnails** are made **in the Worker on first request** with Photon
  (`@cf-wasm/photon`, Rust → WASM with a workerd build; bundled as a WASM module by the
  Vite plugin): longest side 320 px (`THUMB_MAX`), JPEG for JPEG sources, PNG otherwise,
  stored in R2 and recorded with `ShowDO.setThumbKey` (not an edit: no history, no version
  bump; clients derive the URL from the id). EXIF orientation is applied (`orient` in
  `routes/thumbnail.ts`), so a sideways phone photo's thumbnail is upright. Images
  already ≤ 320 px are served as their own thumbnail. The Worker decodes at most 4096 × 4096 px (`MAX_DECODE_PIXELS`, ≈ 64 MB;
  a Worker has 128 MB), so **the client scales bigger photos down before upload**
  (`resize.ts` `shrinkLargeImage`, the queue's `prepare`: PNG/JPEG/WebP over 16.7 MP →
  longest side ≤ 4096 px via `OffscreenCanvas`, `resizeTarget` in `shared/attachments.ts`)
  and sends the original dimensions (`originalSize` → the row's `custom.original_size`).
  The browser draws it upright (`imageOrientation: "from-image"`), so the re-encoded file
  needs no EXIF. GIFs and animated WebP are never resized (that would drop the
  animation); they upload as they are under the 25 MB cap. **Not every image has a
  thumbnail**: GIFs and animated images get their first frame only if Photon decodes
  them, and anything too large to decode (an unresized GIF, a raw API upload) or
  undecodable gets 404 from the thumb route. The client asks for `/thumb` only when
  `hasThumbnail(row)` (`selectors.ts`: `thumb_key` set, or known dimensions within
  `MAX_DECODE_PIXELS`); otherwise, or if the thumb fails to load, `Thumb` shows the
  original.
- **Client** (`features/attachments/`): `selectors.ts` (`attachmentsOf`, `thumbnailOf` =
  the first image, cached per map), `uploads.ts` (`UploadQueue`: client-side type/size
  checks, `prepare` (the resize above), reserve + PUT with progress through `putFile`
  (XMLHttpRequest), two at a time, optional `ready` promise), `state.ts` (the page's queue
  and the open lightbox; `useDeleteFile` deletes at once and offers Undo),
  `Attachments.tsx` (`Thumb`, `AttachmentStrip`, `attachmentColumn`, `AttachmentsField`,
  the lightbox and `AttachmentsHost`, mounted once in `ShowWorkspace`). Upload errors
  toast; empty files are refused before reserving. In the row panel (`AttachmentsField`,
  ux.md §Images) images show full width with a **caption** under each (`custom.caption`,
  the file name until set; editable: Enter or blur saves, Escape reverts; shown in the
  lightbox too), other files as a row; ↑/↓ reorder, × deletes.
- **Adding an attachment field to a table**: add it to `ATTACHMENT_FIELDS` (e.g.
  `surfaces: { images: { type: "attachment" } }`), give the tab's view object the files
  (`attachmentsOf(tables.attachments, table, id, field)`, in the ViewCache deps) and a
  column from `attachmentColumn({table, field, showId, files, recordId, editable})`, and
  list the key in `VIEW_FIELDS` (kind `text`: filters match file names; sort by count).
  The row panel shows it full width automatically; deletes cascade automatically.

## Units, formulas and surfaces (M3b: R11, R12, S2)

- **Units model** (`src/shared/units.ts`). A measurement is stored as a plain number of
  **meters** (field type `measurement`, SQLite REAL; the engine refuses negatives and
  non-numbers). Units (`m cm mm ft-in ft in`) are only for display and typing. The
  **active unit** is the view's `config.unit` override (only via Fields → **Unit
  override**, editors or a personal view's owner; the toolbar then shows a "View unit: …"
  chip; it's a view change like any other: a draft on a shared view) → the user's
  preference (`cuesheet.unit.<userId>` in localStorage: the toolbar's m / cm / ft-in
  toggle, which never touches the view, Show settings → My unit, or the calculator's
  toggle; `useUserUnit`/`setUserUnit` in `features/views/units.tsx`, live across grids
  and tabs) → the show's `default_unit` (the ShowDO `meta` row, via the `meta` op; Show settings →
  Show default, editors) → meters. `useViewConfig` resolves it and hands it to the
  columns (`withUnit`: `Column.unit` on measurement columns and length formulas), so
  cells, the row panel (History included: `formatStored(…, unit)`; pixel sizes `w×h`),
  filters and color rules all use it.
- **Parsing** (`parseLength(text, activeUnit)` → `{m}` | `{error}` | null for empty):
  `4.5` (in the active unit; ft-in: decimal feet), `4.5 m`, `450cm`, `1,200 mm`, `177in`,
  `14.75ft`, `14'`, `9"`, `14'9"`, `14' 9"`, `14' 9`, `14 ft 9 in`, fractions (`14' 9 1/2"`,
  `3/4"`), `1 m 20 cm`; smart quotes/primes are fine; negatives and lengths over 1 km
  (`MAX_LENGTH_M`) are errors.
  **Formatting**: m 2 dp, cm 1 dp, mm 0 dp, in 1 dp, ft 2 dp, ft-in to the nearest 1/8"
  (`FT_IN_DENOMINATOR`; `14' 9 1/8"`). `formatLengthParts` splits the number from the
  muted unit label the grid shows. `editLength` is the editor's starting text: precise
  (`14' 9.165"`, `1.3716 m`), so committing it unchanged is a no-op; lengths within
  `LENGTH_EPSILON` (0.02 mm) are equal (`valuesEqual(a, b, "measurement")`).
  **Pixel sizes**: `parsePixelSize` takes `1920x1080`, `1920 × 1080`, `1920*1080`,
  `1920, 1080`; stored as `{w, h}` (field type `pixel_size`, whole pixels 1–100,000).
- **Grid column types**: `measurement` (value: meters or null; cell = number + muted
  unit; typing accepts any format), `pixelsize` (`{w,h}` or null, shown `1920×1080`;
  sorts by area), `formula` (read-only; value is a formula `Value`; errors render as a
  red `#CODE` with the message as the tooltip; `resultType` number/text/measurement
  decides filtering and sorting; errors sort and filter as empty). Filters: kind
  `measurement` takes `> ≥ < ≤ is is-not empty`; the value is **saved with the unit it was
  typed in** (`qualifyLength`: "4" typed while viewing cm is stored "4 cm"; `14' 6"` as
  is), shown converted to the viewer's unit, and compared in meters
  (`measurementFilterMeters`; a bare number or unit-less text from older filters is
  meters), so one saved filter or color rule matches the same rows in every unit.
- **Refused input** (a negative or out-of-range length, a bad pixel size, a lens ratio of
  0): the grid keeps the editor open, marks it `aria-invalid` and says why in its status
  line (`parseError`); the row panel shows the reason under the field; the calculator
  under its input. Nothing is written. A `Column.parse(text) → {value} | {error}` overrides
  a column's parsing (the lens ratio column accepts `1.5` or `1.5:1`). Copying measurement
  cells copies the precise edit text (`copyText`), so pasting loses nothing.
- **Limits** (server `FieldSpec` `min`/`minExclusive`/`max`/`integer`, checked by the op
  engine, and the same on input): lengths 0–1000 m, pixel sizes whole 1–100,000, lens
  ratio above 0 up to 100.
- **Adding a measurement field**: column `real(...)` in the DO schema + migration; `FIELDS`
  entry `measurement` in `tables.ts` (row type `number | null`, meters); a grid column
  `{type: "measurement", getValue: (v) => v.row.field}` whose edit op writes the number
  (null clears); a `VIEW_FIELDS` entry with kind `measurement`; importer: parse with
  `parseLength(text, headerUnit(header))`. Nothing else: units, filters and the toggle
  come from the view layer.
- **Formula language** (`src/shared/formula/`: `lexer.ts`, Pratt `parser.ts`,
  `evaluate.ts`, `index.ts` with the reference in its header comment; data-model.md
  §Formulas). `compile(source)` once → `run(compiled, record)` per row; `dependencies()`
  lists the fields and link paths read. A `FormulaRecord` is `{label?, get(name)}`
  returning a value, a `{records}` set for links, or undefined (→ `#NAME`). Values:
  numbers, text, booleans, lengths `{value, unit: "m"}`, pixel sizes, lists, errors
  `{error, code}`. Dimension rules: length ± length, length × or ÷ number → length; length
  ÷ length → number; anything else with a length → `#UNIT`. Blank operands make
  arithmetic blank. Errors propagate; nothing throws. Nesting deeper than 200 levels
  (brackets, calls, operator chains; measured without recursion) compiles to a `#DEPTH`
  error. `ROUND` rounds half away from zero after correcting binary error
  (`ROUND(1.005, 2)` = 1.01); more than ±20 digits is `#VALUE`. `ASPECT` snaps to 16:9,
  16:10, 4:3, 21:9, 32:9, 1:1, 2.35:1 within 1% (the closest), else `1.86:1`.
- **Computed columns**: built-ins are declared in code (`features/surfaces/formulas.ts`,
  `SURFACE_FORMULAS`: `ppi`, `pixel_pitch`, `aspect_ratio`, `throw_width`), computed per
  row when the tab builds its view objects (`computeSurface`, cached by the ViewCache on
  the surface and its parent) and shown as `formula` columns (`VIEW_FIELDS` gives their
  kind). They're sortable, filterable and usable in color rules like any column. There
  are no user-defined formula columns yet (M5, with custom fields).
- **Surfaces** (`features/surfaces/`): an ordered table (`order_key`, drag), `parent_id`
  (the engine refuses a parent that is the surface or one of its regions; deleting a
  surface nulls its regions' parent and drops its links), measurements `width`,
  `height`, `throw_distance`, numbers `pixel_width`, `pixel_height`, `lens_ratio`. The
  grid's **Pixels** column edits `pixel_width` + `pixel_height` together. Links
  `scenes.surfaces` (`scene_surfaces`) and `content.surfaces` (`content_surfaces`) show as
  **Surfaces** columns on Scenes and Content (`surfaceLinkColumn`/`surfaceLinkOps`) and as
  editable reverse columns on Surfaces (link/unlink from the scene/content side). The
  Parent picker leaves out the surface and its regions. `images` (attachments) and the
  gallery come with M3a: the Surfaces **Images** column and a "+ Surface gallery"
  preset. At ≤ 480 px the Channel column hides unless the view lists it
  (`narrowHidden` on `TableGrid`/`useViewConfig`); Name is 140 px wide. The importer warns
  about header units it doesn't know (read as meters) and about regions whose parent
  channel isn't in the file.
- **⌘K ranking** (`searchShow`): groups with an exact or prefix *name* match (or a cue
  number) come before groups with only partial text matches, so "C WALL" lists the surface
  before cues whose description mentions a wall; note bodies never count as names.
- **Calculator** (`Calculator.tsx`, math in `calc.ts`): physical size, pixel size and PPI
  (= pixel_width ÷ width in inches; blank until both pixel sides are set, in the grid's
  PPI/pitch columns too). One of the three is locked (lock buttons); editing
  another recomputes the third so the locked one stays: lock PPI + change width → pixel
  width follows; lock physical + change PPI → pixels follow; lock pixels + change PPI →
  size follows; editing the locked one acts as if the other stored one were locked.
  "Keep aspect ratio" scales the height with the width (pixels too). The locked PPI and
  the aspect ratios are captured when the lock / checkbox is engaged (`CalcRefs`) and
  every edit computes from them, so rounding to whole pixels never drifts (a 10-edit round
  trip returns exactly 1920×1080 / 4.5 m). Default lock: pixels for a region whose parent
  has a pixel size, else physical. Pixels round to whole numbers; a result outside the
  limits is refused with a message. "Use parent's PPI" (regions) fills the region's pixels
  from its size. The pixels-aren't-square warning allows 1%. Every change is one `update` op.
  **Units in the calculator**: it shows the grid's active unit (view override → your unit
  → show default), live, including toolbar toggles while it's open (`TableGrid` passes
  `{unit, viewUnit}` to `panelTabs`); its own toggle sets your unit, and says so when the
  view's override wins. Projector: throw distance + lens ratio →
  image width, plus the distance / ratio that fills the surface's width. A region shows
  its parent's canvas and its share of it.

## Script (M4a: R20, decisions 0004 and 0007)

- **Model** (`src/shared/script.ts`, DO migration `0006_script`). `scripts` (one per show;
  the engine refuses a second): `title`, `current_version_id` (used for Cue.page and
  printing). `script_versions`: `script_id` (cascade), `label`, `attachment_id` (the
  original file: an attachment on the version's `source_file` field), and server-set
  `imported_at`, `source` (pdf/docx/txt/ocr), `confidence`, `text_key`, `text_bytes`,
  `block_count`, `page_count`, `page_map` (`[{startBlock, page, label}]`), `stats`
  (counts by state right after re-anchoring), plus `position`. `cue_anchors`: `cue_id`
  and `script_version_id` (both cascade, immutable; unique together), `block`, `offset`,
  `length`, `quote`, `prefix`, `suffix`, `page` (derived), `state` (select seeded
  matched/moved/changed/missing/manual), `confidence`. The migration also seeds
  `cues.status` "Cut" (the resolve screen's Cut).
- **Where the text lives.** The extracted text of a version (`ScriptText`: `blocks`
  `{i, page, kind, text}` with 1-based physical pages, `pages` `{page, label}`, `source`,
  `confidence`, optional `warnings`) is gzipped JSON in R2 at
  `shows/<showId>/script/<versionId>-<nonce>.json.gz` (`scriptTextKey`; a random nonce per
  import, so purging a deleted version's text can never hit a live one), **never in
  SQLite** (rows are capped at 512 KiB; snapshots stay small). `GET /api/shows/:id/script/versions/:vid/text`
  serves it as plain JSON (immutable, ETag). Its bytes count toward `shows.storage_bytes`;
  deleting a version queues the text in `pending_r2_deletes` (purged after 24 h, never
  restorable; `pendingFile` ignores those entries).
- **Routes** (`routes/script.ts`, registered in `shows.ts`): `POST /script/versions
  {versionId?, label, text, baseVersionId?, title?, clientId?}` (editors/owner; 8 MB max;
  the text is re-validated and normalized by `sanitizeScriptText`) stores the text, and in
  **one batch** (`ShowDO.mutateScript`, which drops anchors for cues deleted meanwhile)
  creates the script if needed, the version (`MutationContext.script` lets it write the
  server-set fields; clients get 403 creating versions and 400 writing those fields), makes
  it **current at once**, and creates one anchor per anchor of the base version (default:
  the previous current) from re-anchoring, including `missing` ones (position null, the old
  quote/context kept) → `{scriptId, versionId, baseVersionId, results, stats}` (201).
  A `versionId` that exists, or was ever a version (history, or text awaiting purge:
  `ShowDO.scriptVersionIdUsed`), gets 409.
  `POST /script/versions/:vid/reanchor {baseVersionId}` re-runs it: anchors in state
  `manual` on the target stay, others are updated or created, `stats` is rewritten
  (its `manual` count includes the kept ones). The
  original file: the client uploads it after the POST (`upload-url` with `{table:
  "script_versions", recordId: versionId, field: "source_file"}`; DOCX, PDF, text and
  Markdown are allowed types) and sends `update script_versions {attachment_id}` (the
  engine checks it's that version's own `source_file` file). Client: `api.createScriptVersion`,
  `api.reanchorScriptVersion`, `api.scriptText`.
- **Anchors through ops** (editors/owner). The engine doesn't have the text; it checks
  `block < block_count`, whole `offset`/`length` ≥ 0, confidence 0–1, one anchor per cue and
  version, and allows `block: null` only for `state: "missing"` (offset/length/page are
  then nulled). A create without a state is `manual`. `page` is always derived from `block`
  through `page_map` (a client value is replaced). **Cue.page**: an anchor created/updated
  on the current version sets its cue's `page` to the page label in the same batch;
  changing `scripts.current_version_id` re-derives it for every cue anchored in the new
  current version; deleting the current version makes the newest other version (highest
  `position`) current. Cues without an anchor there keep their page; a cue whose anchor
  there is `missing` (no position: unplaced, or skipped on the Resolve screen) has no page
  (`page` null, `currentPageLabel` → null; not current → undefined, no change). Deleting a cue deletes
  its anchors; deleting a version deletes its anchors and its file; deleting the script
  deletes everything. `show-state.ts` mirrors all of this optimistically
  (`scriptFollowUps`).
- **Anchoring engine** (`src/shared/script-anchor/`, pure, shared by Worker and client).
  Positions are in a version's **joined text**: block texts joined by one space
  (`joinBlocks`), so a quote survives reflow. `makeAnchor(text, block, offset, length)`
  (a selection; quote + ≤ 32 chars of context each side), `makePositionAnchor(text, block)`
  (LX/timecode/visual cues: the block's first words, ≤ 48 chars), `anchorPosition(text,
  anchor)` (joined span, page/label, per-block `segments` to underline, `exact`),
  `suggestSlot(text, {before, after})` (a block for a positional cue from its show-order
  neighbours' anchors), `diffPages(old, new)` (page statuses same/changed/new, removed
  pages, blocks inserted/deleted), `reanchor(old, new, [{cueId, anchor}])`, `anchorStats`.
  **Re-anchoring** (header comment of `reanchor.ts`): the old block's position is
  predicted in the new text through a patience diff of block texts (`mapBlocks`),
  interpolated between unchanged blocks; then 1. prefix + quote + suffix exact →
  `matched` (same printed page label and ≤ 3 blocks from the prediction, `NEAR_BLOCKS`)
  or `moved`, confidence 1; 2. **cut check**: the anchor's old blocks all unmapped with
  their unchanged neighbours now adjacent, or prefix and suffix meeting (or both in one
  block that no longer holds the quote) → `missing`, unless the quote (≥ 4 words,
  `MIN_MOVE_WORDS`) occurs exactly once elsewhere (then it moved: matched/moved, 0.9);
  3. quote alone, accepted (matched/moved by place, 0.9) only with one side of the
  context, or within `NEAR_BLOCKS` of the prediction, or as the sole occurrence of a ≥ 4
  word quote with no fuzzy match ≥ 0.8 near the prediction (an edited original beats a
  far exact copy); otherwise `changed` 0.6 (`CONFIDENCE_AMBIGUOUS`) with the occurrences
  as candidates; 4. prefix and suffix both found around a plausible span → that span,
  `changed`, confidence = its bigram Dice when ≥ 0.8, else 0.5; 5. fuzzy: bigram Dice
  within ±15% (`WINDOW`) of the prediction, then everywhere, ranked by score × (1 −
  0.1·min(1, distance/window)), accepted at ≥ **0.8** (`FUZZY_THRESHOLD`) → `changed`,
  confidence = the raw score, top-3 `candidates`; 6. one side of the context (≥ 8 chars,
  the side nearer the prediction) → `changed` 0.5; 7. `missing` (`to: null`, fuzzy
  candidates even below 0.8). **Never someone else's line**: a span only in new blocks the
  diff pairs with *other* old blocks is never accepted as an exact or fuzzy match (only
  listed as a candidate). An anchor with no position (block < 0) searches without a
  prediction. Regression scenarios from the M4a review: `scenarios.test.ts` (fixture
  `scene.fixture.ts`). `normalizeText` (NFKC, curly
  quotes/primes → straight, all dashes → "-", zero-width/soft hyphens removed, whitespace
  collapsed) is applied to every block at extraction and to quotes when matching.
  Performance: nominal target 1,500 blocks × 150 anchors < 300 ms; measured ≈ 5–10 ms when
  lines are unchanged, 100–200 ms when every anchor needs the fuzzy search or is cut. The
  test runs on cold texts (joining and tokenizing included) and asserts < 600 ms with
  `retry: 2`, so a loaded CI machine doesn't fail it.
- **Extraction** (`src/web/features/script/extract/`, browser; no UI: M4b's dialog calls
  it). `extractScript(file, {pdfjs?})` → ScriptText, or `ScriptExtractError` with `code`
  `unsupported` / `unreadable` (damaged, password) / `no-text-layer` (a scan: no OCR yet) /
  `empty`, and a message for the user. **PDF** (`pdf.ts`; pdf.js's **legacy build**
  `pdfjs-dist/legacy/build/pdf.mjs` and its worker are lazy chunks, `?url` for the worker;
  unit tests pass the same build under Node): items → lines (same baseline, split at gaps
  over 4 font sizes) → the first margin line (top/bottom 8%) on a page that reads as a page
  number becomes its label (`pageLabelOf`: "14", "14a", "- 14 -", "Page 14", "I-3-14",
  roman; later ones stay text), margin lines repeated on half the pages are dropped as
  running headers → blocks (new block on a gap > 1.45 × median line spacing, an indent
  change, and around headings, character names and parentheticals) → kinds
  (`classifyBlocks`: heading = the whole line ("ACT ONE", "SCENE 3: THE TRAIN", "No. 4 -
  VAMP"; no lowercase words after the keyword); character = a short caps name followed by
  a paragraph that isn't all caps, or by a caps (sung) line when the name itself doesn't
  look sung (`looksLikeLyric`: apostrophes, hyphens, OH/LA/…); direction = parenthesized /
  bracketed or ≥ 60% italic by font name; dialogue after a name (lyric when shouty or caps
  that look sung); caps that look sung elsewhere → lyric; else other); confidence = share
  of pages with text. **DOCX** (`docx.ts`, JSZip imported lazily + regex tokenizer, no
  DOM): text boxes (`w:txbxContent`, nested, and `mc:Fallback` copies) are stripped first;
  paragraph style names → kinds; Word's `lastRenderedPageBreak`s → pages (else hard page
  breaks, including one at the end of a paragraph; else 40 blocks a page with a warning,
  `FALLBACK_BLOCKS_PER_PAGE`). **TXT/MD** (`text.ts`): blank-line paragraphs, a
  character name on a paragraph's first line splits off, `--- page 14 ---` markers (label
  after "page") or form feeds, else 40 a page with a warning; Markdown `#` headings and
  `*italic*` lines (directions). Fixtures are generated in `extract.test.ts` (pdf-lib, JSZip).
- **Tests**: `src/shared/script-anchor/reanchor.test.ts` (engine; synthetic scripts in
  `testing.ts`) and `scenarios.test.ts` (review regressions),
  `src/web/features/script/extract/extract.test.ts`,
  `src/web/lib/show-state-script.test.ts`, `test/worker/script.test.ts`,
  `e2e/script-import.spec.ts` (API import of `e2e/fixtures/script.txt`) and
  `e2e/script-extract.spec.ts`: **extraction in Chromium** through the dev page
  `/dev/script-extract` (`pages/dev/ScriptExtractDevPage.tsx`: pick a file, see the
  ScriptText as JSON), a generated PDF (pdf.js + worker, running header, labels) and DOCX.

## Script view (`src/web/features/script/`, R20)

- **Contract with the data/anchoring engine** ("Script" above). Everything here imports
  script types and engine helpers from `contract.ts` only: re-exports from
  `src/shared/script.ts` and `src/shared/script-anchor` (`makeAnchor`,
  `makePositionAnchor`, `anchorPosition`), `extractScript` (loads `./extract` on demand),
  and `CueAnchorRow`: the stored anchor row normalized for the UI (`normalizeAnchor`:
  `block` -1 when it has no position, empty strings for null text, cached per row).
- **Data access** (`source.ts`): a `ScriptSource` (`getSnapshot` → scripts / versions /
  anchors maps; `apply(cueOps, anchorOps)` = one batch; `importVersion`; `setOriginal`;
  `fetchText`), over the store's tables and `api.createScriptVersion` / `api.scriptText`;
  component tests inject their own. `ScriptSourceProvider` is mounted once in
  `ShowWorkspace`. Anchor ops are store ops on `cue_anchors`; the client never sends
  `page` (the server derives `cue_anchors.page` and `cues.page` from `block`). Hooks: `data.ts`
  (`useScriptText`, `useVersionAnchors`, import results kept in sessionStorage for the
  Resolve screen).
- **Import** (`ImportPanel.tsx`): pick/drop → `extractScript` in the browser → preview
  (pages, blocks, confidence, first page, the extractor's warnings; OCR or confidence < 0.8
  shows a warning with guidance) → label → Import. Size checks before anything is sent:
  text over the route's 8 MB (`MAX_SCRIPT_BODY_BYTES`, `src/shared/script.ts`) is refused
  with a message (`textTooBig`); an original over 25 MB is not uploaded (a note says so;
  the text still imports, `originalTooBig`). Then: POST the version first (the server creates it, current,
  and re-anchors the previous version's cues), then upload the original through the
  attachments pipeline (`{table: "script_versions", recordId: versionId, field:
  "source_file"}`) and `update script_versions {attachment_id}`. A failed upload leaves
  the version without its original ("Attach original…" / "Retry with a file…").
- **Reader** (`Reader.tsx`, `ScriptBlocks.tsx`): pages virtualized (react-virtual), each
  a grid of gutter (page label) | text column (~70ch) | margin. Blocks render by kind;
  each is `[data-block=<i>]` with its text alone in `[data-text]` (selection offsets rely
  on it). Keys outside inputs: j / PageDown, k / PageUp, `/` find, `g` go to a page label.
  A sticky header shows the page **at the middle of the visible script**; the list ends
  with a viewport of padding (`paddingEnd`) so any page, the last included, scrolls to the
  top. The navigator lists headings and pages (a "Pages" toggle below 900 px). At ≤ 600 px: one column, markers become badges in the text that
  expand on tap (Open / Show in list).
- **Markers** (`Marker.tsx`, `markers.ts`): `Q 14.22` + trigger badge (`triggerBadge`:
  LINE, LX 117, SQ 12, TC 1:00:00, VISUAL, FOLLOW, MANUAL) + text (`markerText`), fixed
  height (`MARKER_HEIGHT`), positioned at their block's measured top and pushed down when
  they'd overlap (`stackMarkers`); markers on one block stack by offset, ties in show
  order (`anchorsByBlock(anchors, orderOf)`: the cue's `order_key`), in the reader and
  the print. Color: status by default, or trigger type / none
  (per user and show, localStorage). Open-notes dot, ⚠ for `changed` / `missing`. Line
  cues (trigger Line, or none) underline their quote (`quoteRanges` via the engine's
  `anchorPosition`, so a quote may run onto the next lines; `segmentText`; hovering a
  marker highlights it); other cues are positional (`isPositionalCue`: LX, timecode,
  visual…) and get a tick; their anchor's quote is just the block's first words. `missing` anchors aren't drawn. The filter bar
  (status / assignee / trigger) is `?filter=` (`filters.ts`), shared with the print; the
  LX/SQ toggle adds faint labels for the cue's `lx_cue` / `sq_cue`.
- **Placing** (`PlacePopover.tsx`, `placement.ts`; editors on the current version only):
  a text selection (`rangeToSpan` → `{block, offset, endBlock, endOffset}` → `spanAnchor`;
  a selection over several lines is one quote, "Quote covers 2 lines"; selecting only a
  character name offers "Use the next line"), a click in the margin (`makePositionAnchor`
  for the block at that height), or the keyboard (lines take focus: click one, ↑/↓ between
  lines; **Enter** = a position at that line, **Shift+Enter** = the whole line as the
  quote; focus returns to the line when the popover closes) opens the popover: **New cue** (number from
  `suggestCueNumber` between the nearest anchored cues before/after in script order;
  scene of the cue before, else after; created right after it in show order, else before
  the next; trigger Line + the selection, or LX / Timecode / Visual for positions) or
  **Attach existing cue** (RecordPicker over cues; moves the cue's anchor if it has one;
  a cue with no trigger type gets one). Dragging a marker onto another block updates its
  anchor: a positional cue moves to the line; a Line cue keeps its quote when that line
  contains it, otherwise `MoveDialog` asks (never silently): **Make this a positional
  cue** (LX / Timecode / Visual) or **Re-anchor on this line and update trigger text**.
  All placements are state `manual`, one batch with their cue ops.
- **URL state**: `?cue=` scrolls to the marker and flashes it (the cue list's parameter,
  so "Show in script" / "Show in list" round-trip; clicking a marker writes it);
  `?version=` reads an older version read-only (its own anchors); `?resolve=<versionId>`
  is the Resolve screen for that version (pinned: `1` means current). "Show in script": the cue grid's row menu, the cue panel's **Script**
  tab (`ScriptTab.tsx`: state, page, quote in context), ⌘K. A marker's ⋯ menu: Open cue,
  Show in list, Remove from script.
- **New version** (`resolve.ts`, `ResolveScreen.tsx`): the import's results give the
  report ("1 matched · 0 moved · 1 changed · 2 missing") and the Resolve list
  (`buildResolveItems`: results when this tab imported it, else the anchor rows); each
  item shows the old text around the old anchor and the new page at the best guess
  (other guesses as chips). Accept / Place (select text, or click a line for its start) →
  anchor state `manual`; for a Line cue, "Update trigger text to the new line" (on by
  default when the quote changed) also writes the new quote to `trigger_value`; Cut → cue status "Cut" (seeded by DO migration `0006_script`)
  and its anchor deleted; Skip → the cue is left unanchored (a guessed anchor becomes
  `missing` with `block: null`; Accept is how to keep a guess). Cues still without a placed anchor are the reader's **Unplaced** tray; the cue
  list's number cell warns about `changed` / `missing` anchors (`anchorWarnings`, a
  **dashed** underline: `CellDecoration.warningStyle`, unlike the wavy duplicate warning).
  **Several people at once**: the list re-checks every pending item against the live
  anchor and cue (`resolvedBy`): accepted / placed / re-matched, cut, or removed by
  someone else → "Resolved by <member name, else someone else>" (the item keeps the user
  id; unknown ids refetch the member list), and each action re-reads the live anchor
  first and refuses with a toast when it's no longer `changed` / `missing` (writes in
  flight from this screen don't count). **A newer version** imported meanwhile: the
  screen is keyed by its version and stays on it, with "A new version (v3) was imported
  by …; your list is for v2", actions hidden, and **Switch to v3**.
- **Roles**: viewers and commenters read (no popover, no drag, no import / resolve).
- **Tests**: `markers`, `placement`, `resolve` (unit), `Reader`, `rangeToSpan`,
  `ResolveScreen` (dom), `e2e/script.spec.ts` against the real engine (TXT fixtures
  `e2e/fixtures/script-v1.txt` / `-v2.txt` with `--- page 12 ---` markers: v2 rewrites
  one line, deletes one and inserts a paragraph).

## Print layouts (`src/web/features/print/`, R21)

- Routes under `/shows/:id` that render without the workspace chrome (ShowWorkspace
  returns just the outlet for paths containing `/print`). `PrintShell` forces the light
  theme by setting `<html data-theme="light">` while mounted (restored on leave, never
  stored), adds a screen-only toolbar (Back, Print / Save as PDF → `window.print()`) and
  the header (show, title, version / view, date).
- **Calling script** (`CallingScriptPrint.tsx`), `/shows/:id/script/print?version=&filter=&go=`:
  one table per script page whose `<thead>`/`<tfoot>` repeat on every printed sheet (the
  running header "show · version · Page 14 · date" and a footer; the page-top header is
  screen-only), each block beside its markers (status colors); a page break after each
  page but the last (no trailing blank sheet); body 11 pt in print. **GO emphasis** (on
  by default, `?go=0` off): a small "GO" tag and a bold cue number. Portrait. From the
  script header's **Print calling script** (keeps the filter) or ⌘K.
- **Print view** (`PrintTable.tsx`), `/shows/:id/print/<tab>?view=<id>`: `TablePrintRoute`
  renders the tab's own component inside `PrintModeContext`; `TableGrid` and `CueGrid`
  build their saved view as usual (`useViewConfig`, which now also returns `viewId`) and
  return `<PrintTable>` instead of the grid: the view's visible columns
  (`formatValue`), groups, filters, sorts and color rules (`rowColors`). Each group is its
  own table with the group title and column headers in `<thead>`, so they repeat on every
  printed page. Landscape by default (`@page { size }` from `PrintShell`'s
  `orientation`; a Sheet toggle, `?orient=portrait`); number-like columns (cue number,
  page, LX/SQ, timecode, numbers, lengths) never wrap; 13 px on screen, 10.5 pt printed.
  The toolbar's **Print** link and ⌘K "Print this view". Toggles on print pages keep
  local state (the URL follows), since a control bound only to the URL snaps back while
  the router applies it.
- **SM cue sheet** (`cueSheet.ts`), `/shows/:id/print/cues?layout=cuesheet`: cue, page,
  SM call / trigger (`smCall`: the SM call, else the trigger badge plus a Line / Visual
  cue's text), LX, description; every cue by scene (not the view's filter); big type.
  From the cue list's **Cue sheet** link, the print page's "SM cue sheet instead", or ⌘K
  "Print SM cue sheet".
- **Presets** (`print/presets/`, M5b), `/shows/:id/print/<tab>?preset=` (dispatched by
  `TablePrintRoute`; `printPresetUrl` knows every layout, the older two included):
  **Notes by person** (`notes?preset=by-person&session=&person=&breaks=1`: a group per
  assignee by name, a note under each of its assignees, Unassigned last; open first, then
  cue order, then oldest; a tick box column; type chips as text; `breaks=1` a page per
  person) and **Notes by cue** (`preset=by-cue`: cue headings in show order, a note under
  each of its cues, "No cue" last); `session` absent = all sessions (pure logic in
  `presets/notes.ts`). **Distribute notes** (by person): per assignee a `mailto:` (their
  People email; subject "<show> notes – <session>"; the notes as text, capped at 1,500
  characters; plus that person's own share link (`options: {session, person}`, enforced
  by the server) when this browser knows one; editors create the missing ones there, one
  per recipient) and "Print only theirs". Numbers (cue, P) never wrap (`data-num`). **Content list** (`content?preset=content`: small thumbnail, name, current
  version, status, scene, cues, surfaces; by scene) and **Surface sheet**
  (`surfaces?preset=surfaces`: a card per surface with its image, size in m and ft-in,
  pixels, PPI, aspect, regions). ⌘K: "Print notes by person/cue (<current session>)",
  "Print content list", "Print surface sheet".
- **Running header/footer**: `PrintShell` emits `@page` margin boxes (`pageRule`): top
  left the layout title, bottom left show · session · date, bottom right `"Page "
  counter(page) " of " counter(pages)` (Chromium ≥ 131 draws them; `running={false}` for
  layouts with their own header, like the calling script). `e2e/print-presets.spec.ts`
  checks them in a real PDF (`page.pdf()` + pdf.js). At ≤ 600 px screen previews wrap
  instead of scrolling sideways.

## Share links (M5b, R23)

- **Model.** D1 `share_links` (migration `0005_share_links_auth`; M5a has `0004`): `id`,
  `show_id`, `token_hash` (SHA-256; the token itself is shown once), `kind` (`view`: the
  live table; `print`: a print layout), `table`, `view_id` (a *shared* view of that table;
  a view link without one is given the table's shared default at creation), `preset`
  (`SHARE_PRESETS` in `src/shared/share.ts`: calling-script, cuesheet, by-person, by-cue,
  content, surfaces), `options` JSON (`{session, person, orient}`; session/person only for
  notes presets, **enforced by the server**), `label`, `created_by`,
  `created_at`, `expires_at`, `revoked_at`, `last_used_at`. Editors and the owner:
  `GET/POST /api/shows/:id/share-links`, `DELETE …/:linkId` (revoke: sets `revoked_at`,
  `ShowDO.disconnectShare(linkId)` sends `revoked` and closes its sockets with 4003),
  `POST …/:linkId/regenerate` (live links only: revokes it and creates a link with the
  same target, options, label and expiry; the token is shown once, so this is how a lost
  or leaked link is replaced). **A view link shows the whole table** (live), not just the
  view's filtered rows (the view shapes the rendering on the client); the Sharing UI says
  so, and row-level scoping is an open question for a hardening pass.
- **How a viewer gets in** (`routes/share.ts`, `auth/share-auth.ts`). `/s/<token>` (the
  SPA, `features/share/SharePage.tsx`) calls `GET /api/share/:token` (no auth;
  rate-limited on failures per IP; 404 unknown, 410 revoked/expired; `X-Robots-Tag:
  noindex`), which returns the show and the link's target and sets an HttpOnly cookie
  `cs_share=<token>; Path=/api/shows/<showId>`. On `/api/shows/*`,
  `requireAuthOrShare` (replaces `requireAuth` there) admits that cookie as a **share
  principal** on exactly these GET routes: the show, `/snapshot`, `/ws`,
  `/attachments/:aid(/thumb)`, `/script/versions/:vid/text` (`SHARE_ROUTES`); any other
  route of that show is 403 ("Share links are read-only"), other shows 401.
  `requireMembership` then sets role `viewer` and `c.var.share` (a `ShareScope`) and a
  stand-in `c.var.user` (`share:<linkId>`). A member's own session wins over a share
  cookie; a signed-in non-member with one is a share viewer. `shareResourceGuard` 404s
  files not on rows of the link's table and script text for non-calling-script links.
- **Scope** (`shareScope` in `src/shared/share.ts`, applied by `src/worker/share-filter.ts`
  in the ShowDO): the link's table plus the tables its grid labels links from (`RELATED`:
  cues → scenes, content, content_versions, persons; never notes unless the link is for
  notes), `views` (only the one view), `attachments` (only on the table's rows); presets
  have their own table lists (`PRESET_TABLES`). `snapshotForShare(scope)` empties every
  other table (unknown/new tables too), drops joins between tables out of scope and their
  select options. **Rows are scrubbed** (`scrubRow`): no user ids (`created_by`,
  `updated_by`, `completed_by` → ""/null), people as `{id, name, role}` everywhere except a
  People link (which keeps group and custom fields), and never `email`, `phone`,
  `organization`, `user_id`. **Notes presets** (`scope.notes`) see only notes of their
  session and, with `options.person`, assigned to that person (joins cut to match). A
  share socket (`X-Cuesheet-Share` header with the scope; tagged `share:<linkId>`,
  attachment `share`) gets each batch through `filterOps` (no personal views; out-of-scope
  ops dropped; fields scrubbed; attachment deletes only for its table's files, found via
  `pending_r2_deletes.row`; possibly an empty `ops` message so versions stay gap-free).
  **M5a data**: custom field definitions, custom tables/rows and shot lists are in no
  scope (a Shots link sees shots, shot lists, content and talent as name + role), and row
  `custom` values are never sent (attachments' `custom` file metadata excepted). A
  batch touching notes or people sends a notes preset's sockets `{type:"version"}`
  instead, so they refetch their filtered snapshot. **Expiry**: `scope.expiresAt`; expired
  share sockets are closed before every broadcast and by the DO alarm (one alarm shared
  with the R2 purge, set for the earliest expiry when a share socket opens). **Adding a table:** decide whether share links of which tables may see it
  (`RELATED` / `PRESET_TABLES`); by default they don't.
- **The page** renders the target on a normal `ShowStoreProvider` (the share cookie makes
  the snapshot/socket/file URLs work unchanged), with a viewer `Workspace` and
  `ShareContext` (`features/share/context.ts`): a `view` link is the tab's component in
  print mode (`PrintTable`) keeping the viewer's theme, with "Live", the theme toggle and a
  read-only row expand (`share-open-row` → `share-row-details`); a `print` link is the
  layout (light). No Back link, tabs, panels or presence names. The target's URL
  parameters (`view`, `layout`, `preset`, `session`, `person`) are put in the URL (the
  link's values win); the session/person pickers hide when the link fixes them. At
  ≤ 600 px wide tables scroll in their own box and drop fixed column widths, so the page
  never scrolls sideways. When the socket
  is refused/revoked the page re-resolves and shows the 404/410 page (`share-gone`).
- **Show settings → Sharing** (`show/ShareSettings.tsx`, editors and owner): pick a shared
  view (live or "as a print layout") or a print layout, session (notes presets), expiry,
  label → the link once (`share-scope-note` states what it shows); Regenerate / Revoke
  per link. This browser remembers the links it made (`ShareSettingsTokens.ts`,
  `cuesheet.shareLinks.<showId>`) to copy again and for "Distribute notes"; revoking
  forgets it. The owner's **Download backup** is its own section (Show settings → Backup).
- **Distribute notes** mints one by-person link per recipient (`options: {session,
  person}`), so each email's link shows only that person's notes for that session.
- **Resolve failures** count against the IP; a revoked/expired link at most once per link
  per hour (`recordFailureOnce`), so its old viewers reopening it don't lock their office out.

## Account security (M5b, R24)

- **Rate limiting** (`auth/rate-limit.ts`): a sliding-window log in D1
  `rate_limit_events(key, at)`; **failures only** are counted (wrong password, unknown
  email, bad invite / reset / share token). A `Limit` is a key with its windows (a bare
  key: `DEFAULT_WINDOWS`, 10 a minute and 50 an hour). Sign-in (`loginLimits`):
  `login:emailip:<email>|<ip>` 10/min + 50/h (so nobody can lock an account out from
  elsewhere), `login:email:<email>` 100/h, `login:ip:<ip>` 50/h; a success clears the
  email+IP key, a reset clears the email's keys (no LIKE: D1 caps LIKE patterns at 50
  bytes). Others: `invite:ip:`, `reset:ip:`, `share:ip:`, `password:user:<id>`. Over a limit: 429 + `Retry-After` (seconds until the window has
  room) and a message that says nothing about the account. The IP is
  `CF-Connecting-IP` ("unknown" locally, so tests set it). Every function takes `now`, so
  tests move time by passing it (or by aging rows).
- **Sessions** slide: 30 days (`SESSION_TTL_MS`), and a session used more than a day after
  its last extension gets 30 fresh days and a re-sent cookie (`sessionOf` in
  `auth/middleware.ts`, `maybeExtendSession`). `POST /api/auth/logout-all` deletes every
  session of the user and `disconnectUser`s them in all their shows ("Sign out
  everywhere" in the header's ⋯ menu, `components/AccountMenu.tsx`).
- **Password change** `POST /api/auth/password {currentPassword, newPassword}` (≥ 10;
  wrong current → 400, rate-limited): keeps this session, deletes the others and closes
  their sockets (`disconnectSession` per session id). **Admin reset links**:
  `POST /api/admin/password-resets {email}` → `/reset/<token>` (24 h, stored in `invites`
  with `kind` "reset" and `user_id`; plain invites have kind "signup" and can't be used as
  resets or vice versa), `GET/POST /api/password-resets/:token` (sets the password, signs
  out everywhere, signs in, clears the login lock). Page: `pages/ResetPasswordPage.tsx`;
  the form is on the Shows page for admins.
- **Invites** carry an optional `show_id` + `role` (`POST /api/invites {email, showId?,
  role?}`: admins anyone; a show's owner only to their show). It answers the same **200**
  whether or not the email has an account (no account oracle; accepting one for an
  existing account is refused). Accepting joins that show; `GET /api/invites/:token`
  returns `showName`/`role` for the page. Transferring a show ends the old owner's open
  invites into it.
- **Secure cookies**: `isHttps(c)` is also true whenever `ENVIRONMENT` is "production".

## Deploy and security headers (M5b; docs/deploy.md)

- `wrangler.jsonc`: top level = local dev/tests (`ENVIRONMENT` "development"); `env.production`
  repeats every binding (they aren't inherited) with a placeholder `database_id`, the R2
  bucket `cuesheet-files`, the weekly cron, observability; `migrations` (DO classes) are
  inherited. Build a production bundle with `CLOUDFLARE_ENV=production pnpm build` (the
  Vite plugin bakes the environment into `dist/`); `wrangler deploy` then uses it.
  `.github/workflows/deploy.yml` does build → `d1 migrations apply --remote --env production
  --config wrangler.jsonc` → deploy after CI passes on `main`, and skips with a notice
  without the `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets or with the placeholder
  database id. `compatibility_date` is the newest the local test runtime supports.
- **Security headers** (`src/worker/security.ts`): pages go through the Worker
  (`assets.run_worker_first: ["/*", "!/assets/*"]`, binding `ASSETS`), which adds a CSP
  built from the page's inline scripts (sha256 of index.html's theme script; `'self'`,
  `'wasm-unsafe-eval'`, `worker-src 'self' blob:` for pdf.js, `img-src/media-src 'self'
  data: blob:`, `connect-src 'self' wss://host` (`ws://` only on local http),
  `frame-ancestors 'none'`, `report-uri /api/csp-report` + `report-to` →
  `POST /api/csp-report` logs and answers 204), plus
  `X-Frame-Options`, HSTS (https), `Referrer-Policy`, `Permissions-Policy`, `nosniff`,
  `X-Robots-Tag: noindex` (API responses get all but the CSP; `public/robots.txt`
  disallows all). The CSP is off under `vite dev` only (`import.meta.env.DEV`), so **the
  e2e build runs with it**: a new inline script, eval, or a third-party origin will show up
  as a failing test (`e2e/security.spec.ts` collects `securitypolicyviolation` events).
  pdf.js runs under it (its worker is a same-origin chunk).
- **Logs**: log through `logError` / `redactTokens` (`security.ts`): share tokens in
  `/s/<token>` and `/api/share/<token>` become `[token]`. Production has invocation logs
  off (they record URLs) and a 0.1 head sampling rate.
- **wrangler commands** other than `wrangler deploy` take `--config wrangler.jsonc`: a build
  writes `.wrangler/deploy/config.json`, redirecting wrangler to `dist/`.
- `GET /api/health` → `{ok, d1, do}` (a `SELECT 1` and `ping()` on a fixed `__health__`
  ShowDO); 503 when either fails. `GET /api/shows/:id/export.json` (owner): the whole
  show as JSON (`routes/backup.ts`); the `scheduled` handler dumps D1 to R2 weekly
  (`backupD1`, `_backups/d1/`, 13 kept; they hold password and token hashes) and prunes
  sessions/invites/rate-limit rows. **Show data is in the DOs, not D1**: the weekly dump
  doesn't cover it; owners download `export.json` (Show settings → Backup) and DO
  point-in-time recovery is the other net (docs/deploy.md).

## Custom fields and custom tables (M5a: R9)

- **Model** (`src/shared/custom-fields.ts`, DO migration `0007_custom_fields_shots`).
  `custom_fields`: `table` (a core table: scenes, cues, content, notes, persons,
  surfaces, shots; or `custom:<customTableId>`; immutable), `key` (a slug `[a-z][a-z0-9_]*`
  ≤ 40, unique per table, immutable; `slugify(label, taken)`), `label`, `type` (text,
  longtext, number, checkbox, select, multiselect, date, datetime, duration, timecode,
  measurement, pixel_size, url, link, attachment, formula), `options` JSON
  (`CustomFieldOptions`: `choices` `[{value, color}]`, `target` + `multiple` for links,
  `formula`, `decimals`, `unit`, `sensitive`; the engine rebuilds it from known keys with
  `checkFieldOptions`), `position`, `width`. **Values live in each row's `custom` JSON
  under the key**; the grid / view column key is **`custom.<key>`** (`customColumnKey`,
  `customKeyOf`). Select values are the choice text (no option ids). `custom_tables`:
  `key`, `label`, `icon`, `position`, `primary_field_key` (the row's name in links,
  pickers and ⌘K; else its first non-sensitive text value; a sensitive primary never
  names a row). `custom_rows`: `table_id` (ref, cascade, immutable) + `order_key` (an
  ordered table; keys are global, each table shows its own rows in order) + `custom`.
  Editors and the owner manage fields and tables (the engine's default role check).
  Commenters may write custom values on **their own notes** (the notes rule), and the
  Notes tab's custom columns follow each note's `editable`.
- **Validation** (`Batch.checkCustomValues`, `checkCustomValue`): a `custom` key that
  names a defined field is checked by its type (select choices, `YYYY-MM-DD` dates,
  `YYYY-MM-DDTHH:MM` datetimes, `h:mm:ss(.ms)` durations, `hh:mm:ss:ff` timecodes, meters
  0–1 km, `{w,h}`, `http(s)://`/`mailto:` or `host.tld/…` URLs, links = arrays of ids
  that must exist in the target: a core table or `custom:<id>`'s rows, ≤ 1 when
  `multiple: false`); formula and attachment fields aren't stored (400); `null` clears.
  **Keys without a definition stay free-form** (imported notes' `created_by_name`,
  attachments' `caption`), capped at **16 KB of JSON per row** (`MAX_FREE_FORM_BYTES`;
  over it the write fails and the DO logs a warning). Attachment custom fields are
  `attachments` rows with `field` = the key (`isCustomAttachmentField`, also checked by
  `upload-url` through `ShowDO.isCustomAttachmentField`).
- **Definition changes rewrite data in the same batch** (engine `afterCustomFieldUpdate`
  / `renameChoices` / `resanitizeViews`, mirrored in `show-state.ts` `refitOps` /
  `renameOps`, so the optimistic state matches):
  - `custom_fields.update` may carry **`renames: [{from, to}]`** (select / multiselect
    only; stripped before the row is written): row values and the views' filter and
    color-rule values move to the new text. The Fields manager sends it when a choice's
    text is edited (`originals` track each choice's stored value).
  - Type or options change: each value goes through `refitValue(before, after, v)`:
    kept when both types share a shape (`keepsValues`: text/longtext/url, and select /
    multiselect → text or long text, a multiselect joined with ", "), a removed choice is
    cleared, a link pointed at **another target is cleared**, and **many → one keeps the
    first** id; anything else is cleared.
  - Every view on the table is re-sanitized: `sanitizeViewConfig(table, raw, known)` /
    `dropDeletedCustomFields` **drop** `custom.*` filters, sorts, grouping and color
    conditions that no longer fit (deleted field, operator the new kind lacks, grouping by
    a non-groupable kind) instead of refusing the view; a color rule is dropped only when
    this empties it.
  - **Defining a field over a free-form key** (field create) refits the rows' existing
    values under that key the same way; the Fields manager confirms with the count.
  - The client asks first, with counts: type change that clears values, removing used
    choices, a new link target, turning off "Allow more than one", a key that already
    holds values.
- **Cascades** (explicit ops, mirrored in `show-state.ts`): deleting a field removes its
  value from every row (and deletes its files) and re-sanitizes views; deleting a record
  removes its id from custom link values pointing at it (`targetNameOf`); deleting a
  custom table deletes its rows (ref cascade), its fields, the link fields elsewhere that
  target it (the confirm names them), and its views (even the last shared one).
- **Sensitive** text fields (`options.sensitive`, e.g. imported passwords): masked in the
  grid (`Column.masked`: dots) and the row panel (a **Reveal** button, `MaskedField`),
  logged in history as `"(hidden)"` (`HIDDEN_VALUE`; create/delete rows are redacted
  too). A value written while the field was sensitive **stays hidden** after the flag is
  removed: the engine checks the record/field's last logged write (`wasHidden`) and logs
  the next old value as `(hidden)`. Formulas never read them: a masked column resolves
  to a `#HIDDEN` error value, and links expose only names (never a sensitive primary).
  Left out of ⌘K, view exports and "Export all" unless an owner ticks **Include
  sensitive fields**. The value itself is stored and synced (members can reveal it).
- **Views** (`VIEW_FIELDS` is per table **plus** `custom.<key>` columns:
  `viewFieldsFor(table, fields)`, kind from `customFieldKind`: date/datetime → `date`,
  formulas → `text`, whose operators cover numbers and lengths; `groupable` marks text
  fields a view may group by). `views.table` is a `ViewTable`: a data table or
  `custom:<id>` (the custom table must exist). A custom table's default view is "All
  rows" in show order (`defaultViewName`).
- **Client** (`features/custom/`): `model.ts` (`fieldsFor` cached per `custom_fields`
  map, `targetLabel` / `searchTarget` for link targets, `customRowLabel`,
  `newCustomTableOps` (the table + a "Name" text field as primary + its shared default
  view), `newFieldOps`, `valueCount`, `customRowsOf`, `reverseLinks`), `columns.tsx`
  (`customColumns`: one grid column per field; date/datetime/duration/timecode/url are
  `text` columns with a `parse` (`src/shared/custom-values.ts`, re-exported by
  `values.ts`: lenient input like `9/30/26`, `7:30pm`, `90s`, `1h 5m`, `01001012`,
  `example.com`) and dates carry `valueType: "date"` for before/after filters; links are
  link/multilink columns searching the target; attachments reuse `attachmentColumn`;
  `customEditOps` turns a grid value into `{custom: {key: stored}}`), `useCustomColumns`
  (the tab's columns + custom ones; they rebuild when definitions change, and on any data
  change when a field shows links or a formula). Tabs opt in with `TableGrid`'s `custom:
  {fieldTable, rowOf, fallbackRecord?, editable?}` (Scenes, Content, Notes, People,
  Surfaces, Shots, custom tables); `CueGrid` calls the hook itself. The row panel shows
  them (attachment fields full width), ⌘K matches text custom fields (`searchShow`),
  filters/sorts/groups/colors work unchanged.
- **Formula fields** (`formula.ts`): evaluated per row with the shared engine over a
  record whose names are the table's columns (title or key, case-insensitive, `{PPI}`,
  `ppi`), custom fields (label or key) and a tab's `fallbackRecord` (Surfaces: the
  storage fields `pixel_width`, `parent`…); links are record sets of names
  (`{Venue}.Name`). Formulas may use other formulas; a cycle is an `#ERROR` value
  ("Circular reference"); a sensitive field is `#HIDDEN`. Results are cached per row
  object; `resultType` (number / measurement / text) is inferred from the first rows.
  Errors show as values (red `#CODE`).
- **Fields manager** (`FieldsManager.tsx`): the view bar's **Fields** popover → a
  top-level **Fields…** entry above the column list (`ViewBar` `fieldTable`; "Custom
  fields…" read-only for others), and **Show settings → Structure** (pick a table, same
  manager). List, **+ Add field**, Edit (name, type, choices with colors, link target +
  "Allow more than one", formula with a live parse check, decimals, Sensitive), delete
  with a confirmation naming how many rows have values.
- **Custom tables in the workspace**: tabs after the core ones (`tables/<id>` →
  `/shows/:id/tables/<id>`, `CustomTableGrid`; `AnyTabKey` / `customTabKey` /
  `tabInfo(key).viewTable` in `tabs.ts`), ⌘K "Go to <table>"; **Show settings →
  Structure → Custom tables**: + New table, rename, ↑/↓ reorder (`position`), delete
  (confirm with the row count and the link fields on other tables that go with it). The
  row panel lists the records linking to a row (reverse links, per field). Custom tables
  have no print route (`/print/<tab>` only knows core tabs).
- **Import**: every CSV that isn't a core table becomes a custom table (name from the file,
  `tableLabelFromFile`; `guessFieldType`: URLs → url, "checked" → checkbox, dates → date,
  IP addresses → text, a password-like header → sensitive text, numbers → number, a few
  repeated values in a status/type-like column → select, long/multi-line → longtext,
  attachments → attachment (files not imported, warned); first text column is primary; a
  default view). Unmapped columns of core CSVs (`unmappedColumns`: not in
  `MAPPED_COLUMNS` / `DERIVED_COLUMNS`, `src/shared/airtable-columns.ts`) become custom
  fields when the **import preview** (`AirtableImport.tsx`, parsed in the browser with
  papaparse; skipped when there's nothing to decide) ticks "Create custom field" (type
  pre-guessed); the preview also renames, retypes or skips each custom table. The
  request's `mapping` form field is an `ImportMapping`; keys stay unique against the
  show's fields. Cells are read with `csvValue` (the same parsers as the grid:
  multiselect comma-split, date, datetime, duration, timecode, measurement, pixel size);
  unreadable cells are left empty and counted in one warning per column ("Gear: Length: 1
  value couldn't be read as measurement; left empty"). **Custom rows count as data**
  (`ShowDO.hasData`): a second import without `?append=1` is a 409, as for core tables.

## Shots (M5a: R14)

- **Data**: `shot_lists` (`name`, `shoot_date`, `location`, `notes`, `position`) and
  `shots` (`shot_list_id` ref cascade, immutable; `number` text, `group` text, `description`,
  `framing` select WS/MS/CU/ECU/OTS/Insert, `camera`, `lens`, `resolution` pixel size,
  `frame_rate` 0–1000, `duration` text, `status` select Planned/Shot/Selected/Cut (seeded
  by migration 0007), `order_key`); links `shots.talent` → persons (`shot_talent`) and
  `shots.content` → content (`shot_content`); attachment field `shots.reference`. Shots
  is a data table (a default "All shots" view grouped by `group`).
- **Tab** (`features/shots/`): the list bar has a **"Current shot list"** `MenuButton`
  (the lists as checkable items, then + New list… / Rename… / Delete list… (confirm;
  deletes its shots); remembered per user and show; a plain **+ New list** button when
  there's none) and a details panel (`ListDetails`: shoot date, location, notes, saved on
  Enter / blur). Below, a `TableGrid` of the list's shots grouped natively by `group`
  (`shotGroups`: "No group" first, then groups by first appearance;
  `VIEW_FIELDS.shots.group` is `groupable`); the view bar's group button reads "Grouped
  by <label>" (all tables). Insert / drag like cues (dragging into another group sets
  `group`); ghost numbers and duplicate warnings from `cueNumberHints(…, "shot")`.
  **Print**: the toolbar's Print link (`/print/shots?view=`), and **+ Shot list** under My
  views is the print layout preset (`SHOT_LIST_PRESET`: number, description, framing,
  lens, talent, duration, status).

## Export, templates, bulk edit (M5a: R26, R27, S8)

- **View export** (`features/export/`): the view bar's **Export** popover (Excel BOM and
  **Excel-safe** on by default; **Include sensitive fields** for owners) and ⌘K "Export
  this view as CSV" (the mounted view registers itself: `activeExport.ts`). `exportRows`:
  the view's visible columns in order, its filtered / sorted rows, a leading group column
  when grouped (**not** when the grouped field is already a visible column: `groupKey`),
  values as the grid formats them (`exportCell`: links joined by ", ", formulas as
  displayed, checkboxes true/false), section rows left out. **Measurements are plain
  numbers in the active unit with the unit in the header** (`exportHeader`: "Width (m)";
  feet-inches exports decimal feet). `toCsv` quotes only what needs it (comma, quote,
  CR/LF, edge spaces), doubles quotes, ends rows with CRLF; `excelSafe` prefixes a `'` to
  cells starting with `=`, `+`, `-`, `@` (plain numbers excepted). File: `<Table> -
  <View>.csv`.
- **Export all tables** (Show settings → Export): `exportAll.ts` zips (JSZip,
  lazy) one CSV per table (scenes, cues, content, content versions, surfaces, notes,
  people, shot lists, shots, each custom table): `id`, the stored fields (refs and links
  as labels, measurements in meters with `(m)` in the header), custom fields, plus
  `manifest.json` (show, time, version, per-table file/rows/columns).
- **Templates** (`POST /api/shows/:id/clone {name, includeScenes?, asTemplate?}`,
  `routes/clone.ts`, owner/editor of the source): a new show (the caller owns it;
  `shows.is_template`, **D1 migration `0004_show_template`**) whose DO gets, one batch per
  table through the op engine (`cloneOps`): the default unit, surfaces (regions' parents
  remapped), scenes + their surface links (unless `includeScenes: false`), custom tables
  (definitions only), custom fields (tables and link targets remapped), shared views
  (record ids in configs remapped; filters on scenes that weren't copied are dropped; the
  seeded defaults of tables that get copies are deleted). **Scenes and surfaces keep
  their custom values**, minus link and attachment keys (their targets aren't copied).
  Never cues, notes, content, shots, attachments, the script or personal views. The D1
  rows are inserted **only after every DO batch succeeded**; a failed copy is a 500 and
  leaves an unreachable object, never a half show in the list. Seeded select options are
  the same in every show, so nothing else is copied. UI: Show settings → Template →
  **Save as template** (name, include scenes); the shows page lists templates apart and
  offers **New from template**.
- **Bulk edit** (S8, `shared/BulkEdit.tsx`): the row menu's **Set field for selection…**
  (every table) and **Move to scene…** (cues; moves them to the end of that scene in
  their order) open a dialog: a field (editable on all the rows; no files or formulas) and
  a value (the row panel's editors); Apply sends one batch of the tab's own edit ops; the
  toast's **Undo** writes each row's previous value back. (The grid's own undo covers
  cell edits only.)
- **DataGrid API additions** (backwards compatible): `Column.href(value)` renders a text
  cell as a link (URL fields); `Column.masked` shows dots (sensitive fields).
  `cueNumberHints` takes an optional noun for its messages.

## Theme and colors

Dark is the default **regardless of the system color scheme**; only the user's toggle
switches to light (`<html data-theme="light">`). The inline script in `index.html` sets the
theme before first paint from the stored choice (`localStorage` `cuesheet.theme`), falling
back to dark; `prefers-color-scheme` is deliberately ignored. `src/web/lib/theme.ts` has the
same logic plus `useTheme()`; the toggle is `components/ThemeToggle.tsx` in the header.

**Never hardcode a color.** Use the variables in `src/web/styles/theme.css`:

| Variable | Use |
| --- | --- |
| `--color-bg-sunken` | Inputs, wells |
| `--color-bg` | Page background |
| `--color-surface` | Header, cards, panels, grid |
| `--color-surface-raised` | Popovers, menus, buttons |
| `--color-surface-hover` | Hovered rows/items |
| `--color-border`, `--color-border-strong` | Dividers; stronger outlines |
| `--color-text`, `--color-text-muted` | Body text; secondary text |
| `--color-accent`, `--color-accent-hover`, `--color-accent-subtle` | Links, primary buttons, selection |
| `--color-text-on-accent` | Text on an accent fill |
| `--color-focus-ring` | Focus outlines |
| `--color-danger`/`-warning`/`-success` + `-subtle` | Status text; its tinted background |
| `--option-{gray,red,orange,yellow,green,teal,blue,purple,pink}-{bg,fg}` | Select-option chips and color rules |
| `--shadow-raised` | Popover shadow |

Also spacing (`--space-1..8`), radii (`--radius-sm/md/lg`) and fonts (`--font-sans`,
`--font-mono`). Both themes must define the same variables; dark surfaces are never pure
black/white (pure white surfaces are intended in **light mode only**, e.g. `--color-surface`,
with an off-white page background); text pairs are WCAG AA. `src/web/styles/theme.test.ts`
enforces these, so add new pairs there when you add tokens.

Layouts must work down to phone width (390px). The header wraps below 600px (page content
such as the show title + presence moves to a second row; the user name hides).
`e2e/responsive.spec.ts` checks this.

## Environment (Claude sandbox)

- Node 22, pnpm 10. Docker is not available.
- Playwright uses the preinstalled Chromium: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`,
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. `@playwright/test` is pinned to **1.56.1** because it
  matches the installed `chromium-1194`; bump only together with the browser. Never run
  `playwright install` here (CI does, in `.github/workflows/ci.yml`).
- Outbound to `*.cloudflare.com` is blocked. `send_metrics: false` is set in
  `wrangler.jsonc` and CI sets `WRANGLER_SEND_METRICS=false`. The "Unable to fetch the
  `Request.cf` object" / "Request was cancelled" noise from workerd at startup is that
  blocked call and is harmless.
- **Never deploy** or call Cloudflare APIs. The D1 `database_id` in `wrangler.jsonc` is a
  placeholder.
- `.dev.vars` (git-ignored) holds `ADMIN_EMAIL` / `ADMIN_PASSWORD`; copy from
  `.dev.vars.example`. The e2e config creates it from the example if missing and reads the
  same credentials.
