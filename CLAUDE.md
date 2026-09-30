# Notes for Claude

The project has left the spec-only phase: M0 (the application scaffold) is built. The stack
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
| `pnpm test` | Vitest only (`--project unit` or `--project worker` to narrow) |
| `pnpm format` | Biome autofix (formatting + import order) |
| `pnpm db:generate` | Drizzle SQL migrations for both D1 and the ShowDO |
| `pnpm db:migrate:local` | Apply D1 migrations to `.wrangler/state` |
| `pnpm cf-typegen` | Regenerate `src/worker/worker-configuration.d.ts` (the `Env` type) after changing `wrangler.jsonc` or `.dev.vars` keys |

Before finishing any task: `pnpm check && pnpm e2e`.

## Layout

- `src/shared/`: types used by both Worker and web (`api.ts` DTOs, `ws.ts` socket messages).
  No runtime dependencies.
- `src/worker/`: `index.ts` (entry; exports DO classes), `app.ts` (Hono app under `/api`),
  `routes/`, `auth/`, `do/ShowDO.ts`, `db/d1/` (D1 schema + migrations), `db/do/` (ShowDO
  schema + migrations).
- `src/web/`: `main.tsx` (router), `pages/`, `components/`, `lib/` (api client, auth, theme,
  `useShowSocket`), `styles/` (`theme.css`, `global.css`). CSS modules per component.
- `test/worker/`: Vitest tests running inside workerd. `e2e/`: Playwright.
- Unit tests sit next to the code as `*.test.ts` and run in plain Node.

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
- **Adding an API route.** Add a handler in the relevant `src/worker/routes/*.ts` (or a new
  file mounted in `app.ts`). Put request/response types in `src/shared/api.ts`, add a method
  to `src/web/lib/api.ts`, and cover it in `test/worker/api.test.ts`. Protect it with
  `requireAuth` / `requireAdmin` (exported from `src/worker/auth/middleware.ts`). Routes
  under `/shows/:id` also use `requireMembership`, a middleware local to
  `src/worker/routes/shows.ts` (not exported) that loads the show + the caller's role into
  `c.var.show` / `c.var.role`; put show routes in that file, or export it if another file
  needs it. Errors are JSON `{ error }`; show-not-found and not-a-member are both 404.
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
- **Deferred to M1:** a `ShowDO.disconnectUser(userId)` RPC called on logout and membership
  removal (sockets carry `userId` as a hibernation tag and attachment, so this is a lookup via
  `ctx.getWebSockets(userId)`), and an endpoint to add members to a show.
- **Writing an e2e test.** Add `e2e/<feature>.spec.ts`. Use helpers in `e2e/helpers.ts`
  (`login`, `createShow`, `uniqueName`). Tests run in parallel against one server whose DB
  persists for the run, so make data unique (`uniqueName`) and don't assume an empty DB.
  Prefer role/label locators; use `data-testid` for things without a good accessible name.
  Use separate `browser.newContext()`s to simulate multiple users.
- **Every feature gets a test** (unit, worker or e2e).
- TypeScript strict everywhere (`noUncheckedIndexedAccess` on). Biome formats and lints
  with `"rules": { "preset": "recommended" }` (Biome 2.5's replacement for the deprecated
  `recommended: true`). Don't disable rules globally; if you run `biome migrate`, check it
  didn't turn the linter's rules off.

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
