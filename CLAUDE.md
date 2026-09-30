# Notes for Claude

The project has left the spec-only phase: M0 (the application scaffold), M1a (the show
data layer: core tables, ops, sync, history, members, Airtable import), M1b (the generic
`DataGrid`) and M1c (the show workspace: a grid tab per core table on the live store, ⌘K)
are built. The stack
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
  types), `order.ts` (order keys), `ids.ts` (UUIDv7). No runtime dependencies except
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
  A future rename endpoint writes D1 only. Apply the same pattern to any other show-level
  fields that must be listable across shows.
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
  State: `version`, `status`, `tables` (Map by id per table), `order` (ids in show order for
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
  they created), `viewer` (read only; `/mutate` is 403). Enforced per op in the DO from the
  role the Worker read on that request. Members: `GET/POST /api/shows/:id/members`,
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
`useWorkspace()` (role, `canEdit`/`canComment`, member names, `toast`/`reportError`, the
cue live sort, `sortCuesNow`, `openImport`).

- **One folder per table**: `features/<table>/columns.ts` (the `Column<View>[]` in display
  order, plus `<table>EditOps(view, key, value) → Op[]`) and the tab component. A tab
  builds **view objects** (the row plus its links resolved to `PickerItem`s) with a
  `ViewCache`, so a view keeps its identity until its inputs change (the grid memoizes rows
  on the object). Scenes, Content, Notes and People use the generic
  `features/shared/TableGrid.tsx` (config: columns, rows or groups, `editOps`,
  `createOps`, `moveOps`, `deleteOps`, panel); the cue list (`features/cues/CueGrid.tsx`)
  has its own component for number hints and the sort menu. Read-only: `editable: false`
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
  `SSS-NNN-` prefix (`features/content/contentName.ts`); `createPerson`.
- **URL state**: the active row is `?<param>=<id>` (`cue`, `scene`, `content`, `note`,
  `person`; `tabs.ts`), written with `replace`. On load, or on a navigation carrying router
  state `{ focus: id }` (⌘K), the tab calls `grid.focusRow(id)` once the row exists
  (`features/shared/useTableChrome.ts`). Per-browser prefs (`features/shared/prefs.ts`,
  localStorage, until saved views): column widths per show+table, collapsed groups per
  user+show+table, the cue live sort per show.
- **Row panel** (`RowPanel`): Space / expand icon; read-only; follows the active row;
  Escape or × closes it and refocuses the row. Grid undo covers cell edits only; inserts,
  moves, deletes and Sort now aren't undoable yet.
- **E2E**: set up data through the API (`apiLogin`, `apiCreateShow`, `importExamples` in
  `e2e/helpers.ts`); the grid virtualizes rows, so open a far-down row with `?cue=<id>`
  instead of expecting it in the DOM.

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
