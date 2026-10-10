# Booking Phase 2C — Google Calendar + Google Meet

Date: 2026-10-10 (Asia/Saigon). Scope stops at Phase 2C. No commit or push.

## Result

An ADMIN can connect one company Google organizer, generate a Meet URL on an existing future PENDING booking, review it, and confirm through the existing status action. Google generation never confirms the booking. Manual Google Meet input remains available, including when the integration is disabled, disconnected or failing. Customer Google sign-in, booking transitions, notification contracts and customer UI are preserved.

## Files changed in this phase

Backend:

- `.env.example`, `src/main.ts`: separate organizer configuration and startup validation.
- `prisma/schema.prisma`, `prisma/migrations/20261010120000_google_calendar_organizer/migration.sql`: additive external event ID and encrypted singleton credential.
- `src/booking/google-calendar.config.ts`: strict enabled configuration and dedicated OAuth client enforcement.
- `src/booking/google-calendar.client.ts`: bounded Google token, identity and Calendar transport boundary.
- `src/booking/google-calendar.service.ts`: OAuth state, credentials, generation and best-effort cleanup.
- `src/booking/google-calendar.controller.ts`: protected connection/status routes and backend callback.
- `src/booking/booking.module.ts`, `admin-booking.controller.ts`, `booking.service.ts`: wiring, Meet action and cancellation hook after commit.
- `src/cache/cache.service.ts`: atomic Redis GETDEL for one-use OAuth state.
- `src/booking/google-calendar.spec.ts`, `google-calendar-redis.integration.spec.ts`: OAuth, configuration, transport, retry and real Redis tests.
- `src/booking/booking-postgres.integration.spec.ts`, `booking-http-postgres.integration.spec.ts`: focused Phase 2C database/concurrency/security coverage.
- `scripts/check-booking-browser.cjs`: provider mock at the Google client boundary, isolated organizer fixture and generated-Meet workflow checks.
- This report.

Frontend (separate checkout):

- `src/admin/pages/GoogleCalendarConnection.jsx`: compact ADMIN-only connection status and connect/reconnect action.
- `src/admin/pages/BookingsManager.jsx`: create Meet button, saved link/open action, existing manual input and explicit confirmation.
- `src/admin/pages/bookings-manager.css`: compact connection row scoped to Booking Admin using existing tokens.
- `src/services/admin/adminApi.js`: connection/status/generation API methods.
- `docs/booking-phase2c-browser/`: browser evidence produced by the existing smoke harness.

Both repositories already contained uncommitted Phase 2B1/V1.1 work. The list above describes this phase's additions, not the entire current git diff. No unrelated formatting/refactor was performed.

## OAuth architecture and routes

Use a second OAuth **Web application** client named `NeoTek Calendar Organizer`. Customer sign-in continues using its existing identity-only client. Config validation rejects reuse of `GOOGLE_CUSTOMER_CLIENT_ID` as the organizer client ID.

| Route | Behavior |
| --- | --- |
| `GET /api/admin/integrations/google/calendar` | ADMIN connection metadata only: enabled, connected, organizer email |
| `GET /api/admin/integrations/google/calendar/connect` | ADMIN + session + rate limit + exact Origin + CSRF; returns Google authorization URL |
| `POST /api/admin/integrations/google/calendar/connect` | Same protections; used by browser UI because browsers reliably supply Origin on POST |
| `GET /api/integrations/google/calendar/callback` | ADMIN/session + one-use state bound to the initiating session; server-side code exchange |
| `POST /api/admin/bookings/:id/google-meet` | ADMIN/session + rate limit + exact Origin + CSRF |

The callback URI is taken exclusively from validated backend config, never reconstructed from request headers. The callback redirects to the configured frontend `/admin/bookings` after success, with no tokens or provider data in the redirect. Callback responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

OAuth uses `access_type=offline`, `prompt=consent`, PKCE S256, cryptographically random state, and a ten-minute Redis TTL. The Redis key hashes both state and session cookie. Atomic GETDEL prevents duplicate callback exchange. Incorrect sessions cannot consume another session's state. The callback is a cross-site navigation, so it uses session + OAuth state in place of the mutation Origin/CSRF headers; existing guards remain unchanged everywhere else.

Calendar scope: `https://www.googleapis.com/auth/calendar.events`. Also requests `openid email` solely to read Google's verified account email and pin the organizer to `GOOGLE_CALENDAR_ORGANIZER_EMAIL`; no profile or full Calendar scope is requested. A different or unverified organizer is rejected. Reconnect cannot silently replace an existing organizer with a different account.

