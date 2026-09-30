# Cuesheet

A database tool for theater production workflows, focused on video/projection
design: managing cues, pieces of content, and the links between them. Think
Airtable, tailored to how our team actually runs a show.

Built for our own team, not as a commercial product.

## Status

**M1c: the cue list.** On top of the M0 scaffold (invite-only sign-in, shows, live
presence) and the M1a data layer (per-show tables in a Durable Object, a typed op API
with real-time broadcast, history, roles, Airtable import): each show is a workspace with
tabs for **Cues, Scenes, Content, Notes and People**, each an editable, real-time
spreadsheet grid (M1b's `DataGrid`). The cue list is grouped by scene, keeps show order
(inserting never moves rows), suggests cue numbers, warns about duplicates, has a live
sort and "Sort now", find-or-create pickers, a read-only row panel, and ⌘K search. The
spec in `docs/spec/` describes what we're building toward (next: saved views, editable
panels, tech mode).

Stack (see [decision 0005](docs/decisions/0005-cloudflare-platform.md)): Cloudflare
Workers + Hono for the API, one SQLite-backed Durable Object per show, D1 for users
and shows, R2 for files (bound, not used yet), Drizzle ORM, React 19 + react-router,
Vite with the Cloudflare plugin, Vitest, Playwright, Biome.

## First run

Requires Node 22+ and pnpm 10.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # admin email/password for local dev
pnpm dev                         # http://localhost:5173
# in a second terminal, while pnpm dev is running:
pnpm seed:example                # creates "Some Like It Hot" from examples/*.csv, prints its URL
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.dev.vars` and open the show. Things
to try on the **Cues** tab:

- Click a cell and type; Enter commits and moves down, Tab moves right, Escape cancels.
- Click cue **14.20** (scene 105) and press **⌘/Ctrl+Shift+Enter**: a new row appears right
  below with a faint **14.22** suggested; Tab accepts it. Leave a number empty and the row
  still stays exactly where you put it.
- Duplicate numbers (e.g. the two **51.50**s) get an orange underline with a tooltip.
- **Sort ▾ → Sort by cue number (live)**: edit a number and the row stays put until you
  click elsewhere, then slides to its place. **Sort now by cue number** rewrites show order.
- Drag a row by the handle on its row number into another scene: its scene changes.
- In a **Content** cell type a new name and pick **Create "…"**: it's created in the cue's
  scene with the `SSS-NNN-` prefix and shows up on the Content tab.
- **Space** (or the ↗ icon on a row number) opens the row panel beside the grid; it
  follows the row you're on.
- **⌘/Ctrl+K**: search cues (by number, e.g. `14.2`), content, scenes, notes and people,
  or run commands (Sort now, Go to…, Toggle theme, Import).
- Open the show in a second browser (or a private window) to watch edits arrive live.
- **Show settings** (⚙): Airtable import, members (the owner adds people who already have
  an account; invite them from the shows page first).
- **Row panel tabs**: edit any field in **Fields** (same pickers as the grid), see the
  cue's **Content** as cards, its **Notes**, and its **History** (who changed what,
  from → to).
- **Notes**: in a cue's Notes tab type a note and press Enter; click type chips, ⌥1–5 for
  priority, `@name` to assign; click a note's status to cycle Open → In progress → Done.
  Start a note with `8.5: ` (colon and space; or `#8.5 `, `q8.5 `) to put it on cue 8.50
  instead, or with
  `*` for a general note.
- **Tech mode** (**Tech** in the header, **⌘/Ctrl+Shift+.**, or ⌘K → Tech mode): set the **Session**
  (e.g. "Tech 2") once, then ↓/↑ (or Space) to move through cues, type, Enter; ⌘/Ctrl+G
  jumps to a cue number. On a phone, **＋** opens quick add: pick a cue, type, Add note.

Undo (⌘Z / ⌘⇧Z) covers cell edits made in that grid; inserts, moves, deletes and "Sort
now" aren't undoable yet. Column widths, collapsed groups and the live sort are remembered
per browser (saved views come in M2).

## Running it

Requires Node 22+ and pnpm 10.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # admin email/password for local dev
pnpm dev                         # applies D1 migrations, then serves http://localhost:5173
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.dev.vars`; that admin is created on
the first request when the users table is empty. Invite teammates from the shows page
(it gives you a one-time link to send them; there's no email sending).

Local data (D1, Durable Objects, R2) lives in `.wrangler/state`. Delete that folder to
start over.

To get a realistic show to play with, run this in a second terminal while `pnpm dev`
is up:

```sh
pnpm seed:example   # signs in as the .dev.vars admin, creates "Some Like It Hot",
                    # imports examples/*.csv, prints the show URL and import warnings
