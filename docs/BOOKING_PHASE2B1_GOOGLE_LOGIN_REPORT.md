# Phase 2B.1 — Google Login for CustomerAccount

Date: 2026-10-09. Google Identity Services adds an identity method to the existing customer domain. Password authentication, customer Redis sessions and Booking authorization remain the foundation. No Calendar scope, organizer OAuth, Meet creation, SMS, deployment, Docker/DNS changes, commit or push.

## 1. Files changed

Backend paths are relative to `Neotek Backend`:

- `prisma/schema.prisma`, `prisma/migrations/20261009120000_customer_google_identity/migration.sql`: nullable customer password and Google identity relation/constraints.
- `src/customer/google-token-verifier.ts`: official Google verification and minimal claim validation; `customer-google.service.ts`: transactional account resolution/linking.
- `src/customer/customer.controller.ts`, `customer.module.ts`: credential endpoint and shared session issuance; `customer.service.ts`: explicit rejection of password login for passwordless accounts.
- `src/booking/booking-environment.ts`, `.env.example`: explicit customer Google configuration validation.
- `src/config/http-security.ts`: 12 KB parser at the Google endpoint and no-store for customer-auth responses.
- `package.json`, `package-lock.json`: official `google-auth-library`; no frontend SDK package added.
- `src/customer/google-token-verifier.spec.ts`, `customer-google.service.spec.ts`: cryptographic/request/retry boundaries.
- `src/booking/booking-http-postgres.integration.spec.ts`, `booking-postgres.integration.spec.ts`: real database linking/concurrency/session/recovery tests and nullable-type assertions.
- `scripts/check-booking-browser.cjs`: existing 108-check regression extended with deterministic Google coverage; this report.

Frontend paths are relative to `Neotek Frontend`:

- `src/customer/GoogleSignInButton.jsx`: shared official GIS renderer and script lifecycle.
- `src/config/features.js`: explicit feature/client-ID gate.
- `src/customer/CustomerProvider.jsx`, `src/services/customer/customerApi.js`: Google credential exchange, authoritative `/me` restoration and sign-out notification to GIS.
- `src/pages/auth/CustomerAuthForm.jsx`, `neotek-auth.css`: shared Login/Register integration, VI/EN messages and scoped layout.
- `.env.example`, `.gitignore`: configuration documentation and ignored local environment/screenshots.
- `docs/BOOKING_PHASE2B1_GOOGLE_LOGIN_REPORT.md`: report pointer; `docs/booking-phase2b1-browser/results.json`: browser evidence. Screenshots are local ignored artifacts.

The backend `.env` and frontend `.env.local` contain the user-supplied public web client ID and enabled dev flags. These files are ignored and are not deliverable secrets/configuration committed to Git.

## 2. Schema and migration

`CustomerAccount.passwordHash` becomes nullable. Existing values are untouched. Google-only accounts have SQL NULL, never random/dummy password hashes. The password login check requires a real hash while retaining the dummy verification cost for unknown/passwordless accounts.

`CustomerOAuthIdentity` stores only `id`, `provider`, `providerSubject`, `customerId`, and `createdAt`. Unique `(provider, providerSubject)` identifies the Google subject; unique `(customerId, provider)` prevents silently replacing one linked Google subject with another. SQL restricts the provider to GOOGLE, rejects empty subjects and uses a restrictive customer foreign key.

The additive migration was replayed twice on a fresh disposable PostgreSQL database. It was also applied to local dev `127.0.0.1:5433/neotek`; before/after counts and a customer-record digest matched. Local data retained: 1 CMS user, 4 pages, 0 customers, 0 bookings. All five migrations are now applied. No reset or db push was used.

## 3. Identity architecture

GIS popup → ID credential → `POST /api/customer-auth/google` → official token verification → find/link/create CustomerAccount → ordinary opaque NeoTek customer session. The stable identity is Google `sub`, never email. No Google access/refresh token, profile blob, picture, client secret or parallel session is stored.

## 4. Account-linking rules

- A previously linked subject signs into that same active customer, even if its Google email changed. NeoTek's canonical email, name and password are preserved. A changed provider email cannot verify a different canonical NeoTek address.
- An unlinked subject matching an existing active account can automatically link when Google is authoritative for the verified address: Gmail, or Workspace with a signed `hd` claim. Existing password/name/verified timestamp remain intact.
- A verified third-party email without `hd` cannot automatically take over an existing account. The result is a generic failure; use the established password method or email recovery. Explicit linking after additional account proof is deferred.
- A new email creates one verified, active customer with a nullable password and validated display name; invalid/missing names use `Google customer`.
- Inactive accounts and a competing Google subject for an already-linked account are rejected.

The stricter third-party linking rule follows Google's [ID token verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token): `email_verified` alone does not establish current ownership of a non-Gmail, non-Workspace mailbox. Customer identity rows provide durable linking evidence and timestamps; the existing BookingEvent audit is booking-specific and is not repurposed as a customer audit model.

## 5. Token validation