## Credential storage

`OrganizerCredential` is a singleton (`google-calendar-organizer`) containing email, OAuth client ID, encrypted refresh token and updated timestamp. It is never returned by Admin/public API serializers. Access tokens are short-lived local variables and never persisted or returned.

Refresh tokens use the existing `VerificationSecret` AES-256-GCM implementation with a dedicated `GOOGLE_CALENDAR_ENCRYPTION_KEY` and authenticated-data binding to the singleton ID. The key remains backend-only and outside the database. Database credentials and this key must be backed up/access-controlled separately. Losing or changing the key requires reconnecting. The small `refreshToken()`/callback storage boundary can later read/write a secret manager without changing booking contracts.

## Data and Meet flow

The migration adds nullable `Booking.externalCalendarEventId` and `OrganizerCredential`; existing `meetingUrl`, statuses and historical event records are retained. The migration was replayed twice on disposable PostgreSQL and applied using `prisma migrate deploy` on the configured local database. No reset or db push was used.

Generation checks the active ADMIN user again inside the database transaction, loads the booking and requires future PENDING state. It reserves a deterministic lowercase hexadecimal Google event ID from the booking ID **before** making any provider call. A second transaction locks the booking row to serialize generation with duplicate requests and status transitions.

The provider first GETs that ID. On 404 it inserts an event with the same ID, `conferenceDataVersion=1` and a stable conference request ID using `hangoutsMeet`. On 409 it reads the same event. It validates the returned event ID, organizer, active state and Google Meet URL before saving the link. Conference provisioning can be asynchronous: one immediate additional GET is allowed; if still unavailable, the UI reports failure and a subsequent click reads the same event.

Event content:

- Title: `NeoTek Consultation - {solution}`.
- Start/end: the reservation's requested timestamps and timezone.
- Description: NeoTek booking ID only.
- No internal notes, customer messages, phone/company details or attendee list. Customer invitations are intentionally omitted in this phase so existing NeoTek confirmation email remains the communication flow. `sendUpdates=none` avoids Calendar invitation mail before Sales confirms.

The persisted event ID survives network timeout, backend crash or a database rollback after Google accepts an insert. Concurrent clicks create one provider event; an existing manual/generated meeting URL is reused without creating another event. An ID reserved during a failed attempt is retained for recovery. Generation does not change booking status/version or enqueue confirmation email. The existing explicit confirmation accepts the generated URL and maintains audit/notification behavior. The UI refreshes the detail form with the saved URL.

Provider calls use a four-second abort deadline per HTTP request with no automatic retries. The generation transaction has a 25-second timeout, covering bounded token/GET/insert/recovery calls. The frontend may report a timeout before the backend finishes; retry safely recovers by the persisted ID. No background workers, sync, webhooks or multi-organizer framework were added.

## Cancellation and completion

Cancellation commits booking state and existing audit/notification work first, then attempts Google event deletion. Provider errors produce a fixed operational warning without raw error bodies/tokens; the booking stays CANCELLED. Missing/already-deleted events (404/410) are treated as cleaned up. This also attempts cleanup for a reserved ID after an ambiguous generation failure. There is no background retry: an event accepted remotely after the cleanup attempt may require an operator to remove it manually.

COMPLETED performs no Calendar request or deletion. Event ID, meeting URL and BookingEvent history remain.

## Automated validation

- Prisma validate: PASS.
- Prisma generate: PASS after retrying an initial Windows DLL lock error.
- Migration replay and repeat deploy on disposable PostgreSQL: PASS.
- Local migration deploy/status: PASS; all seven migrations applied/current.
- Backend ESLint (without broad `--fix`): PASS after targeted fixes.
- Backend production build: PASS.
- Full Jest: 34 suites / 219 tests PASS, four opt-in suites skipped in that invocation. An additional timeout-recovery test was subsequently added and the focused Calendar suite rerun (see final validation update below).
- Real PostgreSQL/HTTP integration: two suites / 51 tests PASS, including Phase 2C concurrent creation, persisted ID after errors, generated-URL confirmation, manual fallback, cancellation durability, role/realm/Origin/CSRF/callback-state checks.
- Real Redis: three suites / three tests PASS (Admin/customer sessions and atomic Calendar state consumption).
- Production smoke: PASS, including readiness, guards, exact Origin and redacted startup; no provider traffic.
- Frontend `eslint src`: PASS.
- Frontend production build: PASS with `VITE_API_BASE_URL=/api`; the existing local localhost API setting is correctly rejected by production config validation. Vite build needed the permitted execution context because sandbox directory traversal was denied.
- Browser smoke: initial run PASS (301 checks, zero unhandled exceptions); rerun after compact connection styling and added OAuth navigation/callback coverage is recorded below.
- `git diff --check`: PASS at review; final check recorded below.

