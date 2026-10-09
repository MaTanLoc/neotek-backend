# Phase 1B — Booking database and customer identity foundation

Date: 2026-10-09, Asia/Saigon. Scope: backend foundation only. Approved product decisions in the Phase 1B request supersede the earlier audit's open questions.

**Migration safety gate: no migration has been applied to the existing CMS/persistent/shared database.** All migration execution described here uses a newly initialized disposable PostgreSQL cluster. Review this package before any persistent application. No frontend work, deployment, commit/push, Google/SMS integration, Docker, infrastructure or DNS change was performed.

## Exact review artifacts

- Final executable Prisma schema: [schema.prisma](../prisma/schema.prisma).
- Exact schema diff against the checkout's current HEAD baseline: [BOOKING_PHASE1B_SCHEMA.diff](BOOKING_PHASE1B_SCHEMA.diff).
- Exact migration, including extension, checks, exclusion, triggers and deterministic resource seed: [20261009000000_booking_foundation/migration.sql](../prisma/migrations/20261009000000_booking_foundation/migration.sql).
- Reproducible isolated PostgreSQL replay/test runner: [test-booking-postgres.ps1](../scripts/test-booking-postgres.ps1).

The SQL was generated with installed Prisma 6.19 `migrate diff` against the original schema, then augmented with reviewed PostgreSQL invariants and an explicit BEGIN/COMMIT. No `migrate dev` reset prompt, `db push` or persistent schema operation was used. Existing migration files are unchanged.

Final SHA-256 artifact fingerprints (file bytes at this checkpoint): schema `DEC8301105FA81E41D8DD7459E144F356AEB5603838A381A884B4CAA7DE39399`; migration `D59F544599DE8EB95678FE35A73431E1BA1043F00163F4987D515A4DFE86A702`. The recorded schema diff was compared to the current Git diff and matches exactly.

## 1. Final schema and CustomerAccount architecture

New enums: BookingStatus(PENDING, CONFIRMED, COMPLETED, CANCELLED, NO_SHOW), BookingHoldStatus(ACTIVE, CONVERTED, RELEASED, EXPIRED), ReservationState(HOLD, BOOKING, RELEASED), NotificationStatus(PENDING, PROCESSING, SENT, FAILED, REVOKED).

| New model | Responsibility |
| --- | --- |
| CustomerAccount | Normalized unique email, Argon2id password hash, name, active, trusted emailVerifiedAt, resend timestamp and audit timestamps |
| CustomerEmailVerification | Unique SHA-256 token hash, customer FK, expiry, used/revoked timestamps |
| BookingResource | Lightweight key/name/active capacity resource; one default NeoTek consultation resource |
| BookingReservation | Unified occupancy ledger: customer/resource, requested and buffered intervals, timezone, state, authoritative hold expiry/release timestamp |
| BookingHold | Customer-bound checkout intent, ledger relation, solution snapshot, lifecycle, idempotency/fingerprint |
| Booking | One submitted request per hold/reservation, verified-account contact snapshot, company/phone/name, required module snapshot, optional message, locale, status/version/timestamps, idempotency |
| BookingEvent | Ordered internal CREATED/STATUS_CHANGED/NOTE_ADDED history, optional operator actor and reason |
| BookingNote | Internal plain-text note and operator author; persistence foundation only |
| NotificationDelivery | Durable typed mail intents, target, deduplication, encrypted verification secret where needed, bounded retry/lease/result state |

UserRole remains ADMIN/EDITOR. User gains only inverse Prisma relations for BookingEvent and BookingNote; its persisted columns and existing auth behavior do not change. All CMS models/relations remain intact. New timestamps use explicit TIMESTAMPTZ(3). Booking's requested start/end/resource/timezone are normalized into its required BookingReservation relation; no conflicting duplicated time fields exist on Booking/Hold.

