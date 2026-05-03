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
| `befiter_ids` | Core identity records (29 columns) |
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
| GET | `/api/identity/lookup` | Email-first lookup, returns `matched_by: "email"\|"phone"`, increments dup-prevention counter |
| POST | `/api/identity/create` | Smart upsert by email: 201 if new, 200 if existing; updates phone if changed |
| PUT | `/api/identity/upsert` | Idempotent upsert: looks up by appUserId→email→phone→create; returns `matched_by` + identity; 201 on create, 200 on match |
| PUT | `/api/identity/:id` | Partial update (currentPhone/email immutable) + audit log |
| PATCH | `/api/identity/:id` | Partial patch with phone archiving + email uniqueness; 404 if not found, 409 if email taken |
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

## Phone Handling

- `current_phone` — the latest known phone number (unverified, can be recycled by operators)
- `previous_phones` — array of all prior phone numbers for this identity (append-only, read-only)
- Phone is NOT unique — two members can have the same phone (recycled SIM cards)
- On create: if email already exists and phone changed, old phone is archived to `previous_phones`
- All phone inputs (identity create/upsert/patch + lead create/patch) are normalised via `normalisePhone()` before persistence

## Backend Hardening v1.0 (Step 2)

- Helmet sets standard HTTP security headers on all responses.
- CORS is restricted via `ALLOWED_ORIGINS` env (comma-separated list); empty = allow all (dev).
- JSON body limit reduced from 10mb → 1mb (no embedded base64; only URLs).
- `/healthz` returns `{status:"ok",uptime}` for liveness checks.
- Rate limits split per route class (per minute, per API key, falls back to IP):
  - read endpoints (GET): 200/min — `readRateLimiter`
  - write endpoints (POST/PUT/PATCH): 60/min — `writeRateLimiter`
  - `/admin/login`: 10 per 15 min per IP — `adminLoginLimiter`
- Standardized error envelope: `{ error, code, details? }` via `apiError()` with stable `code`s
  (`VALIDATION_FAILED`, `UNAUTHORIZED`, `EMAIL_TAKEN`, `IDENTITY_NOT_FOUND`, `RATE_LIMIT_EXCEEDED`, ...).
- Request logger now redacts PII (`email`, `phone`, `fullName`, `dateOfBirth`, photos, medical fields,
  passwords, raw API keys) and only logs response bodies on errors (status >= 400). Lines truncated at 400 chars.
- Production config gate (`assertProductionConfig`): server refuses to start in `NODE_ENV=production`
  if `SESSION_SECRET` or `ADMIN_PASSWORD` are still defaults.
- Admin session cookie now sets `sameSite: lax` (CSRF defence).

## Data Contract Guarantees (v1.0)

- All identity-returning endpoints respond with the full `BefiterIdWithLinks` shape (identity fields + `appLinks` array)
- `height` and `weight` are serialized as JSON numbers (not strings) via `serializeIdentity()` helper in `storage.ts`
- `dateOfBirth` and `anniversary` validated as `YYYY-MM-DD` on patch
- `languagePreference` accepted on patch/upsert (BCP 47 code, defaults to `"en"`)
- `fitnessGoals` validated against `VALID_FITNESS_GOALS` enum: Weight Loss, Muscle Gain, Flexibility, Endurance, General Fitness, Rehabilitation, Sports Performance, Stress Relief
- `updatedAt` refreshed on every successful patch/update via storage layer

## Key Business Rules

1. **Email is the verified identifier** — email OTP is the login proof; always searched first in lookup
2. **Phone is unverified** — only used for pre-fill, searched second in lookup
3. **Lookup returns `matched_by`** — `"email"` or `"phone"` so caller knows confidence level
4. **Create is a smart upsert by email**:
   - Same email + same phone → 200, no changes
   - Same email + different phone → 200, archives old phone to `previous_phones`
   - Different email + any phone → 201, new identity (phone uniqueness not enforced)
5. **currentPhone + email immutable** via API PUT — phone only changes via create/upsert flow
6. **identityTag always "member"** — never changes
7. **app_name is free text** — no hardcoded list, open for future products
8. **Every field change logged** — one row per changed field in identity_updates
9. **Duplicate prevention counter** — persisted in DB stats table

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