Google is mocked only at the provider boundary in database/browser tests. Transport tests mock fetch. Automated checks never require live Google tokens or calls. An initial combined test run found a duplicate singleton organizer **fixture** when the browser followed database tests; fixture setup was changed to upsert and browser checks rerun independently.

## Manual live test — NOT RUN

The current backend `.env` has none of the organizer integration enable/client/secret/email/key settings. No organizer consent/session or production credentials were available, so no live Google event, Meet URL or remote deletion is claimed. Automated provider mocks do not establish live Google compatibility.

After configuring the prerequisites, perform this separate manual test without printing OAuth tokens:

1. Log in as ADMIN and connect the company-controlled organizer account from Booking management.
2. Choose/create a future PENDING booking.
3. Click **Tạo Google Meet** and verify the event exists in that organizer's primary Calendar, with correct timestamps/timezone.
4. Verify the Meet URL and event ID are persisted in NeoTek; booking is still PENDING.
5. Click again/retry if provisioning is pending and verify there is still only one event.
6. Review and explicitly confirm the booking; verify existing email behavior uses the stored URL.
7. Open customer My Bookings and verify the Join Meeting link appears only as part of the confirmed workflow, in VI and EN.
8. Cancel a separate generated test booking and verify Calendar cleanup. Simulate a provider failure and verify cancellation remains durable.
9. Mark a finished confirmed booking COMPLETED and verify the Calendar event and history remain.

## Production prerequisites

- Enable Google Calendar API in the dedicated OAuth client's Google Cloud project.
- Configure OAuth consent, company organizer as an allowed test user while applicable, and production publishing/verification according to Google's current requirements. External apps in Testing can have expiring refresh tokens; do not treat a development connection as production readiness.
- Register the exact backend callback URL. Production requires HTTPS; local default is `http://localhost:3000/api/integrations/google/calendar/callback`.
- Configure `GOOGLE_CALENDAR_ENABLED=true`, `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URI`, `GOOGLE_CALENDAR_ORGANIZER_EMAIL`, `GOOGLE_CALENDAR_ENCRYPTION_KEY`, and existing exact `FRONTEND_URL`. No `VITE_*` secret.
- Use a company-controlled account with Calendar and Google Meet conference capability. The configured email must be the organizer's primary verified Google email.
- Deploy the additive migration, keep encryption key durable in backend secret environment/secret manager, then connect from ADMIN UI.
- Allow outbound HTTPS to Google's OAuth, userinfo and Calendar endpoints; keep callback reachable with the existing Lax Admin session cookie.
- Configure edge/access logging to redact OAuth callback query strings (authorization codes and state). Application code never logs them.
- Complete the live checklist above before enabling production use. Existing Resend production sender/domain verification remains deferred and unchanged.

## References

- [Google server-side OAuth, offline access, state and refresh tokens](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Calendar event creation and client-provided event IDs](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [Calendar events.insert and conferenceDataVersion](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

## Final validation update

- Focused Calendar suite: PASS, eight tests, including timeout after accepted Google insertion and recovery without another insert.
- Backend production build after the final provider-boundary sanitization change: PASS.
- Full backend lint and frontend source lint: PASS.
- Both repository diff checks: PASS.
- Final browser run: PASS, 302 checks and zero unhandled JavaScript exceptions. Includes organizer reconnect through the actual backend callback with real Admin session/CSRF/Origin and real Redis state, generated-Meet provider failure/retry, separate confirmation, VI/EN customer links, and responsive Admin/public regression at 1440/1280/1024/820/390 pixels. Google authorization and code exchange are intercepted/mocked; no live account is used.
- Browser evidence: `../Neotek Frontend/docs/booking-phase2c-browser/results.json` and screenshots. The compact connection row was visually reviewed after the final styling change.
- Live Google test remains NOT RUN pending the organizer configuration and consent described above.