CustomerAccount is a distinct security realm with no role field and no CMS User creation/linking. Registration rejects extra keys, normalizes email, hashes even for duplicate requests, returns `{ accepted: true }` for both new/duplicate accounts, and does not create a session. Explicit authentication permits an unverified active customer to authenticate, returns a customer realm principal, uses dummy-hash verification for absent accounts and generic invalid credentials. It never calls the CMS AuthService. Same email in CMS and customer tables represents independent identities.

The foundation services are exported by dedicated Nest modules but deliberately **not imported into the running AppModule** and have no HTTP controllers. This allows review/migration gating without opening unguarded customer APIs or making the current CMS startup depend on the new tables/key. Customer HTTP cookies/Redis session issuance, logout and middleware integration belong to Phase 1C; this phase does not claim those endpoints are implemented.

## 2. Email verification architecture

- 32 random bytes (256-bit entropy), base64url bearer token; only its SHA-256 hash is stored in CustomerEmailVerification. Raw tokens are never returned by registration/resend or logged.
- One-hour lifetime. Verification obtains the customer row lock, re-reads the token, checks active account, unused/unrevoked token and `expiresAt > clock_timestamp()`, then atomically records usedAt and trusted emailVerifiedAt. A second consume fails with the same generic invalid-token response.
- Resend requires an internally authenticated customer principal, validates locale, uses an account-row-serialized 60-second cooldown and rotates/revokes prior tokens. Existing pending/leased delivery rows are revoked and secrets erased. Cooldown/already-verified responses remain generic. A mail already in flight cannot be unsent; any revoked token in such a message fails verification.
- Independent hashed Redis namespaces enforce registration (IP and normalized account 5/hour), login (IP5/minute, account20/minute), verify (IP20/hour), resend (IP10/hour, customer5/hour). Rate-limit storage fails closed. No admin session/rate keys are reused.
- Registration, token creation and notification enqueue share a transaction. Vendor sending occurs later; delivery outage leaves CustomerAccount and verification intent durable. A database enqueue failure rolls back that transaction, rather than creating an account with an untracked token.
- Retryable verification mail requires the bearer token after restart. The outbox stores an AES-256-GCM envelope, authenticated with verification ID as AAD, while the token table remains hash-only. `CUSTOMER_VERIFICATION_ENCRYPTION_KEY` is a canonical base64 32-byte backend secret. Payload JSON contains no token. Only the EmailProvider adapter receives the decrypted token for delivery.
- Successful/revoked/terminally failed deliveries erase encryptedSecret. Keep the encryption key stable until outstanding deliveries drain, or deliberately rotate/reissue verification before changing it. Key ring/provider secret management is not configured by this task.

Both hold acquisition and finalization lock/reload CustomerAccount and require the server's emailVerifiedAt. A browser principal alone cannot assert verification. The future HTTP layer must construct the principal from its dedicated customer session guard; accepting `realm`/customerId from a request body is explicitly forbidden.

## 3. BookingResource, hold and booking

Migration seeds id `neotek-consultation-v1`, key `neotek-consultation`, name `NeoTek consultation`, active=true. It only inserts into the new resource table, uses ON CONFLICT(key) DO NOTHING, and never changes CMS content or operators. A second Prisma deploy is a no-op. Multiple resources are supported through required ledger resourceId; no round robin/staff schedules/assignment optimization exists.

Browser selection is not a hold. `acquireHold()` validates strict input, verified active customer, active resource, scheduling policy and a real published solutionModules catalogue key. Solution label is snapshotted from the published Vietnamese catalogue; no fabricated Page FK/detail article requirement. Booking email is always the verified account email. Finalization requires contact name, company, phone, solution/module and trusted held time; message is optional. Alternate email, status, requested-time overrides, assignment, integration and audit fields are rejected.

Requested interval, customer, resource, timezone and expiry are on the required shared ledger row. Hold carries the solution snapshot. Final Booking references both the original hold and the **same reservation ID**. `PENDING` is a durable submitted request with no automatic expiry. PENDING and CONFIRMED block; COMPLETED/NO_SHOW also retain historical occupancy; CANCELLED releases. Neither historical status creates future availability outside policy.

