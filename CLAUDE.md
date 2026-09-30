# Notes for Claude

The project has left the spec-only phase: M0 (the application scaffold), M1a (the show
data layer: core tables, ops, sync, history, members, Airtable import), M1b (the generic
`DataGrid`), M1c (the show workspace: a grid tab per core table on the live store, ⌘K),
M2a (saved views and conditional formatting) and M2b (notes panel, editable row panel with
history, tech mode, phone quick-add, the show's current session) are built. The stack
is decided in `docs/decisions/0005-cloudflare-platform.md`; don't relitigate it without a
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
| `pnpm e2e` | Playwright headless (builds and starts its own server on :4317) |
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
  validation, per-table defaults). No runtime dependencies except
  `fractional-indexing` in `order.ts`, which must run identically on both sides.
- `src/worker/do/ops-engine.ts`: applies op batches to the ShowDO's SQLite.
  `src/worker/import/airtable.ts`: CSVs → ops.
- `src/web/lib/show-store.ts` (+ pure `show-state.ts`): the client store for one show.
- `src/worker/`: `index.ts` (entry; exports DO classes), `app.ts` (Hono app under `/api`),
  `routes/`, `auth/`, `do/ShowDO.ts`, `db/d1/` (D1 schema + migrations), `db/do/` (ShowDO
  schema + migrations).
- `src/web/`: `main.tsx` (router), `pages/`, `features/` (see "Table views"), `components/`,
  `lib/` (api client, auth, theme, `useShowSocket`, show store + `show-selectors.ts`),
  `styles/` (`theme.css`, `global.css`). CSS modules per component.
- `test/worker/`: Vitest tests running inside workerd. `e2e/`: Playwright.
- Unit tests sit next to the code as `*.test.ts` and run in plain Node. React component
  tests are `*.test.tsx` and run in jsdom (the `dom` project; helpers in `src/web/test/dom.ts`,
  no testing-library).
- `src/web/pages/dev/`: developer-only pages (`/dev/grid`). Registered via `devRoutes` in
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
- **Rate limiting** of login is deferred to M5 (TODO in `routes/auth.ts`).
- **DO code.** `src/worker/do/ShowDO.ts`. Expose operations as RPC methods on the class
  (the Worker calls `env.SHOW.get(env.SHOW.idFromName(showId)).method()`); only WebSockets
  go through `fetch`. The Worker checks auth + membership before calling the DO; the DO
  trusts its caller. Use the Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`,
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
  targetId, position?}`. Send them with `store.mutate(ops)` on the client (or
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
  validation: text/number/bool/select/multiselect/ref). (3) For a select: seed its options
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
  the owner can't be changed or removed). Removal and logout call
  `ShowDO.disconnectUser(userId)`, which sends `{type:"revoked"}` to that user's sockets
  and closes them with code 4003; `useShowSocket` treats `revoked` as terminal (status
  `unauthorized`, "No access") and doesn't reconnect.
- **Airtable import** (`POST /api/shows/:id/import/airtable`, multipart CSV files; editors
  and owners; 4 MB max). A show that already has rows in any core table gets 409
  `{error:"Show already has data"}` unless the request has `?append=1` (the UI asks for
  confirmation first; appended rows are added, not merged). Files are recognised by Airtable's `<Table>-<View>.csv` name or by their
  headers; the five core tables are imported, others skipped with a warning. The import is
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
  to `custom.created_by_name`; `Created Time` is read as UTC.
- **Writing an e2e test.** Add `e2e/<feature>.spec.ts`. Use helpers in `e2e/helpers.ts`
  (`login`, `createShow`, `uniqueName`). Tests run in parallel against one server whose DB
  persists for the run, so make data unique (`uniqueName`) and don't assume an empty DB.
  Prefer role/label locators; use `data-testid` for things without a good accessible name.
  Use separate `browser.newContext()`s to simulate multiple users.
- **Writing a worker test.** Use `test/worker/helpers.ts` (`api`, `post`, `loginAdmin`,
  `newUser`, `createShow`, `connectDO`, `collect`, `isType`). `api()` adds a same-origin
  `Origin` to non-GET requests like a browser does (the CSRF check needs it on bodyless
  and multipart requests). Example CSVs import as text with `?raw`.
- **Every feature gets a test** (unit, worker or e2e).
- TypeScript strict everywhere (`noUncheckedIndexedAccess` on). Biome formats and lints
  with `"rules": { "preset": "recommended" }` (Biome 2.5's replacement for the deprecated
  `recommended: true`). Don't disable rules globally; if you run `biome migrate`, check it
  didn't turn the linter's rules off.

## Grid

Every table UI uses the generic `DataGrid` in `src/web/components/grid/`. Read its
[README](src/web/components/grid/README.md) before wiring a table: props, value shapes per
column type, ordering rules (show order vs live sort with the focused row held until blur),
the keyboard map and an integration example. The grid never fetches or persists; it calls
`onEdit` / `onInsert` / `onMove` / `onDelete` and renders what it's given. `RecordPicker`
(find-or-create, R5a) is exported for reuse outside the grid. Try it at `/dev/grid`.

## Table views (`src/web/features/`)

The show page (`/shows/:id`) is a workspace (`features/show/ShowWorkspace.tsx`): header
(title, presence, theme), tabs (`features/show/tabs.ts`: Cues, Scenes, Content, Notes,
People → `/shows/:id/<tab>`; `/shows/:id` and unknown tabs redirect to `cues`), Show
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
- **URL state**: the active row is `?<param>=<id>` (`cue`, `scene`, `content`, `note`,
  `person`; `tabs.ts`), written with `replace`. On load, or on a navigation carrying router
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
  (cues: `CueContentCards`, link/unlink through the content picker) and **History**
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
  "Undo" toast for 8 s (`noteRestoreOps`: recreate with the same id, fields and links). A note's session defaults to the show's current session and is editable per
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
  under the box. Bodies are capped at 100,000 characters (a counter appears near the
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
  per user and show), the compose box, the session control, and a disabled camera button
  ("Attachments arrive in M3"); saving shows "Saved to Cue …" and keeps the cue. With no
  cue picked, Add note is disabled unless the note starts with `*` (or a cue prefix). The
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
  list's `open_notes`), declared per table in `VIEW_FIELDS` with their kind
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
