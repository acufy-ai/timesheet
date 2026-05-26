# Dev Setup

How to clone this repo and have a working local app pointed at the
shared dev database. Should take under 10 minutes the first time, ~30
seconds every time after.

The app runs in Docker. The database lives on a shared Postgres at
`ldb.acufy.ai` that's already seeded with demo data. You don't install
Postgres, you don't run migrations, you don't run the seed script.

## Prerequisites

- **Docker Desktop** (Windows/macOS) or Docker Engine (Linux). Anything
  4.x or newer should work.
- **Git**. You already have this if you're reading this.
- Network access to `ldb.acufy.ai:5432` (no VPN required from a normal
  laptop, but corporate firewalls sometimes block outbound 5432).

## One-time setup

### 1. Clone the repo

```bash
git clone git@github.com:acufy-ai/timesheet.git
cd timesheet
```

### 2. Get the env-file kit

The kit holds three pre-filled `.env` files with database connection
strings, account passwords, encryption keys, and third-party API
secrets. It's not in this repo on purpose — credentials don't belong
in git. Ask the project lead and they'll send you the kit (currently
`timesheet-dev-env.zip`).

You'll get three files:

| Source file | Rename to | Drop into |
|---|---|---|
| `root.env`      | `.env` | repo root (next to `docker-compose.yml`) |
| `backend.env`   | `.env` | `backend/.env`                            |
| `frontend2.env` | `.env` | `frontend2/.env`                          |

After dropping them in, your tree should look like:

```
timesheet/
├── .env                  ← from root.env
├── docker-compose.yml
├── docker-compose.dev-shared.yml
├── backend/
│   └── .env              ← from backend.env
└── frontend2/
    └── .env              ← from frontend2.env
```

All three files are gitignored, so you can't accidentally commit them.

### 3. Bring up the stack

From the repo root:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev-shared.yml up --build -d redis api frontend
```

First time: 3-5 minutes (pip install + npm install run inside the
containers). Subsequent runs: under 30 seconds.

When that finishes:

```bash
docker compose ps
```

You should see `timesheet-api-1`, `timesheet-frontend-1`, and
`timesheet-redis-1` all `Up`.

### 4. Log in

Open `http://localhost:5181` in your browser.

| Email | Password | Role |
|---|---|---|
| `tenantuser7@gmail.com` | (see kit) | Tenant Admin |
| `acufydev@gmail.com`    | (see kit) | Platform Admin |
| `admin@example.com`     | `password` | Seed admin |
| `manager1@example.com`  | `password` | Seed manager |
| `emp1-1@example.com`    | `password` | Seed employee |

Use an incognito tab the first time to avoid any cached token from
another environment.

## Daily run

After the one-time setup, you only need:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev-shared.yml up -d redis api frontend
```

To follow logs while developing:

```bash
docker compose logs -f api
```

To stop:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev-shared.yml down
```

## Making code changes

The api container uses `uvicorn --reload`, so backend Python edits
hot-reload inside the container. **Frontend changes do NOT hot-reload**
in the Docker setup because Vite is producing a production build at
container start. For active frontend work, either:

- Rebuild the frontend container when you make a change:
  `docker compose -f docker-compose.yml -f docker-compose.dev-shared.yml up --build -d frontend`
- Or run Vite outside Docker for frontend-only iteration: `cd frontend2 && npm install && npm run dev`. The bare Vite server runs on
  whatever port `frontend2/package.json` is configured for and hits the
  same backend at `localhost:8000`.

## What's shared

The database is shared across every dev. So:

- Users you add show up in other devs' UI on their next page refresh.
- Mailboxes you connect are visible to other devs.
- Time entries, projects, clients — all shared.

This is the intended workflow. But it has constraints. See
[backend/DEV_SHARED_DB.md](backend/DEV_SHARED_DB.md) for the full set of
"do" and "don't" rules. Highlights:

- **Do not run Alembic migrations against the shared DB.** If your
  branch adds a migration, point at a local Postgres for that work
  (override `DATABASE_URL` in your `backend/.env`).
- **Do not run destructive SQL.** No `DELETE FROM users` without a tight
  filter. No `TRUNCATE`. No `DROP TABLE`.
- **Use throwaway mailboxes only.** The encryption key is shared, so
  any mailbox OAuth token you store is decryptable by every other dev.
  Connect dev-only Gmail/Outlook accounts.

## Troubleshooting

**Backend startup fails with "password authentication failed":**
Check that `.env` in the repo root has the `DATABASE_URL` line with the
URL-encoded password (`%21` for `!`, `%40` for `@`, etc.).

**Connection times out on backend startup:**
You probably can't reach `ldb.acufy.ai:5432`. Test with
`Test-NetConnection ldb.acufy.ai -Port 5432` (Windows PowerShell) or
`nc -vz ldb.acufy.ai 5432` (macOS/Linux). If blocked, you're on a
network that filters outbound 5432.

**Login returns "Invalid email or password":**
The api may still be connecting to the local `db` container instead of
`ldb.acufy.ai`. Verify with
`docker exec timesheet-api-1 env | grep DATABASE_URL` — it must point
at `ldb.acufy.ai`, not `db:5432`. If wrong, the root `.env` is missing
the `DATABASE_URL` and `CONTROL_DATABASE_URL` lines. Recreate the api
container after fixing: `docker compose -f docker-compose.yml -f docker-compose.dev-shared.yml up -d --force-recreate api`.

**Frontend loads but every API call 401s:**
Clear `sessionStorage` for `localhost:5181` and log in again. Tokens
from another environment (ldev, prod) don't transfer.

**Port 5181 already in use:**
Change `FRONTEND_PORT` in the root `.env` to something free
(5182, 5300, whatever), then `docker compose ... up -d --force-recreate frontend`.

## When things go sideways

If the shared DB ends up in a confusing state because someone ran
something they shouldn't have, ping the team. There's no scheduled
reset — recovery is a coordinated thing.

For anything outside dev-shared-DB work (real ldev/prod debugging,
schema migrations, infrastructure), get explicit approval before
touching shared infrastructure.
