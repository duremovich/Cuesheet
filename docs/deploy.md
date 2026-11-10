# Deploying Cuesheet

Cuesheet runs on Cloudflare ([decision 0005](decisions/0005-cloudflare-platform.md)): one
Worker (the API and the static app), a SQLite-backed Durable Object per show (**all of a
show's data**: scenes, cues, content, notes, views…), D1 for users/shows/memberships and
other cross-show records, R2 for files. Production is the `production` environment in
`wrangler.jsonc`; `.github/workflows/deploy.yml` deploys it after CI passes on `main`.

Nothing here can run from the Claude sandbox (outbound to `*.cloudflare.com` is blocked):
do the one-time setup from a developer machine, then let GitHub Actions deploy.

## Two things to know about wrangler here

- **`.wrangler/deploy` redirection.** `pnpm build` (the Cloudflare Vite plugin) writes
  `.wrangler/deploy/config.json`, which points wrangler at the *built* config in `dist/`.
  After a build, a plain `wrangler …` command silently uses that one (and whatever
  environment it was built for). So **every wrangler command below except `wrangler deploy`
  passes `--config wrangler.jsonc`**, which always means the source config. `wrangler
  deploy` is the one that should follow the redirection: build with
  `CLOUDFLARE_ENV=production pnpm build`, then `wrangler deploy` (no `--env`).
- `--env production` selects the production bindings (database id, bucket, secrets).
  Without it, commands act on the local-dev top-level config.

## Plan: free or $5

- **Workers Paid ($5/month) is recommended.** Sign-in hashes passwords with PBKDF2
  (100,000 iterations, the most hosted Workers allow), which takes more CPU than the Free
  plan's 10 ms per request; on Free, sign-ins can fail with "exceeded CPU". Paid also
  raises the request, Durable Object, D1 and log quotas well past what a team uses.
- **Free works for a trial**: SQLite-backed Durable Objects are on the Free plan, as are
  D1, R2 (10 GB), cron triggers and Workers Logs, each with daily quotas (check
  Cloudflare's pricing pages; they change). Expect occasional sign-in failures.
- Either way, attachments count toward R2 (each show is capped at 2 GB by the app).

## One-time setup

The same steps as a bare checklist: [`scripts/cf-setup.md`](../scripts/cf-setup.md).

1. **Tools.** Node 22, pnpm 10, `pnpm install`, then `pnpm exec wrangler login` (a browser
   window; or `export CLOUDFLARE_API_TOKEN=…` with the token from step 8).
2. **D1 database.**

   ```sh
   pnpm exec wrangler d1 create cuesheet --config wrangler.jsonc
   ```

   Copy the printed `database_id` into `wrangler.jsonc` →
   `env.production.d1_databases[0].database_id` (replacing the zeros) and commit it. It's
   not a secret. Leave the top-level one (local dev) as it is.
3. **R2 bucket.**

   ```sh
   pnpm exec wrangler r2 bucket create cuesheet-files --config wrangler.jsonc
   ```

   (Another name? Change `bucket_name` under `env.production.r2_buckets`.) Keep the bucket
   private: files are only served through the Worker, which checks show membership.
4. **Migrations.**

   ```sh
   pnpm exec wrangler d1 migrations apply DB --remote --env production --config wrangler.jsonc
   ```

   Durable Object classes migrate themselves (the `migrations` list in `wrangler.jsonc`,
   applied on deploy; each show's tables migrate when its object starts).
5. **First deploy.**

   ```sh
   CLOUDFLARE_ENV=production pnpm build
   pnpm exec wrangler deploy
   ```

   It prints the `workers.dev` URL (`https://cuesheet-production.<account>.workers.dev`).
6. **Secrets** (the first admin; read once, while no user exists yet):

   ```sh
   pnpm exec wrangler secret put ADMIN_EMAIL --env production --config wrangler.jsonc
   pnpm exec wrangler secret put ADMIN_PASSWORD --env production --config wrangler.jsonc  # ≥ 10 characters
   ```

7. **Seed the admin.** Open the URL and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`: the
   first request creates that account when the users table is empty. Then change the
   password (account menu ⋯ → Change password…) and delete the secret, which isn't read
   again once a user exists:
   `pnpm exec wrangler secret delete ADMIN_PASSWORD --env production --config wrangler.jsonc`.
   Invite the team from the Shows page.
8. **GitHub Actions.** Create an API token (Cloudflare dashboard → My Profile → API
   Tokens → Create token → "Edit Cloudflare Workers" template, plus **D1: Edit**; account
   resources: your account; zone resources: the zone of your custom domain, if any). In
   the GitHub repo:
   - Settings → Environments → **production** (created by the first deploy run, or create
     it): add **required reviewers** and/or a deployment branch rule "main only", so a
     deploy needs a person's approval and can't come from another branch.
   - Put the secrets on that environment (or the repository): `CLOUDFLARE_API_TOKEN`,
     `CLOUDFLARE_ACCOUNT_ID` (dashboard → Workers & Pages → Account ID).
   - Optional variable `PRODUCTION_URL` (e.g. `https://cuesheet.example.com`): the deploy
     then checks `/api/health` afterwards.

   From then on every push to `main` that passes CI deploys (after approval, if you set
   reviewers). Without the secrets (or with the placeholder database id) the Deploy
   workflow skips with a notice. It can be run by hand (Actions → Deploy → Run workflow),
   from `main` only.
9. **Custom domain** (optional; the zone must be on the same Cloudflare account). In
   `wrangler.jsonc` under `env.production`, uncomment and edit:

   ```jsonc
   "routes": [{ "pattern": "cuesheet.example.com", "custom_domain": true }],
   "workers_dev": false
   ```

   Deploy; Cloudflare creates the DNS record and certificate. Turn on "Always Use HTTPS"
   for the zone. Share links, invite and reset links use the page's origin, so they follow.

## What each deploy does

`deploy.yml`, after the CI workflow succeeds for a push to `main`:

1. `CLOUDFLARE_ENV=production pnpm build`: the Vite plugin builds the app and the Worker
   with the `production` environment baked into `dist/cuesheet/wrangler.json` (name
   `cuesheet-production`, `ENVIRONMENT=production`, its D1/R2 bindings, the weekly cron)
   and redirects wrangler to it.
2. `wrangler d1 migrations apply DB --remote --env production --config wrangler.jsonc`:
   pending D1 migrations (`src/worker/db/d1/migrations`). Write migrations that the
   previous Worker version can live with (add columns/tables; don't drop or rename in the
   same deploy), since they apply before the new code is live.
3. `wrangler deploy`: uploads the Worker and assets; Durable Object class migrations run.
4. Optionally `GET $PRODUCTION_URL/api/health`.

## Rollback

- **Code:** `pnpm exec wrangler rollback --env production --config wrangler.jsonc` (or
  dashboard → the Worker → Deployments → Rollback). It returns to the previous version
  immediately. List versions with
  `pnpm exec wrangler deployments list --env production --config wrangler.jsonc`.
- **D1 migrations don't roll back.** Keep migrations additive (see above) so the old code
  still works after a rollback. To undo a bad D1 data change, restore D1 from Time Travel:
  `pnpm exec wrangler d1 time-travel restore cuesheet --timestamp=<ISO time> --env production --config wrangler.jsonc`
  (D1 keeps 30 days on Paid, 7 on Free), or from a weekly dump (below).
- **Durable Objects:** a show's SQLite migrations are forward-only too; the ShowDO only
  adds tables and columns. A rolled-back Worker ignores what it doesn't know. To undo bad
  show *data*, see "Show data: point-in-time recovery".

## Backups

**Show data lives in each show's Durable Object and is NOT in the weekly D1 dump.** The D1
dump has accounts, memberships, show names, invites and share links: enough to rebuild
who has access, not a single cue or note. Cover show data with the per-show export and
Durable Object point-in-time recovery below.

- **Each show: "Download backup" (recommended weekly per active show).** Owners: Show
  settings → Backup → **Download backup** (`GET /api/shows/:id/export.json`): the show's
  whole Durable Object (every table, personal views too, links, select options,
  settings), its D1 side (name, session, members, share links without their token
  hashes), and a manifest of its files in R2 (key, size, type) for copying them with
  `wrangler r2 object get … --config wrangler.jsonc`. Keep one per active show every week
  and before risky changes (a big import, a new script version) and at the end of a
  production. The export.json is for keeping, not for restoring: it has no history and
  no file bytes. To restore or move a show, use the instance-to-instance copy in "Moving a
  show between instances" below (it reads the source instance live).
- **Show data: point-in-time recovery.** SQLite-backed Durable Objects keep 30 days of
  history. At the time of writing it's reached through the Durable Object Storage API
  (`ctx.storage.getBookmarkForTime(time)` then
  `ctx.storage.onNextSessionRestoreBookmark(bookmark)` and restarting the object), not
  through a wrangler command or a dashboard button; check Cloudflare's Durable Objects
  docs ("Point in time recovery") for a CLI/dashboard option before relying on this. With
  none, recovering a show means adding a small admin-only route that calls those two
  methods on that show's ShowDO; restoring rewinds the *whole* show to that moment.
- **D1, weekly, automatic.** The Worker's `scheduled` handler (cron `17 3 * * 1`, Mondays
  03:17 UTC; `src/worker/routes/backup.ts`) writes every D1 table except sessions and
  rate-limit events as gzipped JSON to R2 under **`_backups/d1/<timestamp>.json.gz`**
  (apart from show files under `shows/`) and keeps the newest 13 (about three months).
  **These dumps contain password hashes and the hashes of invite, reset and share-link
  tokens: treat them as secrets** (don't copy them anywhere public; the bucket stays
  private). It also prunes expired sessions, old invites and rate-limit events. Fetch one
  with `pnpm exec wrangler r2 object get cuesheet-files/_backups/d1/<file> --file backup.json.gz --remote --config wrangler.jsonc`.
  D1 Time Travel covers finer-grained cases.
- **R2** has no automatic backup here. For more than the show exports, add an R2 bucket
  replication or a periodic `rclone` copy (R2 is S3-compatible).

## Moving a show between instances

`scripts/migrate-show.ts` copies one show from instance A (say the local one on 4318) to
instance B (say production) **under the same show id**, then verifies the copy. It needs
Node 22.18+ (it runs the TypeScript file directly) and an **instance admin** login on both
sides. Both instances must run **the same Cuesheet version** (the code with the transfer
routes, and the same show schema: the import refuses a different `__drizzle_migrations`
list).

```sh
node scripts/migrate-show.ts \
  --from http://localhost:4318 --from-creds ../cuesheet-live/admin.dev.vars \
  --to-creds ../cuesheet-live/admin.prod.vars \
  --show 9f6bf44e-3e7c-4fdf-9d73-08f252f57f21
```

A creds file is `ADMIN_EMAIL=…` / `ADMIN_PASSWORD=…` lines like a `.dev.vars` (BOM, CRLF,
quotes and comments are fine), optionally with `URL=https://…`, which stands in for a
missing `--from` / `--to`; or JSON `{"email", "password", "url"?}`. Every request sends
`User-Agent: cuesheet-migrate/1.0`: Cloudflare's Browser Integrity Check answers library
default user agents with 403 "error code: 1010". https targets with `Secure` cookies work
(the CLI keeps its own cookie jar).

- **What's copied:** every row of every table in the show's Durable Object, raw and with
  the same rowids (scenes, cues, content, notes, links, views incl. personal ones, select
  options, custom fields/tables, script + versions + anchors, attachments, the **whole
  change history**, files waiting for their deferred delete, the AUTOINCREMENT counter);
  the D1 show row (name, session, `storage_bytes`, template flag, `created_at`), its
  memberships and share links (token hashes included, so a link keeps working if its
  token's path is opened on the new host); and every R2 object under `shows/<id>/`
  (attachments, thumbnails, the gzipped script texts) with its metadata.
- **Users:** each user id the show references maps to the target account with the **same
  email**; anyone without an account there maps to the **target login** (the CLI prints
  each mapping; "NO ACCOUNT ON TARGET" lines are those). Several users mapped onto one
  account merge into one membership with the highest role. To keep people's authorship,
  invite them on the target first, then migrate.
- **Not copied:** sessions (everyone signs in again), pending invites, rate-limit events,
  upload reservations, other shows. Nothing is deleted on the source.
- **Safety:** the target accepts an import only into a show id it doesn't have (no D1
  row, an empty Durable Object). A previous import of the same show (the DO's
  `transfer:state` marker) is replaced only with `--overwrite`, and never once someone has
  edited it (its version moved). Rows are staged first and swapped in with one
  transaction at the end, and the D1 rows are written last: until then the show is in
  nobody's list.
- **Re-running:** safe. After an interrupted run, run it again with `--overwrite` (the CLI
  says so). If the target already holds a finished import, a plain re-run only verifies.
- **Verify** (always runs after an import; alone with `--verify-only`): per table, row
  count and SHA-256 of the canonical rows (source with the user mapping applied) on both
  sides; DO version and counters; the D1 show row, memberships and share links; for every
  R2 object the size, metadata and a SHA-256 **computed by each instance from its own
  bucket**; and the app's own snapshot as each admin sees it (shared views). Exit 0 =
  migrated and identical, 1 = differences (listed), 2 = refused or failed.
- **Limits:** rows go in ≤ 8 MB requests, files one request each (≤ 95 MB; attachments are
  capped at 25 MB anyway). Files pass through the machine running the CLI.

The routes behind it (instance admins only, `src/worker/routes/transfer.ts`):
`GET /api/admin/users`, `GET /api/admin/shows/:id/transfer` (manifest / status),
`…/transfer/rows?table=&after=`, `…/transfer/files`, `…/transfer/file?key=`,
`…/transfer/file-hash?key=`; and on the target `POST …/transfer/begin`, `POST …/rows`,
`PUT …/file?key=`, `POST …/finish`.

## Monitoring and logs

- **Logs:** production keeps our own log lines (errors, CSP reports) at a **10% sample**
  (`head_sampling_rate: 0.1`) and turns off automatic per-request *invocation* logs
  (`logs.invocation_logs: false`): those record full URLs, and `/s/<token>` and
  `/api/share/<token>` carry share tokens. Every line the Worker logs has share tokens
  rewritten to `[token]` (`redactTokens` in `src/worker/security.ts`). While debugging,
  raise the sample rate (not the invocation logs) or use
  `pnpm exec wrangler tail --env production --config wrangler.jsonc` live (tail shows
  URLs: don't share its output).
- **Health:** `GET /api/health` → `{ok, d1, do}` (503 when D1 or a Durable Object doesn't
  answer). Point an uptime checker at it (Cloudflare Health Checks, or any external one).
- **CSP reports:** browsers report blocked content to `/api/csp-report` (logged as
  `csp-report`). A burst after a deploy means the page is loading something the policy
  doesn't allow.
- **Usage:** dashboard → Workers & Pages → the Worker → Metrics (requests, CPU, errors);
  D1 and R2 have their own metrics pages. Watch CPU time on sign-in if you're on Free.
- **Cron:** dashboard → the Worker → Triggers → Cron events shows each backup run.

## Security headers

The Worker serves the app's pages (`run_worker_first`, `src/worker/security.ts`) so every
page gets a `Content-Security-Policy`: scripts from our origin plus the hash of
`index.html`'s inline theme script, `'wasm-unsafe-eval'`, workers from self/blob:,
images/media from self/data:/blob:, sockets to our own host over `wss:` only (plain `ws:`
only for local http), no framing, violations reported to `/api/csp-report`. Also
`X-Frame-Options: DENY`, `Strict-Transport-Security` (https), `Referrer-Policy`,
`Permissions-Policy`, `nosniff` and `X-Robots-Tag: noindex` (plus `robots.txt`: disallow
all). API responses get the same minus the CSP. In production (`ENVIRONMENT=production`)
session and share cookies are always `Secure`.

## Local checks before a deploy

`pnpm check && pnpm e2e` (the e2e build runs with the production security headers).
`CLOUDFLARE_ENV=production pnpm build` builds exactly what CI deploys (afterwards, a plain
`wrangler` command follows the redirection to that build: use `--config wrangler.jsonc`).
