# Threat Model

## Project Overview

BeFiter ID Service is a centralized identity platform for BeFiter members. It is a Node.js/TypeScript Express application with a React/Vite admin dashboard and PostgreSQL database accessed through Drizzle ORM. Production entry point is `server/index.ts`; routes are registered in `server/routes.ts`. It exposes API-key-protected app-to-app APIs for identity and lead synchronization, session-protected admin dashboard APIs, and a background outbound webhook worker.

Production assumptions: `NODE_ENV` is set to `production`; Replit deployment terminates TLS for client/server traffic; mockup and development-only tooling are not production surfaces.

## Assets

- **Member identity records** -- names, email addresses, phone history, demographic details, emergency contact data, health/medical fields, height/weight, app links, and audit history. Disclosure or tampering affects privacy, account matching, and downstream BeFiter products.
- **Lead records** -- lead contact details, brand/branch attribution, sales status, pricing fields, visits, and follow-up data.
- **API keys** -- partner application credentials stored as bcrypt hashes plus a short lookup prefix. A valid key allows partner APIs to read and modify identity and lead data.
- **Admin sessions and credentials** -- environment-defined admin username/password and PostgreSQL-backed session cookies that grant dashboard access.
- **Webhook payloads and signing secrets** -- outbound identity events sent to `befiter.com` and `befiter.store`, signed with HMAC secrets from environment variables.
- **Database connection and application secrets** -- `DATABASE_URL`, `SESSION_SECRET`, admin password, and webhook secrets.

## Trust Boundaries

- **Browser to admin API** -- admin React pages call `/admin/*` APIs using the session cookie. The browser is untrusted; every admin data or mutation route must enforce the server-side session.
- **Partner app to public API** -- connected BeFiter applications call `/api/*` using `x-api-key`. Each API key identifies one application via `req.appName`; the service must decide whether a key authorizes a specific identity, lead, and action.
- **Server to PostgreSQL** -- route handlers and storage methods cross into the database. Queries must remain parameterized and inputs validated before persistence.
- **Server to outbound webhook destinations** -- the worker posts identity events to environment-configured URLs using signing secrets. Webhook URLs/secrets are trusted configuration, while remote responses are untrusted.
- **Public/authenticated/admin boundaries** -- `/healthz` and static assets are public; `/api/*` requires valid API key; `/admin/*` data/mutation endpoints require an admin session; development Vite routes are not production.
- **Internal/production boundary** -- attached assets, mockups, Vite dev server behavior, and development defaults are out of production scope unless reachable with `NODE_ENV=production`.

## Scan Anchors

- Production entry points: `server/index.ts`, `server/routes.ts`, `server/static.ts`.
- Authentication and authorization: `server/auth.ts`, `server/admin-auth.ts`, `server/security.ts`, API-key uses in `server/routes.ts`.
- Data access and privacy: `server/storage.ts`, `shared/schema.ts`, serializers and search/lookup/update methods.
- Webhook delivery: `server/webhook-publisher.ts`, webhook event creation in `server/storage.ts`, admin webhook retry/list routes in `server/routes.ts`.
- Client admin API callers: `client/src/pages/*`, `client/src/components/identity/audit-log-table.tsx`, `client/src/hooks/use-admin-auth.ts`.
- Dev-only/ignore unless production reachable: `server/vite.ts`, Replit Vite plugins, attached_assets, node_modules, build scripts except for dependency/config review.

## Threat Categories

### Spoofing

Partner API access depends on possession of a valid `x-api-key`; admin access depends on the session cookie set after password login. API keys must be high entropy, stored only as hashes, compared securely, and revocable. Admin sessions must use a strong production `SESSION_SECRET`, secure HTTP-only cookies, and production must refuse default admin credentials.

### Tampering

Partner APIs can create, link, and update member identity and lead records; admin APIs can modify/delete identities and API keys. Inputs must be validated server-side and immutable fields must not be modifiable by less-privileged callers. The service must prevent one connected app from altering records it should not control unless that cross-app authority is an explicit product guarantee.

### Repudiation

Identity mutations should leave audit entries that identify the acting app or admin context and the changed fields. Sensitive admin actions such as API-key creation/deletion, identity deletion, webhook retries, and admin edits should be attributable enough for incident response.

### Information Disclosure

Identity and lead records contain substantial PII and health-related information. API responses, admin lists, webhook payloads, logs, and error messages must not disclose data to unauthenticated users or to partner apps that are not authorized for that record. Logs must redact PII and raw API keys.

### Denial of Service

Public API and admin login endpoints must be rate limited. Request bodies and search result sizes must be bounded. Outbound webhook delivery must use timeouts, retry limits, and atomic event claiming so a failing downstream service does not exhaust resources.

### Elevation of Privilege

Server-side checks must enforce API-key and admin boundaries for every route. Partner app identity should not be trusted from request body fields; it must come from the API key. Database access must use parameterized queries, and outbound fetch destinations must come from trusted environment configuration rather than user input.
