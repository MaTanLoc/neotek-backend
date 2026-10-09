# Phase 1C.1 — Customer password recovery

Date: 2026-10-09. Scope: CustomerAccount forgot/reset password, existing outbox/dev transport, VI/EN UI and full regression validation. ADMIN/EDITOR authentication implementation and Booking occupancy/workflow were not changed. No deployment, Google/Meet/SMS, Docker/DNS changes, commit or push.

## Files changed

Paths below are relative to their checkout. Earlier Phase 1B/1C and unrelated working-tree changes were preserved.

Backend:

- `prisma/schema.prisma` and `prisma/migrations/20261009100000_customer_password_recovery/migration.sql`: dedicated reset persistence, customer session generation and outbox relation/shape extension.
- `src/customer/customer-input.ts`: shared registration/recovery password and email policy.
- `src/customer/customer-password-recovery.service.ts`: issuance, cooldown/rotation, validation, atomic consumption/password update/session revocation.
- `src/customer/customer.service.ts`, `customer-session.service.ts`, `customer.controller.ts`, `customer.module.ts`: shared policy, generation-aware login/session resolution and two new HTTP endpoints.
- `src/notification/notification.service.ts`, `email-provider.ts`: reset outbox handling, separate token context and VI/EN reset template through existing provider abstraction.
- `src/booking/booking-environment.ts`, `.env.example`: bounded reset lifetime validation/documentation.
- `src/customer/customer-password-recovery.service.spec.ts`, `customer-session.service.spec.ts`, `customer-session.integration.spec.ts`, `src/notification/email-provider.spec.ts`, `src/booking/booking-http-postgres.integration.spec.ts`: recovery/security/Redis/PostgreSQL tests and controller fixture wiring.
- `scripts/check-booking-browser.cjs`: extended existing real-browser Booking regression with recovery checks; artifacts now go to the Phase 1C.1 directory.
- This report.

Frontend:

- `src/pages/auth/PasswordRecovery.jsx`: forgot/reset forms and accepted/success/invalid states using AuthLayout and existing auth classes.
- `src/customer/recoveryCopy.js`: VI/EN recovery copy.
- `src/pages/auth/CustomerAuthForm.jsx`: localized forgot-password link; existing register/login link ordering retained.
- `src/services/customer/customerApi.js`: two anonymous POST operations and customer CSRF cache clear after reset.
- `src/App.jsx`: four recovery routes and noindex metadata.
- `docs/BOOKING_PHASE1C1_PASSWORD_RECOVERY_REPORT.md`: pointer to this report.
- `docs/booking-phase1c1-browser/`: final Chrome results/screenshots.

## Schema and migration

Dedicated persistence was necessary: CustomerEmailVerification has different semantics and cannot safely stand in for password reset. The additive migration introduces:

1. `CustomerPasswordReset`: customer relation, unique SHA256 `tokenHash`, `expiresAt`, `usedAt`, `revokedAt`, `createdAt`, customer/date and expiry indexes, hash/lifetime check.
2. `CustomerAccount.authVersion`: non-negative integer, default zero. No changes to CMS User.
3. Nullable `NotificationDelivery.passwordResetId` with a restrictive foreign key. Existing outbox shape is extended transactionally to permit exactly one reset, verification or booking/event branch; previous attempt/locale/lease requirements remain enforced.

The SQL is enclosed in BEGIN/COMMIT. No table/data reset, `db push`, occupancy constraint change or Booking data rewrite is used. The original Phase 1B migration remains unchanged (SHA256 `D59F544599DE8EB95678FE35A73431E1BA1043F00163F4987D515A4DFE86A702`). Existing verification/booking rows have a null reset relation and retain valid shapes.

Exact recovery migration: [20261009100000_customer_password_recovery/migration.sql](../prisma/migrations/20261009100000_customer_password_recovery/migration.sql), SHA256 `67A0ED6E2B0730732953CECF2D5C3ABCF3860D916D3265D5245C318B74104F74`.

Prisma format, validate and generate passed. The additive migration was applied to the existing development database with `prisma migrate deploy`; status reports all four migrations applied. Before/after counts for User, Page, PageSection, CustomerAccount, Booking, BookingReservation and NotificationDelivery were identical. No existing rows were removed.

