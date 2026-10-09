# Booking V1 — Phase 1C delivery report

Date: 2026-10-09. Scope: customer identity HTTP layer, Booking V1 APIs/UI, ADMIN workflow, asynchronous email and regression validation. No deployment, commit/push, Docker/DNS changes, Google integration or SMS.

The Phase 1B schema and occupancy model were retained. `prisma/schema.prisma` SHA256 at entry and completion: `DEC8301105FA81E41D8DD7459E144F356AEB5603838A381A884B4CAA7DE39399`. Existing migration/schema and unrelated CMS URL changes were already in the working tree; they are not new Phase 1C schema changes.

## 1. Files changed

Backend, relative to `Neotek Backend`:

- `src/customer/customer.controller.ts`, `customer.guards.ts`, `customer-session.service.ts`, `customer.module.ts`: separate HTTP authentication realm, Redis sessions and mutation protection.
- `src/customer/customer.service.ts`: retained Phase 1B account/verification domain with stricter name validation.
- `src/booking/booking.controller.ts`, `admin-booking.controller.ts`, `booking.module.ts`, `booking.service.ts`, `booking-domain.ts`: HTTP adapters, safe projections, own-booking pagination/filtering, ADMIN queries/notes and contact validation. Existing transactional occupancy protocol retained.
- `src/booking/booking-environment.ts`: fail-closed startup configuration validation.
- `src/notification/email-provider.ts`, `notification.worker.ts`, `notification.module.ts`, `notification.service.ts`: configured provider, delivery templates and worker; existing durable dispatcher retained.
- `src/app.module.ts`, `src/main.ts`, `.env.example`, `.gitignore`: application wiring, configuration documentation and ignored private local mail directory.
- `src/customer/customer-session.service.spec.ts`, `customer-session.integration.spec.ts`, `src/booking/booking-environment.spec.ts`, `booking-domain.spec.ts`, `booking-http-postgres.integration.spec.ts`, `booking-postgres.integration.spec.ts`, `src/notification/email-provider.spec.ts`, `src/app.module.spec.ts`, `src/auth/admin-session.integration.spec.ts`: new coverage and fixture corrections without weakening production guards.
- `scripts/test-booking-postgres.ps1`, `check-booking-browser.cjs`, `check-booking-production.cjs`: isolated database, real Chrome and production-entry validation.
- This report.

Frontend, relative to `Neotek Frontend`:

- `src/services/http.js`, `services/customer/customerApi.js`, `services/admin/adminApi.js`: shared credentialed HTTP transport with bounded requests; separate customer/CMS API facades.
- `src/customer/CustomerProvider.jsx`, `context.js`, `customerCopy.js`: customer session restore, safe redirects and VI/EN copy.
- `src/pages/auth/CustomerAuthForm.jsx`, `Login.jsx`, `Register.jsx`, `VerifyEmail.jsx`, `AuthLayout.jsx`, `neotek-auth.css`: real customer forms and verification UX.
- `src/pages/booking/BookingPage.jsx`, `BookingPage.css`, `BookingDialog.jsx`, `useBookingFlow.js`, `WeekCalendar.jsx`, `bookingUtils.js`: real policy/availability, intent preservation, hold/replacement/finalization UX and policy-aware calendar bounds.
- `src/pages/account/MyBookings.jsx`, `my-bookings.css`: own-booking views.
- `src/admin/pages/BookingsManager.jsx`, `src/admin/app/AdminApp.jsx`, `src/admin/styles/admin.css`: ADMIN booking workspace within the existing shell.
- `src/App.jsx`, `src/locales/vi.json`, `en.json`: routing/provider integration and removal of mock auth copy.
- Removed unused `src/pages/booking/bookingData.js` after checking references. Existing `src/config/features.js` booking enablement was retained.
- `docs/BOOKING_PHASE1C_REPORT.md`, `docs/booking-phase1c-browser/`: report pointer, browser results and screenshots. Earlier audit and unrelated pre-existing edits retained.