The backend uses `OAuth2Client.verifyIdToken` from the official library, including rotating Google signing keys, signature verification, Google issuer, configured audience and lifetime. Certificate transport has a 5-second timeout and no retries. Additional strict checks require a bounded nonempty subject, normalized valid email, literal boolean `email_verified: true`, exact audience, approved issuer and an expiry later than the current time (no expired-token clock-skew acceptance).

Names initialize new accounts only, are trimmed, limited to 120 characters and reject control characters. Credentials are bounded to 8,192 characters and JWT structure before Google/network work. Untrusted frontend email, subject, name, role, customer ID or arbitrary body fields are never accepted.

## 6. Session issuance

Password and Google login share `CustomerController.finishLogin`. The existing generation-aware session service checks active/authVersion, writes an opaque random customer token under the existing hashed Redis key and revokes any prior customer cookie session. Cookie name remains `neotek_customer_session`, HttpOnly, host-only, path `/`, SameSite=Lax, Secure in production, with the existing absolute eight-hour TTL.

`/customer-auth/me`, atomic session CSRF reuse, logout, generation revocation and Redis fail-closed behavior are reused. No Google claim is used as a cookie, Redis session value or authorization role. Google customer cookies cannot authorize CMS routes; CMS cookies cannot authorize customer routes.

## 7. Frontend GIS

Login and Register render the same `GoogleSignInButton`, using the official `https://accounts.google.com/gsi/client` script and `google.accounts.id.renderButton`. GIS initializes once per document; rendered button state dispatches the callback to its mounted form and cleanup removes stale handlers. Google renders the button; there is no invented Google logo/button implementation in production.

The standard popup button uses `continue_with`, VI/EN locale and bounded width. No One Tap prompt or auto-select is enabled. Closing the account popup does not start a NeoTek request or disable password authentication. Script failure/10-second load timeout shows localized fallback text. Missing/invalid frontend configuration omits the Google section. A request mutex prevents duplicate/password/Google submissions while busy.