One customer may have at most one HOLD ledger row. A slot change is a transaction that releases the old hold/ledger and creates the new hold. Any conflict rolls the whole transaction back, preserving the old hold. Idempotent release does not release an already converted booking.

## 4. Occupancy/race guarantee and PostgreSQL extensions

Required extension: **btree_gist**, for equality on resource text combined with range-overlap GiST. No new PostgreSQL process or extension is installed in the user's persistent server. Verified test server is PostgreSQL18; target version/extension permission must be checked read-only before a shared migration.

The ledger has one exclusion constraint:

```sql
EXCLUDE USING gist (
  "resourceId" WITH =,
  tstzrange("busyStartAt", "busyEndAt", '[)') WITH &&
) WHERE ("state" IN ('HOLD', 'BOOKING'))
```

Every hold and every blocking booking uses this same table/constraint. Therefore HOLD/HOLD, HOLD/PENDING, HOLD/CONFIRMED, PENDING/PENDING and PENDING/CONFIRMED all conflict on the same resource. Different resources succeed. Half-open ranges permit adjacency with zero buffers; configured buffers intentionally require extra clearance.

All occupancy writers go through BookingService READ COMMITTED interactive transactions. Lock order is customer row, then all involved resource rows in sorted ID order. Resource locks serialize acquisition/replacement/finalization/cancellation with fresh subsequent reads. Administrative transitions additionally lock the Booking row before the resource and never acquire a customer lock; no reverse resource-to-customer path exists. Failed transactions release locks automatically. No Redis lock or browser availability check is authoritative.

SQL's static exclusion predicate cannot expire rows dynamically. It intentionally contains no `now()` predicate. Instead:

1. Public occupancy projection filters HOLD using `expiresAt > clock_timestamp()` immediately, without modifying records.
2. Every acquisition locks its target/previous resources, reads fresh database time and synchronously releases expired ledger rows there, marking matching ACTIVE holds EXPIRED.
3. In that same protected transaction it checks remaining overlap and acquires capacity. Expired occupancy is removed from the constraint before insertion; concurrent contenders serialize on the resource lock.

Thus no cleanup worker/cron is part of correctness. An expired row can remain physically HOLD until the next acquisition, but it is never returned as busy and cannot cause the supported acquisition API to reject an otherwise free slot. **Direct INSERT into the ledger is not an acquisition API**: it must use the protected transaction/reclamation protocol. The exclusion constraint still rejects unsafe overlapping direct writes, and deferred binding triggers reject orphan/mismatched hold/booking rows. Future writers must preserve this single boundary.

This design adapts PostgreSQL's [resource/range exclusion mechanism](https://www.postgresql.org/docs/18/rangetypes.html#RANGETYPES-CONSTRAINT), [row locks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS) and [READ COMMITTED fresh-command snapshots](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED). Prisma6 interactive transactions support explicit isolation settings; see [Prisma6 transaction documentation](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions). Custom SQL constraints/triggers are maintained in migration history because the Prisma schema cannot fully express them.

## 5. Hold expiration and atomic conversion

`BOOKING_HOLD_MINUTES` defaults to10 and accepts10–15 with no schema changes. `BookingReservation.expiresAt` is the single authoritative expiry. Frontend countdown is future display state only.

Finalization transaction:

1. Lock/reload verified active customer; resolve any customer-scoped idempotent booking replay.
2. Load an owned hold; lock its resource; read fresh DB clock **after any lock wait**.
3. Reject `expiresAt <= now` with HOLD_EXPIRED. Require ACTIVE hold/HOLD ledger, no prior booking, active resource and a still-policy-valid interval. Time/resource/solution come from the held server record, not finalization input.
4. Insert Booking(PENDING) with required contact snapshots and unique hold/reservation/idempotency references.
5. Promote the existing ledger row HOLD->BOOKING and clear expiresAt; mark hold CONVERTED. The occupied range/resource never changes or disappears.
6. Insert CREATED event and two distinct customer/admin outbox intents. Commit everything together; deferred structural triggers verify final bindings.