```

It targets `http://localhost:5173`; set `SEED_URL` for another port. You can also import
from **Show settings → Import Airtable CSVs…** in the show (select the Breakdown, Personnel,
Content, Cue List and Notes CSVs together).

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server with the Worker, DOs, D1 and R2 running in workerd; HMR for the app |
| `pnpm build` | Production build: `dist/client` (static assets) + `dist/cuesheet` (Worker bundle + `wrangler.json`) |
| `pnpm preview` | Build, then serve the built Worker locally |
| `pnpm typecheck` | `tsc -b` over the web, worker and node projects |
| `pnpm lint` / `pnpm format` | Biome check / Biome check with fixes |
| `pnpm test` | Vitest: `unit` project (Node) and `worker` project (inside workerd) |
| `pnpm e2e` | Playwright, headless Chromium, against a fresh built server |
| `pnpm check` | typecheck + lint + test (what CI runs before e2e) |
| `pnpm db:generate` | Generate SQL migrations from the Drizzle schemas (D1 and DO) |
| `pnpm db:migrate:local` | Apply D1 migrations to the local database |
| `pnpm cf-typegen` | Regenerate `src/worker/worker-configuration.d.ts` after editing `wrangler.jsonc` |
| `pnpm seed:example` | Create "Some Like It Hot" from `examples/*.csv` on a running dev server |

Nothing here deploys. Deploying needs a Cloudflare account, real D1/R2 IDs in
`wrangler.jsonc`, and `ADMIN_EMAIL` / `ADMIN_PASSWORD` set as secrets.

## Tests

- **Unit** (`src/**/*.test.ts`, plain Node): password hashing, session cookie parsing,
  theme resolution, theme contrast (WCAG AA) checks, order keys and ids, the client show
  store (optimistic apply, reconcile, rollback, gap refetch, structural sharing on
  refetch), Airtable CSV helpers, and the table features: cue-number suggestions and
  duplicate warnings, the "Sort now" plan, content-name prefixes, grid edit → ops, link
  diffs, scene grouping, global search.
- **Worker** (`test/worker/*.test.ts`, `@cloudflare/vitest-pool-workers`): the ShowDO
  (migrations, meta, WebSocket presence, hibernation), the op engine (ordering, validation,
  cascades, links, roles, history, versions, broadcast), the Airtable import of the real
  `examples/` CSVs, and the `/api` routes against real
  D1 and DOs.
- **E2E** (`e2e/*.spec.ts`, Playwright): sign in, create a show, see presence go to 2 with
  a second browser; invites; sign out; theme default/toggle/persistence; importing the
  example CSVs; the cue grid (`cue-grid.spec.ts`: insert with a suggested number, show
  order, live sort, Sort now, drag across scenes, content picker, two browsers live, ⌘K,
  viewer read-only, 390 px); the other tabs; commenters; members. Playwright's
  `webServer` runs `pnpm build`, applies migrations into `.wrangler/e2e-state`, and serves
  the built Worker with `vite preview` on port 4317.

## Source layout

```
src/
  shared/             Used by both sides: API DTOs (api.ts), socket messages (ws.ts), core
                      tables (tables.ts), ops (ops.ts), order keys (order.ts), ids (ids.ts)
  worker/             The Cloudflare Worker
    index.ts          Entry: exports the fetch handler and the ShowDO class
    app.ts            Hono app: middleware and route mounting under /api
    routes/           auth.ts, shows.ts (DO proxy, WebSocket, mutate/snapshot/history,
                      members, import), invites.ts
    auth/             password (PBKDF2), cookie, session, middleware (requireAuth/Admin, seed)
    do/ShowDO.ts      Per-show Durable Object: SQLite via Drizzle, WebSocket hibernation
    do/ops-engine.ts  Applies op batches: validation, order keys, cascades, history
    import/           Airtable CSV → ops
    db/d1/            D1 schema, client, migrations/ (applied by wrangler)
    db/do/            ShowDO schema, migrations/ (applied in the DO constructor)
  web/                The React app
    main.tsx          Router and providers
    pages/            Login, Shows, Show (loads the show, then the workspace), Invite, dev/
    features/         show/ (workspace: tabs, settings, ⌘K), cues/, scenes/, content/,
                      notes/, people/ (one tab each: columns.ts + the grid), search/
                      (⌘K palette), shared/ (table chrome, pickers, ops helpers, panel)
    components/       AppHeader, ThemeToggle, PresenceIndicator, AirtableImport, grid/
    lib/              api client, auth context, theme, useShowSocket, show-store (+ show-state,
                      show-selectors)
    styles/           theme.css (color tokens), global.css
test/worker/          Tests that run inside workerd
e2e/                  Playwright tests
scripts/              seed-example.ts (pnpm seed:example)
```

## Repo layout

| Path | What's in it |
| --- | --- |
| `src/`, `test/`, `e2e/` | The application and its tests (above) |
| `docs/spec/` | The working spec: overview, requirements, data model, open questions |
| `docs/decisions/` | Short records of decisions (stack, hosting, etc.) |
| `examples/` | Reference material from past shows (Airtable CSV exports, screenshots) |
