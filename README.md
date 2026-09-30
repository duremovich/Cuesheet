# Cuesheet

A database tool for theater production workflows, focused on video/projection
design: managing cues, pieces of content, and the links between them. Think
Airtable, tailored to how our team actually runs a show.

Built for our own team, not as a commercial product.

## Status

**M0: application scaffold.** Sign-in (invite-only), a list of shows, an empty
show page with live presence over WebSockets. No cue grid yet (that's M1). The
spec in `docs/spec/` still describes what we're building toward.

Stack (see [decision 0005](docs/decisions/0005-cloudflare-platform.md)): Cloudflare
Workers + Hono for the API, one SQLite-backed Durable Object per show, D1 for users
and shows, R2 for files (bound, not used yet), Drizzle ORM, React 19 + react-router,
Vite with the Cloudflare plugin, Vitest, Playwright, Biome.

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

Nothing here deploys. Deploying needs a Cloudflare account, real D1/R2 IDs in
`wrangler.jsonc`, and `ADMIN_EMAIL` / `ADMIN_PASSWORD` set as secrets.

## Tests

- **Unit** (`src/**/*.test.ts`, plain Node): password hashing, session cookie parsing,
  theme resolution, theme contrast (WCAG AA) checks.
- **Worker** (`test/worker/*.test.ts`, `@cloudflare/vitest-pool-workers`): the ShowDO
  (migrations, meta, WebSocket presence, hibernation) and the `/api` routes against real
  D1 and DOs.
- **E2E** (`e2e/*.spec.ts`, Playwright): sign in, create a show, see presence go to 2 with
  a second browser; invites; sign out; theme default/toggle/persistence. Playwright's
  `webServer` runs `pnpm build`, applies migrations into `.wrangler/e2e-state`, and serves
  the built Worker with `vite preview` on port 4317.

## Source layout

```
src/
  shared/             Types used by both sides: API DTOs (api.ts), WebSocket messages (ws.ts)
  worker/             The Cloudflare Worker
    index.ts          Entry: exports the fetch handler and the ShowDO class
    app.ts            Hono app: middleware and route mounting under /api
    routes/           auth.ts, shows.ts (incl. DO proxy + WebSocket), invites.ts
    auth/             password (scrypt), cookie, session, middleware (requireAuth/Admin, seed)
    do/ShowDO.ts      Per-show Durable Object: SQLite via Drizzle, WebSocket hibernation
    db/d1/            D1 schema, client, migrations/ (applied by wrangler)
    db/do/            ShowDO schema, migrations/ (applied in the DO constructor)
  web/                The React app
    main.tsx          Router and providers
    pages/            Login, Shows, Show, Invite
    components/       AppHeader, ThemeToggle, PresenceIndicator
    lib/              api client, auth context, theme, useShowSocket
    styles/           theme.css (color tokens), global.css
test/worker/          Tests that run inside workerd
e2e/                  Playwright tests
```

## Repo layout

| Path | What's in it |
| --- | --- |
| `src/`, `test/`, `e2e/` | The application and its tests (above) |
| `docs/spec/` | The working spec: overview, requirements, data model, open questions |
| `docs/decisions/` | Short records of decisions (stack, hosting, etc.) |
| `examples/` | Reference material from past shows (Airtable CSV exports, screenshots) |