## API

| Method | Route | Public result |
| --- | --- | --- |
| POST | `/api/customer-auth/forgot-password` | 202 `{ "accepted": true }` for known, unknown, inactive and cooldown cases |
| POST | `/api/customer-auth/reset-password` | 200 `{ "reset": true }` after successful consumption |

Forgot body: `{ email, locale: "vi" | "en" }`. Reset body: `{ token, password, confirmPassword }`. Schemas are strict; unexpected fields are rejected. Both routes use existing exact Origin validation. They do not accept ADMIN credentials as customer identity or require a logged-in customer. Reset authorization is the one-use bearer token, rather than a session CSRF value; the routes still enforce Origin and rate limits.

Invalid, expired, used and revoked well-formed reset tokens share `INVALID_PASSWORD_RESET_TOKEN`. Malformed bodies and mismatched/weak passwords return safe validation errors. Existing global body limits and safe exception filtering apply. No automatic login is performed after reset.

## Token architecture

Issuance uses 32 cryptographically random bytes encoded as base64url. Only SHA256 is persisted in CustomerPasswordReset. The durable delivery secret uses existing AES-256-GCM encryption with separate authenticated context `password-reset:<id>`. Verification state and tokens are independent.

Default expiry is 45 minutes, configurable with backend `CUSTOMER_PASSWORD_RESET_MINUTES` from 30 through 60; invalid configuration fails startup. Database time is authoritative. A customer row lock serializes forgot/reset operations. Requests within 60 seconds return the same accepted response without creating another token/intent. A later accepted issuance revokes older active tokens and pending/processing reset deliveries.

Reset rechecks token/account status after taking the same customer lock, validates expiry, hashes the new password with Argon2id and atomically updates password/authVersion, consumes the token, revokes other reset tokens and clears pending reset delivery secrets. Two simultaneous resets have exactly one winner. Raw tokens/passwords are never logged. Loading a link does not consume it.

## Email and outbox

`CUSTOMER_PASSWORD_RESET` uses NotificationDelivery → NotificationService dispatcher → existing EmailProvider. Customer recovery code does not call Resend directly. Links use `/reset-password#token=...` and `/en/reset-password#token=...`; tokens stay out of HTTP URLs/referrers. Successful reset removes the fragment from browser history.

The worker recognizes reset-token revocation/use/expiry independently of email verification and discards stale deliveries. Provider failures retain the reset/account transaction and are retried using existing bounded attempts, lease recovery and redacted error codes. Successful delivery clears the encrypted secret. A provider already sending a rotated email may finish; that link is still unusable because token validation is authoritative.

Existing explicit dev transport is reused for real local email-file delivery. Production credential work is deferred; no real external email was sent. The existing backend-only encryption key must remain stable while either verification or reset deliveries are pending.

## Session revocation

Every customer session records the account's authVersion. Every guarded request resolves current account state from PostgreSQL and rejects a mismatched generation. Reset increments authVersion in the same transaction as password replacement: all prior customer Redis sessions become unusable immediately, without enumerating/scanning Redis keys or depending on Redis deletion succeeding.

Old inert session/CSRF entries expire on their original TTL; revocation means authorization is denied, rather than claiming all physical Redis keys were deleted. Existing pre-migration sessions without a version are generation zero and become invalid on the first reset. Login passes the authenticated generation into session issuance so a stale password check racing reset cannot mint a valid new session. Fresh login with the new password creates a valid session. ADMIN/EDITOR namespaces, cookies and sessions are unaffected. `emailVerifiedAt` is never changed by recovery.

## Frontend

Routes: `/forgot-password`, `/reset-password`, `/en/forgot-password`, `/en/reset-password`.

Login exposes “Quên mật khẩu?” / “Forgot password?”. Forgot shows an email field followed by the same generic success copy for known/unknown accounts. Reset provides new/confirm password fields, mismatch validation, safe invalid/expired/reused link state and a request-new-link action. Success explains that old sessions ended and provides a login link. Server policy remains authoritative: both registration and reset require 12–256 characters. No unrelated auth layout redesign or new CSS system/dependency was introduced.