If validation occurs before expiry, conversion may succeed even if wall time crosses expiry before commit; validation under locks is the decision point. A competing acquisition waits and then sees BOOKING. If expiry passes while finalization waits on its resource lock, its fresh DB time rejects it. At exact equality it is expired. On DB/outbox failure, conversion rolls back and the original hold remains intact.

Idempotency: unique `(customerId,idempotencyKey)` separately on hold and booking; normalized request fingerprint binds each key to its body. Same live hold request returns the existing hold without renewing expiry. Reuse with different input returns IDEMPOTENCY_CONFLICT; reuse of a terminal/expired hold returns HOLD_NOT_ACTIVE. Same finalization key/body returns the one committed booking; a different key cannot finalize an already converted hold. No duplicate events/intents. Domain errors expose no conflicting booking identity.

## 6. Status/admin and scheduling policy

Only active database User.role=ADMIN may call transition; EDITOR and customer identities do not gain booking permission. Domain transitions are precisely PENDING->CONFIRMED/CANCELLED and CONFIRMED->COMPLETED/CANCELLED/NO_SHOW. Terminal states cannot reopen. SQL also rejects invalid status edges; the service additionally enforces expectedVersion, timing and cancellation reason, then writes an ordered event/version and required confirmation/cancellation intent atomically. Confirm requires a future start; complete/no-show require requested end reached. No arbitrary status PATCH exists.

Scheduling defaults (configuration, not a claim of verified business opening hours): Asia/Ho_Chi_Minh, Monday–Friday,08:00–18:00, durations30/45/60,60-minute lead,90-day horizon, zero buffers,10-minute hold. `.env.example` documents every consumed variable. Policy validates bounds and rejects invalid config. V1 deliberately allows the approved fixed UTC+07 timezone only; additional timezone/DST support needs an explicit conversion implementation. No staff/holiday editor is added.

`availability()` generates policy-valid 15-minute candidates for an approved duration over a bounded42-day range. It queries occupancy over an expanded buffer range, merges busy intervals, omits times outside working policy and returns only timezone and `{start,end,available}` periods. No IDs/counts/customer PII/internal labels escape. This is advisory: acquisition repeats validation under locks. Raw unavailable-period projection is also PII-free.

## 7. NotificationDelivery architecture

NotificationService enqueues through the caller's Prisma transaction; BookingService contains no email vendor calls. EmailProvider is an injected contract. Dispatcher foundation is an explicitly invoked `dispatchOne()`; no automatic worker/timer/vendor is enabled by AppModule.

The outbox handles email verification, booking-created customer/admin, booking-confirmed customer and booking-cancelled customer. Unique deduplication key prevents duplicate intents. Each row records recipient/template/locale, internal entity references, payload, attempts, scheduling and result/error code. Only verification uses encryptedSecret. No notes/password/session token enters mail payloads.

Claims use FOR UPDATE SKIP LOCKED, unique lease tokens and a5-minute lease. Provider calls run after claim commit and outside domain transactions, bounded to10seconds. Failures retry with capped exponential backoff; maximum5 attempts, then visible FAILED and redacted error code. Expired leases can be reclaimed after process crash. Completion is conditional on the same lockToken/status, preventing stale workers from overwriting newer state. Expired/used/revoked verification messages become REVOKED rather than sending a valid new secret.

Delivery is at least once. A timeout/acknowledgement crash may still produce duplicate external email; adapters should use the supplied deduplication key for provider idempotency and their own cancelable network deadline. Tests use fake providers only. No live mail or credentials were configured. Phase1C will add environment-selected EMAIL_PROVIDER/EMAIL_FROM/EMAIL_REPLY_TO, rendered templates, verified sender/admin destination, dispatcher scheduling and controlled retry UI. The foundation already ensures provider failure does not erase customer or Booking.

## 8. Indexes/constraints and FK/onDelete review

Exact names and definitions are in migration.sql; the following is the complete functional inventory.