Private backend `.env` now has a generated verification encryption key, the existing active admin as notification recipient and explicit local `dev` mail transport. Existing values were preserved. Secrets and recipient values are deliberately excluded from this report and Git.

## 2. Routes and endpoints

Public/customer frontend routes have VI and `/en` equivalents:

| Route | Purpose |
| --- | --- |
| `/booking` | Anonymous calendar and authenticated reservation flow |
| `/login`, `/register` | Customer authentication |
| `/verify-email` | Verification token/pending/resend UX |
| `/account/bookings` | Own upcoming/past bookings |
| Existing `/admin` shell | ADMIN-only Booking panel |

API routes below use the existing `/api` prefix:

| Method | Endpoint | Access |
| --- | --- | --- |
| POST | `/customer-auth/register`, `/customer-auth/login` | Exact Origin; rate-limited |
| GET | `/customer-auth/me`, `/customer-auth/csrf` | Customer session |
| POST | `/customer-auth/logout`, `/customer-auth/resend-verification` | Customer session + Origin + customer CSRF |
| POST | `/customer-auth/verify-email` | One-use bearer token + exact Origin + rate limit |
| GET | `/booking/options`, `/booking/availability` | Anonymous; availability rate-limited |
| GET | `/booking/hold` | Own current hold |
| POST | `/booking/hold` | Verified customer; acquire or atomically replace |
| POST | `/booking/holds/:id/release` | Own hold; customer mutation guards |
| POST | `/booking/finalize` | Verified customer; customer mutation guards |
| GET | `/booking/mine`, `/booking/mine/:id` | Own bookings only |
| GET | `/admin/bookings`, `/admin/bookings/:id` | CMS ADMIN only |
| POST | `/admin/bookings/:id/status`, `/admin/bookings/:id/notes` | CMS ADMIN + existing CSRF/Origin/rate guards |

## 3. Customer session architecture

CustomerAccount remains separate from CMS User. A random 32-byte opaque token is placed in host-only `neotek_customer_session`, HttpOnly, SameSite=Lax, path `/`; Secure in production. Local loopback HTTP development is supported. Redis stores SHA256-derived keys under distinct customer session/CSRF namespaces. Sessions have an absolute eight-hour expiry; reads and refreshes do not extend it. Account status and verification are read from the database on resolution.

Customer guards never accept the admin cookie. CMS guards never accept the customer cookie. CSRF values are session-bound and atomically reused, rather than rotated by each GET. Logout removes only the current customer session and CSRF key. Redis failures fail closed with safe dependency errors.

## 4. Email verification

Registration atomically persists account, hashed verification token and notification intent, then returns generic accepted UX, including duplicate registration. Passwords use Argon2id. Login is allowed before verification; acquisition/finalization return stable `EMAIL_VERIFICATION_REQUIRED` until verified.

Raw tokens are not stored as reusable plaintext: the account token record holds a SHA256 hash and the delivery carries an authenticated encrypted secret. The backend-only 32-byte base64 encryption key must remain stable while deliveries are pending. Tokens expire and are consumed once; resend serializes cooldown/rotation and revokes earlier tokens/deliveries. Used, invalid and expired links have safe UI states.

Links carry `#token=...`, keeping the token out of HTTP request URLs/referrers. Verification requires an explicit POST from the page; loading a link alone does not consume it. Successful verification clears the fragment and refreshes the customer state. Delivery failure preserves the registered account.

## 5. Email provider and durable outbox

Domain transactions enqueue NotificationDelivery rows; provider work runs separately. The Nest lifecycle worker polls every two seconds, claims up to ten deliveries per tick using `FOR UPDATE SKIP LOCKED`, and supports stale-lease recovery. Dispatch has a ten-second deadline, at most five attempts, bounded backoff and redacted failure codes. ADMIN detail exposes delivery state/attempts without credentials or encrypted tokens.