## Security controls

- Exact Origin, strict DTOs, existing body limits, safe errors and no credential/token logging.
- Forgot: 10 requests/IP/hour and five/email/hour; hashed identifiers, same response/state for unknown and cooldown cases.
- Reset: 20 attempts/IP/hour and five/token/15 minutes; identifiers are hashed.
- Redis rate-limit failure fails closed. External email failure cannot expose account existence through the forgot response because delivery occurs asynchronously.
- Database row locks, unique token hashes, atomic consumption, cooldown and rotation limit concurrent/retried issuance.
- Recovery only updates CustomerAccount password/authVersion; CMS User and email-verification fields remain untouched.

## Tests and results

- Full backend Jest with real Redis enabled: **184 passed**, 36 PostgreSQL cases gated by the standard opt-in; 33 passing suites, two PostgreSQL suites gated. Six additional unit/security/template cases extend the previous 178-case run.
- Real Redis customer integration passed with multiple old sessions rejected after generation change, stale issuance denied, fresh generation accepted and original absolute TTL/CSRF isolation preserved. Existing ADMIN Redis integration also passed.
- PostgreSQL: **36/36 passed across both suites** on the final migration. Five additional HTTP recovery cases cover generic known/unknown/cooldown responses, concurrent issuance/reset, token lifecycle, old/new login, multi-session revocation, ADMIN/EDITOR survival, verified/unverified accounts, delivery recovery, strict input/Origin/body/rates. Existing 31 Booking/domain/HTTP cases are retained. Combined backend total: **220/220 passed**, with gated PostgreSQL cases executed separately rather than left skipped.
- Backend lint and Nest build passed; frontend lint and production build passed (8,660 modules). Production source-map count: **zero `.map` files**. Final Chrome result: **108 checks passed, zero unhandled exceptions**.
- Production-entry smoke passed on an empty disposable outbox with production configuration and process-local fake provider credentials, without provider traffic.

The PostgreSQL runner creates a separate native PostgreSQL 18 loopback cluster, applies all four migrations, verifies a second deploy is a no-op, and removes only its owned cluster. An initial database run exposed the missing reset branch in the pre-existing outbox shape; the new migration was corrected before application to the existing development database.

## Browser and regression

The extended Chrome/CDP harness uses the production frontend bundle, real Nest, disposable PostgreSQL, namespaced real Redis and the actual dev notification worker. It reruns the 80 Phase 1C checks, then exercises recovery in both locales: generic responses, real reset email, mismatch, successful reset, old/new login, previous session rejection, CMS session preservation, used/expired/invalid links and fragment removal.

Forgot, reset and invalid-reset layouts are checked at 1440/1024/820/390 for VI and EN, with screenshots. Representative screenshots are visually reviewed by the assistant; this is separate from automated interaction/overflow assertions. Evidence: [Phase 1C.1 Chrome results](../../Neotek%20Frontend/docs/booking-phase1c1-browser/results.json).

The final run passed all 80 existing checks plus 28 recovery flow/layout checks. Visual review covered the VI mobile reset form, EN mobile forgot form and EN desktop success state. Testing also found and fixed same-page fragment navigation retaining an earlier token's UI state; the form now remounts when its token fragment changes, and the final expired/invalid/used-token cases passed on the rebuilt bundle.

Full Jest and existing PostgreSQL/browser coverage retain Booking concurrency/replacement/idempotency, registration/login/verification, ADMIN/EDITOR roles, CMS/publication, CSRF, Origin, rate limits, Cloudinary signing restrictions, sanitization and notification retry checks. No Google integration or Booking reschedule/cancel feature was added.

## Remaining production dependencies

Configure the existing real email provider credentials and verified sender before production use; dev delivery does not prove external inbox receipt. Apply the new additive migration in the target deployment process before starting this version, retain the encryption key, and configure the correct FRONTEND_URL. No production deployment was performed.

Final feature-completion status: **Phase 1C.1 complete; Phase 1 Booking V1 is feature-complete for the agreed scope.** External email credentials/inbox delivery remain the explicitly deferred production dependency.