| Constraint/index | Purpose |
| --- | --- |
| New table primary keys | Stable entity identity |
| Customer unique email + normalized-email CHECK | Case-normalized uniqueness; no CMS linkage |
| Verification unique hash + hash/expiry CHECK | Fast secret lookup; strong digest format and ordered lifetime |
| Resource unique key | Stable default/resource lookup |
| Ledger resource/state/requestedStart, customer/state, state/expiry | Availability, replacement and synchronous expiry queries |
| Ledger valid_interval CHECK | Positive requested interval and buffered interval enclosing it |
| Ledger valid_state CHECK | HOLD requires expiry/no release; BOOKING clears expiry/no release; RELEASED requires release time |
| Ledger no_overlap GiST exclusion | One coherent buffered occupancy constraint for HOLD and BOOKING |
| Ledger one_hold_per_customer partial UNIQUE | At most one HOLD row per customer (expired rows synchronously reclaimed) |
| Hold unique reservation; customer/idempotency; customer/status | One hold per ledger, duplicate acquisition and lifecycle lookup |
| Booking unique reservation, hold, customer/idempotency | One conversion/booking per hold and retry protection |
| Booking customer/created/id, status/created/id, created/id | History/admin paging; time filtering joins indexed ledger |
| Booking contact/locale/version CHECK | Mandatory contact/module and bounded locale/version structure |
| Event unique booking/sequence + shape CHECK | Ordered internal history and approved event/transition shapes |
| Note booking/created/id + nonempty CHECK | Internal note history and valid body |
| Outbox unique deduplication; status/nextAttempt; customer/created; booking/created | Deduplication, dispatcher claims and operator history |
| Outbox shape CHECK | Valid entity reference family, locale, attempt bound and lease/status consistency |
| Deferred ledger/hold/booking binding triggers | At commit, same customer/reservation/hold ownership and compatible lifecycle; rejects orphan ledger/domain rows |
| Booking status-transition trigger | Rejects unsupported status changes at DB boundary too |

Every new FK uses ON DELETE RESTRICT and ON UPDATE CASCADE. Reservation references CustomerAccount and BookingResource. Hold references CustomerAccount and Reservation. Booking references CustomerAccount, Reservation and Hold. Verification references CustomerAccount. Event references Booking and nullable existing User actor. Note references Booking and existing User author. Delivery references CustomerAccount and nullable Verification/Booking/Event according to its checked reference family. No cascades can erase booking/audit/outbox history. Deactivate accounts/operators/resources; do not hard-delete referenced history. A reviewed retention/anonymization process can be added later.

## 9. Migration locking/data impact and rollback

Before persistent application, verify target PostgreSQL version/extension privilege, current `_prisma_migrations` status, expected schema baseline, backup/restore evidence and existing CMS/operator inventory. These checks were not performed against the current shared DB because this task stops at the migration gate.

SQL is additive and wrapped in BEGIN/COMMIT:4 enums,9 empty tables, indexes/checks/FKs/triggers/functions, btree_gist if absent, and1 resource row. It does not rewrite User/CMS columns, migrate mock bookings, alter published content or modify existing users. Creating FKs to existing User requires brief locks on that referenced table; run in an approved maintenance window and check lock contention. New GiST/unique indexes are built on empty new tables. Extension creation requires database/catalog permissions and can fail before migration commit. Do not substitute a race-prone check/insert if it is unavailable.

On failure inside SQL, transaction rolls back new objects/seed; Prisma may retain a failed migration bookkeeping record requiring reviewed resolution. Never edit an already applied migration or casually run migrate resolve. After successful release, rollback application exposure by keeping customer/Booking modules/routes/flags disabled while retaining additive schema/history. Prefer a reviewed corrective forward migration. Do not drop the extension/tables or reset a shared DB to undo this phase; extension may be shared and customer/booking data becomes durable as soon as real usage begins.

**Checkpoint to authorize later:** approve the exact linked schema diff and SQL, resource seed, default operating policy, key/provider configuration plan, target DB identity, backups and expected locks. No further persistent DB action is performed in Phase1B without that review.

## 10. Changed files and preserved work

Changed by this phase:

