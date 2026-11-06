---
name: Contact verification trust
description: Rules for app-scoped email and phone OTP attestations in the shared identity service.
---

Contact verification is app-scoped, not global. Only the app whose authenticated backend recorded the OTP attestation may treat that exact normalized email or phone as verified. Changing a contact invalidates prior attestations; a matching string alone is not verification.

**Why:** The centralized identity service serves multiple apps with separate OTP flows. A global verified flag could transfer one app's proof to another or revive proof for a stale contact.

**How to apply:** Derive the verifier app from the authenticated API key, store the exact normalized value and verification method, return status only to that app, and invalidate it when the current contact changes.

For server-only attestation endpoints, reject browser `Origin` and `Referer` headers and keep the API key on the application backend. Do not reject `Sec-Fetch-*` headers alone: server-side fetch clients may send them too.

**Why:** A Node server-side `fetch` request included `Sec-Fetch-Mode`, so treating that header alone as proof of a browser request rejected valid backend calls.

**How to apply:** Use the API key as the trust boundary and browser-origin headers as defense in depth; never expose the application key to frontend code.

## Reassociation proof

An app-scoped contact attestation alone does not authorize replacing that app's user association. Reassociation proof must bind a fresh OTP to the exact identity, current contact, purpose, and intended new app-user ID; consume it once and update the existing app-specific link atomically with an expected-old-ID check.

**Why:** Without binding proof to the intended account, a valid OTP for one Social account could be replayed to attach a different account to the same central identity.

**How to apply:** For returning-user reassociation, require a short-lived single-use proof and idempotent audit record. Update only the caller app's link; preserve other app links and identity fields.

## Development schema push caution

If Drizzle push offers to rename the legacy `session` table to `admin_audit_log`, do not accept that rename as part of an unrelated feature migration. Review the diff and apply only the intended additive development schema change until the mismatch is understood.

**Why:** The existing session table is unrelated application state, and accepting a misleading rename could disrupt sessions or apply unrelated schema changes.

**How to apply:** Compare the development database inventory with the intended schema change before running a broad push; stop when the tool proposes unrelated renames or drops.