Supported backend-only transports:

- `disabled`: development only; durable intents remain pending, never falsely marked sent.
- `dev`: explicit private `EMAIL_DEV_DIRECTORY`; writes deduplicated JSON mail files. Local configuration uses ignored `.local/mail`. These files contain private email content and verification links and must remain outside public/static directories.
- `resend`: real HTTPS provider adapter, eight-second request timeout, stable Idempotency-Key, plaintext localized templates. Production rejects disabled/dev or incomplete provider settings.

Events: verification, booking-created customer/admin, confirmed customer, cancelled customer. External delivery is at-least-once with provider idempotency protection; it is not an absolute exactly-once email guarantee. Domain booking/notification intent creation is idempotent.

Resend request format follows the [official send-email API](https://resend.com/docs/api-reference/emails/send-email). Adapter tests mock the external HTTP boundary; actual dev worker delivery was tested. No real external email was sent.

## 6. Booking API

Public availability returns only timezone, interval data and server time. No booking IDs, account/contact information, notes or admin identities are exposed. Options use published CMS solution/module data with VI/EN labels and the approved server resource.

The server enforces Asia/Ho_Chi_Minh, configured working days/hours, durations, lead time, horizon and buffers. Defaults: Monday–Friday 08:00–18:00, 30/45/60 minutes, 60-minute lead, 90-day horizon, zero buffers, ten-minute holds. Active holds and PENDING/CONFIRMED bookings block occupancy; expired holds are immediately ignored without depending on cleanup.

Strict input schemas reject client-controlled status, arbitrary email/resource/timezone/calendar IDs and internal fields. Finalization derives interval/resource from the owned hold and email from the verified account; name, company, phone, solution and optional message are validated.

## 7. Hold and replacement behavior

Only authenticated verified customers acquire holds. The same acquire endpoint performs replacement: customer lock, sorted resource locks, conflict checks and ledger changes remain in one transaction. Successful B replaces A; conflicting B rolls back and leaves A active. Maximum one active non-expired hold per customer remains enforced.

The countdown uses server-provided time/expiry and is display-only. Refresh restores the same expiry. Explicit close/Cancel/ESC attempts an immediate guarded release and reports failure; SPA navigation uses best effort, with database TTL as the fallback for tab/browser termination. Change-time keeps the prior hold until the replacement transaction succeeds. Expired holds offer reacquisition with a fresh request key.

## 8. Race-condition guarantees

The Phase 1B BookingReservation ledger, PostgreSQL exclusion/unique constraints, customer/resource lock ordering and database clock remain authoritative. Hold-to-booking converts occupancy within one transaction and persists Booking, BookingEvent and notification intents together. There is no release/acquire gap.

Stable client idempotency keys survive retryable failures. Same-key retries return the persisted result. Duplicate finalization, including a lost response after commit, does not create another booking or notification intent. Database constraints still protect bypass paths; no concurrency tests were replaced with mocks.

## 9. Public Booking flow

Existing Month/Week/Work-week calendar, visual structure, Radix dialog and drag interactions were reused. Anonymous viewing and local selection do not acquire a hold. Continue preserves only a validated slot/module intent in sessionStorage, then routes through login/registration/verification. Returning customers acquire again against current server availability.

Review shows account email read-only, required contact fields, module, requested time and countdown. Success explicitly reports a PENDING request, rather than implying admin confirmation. Availability polls and refreshes after mutations. Transport requests have a bounded timeout and UI retains retry keys on uncertain responses.

## 10. My Bookings

`/account/bookings` and `/en/account/bookings` restore the customer session and fetch server-filtered upcoming/past results with 25-row pagination. Cards show solution, date/time, duration, localized status and useful contact/company details. The meeting area tolerates null. Management is read-only; no customer cancel/reschedule workflow was added. Detail/list projections exclude notes, delivery secrets and other customers' bookings.

## 11. Admin Booking

The existing admin shell now includes ADMIN-only Booking navigation and overview entry. The panel supports search, status and date filters, pagination, contact/time/module detail, event history, internal notes and controlled status actions. Delivery state uses operator-facing labels. Backend ADMIN guards reject EDITOR and customer sessions regardless of UI visibility.

Existing CMS editors, auth provider and section-save contracts were preserved. Added CSS is scoped to admin/booking/auth classes, without admin-owned global body/html/root layout rules.

## 12. Status transitions

Allowed transitions only:

- PENDING → CONFIRMED or CANCELLED.
- CONFIRMED → COMPLETED, CANCELLED or NO_SHOW.

Transitions require the current version to reject stale concurrent actions and persist an audit event with the ADMIN actor. Cancellation requires a reason and frees occupancy. Confirmed/cancelled changes enqueue the corresponding customer email. Terminal states do not accept arbitrary patches.

## 13. Security controls

Separate cookies/Redis namespaces/principals, secure production cookie attributes, exact Origin, session CSRF, hashed rate-limit identities, strict Zod bodies, bounded lengths and safe errors are enforced. Registration/verification/login are rate-limited; authenticated mutations have a separate rate budget. Customer booking reads and hold operations enforce ownership, not just authentication. Safe-return routing is restricted to known local booking/account paths.

Public availability exposes no PII. Customer projections exclude internal metadata. ADMIN PII routes enforce ADMIN in the backend. Provider credentials and verification encryption keys remain server-only. No password console logging, fake auth success or mock booking completion remains in the implemented flow.

## 14. Test counts and results

- Full backend Jest run with real Redis enabled: **178 passed**, **31 PostgreSQL cases skipped by the default opt-in gate**, 32 passing suites, two PostgreSQL suites gated.
- Those PostgreSQL suites are run separately on a disposable real server; final results are recorded below. These are the same 31 cases, not 31 additional cases beyond the 209 total.
- Combined backend result: **209/209 passed** across the default/Redis run and separate PostgreSQL run; no remaining unexecuted PostgreSQL cases.
- Full backend and frontend lint passed. Backend Nest and frontend production builds passed.
- Expected failure-path log messages during Jest are intentional dependency/security tests, not unhandled application failures.

## 15. PostgreSQL integration

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-booking-postgres.ps1 -Browser -ProductionSmoke` from the backend checkout after both builds.

The runner creates a separate PostgreSQL 18 loopback cluster with an ephemeral port and an explicitly disposable database, replays all three migrations, verifies a second deploy is a no-op, then stops/removes only its owned cluster. It never resets the existing development database.

Coverage includes simultaneous hold winners, partial/nested overlap, PENDING/CONFIRMED conflicts, adjacent slots, buffers, expired reuse, replacement success/rollback, one-active-hold rule, release, finalization expiry, duplicate finalize, outbox rollback, notification retries, verification lifecycle, HTTP ownership/security and status audit. Final run result: **31/31 passed across two suites**.

Prisma validate/generate and existing development migration status passed; three migrations are applied. Schema SHA256 remained unchanged throughout Phase 1C. Existing Prisma package.json configuration emits a deprecation warning; migration to a future Prisma config is outside this phase.

## 16. Redis integration

Real Redis admin and customer session integration suites passed using `AUTH_REDIS_TEST_URL` set process-locally from existing configuration. They verify session lifecycle and atomic CSRF reuse. Test-owned keys are cleaned; existing sessions are not flushed.

The PostgreSQL HTTP suite uses a controlled in-memory Redis fixture and must not be described as real Redis coverage. The separate Chrome flow uses actual Redis with a random test namespace and cleans only that namespace.

## 17. Frontend lint/build

`npm.cmd run lint` and `npm.cmd run build` passed. Production build transformed 8,658 modules. Browser testing uses the production bundle with `/api` proxying; no credentials are built into Vite. Source-map output was checked separately: **zero `.map` files**. The shared HTTP extraction retained existing CMS API methods and existing AdminApiError behavior. A successful HTTP status with a truncated/invalid JSON body is treated as a failed response, preserving retry behavior rather than reporting false success.

## 18. Responsive/browser review

Evidence: [Chrome results](../../Neotek%20Frontend/docs/booking-phase1c-browser/results.json) and sibling PNG screenshots. The harness drives real headless Chrome through CDP against Nest, disposable PostgreSQL, real namespaced Redis and the actual dev notification worker.

VI and EN were checked at 1440, 1024, 820 and 390 pixels for Booking, login, registration, My Bookings and hold dialog, including overflow, keyboard focus and ESC release. End-to-end cases cover registration/verification/return, existing session/login, unverified resend/rotation, countdown/refresh, finalization, replacement success/conflict, release, expiry/reacquire, own bookings and ADMIN management. Real mouse drag checks local selection without hold acquisition. A lost-finalization-response case checks safe retry after commit.

Assistant visual inspection of representative desktop/mobile screenshots supplements automated DOM/interaction assertions. This is not a claim that a human manually repeated every flow at every width. Final browser result: **80 checks passed, zero unhandled exceptions**. The final `-BrowserOnly` run used the final production bundle after correcting truncated-JSON response handling and the initial countdown clock. It also asserted exactly two creation delivery intents after the lost-response finalization retry. Test-helper form filling and status waits were made atomic/specific to avoid reacting to a replaced DOM node or an option label before the status save completed.

## 19. Regressions checked

The complete available backend Jest suite includes CMS ADMIN/EDITOR auth/roles, Redis error handling, atomic CSRF, Origin, login/mutation limits, publication semantics, public CMS responses, Cloudinary signing restrictions and existing HTML/FAQ sanitization. New HTTP tests additionally enforce customer/CMS isolation and Booking PII ownership.

Chrome checks Home, Solutions and a real published Solution Detail in both locales at desktop/mobile, plus existing Admin CMS and Booking panels at four widths. CMS data is copied read-only into the disposable database for this check; production/customer data is not modified. Existing admin API contracts remain covered through actual browser CMS loading.

Production-entry smoke starts the compiled backend with production settings and an empty disposable outbox; checks readiness, unauthenticated CMS/customer guards, public options, exact Origin rejection and redacted startup. Fake provider credentials are process-local and never used to send mail because the outbox is empty. Final result: **passed**. An earlier attempt overlapped compilation and missed the readiness deadline; the successful run occurred after compilation, with a bounded 30-second startup allowance.

## 20. Remaining limitations and operations

- Real external Resend delivery/inbox receipt is unverified. Before production use, configure backend `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, verified `EMAIL_FROM`, optional `EMAIL_REPLY_TO`, correct `FRONTEND_URL`, `BOOKING_ADMIN_EMAIL` and a stable `CUSTOMER_VERIFICATION_ENCRYPTION_KEY`. Startup rejects incomplete or dev-only production transport.
- Local dev mail is available under backend `.local/mail`; it is a private transport artifact, not an external inbox. `disabled` intentionally cannot complete email verification without a configured transport.
- Browser crash/network loss can prevent immediate release; database TTL remains authoritative. Sending email is asynchronous and does not guarantee instant receipt.
- No Google meeting links are generated in V1. Meeting fields remain null-safe. No customer reschedule/cancel, password-reset UI, SMS or infrastructure work was added.
- No destructive migration, schema redesign, deployment, commit or push was performed. Existing working-tree changes were preserved.

## 21. Phase 2 readiness

Booking V1 exposes stable customer identity, verified contacts, time/resource occupancy, PENDING/CONFIRMED lifecycle, status audit and durable notification boundaries. Phase 2 can attach Google Calendar/Meet integration to those domain events using backend-only credentials, reconciliation and idempotency, without replacing the V1 hold ledger. That integration has deliberately not been implemented in Phase 1C.
