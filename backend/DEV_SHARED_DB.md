# Shared Dev Database

A pre-seeded Postgres on `ldb.acufy.ai` for local development. Lets you
clone the repo, point your local backend at this DB, and have a working
app without provisioning Postgres locally.

## When to use this

Use it for:
- Onboarding (you can `git clone` and be running in 5 minutes).
- Iterating on UI / API code against realistic seed data.
- Demos where you want consistent dummy users.

Don't use it for:
- Anything destructive. The DB is shared with other devs. Don't drop
  tables, don't truncate, don't run raw `DELETE` without filtering.
- Schema changes. If your branch adds an Alembic migration, run that
  migration against a **local** Postgres, not this one. Coordinate
  with the team before applying migrations here.
- Testing destructive flows (delete tenant, delete user). Spin up a
  local Postgres for that work.

## Connection details

Append these to your `backend/.env`:

```
DATABASE_URL=postgresql+asyncpg://ts_test_dev_user:TestDev%232026%21@ldb.acufy.ai:5432/ts_test_dev
CONTROL_DATABASE_URL=postgresql+asyncpg://ts_test_dev_user:TestDev%232026%21@ldb.acufy.ai:5432/ts_test_dev_control
```

Notes:
- The `#` in the password is URL-escaped as `%23`. The `!` as `%21`.
- The role is `ts_test_dev_user`. The plaintext password is `TestDev#2026!`.
- This DB lives on the same Postgres host as ldev. Performance is
  internet-round-trip-bound, not LAN-fast.

## Test accounts

| Email | Password | Role | Where |
|---|---|---|---|
| `acufydev@gmail.com` | `TestDev#2026!` | PLATFORM_ADMIN | `ts_test_dev_control.platform_admins` |
| `tenantuser7@gmail.com` | `Tenant@987` | ADMIN | `ts_test_dev.users` (tenant 1) |
| Seed users (`admin@example.com`, `manager1@example.com`, `emp1-1@example.com`, etc.) | `password` | various | `ts_test_dev.users` (tenant 1) |

The PA logs in via the native bcrypt path against
`platform_admins.hashed_password`. The tenant user logs in via the
native bcrypt path against `users.hashed_password`. Neither account is
bound to Auth0 today.

## Auth0 settings for local dev

Leave Auth0 disabled in your local `.env`:

```
AUTH0_ENABLED=false
AUTH0_MGMT_ENABLED=false
```

This makes the backend take the bcrypt path for every login, which is
what these accounts are seeded to use.

## What's seeded

`ts_test_dev` holds the standard `python -m app.seed` dataset, plus the
`tenantuser7@gmail.com` row added separately:

- Tenant 1 "Default Tenant".
- 13 seed users from `app/seed.py` (admin, ceo, alexander, margaret,
  manager1-3, emp1-1 through emp4-1, plus `system_ingestion_1`).
- `tenantuser7@gmail.com` (ADMIN, password `Tenant@987`).
- Seed projects, clients, leave types, departments, time entries.

`ts_test_dev_control`:

- `acufydev@gmail.com` (PLATFORM_ADMIN, password `TestDev#2026!`).
- No tenants registered in the control plane (the seed uses the
  legacy shared-DB mode, so tenants live on the per-tenant DB side).

## When something looks wrong

The DB is not reset on a schedule. If the data drifts or someone
mutates it in a confusing way, ping the team — don't run resets on
your own.

## Don't commit `.env`

Your `backend/.env` is gitignored. Don't ever check the DB password
into git. The string `TestDev#2026!` is fine to share verbally / over
Slack within the team but does not belong in a commit.