- `prisma/schema.prisma`, `.env.example`.
- New `prisma/migrations/20261009000000_booking_foundation/migration.sql`.
- New `src/booking/{booking-domain.ts,booking-policy.ts,booking.service.ts,booking.module.ts,booking-domain.spec.ts,booking-postgres.integration.spec.ts}`.
- New `src/customer/{customer.service.ts,customer.module.ts,customer.service.spec.ts}`.
- New `src/notification/{notification.service.ts,notification.module.ts,verification-secret.ts}`.
- New `scripts/test-booking-postgres.ps1` and this report/schema-diff artifact.

Pre-existing edits preserved: frontend AdminApp.jsx/admin.css and its untracked BOOKING_PHASE1_AUDIT.md; backend content-urls.ts/content-urls.spec.ts. No source file from those edits was changed by Phase1B. No new package/dependency, frontend source or AppModule registration was added.

## 11. Validation and regressions

Final validation completed against the artifact fingerprints above.

- Prisma format/validate/generate: PASS with installed6.19. Native engine generation required an allowed sandbox escalation; it changes generated client files only, not database schema. Existing package.json Prisma-config deprecation remains.
- Backend lint (`eslint src --no-fix`) and build (`npm.cmd run build`): **PASS** on the final source.
- Existing regression/unit suites (`jest --runInBand --testPathIgnorePatterns booking-postgres.integration`): **27 suites/161 tests PASS**,1 optional real-Redis suite/test skipped because AUTH_REDIS_TEST_URL is not configured. This covers ADMIN/EDITOR/current-role auth, HTTP Origin/CSRF/cookies/body/safe errors, rate limits, cache failure/session primitives, public CMS/publication/sanitization, media and migration helpers. PostgreSQL tests are run separately in the disposable cluster.
- Final real PostgreSQL replay: **all3 migrations PASS**, second deploy **no pending migrations**, **22/22 integration tests PASS**. Together with the regression/unit run, **183 tests passed across28 suites**,1 live-Redis test skipped. The final test cluster was stopped and its temporary directory removed.
- Whitespace checks: both repositories' `git diff --check` PASS; new source/SQL/report files also checked for trailing whitespace. Only existing Windows LF/CRLF notices remain.
- Real PostgreSQL tests cover A–J using separate interactive transaction connections: concurrent holds, HOLD versus BOOKING occupancy at DB exclusion level, PENDING/CONFIRMED conflicts, adjacency/multi-resource, expiry before cleanup, duplicate finalization and idempotency, expiry across resource-lock waits, promotion across original expiry, transactional replacement/release and rollback under competition. Additional cases cover identity/verified ownership, DB structural/status guards, partial/nested/buffer conflicts, policy-only public availability, notification persistence rollback, verification rotation/expiry/one-use and durable provider-failure retry.
- PostgreSQL test runner initializes a fresh loopback-only native cluster under a validated temporary path, creates only `neotek_booking_disposable`, overrides child-process URLs, replays all3 migrations, runs deploy again to prove no-op, runs tests, stops that cluster and removes only its verified temporary directory. No existing DB is reset/reused. Windows restricted-token sandbox could not start pg_ctl; isolated tests used approved escalation.
- No browser/responsive validation is claimed: frontend is unchanged. No live Redis integration, email vendor delivery, Google/API, production database/extension or infrastructure check is claimed.

## 12. Deferred to Phase 1C

Wire the reviewed customer/booking modules only after persistent migration approval. Add realm-specific customer HttpOnly cookies/Redis sessions/logout, session/CSRF/exact-Origin guards, body/query/mutation rate limits and strict HTTP response projections; preserve current CMS security controls. Add email adapter/config validation/rendered VI/EN templates, verified sender/admin recipient, worker scheduling and operator retry/visibility. Add customer/my-bookings/admin list/detail/notes endpoints and UI in the existing shells, intent preservation and verification flow. Verify full end-to-end paths at1440/1024/820/390 in VI/EN before enabling flags. No full Booking frontend, social OAuth, external calendar/meeting integration or deployment is included in this foundation.