Only `{ credential }` is sent to the backend. After the cookie exchange, CustomerProvider refreshes through `/me`; frontend-decoded claims never establish authentication. Google credentials are not placed in local/session storage, URLs or logs. Logout clears NeoTek state after successful backend logout, then calls GIS `disableAutoSelect` best effort; an SDK failure cannot prevent state clearing. Reference: [GIS JavaScript API](https://developers.google.com/identity/gsi/web/reference/js-reference).

## 8. Booking returnTo

The existing locale-specific allowlist allows only `/booking` and `/account/bookings` (and `/en` equivalents). Login/Register retain the safe query across navigation. Existing `neotek-booking-intent` storage and restore logic are reused unchanged. Authentication does not reserve occupancy; after verified session restoration, Booking reacquires the intended slot through the normal server hold policy, conflict checks and expiry rules.

## 9. Verification and password recovery

New Google accounts have `emailVerifiedAt` set from database time and do not enqueue verification email. Safely linking an unverified matching Gmail/Workspace account marks it verified in the same transaction, revokes unused verification tokens and revokes pending/processing verification deliveries while clearing encrypted secrets/leases. Existing verified timestamps and password reset state are preserved.

Google-only accounts can safely establish a password through the existing email-proof forgot/reset flow. Reset updates the real password hash, increments authVersion and invalidates earlier customer sessions; it preserves the Google identity and email verification. Existing password recovery and confirmation policies apply unchanged.

## 10. Configuration

Backend:

```dotenv
GOOGLE_CUSTOMER_LOGIN_ENABLED=true
GOOGLE_CUSTOMER_CLIENT_ID=<public-web-client-id>.apps.googleusercontent.com
```

Frontend:

```dotenv
VITE_FEATURE_GOOGLE_LOGIN=true
VITE_GOOGLE_CLIENT_ID=<same-public-web-client-id>.apps.googleusercontent.com
VITE_API_BASE_URL=http://localhost:3000/api
```

Both flags default off in examples and must be explicitly true. Enabled backend configuration with a missing/invalid client ID fails startup with a redacted message; disabled endpoint returns 503 for a valid-shaped request. Frontend flags are compiled by Vite, so restart dev/build after changing them. Restart the backend after changing its environment. Only the public web client ID belongs in Vite; there is no customer Google client secret.

The supplied development origin is `http://localhost:5173`. Use that exact origin for a live GIS check, with the same backend `FRONTEND_URL`; `127.0.0.1` or a different port requires its own authorized Google JavaScript origin. Browser tests use a private loopback origin and mock GIS, not Google credentials for an unauthorized origin. Production origin/client configuration and deployment are outside this phase.

At handoff, the local Vite server on 5173 exposes the configured enabled Google feature. The backend dev watch server was started on 3000; `/api/health/ready` returned 200 and unauthenticated `/api/customer-auth/me` returned 401. Both public client IDs and the exact localhost frontend origin were checked to match.

## 11. Security controls

Exact OriginGuard is mandatory on the anonymous Google POST. The GIS JavaScript callback sends a same-app JSON fetch; Google's automatic form-post double-submit cookie flow is not used. Existing authenticated mutations still require NeoTek session CSRF. Strict input, endpoint-specific 12 KB JSON parser, 10 attempts/IP/minute before verification, hashed Redis rate identifiers and no-store responses constrain the boundary. Redis rate/session errors fail closed. Certificate failures and invalid tokens return a generic authentication error without leaking library details or credentials.

No browser-controlled claims, admin grants, wildcard origins, Google scopes, provider tokens in persistence, logging of raw credentials, client secrets or changes to CMS authorization were introduced. An ID credential is a bearer credential until expiry; the endpoint does not add a nonce challenge or claim single-use semantics. The credential must remain transient and HTTPS is required outside explicit local development.

## 12. Concurrency

Transactions take PostgreSQL advisory locks by subject, then normalized email, followed by a customer row lock when matching an account. Provider and customer/provider uniqueness and the existing email unique constraint are database-enforced. A bounded retry (three transaction attempts) handles P2002 collisions with independent password registration. The retry rereads current identity/account state and never blindly overwrites credentials.

Real PostgreSQL tests exercise simultaneous new-account callbacks, simultaneous linking to an existing password account, competing subjects for one email and registration racing Google creation. Generation-aware session issuance protects password reset races using the existing expected authVersion contract.

## 13. Validation and results

| Validation | Result |
| --- | --- |
| Prisma validate / generate | Passed |
| Local migration status | All 5 migrations applied |
| Backend ESLint / Nest build | Passed |
| Full Jest with real Redis integration enabled | 199 passed; 45 PostgreSQL tests intentionally skipped here and run separately |
| Disposable PostgreSQL suites | 45 passed; migration replay twice passed |
| Production compiled entry smoke | Passed; readiness, customer/admin guards, public options, exact Origin, redacted startup and no provider traffic |
| Frontend ESLint / Vite production build | Passed |
| Frontend production source maps | 0 |
| Full Chrome browser regression | 136 passed, 0 unhandled exceptions; includes 108 existing checks and 28 Google checks |
| Git diff whitespace checks | Passed with Windows CRLF handling |

Tests use no live Google credentials or network dependency for token verification: local RSA keys test the actual official library signature verification; only its certificate-fetch boundary is mocked. Domain HTTP tests mock the verifier but use real disposable PostgreSQL. Browser tests mock the GIS script/callback and backend verifier only; account linking, real PostgreSQL, real Redis under a random namespace, cookie/CSRF and Booking remain real. Existing CMS publication/schema, media/Cloudinary signature/guard and password/verification/recovery regression suites pass. Live Cloudinary uploads and external email delivery were not exercised.

The browser harness retains the original 108 checks and adds 28: Login/Register in VI/EN at 1440/1024/820/390, GIS failure, missing compiled client ID, backend rejection, successful Register/Login callbacks, `/me`, My Bookings, logout, safe returnTo and preserved booking intent with server hold acquisition. Missing configuration is simulated only in test HTTP asset responses; no runtime product bypass was added. Mock GIS rendering validates host layout/callback behavior, not Google's live popup/iframe appearance.

Reproduction (PowerShell, backend checkout):

```powershell
npm.cmd exec prisma -- validate
npm.cmd exec prisma -- generate
npm.cmd exec prisma -- migrate status
npm.cmd exec eslint -- src
npm.cmd run build
# Set AUTH_REDIS_TEST_URL to the local test Redis without printing credentials.
npm.cmd test -- --runInBand
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-booking-postgres.ps1 -ProductionSmoke -Browser
```

Build the frontend first with `VITE_API_BASE_URL=/api` for the harness's intentional same-origin proxy and the enabled Google configuration in `.env.local`, then restore the dev API setting. Normal dev uses `http://localhost:3000/api`. Frontend lint is `npm.cmd run lint`; production build is `npm.cmd run build`. Screenshots/results are under `Neotek Frontend/docs/booking-phase2b1-browser`.

## 14. Live Google test status

Not performed. No real account selection or real Google ID credential was automated, and deterministic passes do not claim live OAuth consent/popup validation. The public client ID supplied by the user is configured in ignored dev environment files.

Small manual check, using only the configured Google test account:

1. Start/restart the backend and Vite dev server, then open `http://localhost:5173/login` (and `/en/login` for locale).
2. Click Continue with Google, confirm the Google prompt opens and select the authorized test account. Request no Calendar permission.
3. Confirm the Google POST succeeds, `/customer-auth/me` reports the customer realm, and one CustomerAccount/GOOGLE subject identity is created or safely linked with a verified email.
4. Confirm the HttpOnly NeoTek customer cookie exists, My Bookings opens, and a booking intent returns through ordinary hold acquisition.
5. Sign out and confirm `/customer-auth/me` returns 401. Check an existing password account still signs in normally.

If Google rejects the prompt, verify the client ID, exact authorized JavaScript origin, External/Testing test-user access and popup/privacy settings. Do not copy tokens or secrets into issue reports or automate account-creation loops.

## 15. Later phases

Calendar organizer OAuth, token storage/refresh, organizer consent, event reconciliation and Meet creation remain separate future work. Customer login requests no Calendar permission and grants no organizer capabilities. Explicit proof-based linking for existing third-party Google email addresses is also a future identity UX extension.
