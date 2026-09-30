# Cloudflare one-time setup (checklist)

Run from a developer machine (not the Claude sandbox). Why and what else: `docs/deploy.md`.
Recommended plan: Workers Paid ($5/month); see "Plan: free or $5" there.

```sh
pnpm install
pnpm exec wrangler login

# 1. D1: copy the printed database_id into wrangler.jsonc →
#    env.production.d1_databases[0].database_id, and commit it.
pnpm exec wrangler d1 create cuesheet

# 2. R2 bucket for attachments and backups (private).
pnpm exec wrangler r2 bucket create cuesheet-files

# 3. D1 tables.
pnpm exec wrangler d1 migrations apply DB --remote --env production

# 4. First deploy (creates the Worker cuesheet-production).
CLOUDFLARE_ENV=production pnpm build
pnpm exec wrangler deploy

# 5. The first admin (used once, while there are no users).
pnpm exec wrangler secret put ADMIN_EMAIL --env production
pnpm exec wrangler secret put ADMIN_PASSWORD --env production
```

6. Open the printed URL, sign in as that admin, change the password (⋯ → Change
   password…), invite the team from the Shows page. Optionally
   `pnpm exec wrangler secret delete ADMIN_PASSWORD --env production`.
7. GitHub → Settings → Secrets and variables → Actions: secrets `CLOUDFLARE_API_TOKEN`
   (template "Edit Cloudflare Workers" + D1 Edit) and `CLOUDFLARE_ACCOUNT_ID`; optional
   variable `PRODUCTION_URL`. Pushes to `main` that pass CI now deploy.
8. Custom domain (optional): uncomment `routes` / `workers_dev` under `env.production` in
   `wrangler.jsonc`, commit, let it deploy.
