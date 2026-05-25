# Acufy Timesheet — Lightsail ldev deployment

This directory contains everything needed to ship the timesheet app to the
Lightsail "ldev" host at `user.webilent.tm.ldev.acufy.ai`.

The deploy pipeline is: **build images locally → save to tar → scp to host
→ `docker load` → `docker compose up`**. No registry, no git pull on the
host, no production rebuild.

## One-time host setup (done)

The following has already been done on the Lightsail host:

- Two databases on `ldb.acufy.ai`:
  - `timesheet_ldev` (per-tenant data + legacy shared)
  - `acufy_control_ldev` (control plane)
- Role `timesheet_user_ldev` owns both DBs (password stored in local `.env.ldev`)
- `pg_hba.conf` has two entries permitting that role from any host
- Backup of `pg_hba.conf` at `/var/lib/pgsql/data/pg_hba.conf.bak.<ts>`

## Per-deploy steps

### 1. Populate `.env.ldev`

```
cp deploy-ldev/.env.ldev.template deploy-ldev/.env.ldev
# Fill in __REPLACE_ME__ entries. The DB URLs are already correct.
```

`deploy-ldev/.env.ldev` is gitignored. Real values never get committed.

### 2. Build, save, ship

```
deploy-ldev/build-and-ship.ps1
```

The script:

1. Reads `.env.ldev` for build args (Vite env vars baked into the bundle).
2. Builds `acufy-timesheet-ldev-backend:latest` and `acufy-timesheet-ldev-frontend:latest`.
3. Saves both to `deploy-ldev/images/*.tar`.
4. scps both tars + the compose file + the `.env` file to
   `/home/ec2-user/timesheet-ldev/` on the Lightsail host.
5. SSHs to the host and runs `docker load` + `docker compose up -d`.
6. Tails the backend logs until the API responds on `127.0.0.1:18030/health`.

### 3. First-time only: Nginx + TLS

If `user.webilent.tm.ldev.acufy.ai` doesn't have an Nginx config yet
(check `/etc/nginx/conf.d/`), do this once:

```bash
# On the Lightsail host. Cloudflare DNS for the subdomain must be
# "DNS only" (not proxied) during certbot issuance. Re-enable proxy
# afterwards if desired.

# 1. Get the LE cert.
sudo certbot certonly --nginx -d user.webilent.tm.ldev.acufy.ai \
  --non-interactive --agree-tos -m ops@acufy.ai

# 2. Drop the nginx config.
sudo cp /home/ec2-user/timesheet-ldev/nginx/user.webilent.tm.ldev.acufy.ai.conf \
        /etc/nginx/conf.d/

# 3. Reload nginx.
sudo nginx -t && sudo systemctl reload nginx
```

### 4. First-time only: seed demo data

```bash
ssh ec2-user@54.225.103.202
cd /home/ec2-user/timesheet-ldev
docker compose exec backend python -m app.seed
```

## Ports on the host

- 18030: backend (FastAPI) — loopback only
- 13050: frontend (Nginx serving static) — loopback only
- Nginx proxies 443 → frontend, 443 `/api/` → backend

## Updating after code changes

Just re-run `build-and-ship.ps1`. Containers are restarted with `up -d`.
Migrations run at backend startup (`alembic upgrade head`).

## Env file: local is the source of truth

Every deploy copies your **local** `deploy-ldev/.env.ldev` over the
host's `/home/ec2-user/timesheet-ldev/.env`. The host file is a
build artifact, not a place to edit. **Never edit the host `.env`
directly** — your changes will be clobbered on the next deploy.

### When you rotate a credential

The three-step sequence, in order, every time:

1. Rotate the upstream credential (e.g. on `ldb.acufy.ai` via dbadmin,
   or on the OpenAI / Auth0 / SMTP provider).
2. Update `deploy-ldev/.env.ldev` locally with the new value. This is
   gitignored, so the secret never reaches git.
3. Run `build-and-ship.ps1`. The script ships the updated `.env.ldev`
   to the host as `.env` and restarts containers.

If you skip step 2 and just rotate + redeploy, the deploy will push
the *old* value back over the host and the containers will fail to
authenticate against the upstream.

### Safety valves

- `-SkipEnv`: opt-in flag for the rare hotfix where you want to ship
  a new image but NOT touch env. Useful only when an env rotation is
  intentionally in flight on the host and you don't want the deploy
  to overwrite it. Default is to always ship the env.
- `__REPLACE_ME__` guard: the script refuses to ship a `.env.ldev`
  that still contains template placeholders. Prevents accidentally
  clobbering a working host file with a half-filled template.

## Rollback

Tar files from the previous deploy stay on the host under
`/home/ec2-user/timesheet-ldev/images/`. To roll back manually:

```bash
ssh ec2-user@54.225.103.202
cd /home/ec2-user/timesheet-ldev
docker compose down
docker load < images/acufy-timesheet-ldev-backend-<previous-tag>.tar
docker load < images/acufy-timesheet-ldev-frontend-<previous-tag>.tar
# edit docker-compose.yml to reference the older image tag, then
docker compose up -d
```

(Yes, this means every deploy should bump the image tag if you want easy
rollback. The script defaults to `:latest` for simplicity. Improve later.)
