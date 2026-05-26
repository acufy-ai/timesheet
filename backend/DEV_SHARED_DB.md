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

## Getting credentials

Connection strings and test account passwords live in the team secrets
store. Ask the project lead. Do not paste them into source files,
issues, or chat history — keep them in your local `backend/.env` only.

The shape of what you'll receive:

- A Postgres role (`ts_test_dev_user`) with `DATABASE_URL` and
  `CONTROL_DATABASE_URL` pointed at `ldb.acufy.ai:5432`.
- One platform-admin email/password and one tenant-admin email/password.
- The standard seed users (`admin@example.com`, `manager1@example.com`,
  `emp1-1@example.com`, etc.) all share the same well-known seed
  password (`password`) — those are fine to mention freely.

## Auth0 settings for local dev

Auth0 keys for ldev's tenant are valid against this DB too. Login
resolution order in the backend is: PA bcrypt → Auth0 → tenant bcrypt,
so the seeded bcrypt users keep working even with Auth0 wired. Get the
Auth0 secrets from the same secrets store entry.

## What's seeded

`ts_test_dev` holds the standard `python -m app.seed` dataset, plus
one extra tenant-admin row added separately:

- Tenant 1 "Default Tenant".
- 13 seed users from `app/seed.py` (admin, ceo, alexander, margaret,
  manager1-3, emp1-1 through emp4-1, plus `system_ingestion_1`).
- One additional tenant-ADMIN test user.
- Seed projects, clients, leave types, departments, time entries.

`ts_test_dev_control`:

- One platform-admin row.
- No tenants registered in the control plane (the seed uses the
  legacy shared-DB mode, so tenants live on the per-tenant DB side).

## When something looks wrong

The DB is not reset on a schedule. If the data drifts or someone
mutates it in a confusing way, ping the team — don't run resets on
your own.

## Never commit `.env`

Your `backend/.env` is gitignored. Don't ever check the DB password,
account passwords, Auth0 client secret, encryption key, or any other
credential into git. Even doc files in this repo must not contain
literal credential values — link out to the secrets store instead.
