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
