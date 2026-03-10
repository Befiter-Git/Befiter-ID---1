# BeFiter ID Service

Centralised identity platform for the BeFiter ecosystem. Single source of truth for every BeFiter Member (service taker) across all BeFiter products.

## Architecture

- **Backend**: Node.js + TypeScript + Express.js (port 5000)
- **Database**: PostgreSQL (Replit built-in) via Drizzle ORM
- **Frontend**: React + Vite (admin dashboard only)
- **Styling**: Tailwind CSS + shadcn/ui (dark sidebar, indigo primary)
- **Auth**: API key auth for app-to-app + session-based admin auth

## Core Concept

- **BeFiter Members** (gym members, active users) → stored in this service
- **BeFiter Partners** (staff, owners, professionals) → NOT stored here, managed per-app

## Database Tables

| Table | Purpose |
|-------|---------|
| `befiter_ids` | Core identity records (24 columns) |
| `app_links` | Which apps are linked to each identity |
| `api_keys` | Auth keys for connected apps (with keyPrefix for fast lookup) |
| `identity_updates` | Audit log — one row per changed field |
| `stats` | Persistent counters (duplicate_prevention_count) |

## API Key Authentication

- Keys stored as bcrypt hash + 10-char plain prefix
- Validation: filter by prefix first → single bcrypt compare (O(1) not O(n))
- Rate limit: 100 req/min per API key via express-rate-limit

## REST API Endpoints

All require `x-api-key` header:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/identity/lookup` | Phone-priority lookup, increments dup-prevention counter |
| POST | `/api/identity/create` | Create identity + app link (phone/email 409 on dupe) |
| PUT | `/api/identity/:id` | Partial update (phone/email immutable) + audit log |
| POST | `/api/identity/:id/link` | Link another app to existing identity |
| GET | `/api/identity/:id` | Fetch identity + all app links |

## Admin Dashboard Routes

All require session auth (ADMIN_USERNAME / ADMIN_PASSWORD env vars):

| Path | Page |
|------|------|
| `/admin/login` | Login page |
| `/admin/dashboard` | Stats: total IDs, this month, app breakdown chart, dup-prevention |
| `/admin/identities` | Search by name/phone/email, paginated table |
| `/admin/identity/:id` | Profile view (5 sections) + edit + audit history tab |
| `/admin/api-keys` | Generate keys, show raw key once, activate/deactivate |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `ADMIN_USERNAME` | Admin login username (default: "admin") |
| `ADMIN_PASSWORD` | Admin login password (default: "admin123") |
| `SESSION_SECRET` | Session cookie secret |

## Phone Normalisation

All phones stored in E.164 format using libphonenumber-js, default region India (+91):
- `9876543210` → `+919876543210`
- `09876543210` → `+919876543210`
- `+919876543210` → `+919876543210`

## Key Business Rules

1. **Lookup before create** — apps must call lookup first
2. **Phone is primary** — lookup checks phone first, email second
3. **Phone + email immutable** via API — admin can edit via dashboard
4. **identityTag always "member"** — never changes
5. **app_name is free text** — no hardcoded list, open for future products
6. **Every field change logged** — one row per changed field in identity_updates
7. **Duplicate prevention counter** — persisted in DB stats table

## File Structure

```
server/
  index.ts          — Express app entry
  db.ts             — DB connection
  routes.ts         — All routes (API + admin)
  storage.ts        — Database access layer
  auth.ts           — API key auth middleware
  admin-auth.ts     — Admin session middleware
  rate-limit.ts     — Rate limiter (per API key)
  phone-utils.ts    — normalisePhone() utility
shared/
  schema.ts         — Drizzle schema for all 5 tables
client/src/
  App.tsx           — Router
  pages/
    admin-login.tsx
    dashboard.tsx
    identities.tsx
    identity-profile.tsx
    api-keys.tsx
  components/
    layout/admin-layout.tsx, admin-nav.tsx
    stats/stat-card.tsx, app-breakdown-chart.tsx
    identity/audit-log-table.tsx
  hooks/use-admin-auth.ts
  lib/api.ts
```
