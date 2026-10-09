/* global beforeAll, afterAll */
import { PrismaClient, BookingStatus } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { BookingService } from './booking.service';
import { BookingPolicy, bookingPolicy } from './booking-policy';
import { CustomerService } from '../customer/customer.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { NotificationService } from '../notification/notification.service';
import { VerificationSecret } from '../notification/verification-secret';

const testUrl = process.env.BOOKING_TEST_DATABASE_URL;
const postgres = testUrl ? describe : describe.skip;
postgres('Phase 1B real isolated PostgreSQL', () => {
  let db: PrismaClient;
  let booking: BookingService;
  let customers: CustomerService;
  let policy: BookingPolicy;
  const notifications = new NotificationService();
  const secret = new VerificationSecret(randomBytes(32).toString('base64'));
  const cache = { incrementWithExpiry: jest.fn().mockResolvedValue(1) };
  let slotSequence = 0;

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      process.env.BOOKING_TEST_DISPOSABLE !== '1' ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/neotek_booking_disposable'
    )
      throw new Error(
        'Use scripts/test-booking-postgres.ps1; existing databases are forbidden',
      );
    db = new PrismaClient({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    policy = bookingPolicy({
      BOOKING_LEAD_MINUTES: '0',
      BOOKING_WORKING_DAYS: '0,1,2,3,4,5,6',
    });
    booking = new BookingService(
      db as PrismaService,
      notifications,
      policy,
      'admin@example.test',
    );
    customers = new CustomerService(
      db as PrismaService,
      notifications,
      cache as unknown as CacheService,
      secret,
    );
    await db.page.upsert({
      where: { slug: 'solutions' },
      update: {},
      create: {
        slug: 'solutions',
        status: 'PUBLISHED',
        sections: {
          create: {
            key: 'modules',
            type: 'solutionModules',
            translations: {
              create: {
                locale: 'vi',
                content: { items: [{ key: 'erp', title: 'ERP consultation' }] },
              },
            },
          },
        },
      },
    });
  }, 30000);
  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  async function customer(verified = true) {
    const row = await db.customerAccount.create({
      data: {
        email: `${randomUUID()}@example.test`,
        name: 'Customer',
        passwordHash: 'test-only',
        emailVerifiedAt: verified ? new Date() : null,
      },
    });
    return { realm: 'customer' as const, customerId: row.id };
  }
  function slot(offset = 0) {
    const day = new Date(Date.now() + ++slotSequence * 86400000);
    day.setUTCHours(2, 0, 0, 0);
    return {
      start: new Date(day.getTime() + offset * 60000),
      end: new Date(day.getTime() + (offset + 60) * 60000),
    };
  }
  function holdBody(
    times: { start: Date; end: Date },
    key = randomUUID(),
    resourceKey = 'neotek-consultation',
  ) {
    return {
      resourceKey,
      requestedStartAt: times.start.toISOString(),
      requestedEndAt: times.end.toISOString(),
      timezone: policy.timezone,
      moduleKey: 'erp',
      idempotencyKey: key,
    };
  }
  function finalBody(holdId: string, key = randomUUID()) {
    return {
      holdId,
      contactName: 'Customer',
      contactPhone: '0900000000',
      contactCompany: 'Company',
      locale: 'vi',
      idempotencyKey: key,
    };
  }
  async function admin(role: 'ADMIN' | 'EDITOR' = 'ADMIN') {
    return db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        passwordHash: 'fixture',
        role,
      },
    });
  }

  it('replays all migrations, seeds exactly one resource and preserves CMS publication', async () => {
    expect(
      await db.bookingResource.count({ where: { key: 'neotek-consultation' } }),
    ).toBe(1);
    expect(
      await db.page.findUnique({ where: { slug: 'solutions' } }),
    ).toMatchObject({ status: 'PUBLISHED' });
    const constraints = await db.$queryRaw<
      { conname: string }[]
    >`SELECT conname FROM pg_constraint WHERE conname = 'BookingReservation_no_overlap'`;
    expect(constraints).toHaveLength(1);
  });

  it('A: simultaneous identical holds on one resource have exactly one winner', async () => {
    const a = await customer(),
      b = await customer(),
      input = holdBody(slot());
    const results = await Promise.allSettled([
      booking.acquireHold(a, input),
      booking.acquireHold(b, input),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('B/C: a hold prevents overlapping holds and direct BOOKING ledger occupancy at database level', async () => {
    const a = await customer(),
      b = await customer(),
      times = slot();
    await booking.acquireHold(a, holdBody(times));
    await expect(booking.acquireHold(b, holdBody(times))).rejects.toThrow(
      'SLOT_UNAVAILABLE',
    );
    await expect(
      db.bookingReservation.create({
        data: {
          customerId: b.customerId,
          resourceId: 'neotek-consultation-v1',
          state: 'BOOKING',
          timezone: policy.timezone,
          requestedStartAt: times.start,
          requestedEndAt: times.end,
          busyStartAt: times.start,
          busyEndAt: times.end,
        },
      }),
    ).rejects.toThrow(/BookingReservation_no_overlap/);
  });

  it.each(['PENDING', 'CONFIRMED'] as BookingStatus[])(
    'D/E: %s booking blocks holds and every other booking occupancy',
    async (status) => {
      const a = await customer(),
        b = await customer(),
        times = slot();
      const hold = await booking.acquireHold(a, holdBody(times));
      const saved = await booking.finalize(a, finalBody(hold.id));
      if (status === 'CONFIRMED')
        await booking.transition((await admin()).id, saved.id, {
          toStatus: status,
          expectedVersion: 1,
        });
      await expect(booking.acquireHold(b, holdBody(times))).rejects.toThrow(
        'SLOT_UNAVAILABLE',
      );
      await expect(
        db.bookingReservation.create({
          data: {
            customerId: b.customerId,
            resourceId: 'neotek-consultation-v1',
            state: 'BOOKING',
            timezone: policy.timezone,
            requestedStartAt: times.start,
            requestedEndAt: times.end,
            busyStartAt: times.start,
            busyEndAt: times.end,
          },
        }),
      ).rejects.toThrow(/BookingReservation_no_overlap/);
    },
  );

  it('F: adjacent intervals and independent resources succeed', async () => {
    const a = await customer(),
      b = await customer(),
      c = await customer(),
      times = slot();
    await booking.acquireHold(a, holdBody(times));
    await booking.acquireHold(
      b,
      holdBody({
        start: times.end,
        end: new Date(times.end.getTime() + 3600000),
      }),
    );
    const resource = await db.bookingResource.create({
      data: { key: randomUUID(), name: 'Second' },
    });
    await expect(
      booking.acquireHold(c, holdBody(times, randomUUID(), resource.key)),
    ).resolves.toBeDefined();
  });

  it('G: expired ACTIVE hold is invisible immediately and acquisition reclaims without any cleanup worker', async () => {
    const a = await customer(),
      b = await customer(),
      times = slot();
    const hold = await booking.acquireHold(a, holdBody(times));
    await db.bookingReservation.update({
      where: { id: hold.reservationId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(
      (await db.bookingHold.findUniqueOrThrow({ where: { id: hold.id } }))
        .status,
    ).toBe('ACTIVE');
    expect(
      await booking.unavailable('neotek-consultation', times.start, times.end),
    ).toEqual([]);
    await expect(booking.finalize(a, finalBody(hold.id))).rejects.toThrow(
      'HOLD_EXPIRED',
    );
    await expect(
      booking.acquireHold(b, holdBody(times)),
    ).resolves.toBeDefined();
    expect(
      (await db.bookingHold.findUniqueOrThrow({ where: { id: hold.id } }))
        .status,
    ).toBe('EXPIRED');
  });

  it('H: concurrent finalization/replay creates one booking, one event and two delivery intents', async () => {
    const a = await customer(),
      hold = await booking.acquireHold(a, holdBody(slot())),
      input = finalBody(hold.id);
    const [first, second] = await Promise.all([
      booking.finalize(a, input),
      booking.finalize(a, input),
    ]);
    expect(first.id).toBe(second.id);
    expect(await db.booking.count({ where: { holdId: hold.id } })).toBe(1);
    expect(
      await db.bookingEvent.count({ where: { bookingId: first.id } }),
    ).toBe(1);
    expect(
      await db.notificationDelivery.count({ where: { bookingId: first.id } }),
    ).toBe(2);
    expect(
      (
        await db.bookingReservation.findUniqueOrThrow({
          where: { id: hold.reservationId },
        })
      ).state,
    ).toBe('BOOKING');
    await expect(booking.finalize(a, finalBody(hold.id))).rejects.toThrow(
      'HOLD_NOT_ACTIVE',
    );
    await expect(
      booking.finalize(a, { ...input, contactCompany: 'Changed' }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('I: expiry while finalization waits for resource lock is rejected using fresh DB time', async () => {
    const a = await customer(),
      hold = await booking.acquireHold(a, holdBody(slot()));
    await db.bookingReservation.update({
      where: { id: hold.reservationId },
      data: { expiresAt: new Date(Date.now() + 200) },
    });
    let lockAcquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "BookingResource" WHERE "id" = 'neotek-consultation-v1' FOR UPDATE`;
      lockAcquired();
      await tx.$queryRaw`SELECT 1 AS waited FROM pg_sleep(0.4)`;
    });
    await locked;
    const result = expect(
      booking.finalize(a, finalBody(hold.id)),
    ).rejects.toThrow('HOLD_EXPIRED');
    await blocker;
    await result;
    expect(await db.booking.count({ where: { holdId: hold.id } })).toBe(0);
  });

  it('I: finalization before expiry retains capacity across the original expiry', async () => {
    const a = await customer(),
      b = await customer(),
      times = slot();
    const hold = await booking.acquireHold(a, holdBody(times));
    await db.bookingReservation.update({
      where: { id: hold.reservationId },
      data: { expiresAt: new Date(Date.now() + 1000) },
    });
    await booking.finalize(a, finalBody(hold.id));
    await db.$queryRaw`SELECT 1 AS waited FROM pg_sleep(1.1)`;
    await expect(booking.acquireHold(b, holdBody(times))).rejects.toThrow(
      'SLOT_UNAVAILABLE',
    );
  });

  it('J: failed slot replacement rolls back release; successful replacement leaves one hold; release is idempotent', async () => {
    const a = await customer(),
      b = await customer(),
      oldTimes = slot(),
      newTimes = slot();
    const old = await booking.acquireHold(a, holdBody(oldTimes));
    await booking.acquireHold(b, holdBody(newTimes));
    await expect(booking.acquireHold(a, holdBody(newTimes))).rejects.toThrow(
      'SLOT_UNAVAILABLE',
    );
    expect(
      (
        await db.bookingReservation.findUniqueOrThrow({
          where: { id: old.reservationId },
        })
      ).state,
    ).toBe('HOLD');
    const next = await booking.acquireHold(a, holdBody(slot()));
    expect(
      await db.bookingReservation.count({
        where: { customerId: a.customerId, state: 'HOLD' },
      }),
    ).toBe(1);
    await booking.releaseHold(a, next.id);
    await booking.releaseHold(a, next.id);
    expect(
      await db.bookingReservation.count({
        where: { customerId: a.customerId, state: 'HOLD' },
      }),
    ).toBe(0);
  });

  it('J: a competitor cannot steal the old slot if replacement rolls back under contention', async () => {
    const a = await customer(),
      b = await customer(),
      c = await customer(),
      oldTimes = slot(),
      busy = slot();
    await booking.acquireHold(a, holdBody(oldTimes));
    await booking.acquireHold(b, holdBody(busy));
    const results = await Promise.allSettled([
      booking.acquireHold(a, holdBody(busy)),
      booking.acquireHold(c, holdBody(oldTimes)),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('serializes same-customer hold retries and distinct slot requests without hoarding', async () => {
    const a = await customer(),
      input = holdBody(slot());
    const [one, two] = await Promise.all([
      booking.acquireHold(a, input),
      booking.acquireHold(a, input),
    ]);
    expect(one.id).toBe(two.id);
    await expect(
      booking.acquireHold(a, { ...input, moduleKey: 'other' }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await Promise.all([
      booking.acquireHold(a, holdBody(slot())),
      booking.acquireHold(a, holdBody(slot())),
    ]);
    expect(
      await db.bookingReservation.count({
        where: { customerId: a.customerId, state: 'HOLD' },
      }),
    ).toBe(1);
  });

  it('requires verified server identity, enforces ownership and rejects alternate email/status/interval fields', async () => {
    const unverified = await customer(false),
      a = await customer(),
      b = await customer();
    await expect(
      booking.acquireHold(unverified, holdBody(slot())),
    ).rejects.toThrow('EMAIL_VERIFICATION_REQUIRED');
    const hold = await booking.acquireHold(a, holdBody(slot()));
    await expect(booking.finalize(b, finalBody(hold.id))).rejects.toThrow(
      'Hold not found',
    );
    for (const extra of [
      { contactEmail: 'attacker@example.test' },
      { status: 'CONFIRMED' },
      { requestedEndAt: new Date().toISOString() },
    ]) {
      await expect(
        booking.finalize(a, { ...finalBody(hold.id), ...extra }),
      ).rejects.toThrow('Invalid input');
    }
    await db.customerAccount.update({
      where: { id: a.customerId },
      data: { emailVerifiedAt: null },
    });
    await expect(booking.finalize(a, finalBody(hold.id))).rejects.toThrow(
      'EMAIL_VERIFICATION_REQUIRED',
    );
    await expect(
      booking.acquireHold(
        { realm: 'admin', customerId: a.customerId } as never,
        holdBody(slot()),
      ),
    ).rejects.toThrow('Customer authentication required');
  });

  it('ADMIN-only workflow, stale transition rejection, ownership projections and cancellation release', async () => {
    const a = await customer(),
      b = await customer(),
      times = slot();
    const hold = await booking.acquireHold(a, holdBody(times));
    const saved = await booking.finalize(a, finalBody(hold.id));
    await expect(
      db.booking.update({
        where: { id: saved.id },
        data: { customerId: b.customerId },
      }),
    ).rejects.toThrow('Invalid booking reservation binding');
    await expect(
      db.booking.update({
        where: { id: saved.id },
        data: { status: 'COMPLETED' },
      }),
    ).rejects.toThrow('Invalid booking status transition');
    await expect(
      booking.transition((await admin('EDITOR')).id, saved.id, {
        toStatus: 'CONFIRMED',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('Admin required');
    const operator = await admin();
    await expect(
      booking.transition(operator.id, saved.id, {
        toStatus: 'COMPLETED',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('INVALID_TRANSITION');
    await booking.transition(operator.id, saved.id, {
      toStatus: 'CONFIRMED',
      expectedVersion: 1,
    });
    await expect(
      booking.transition(operator.id, saved.id, {
        toStatus: 'CANCELLED',
        expectedVersion: 1,
        reason: 'Requested',
      }),
    ).rejects.toThrow('STALE_BOOKING');
    await expect(booking.ownBooking(b, saved.id)).rejects.toThrow(
      'Booking not found',
    );
    expect(await booking.ownBooking(a, saved.id)).toMatchObject({
      meetingUrl: null,
      status: 'CONFIRMED',
    });
    expect(
      Object.keys(
        (
          await booking.unavailable(
            'neotek-consultation',
            times.start,
            times.end,
          )
        )[0],
      ).sort(),
    ).toEqual(['available', 'end', 'start']);
    await booking.transition(operator.id, saved.id, {
      toStatus: 'CANCELLED',
      expectedVersion: 2,
      reason: 'Requested',
    });
    await expect(
      booking.acquireHold(b, holdBody(times)),
    ).resolves.toBeDefined();
    expect(
      await db.notificationDelivery.count({ where: { bookingId: saved.id } }),
    ).toBe(4);
  });

  it('registration is durable, duplicate-safe and independent of CMS identity; login does not require verification', async () => {
    const email = `${randomUUID()}@example.test`,
      input = {
        email: email.toUpperCase(),
        name: 'Name',
        password: 'customer secure password',
        locale: 'vi',
      };
    const results = await Promise.all([
      customers.register(input, 'registration'),
      customers.register(input, 'registration'),
    ]);
    expect(results).toEqual([{ accepted: true }, { accepted: true }]);
    const account = await db.customerAccount.findUniqueOrThrow({
      where: { email },
    });
    expect(account.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(account.emailVerifiedAt).toBeNull();
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(
      await customers.authenticate(
        { email, password: input.password },
        'login',
      ),
    ).toMatchObject({ realm: 'customer', emailVerifiedAt: null });
    await expect(
      customers.authenticate(
        { email, password: 'wrong secure password' },
        'login',
      ),
    ).rejects.toThrow('Invalid email or password');
    await expect(
      customers.register({ ...input, role: 'ADMIN' }, 'registration'),
    ).rejects.toThrow('Invalid input');
    expect(
      await db.notificationDelivery.count({
        where: { customerId: account.id },
      }),
    ).toBe(1);
  });

  it('verification hashes only, encrypted outbox, cooldown, rotation, expiration and one-time consumption', async () => {
    const email = `${randomUUID()}@example.test`;
    await customers.register(
      {
        email,
        name: 'Verify',
        password: 'a long customer password',
        locale: 'en',
      },
      'verification',
    );
    const account = await db.customerAccount.findUniqueOrThrow({
        where: { email },
      }),
      principal = { realm: 'customer' as const, customerId: account.id };
    let delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { customerId: account.id },
    });
    const firstToken = secret.open(
      delivery.encryptedSecret!,
      delivery.verificationId!,
    );
    expect(JSON.stringify(delivery.payload)).not.toContain(firstToken);
    expect(delivery.encryptedSecret).not.toContain(firstToken);
    await customers.resend(principal, 'en', 'resend');
    expect(
      await db.customerEmailVerification.count({
        where: { customerId: account.id },
      }),
    ).toBe(1);
    await db.customerAccount.update({
      where: { id: account.id },
      data: { verificationIssuedAt: new Date(Date.now() - 61000) },
    });
    await customers.resend(principal, 'en', 'resend');
    await expect(customers.verify(firstToken, 'verify')).rejects.toThrow(
      'Invalid verification token',
    );
    delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { customerId: account.id, status: 'PENDING' },
    });
    const token = secret.open(
      delivery.encryptedSecret!,
      delivery.verificationId!,
    );
    const results = await Promise.allSettled([
      customers.verify(token, 'verify'),
      customers.verify(token, 'verify'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await db.customerAccount.findUniqueOrThrow({
          where: { id: account.id },
        })
      ).emailVerifiedAt,
    ).not.toBeNull();
    const expiredAccount = await customer(false);
    await customers.resend(expiredAccount, 'vi', 'expire');
    const expiredDelivery = await db.notificationDelivery.findFirstOrThrow({
      where: { customerId: expiredAccount.customerId },
    });
    const expiredToken = secret.open(
      expiredDelivery.encryptedSecret!,
      expiredDelivery.verificationId!,
    );
    await db.customerEmailVerification.update({
      where: { id: expiredDelivery.verificationId! },
      data: {
        createdAt: new Date(Date.now() - 7200000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(customers.verify(expiredToken, 'verify')).rejects.toThrow(
      'Invalid verification token',
    );
  });

  it('email failure retries without losing customer or booking; expired lease recovery is bounded and redacted', async () => {
    const a = await customer(),
      hold = await booking.acquireHold(a, holdBody(slot()));
    const saved = await booking.finalize(a, finalBody(hold.id));
    const failed = {
      send: jest
        .fn()
        .mockRejectedValue(new Error('vendor-secret-must-not-be-stored')),
    };
    // Make only this booking due so other test fixtures do not affect claims.
    await db.notificationDelivery.updateMany({
      where: { status: 'PENDING' },
      data: { nextAttemptAt: new Date(Date.now() + 86400000) },
    });
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { bookingId: saved.id },
    });
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { nextAttemptAt: new Date(0) },
    });
    expect(await notifications.dispatchOne(db, failed, secret)).toBe(true);
    expect(
      await db.booking.findUnique({ where: { id: saved.id } }),
    ).not.toBeNull();
    expect(
      await db.customerAccount.findUnique({ where: { id: a.customerId } }),
    ).not.toBeNull();
    expect(
      await db.notificationDelivery.findUnique({ where: { id: delivery.id } }),
    ).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastErrorCode: 'EMAIL_DELIVERY_FAILED',
    });
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'PROCESSING',
        lockedAt: new Date(0),
        lockToken: randomUUID(),
        attempts: 4,
      },
    });
    await notifications.dispatchOne(db, failed, secret);
    expect(
      await db.notificationDelivery.findUnique({ where: { id: delivery.id } }),
    ).toMatchObject({
      status: 'FAILED',
      attempts: 5,
      lockedAt: null,
      lockToken: null,
    });
  });

  it('rejects partial and nested overlap and respects policy/buffers in public availability', async () => {
    const a = await customer(),
      b = await customer(),
      times = slot();
    const buffered = new BookingService(
      db as PrismaService,
      notifications,
      { ...policy, bufferBefore: 30, bufferAfter: 15 },
      'admin@example.test',
    );
    await buffered.acquireHold(a, holdBody(times));
    await expect(
      buffered.acquireHold(
        b,
        holdBody({
          start: new Date(times.start.getTime() + 1800000),
          end: new Date(times.end.getTime() + 1800000),
        }),
      ),
    ).rejects.toThrow('SLOT_UNAVAILABLE');
    await expect(
      buffered.acquireHold(
        b,
        holdBody({
          start: new Date(times.start.getTime() + 900000),
          end: new Date(times.start.getTime() + 2700000),
        }),
      ),
    ).rejects.toThrow('SLOT_UNAVAILABLE');
    const adjacent = {
      start: times.end,
      end: new Date(times.end.getTime() + 3600000),
    };
    await expect(buffered.acquireHold(b, holdBody(adjacent))).rejects.toThrow(
      'SLOT_UNAVAILABLE',
    );
    // The occupied period is outside this visible range but intersects the
    // candidate's before-buffer; the availability query must expand its bounds.
    const from = new Date(times.end.getTime() + 20 * 60000);
    const availability = await buffered.availability(
      'neotek-consultation',
      from,
      new Date(from.getTime() + 70 * 60000),
      60,
    );
    expect(availability.periods.length).toBeGreaterThan(0);
    expect(availability.periods[0].available).toBe(false);
    expect(Object.keys(availability.periods[0]).sort()).toEqual([
      'available',
      'end',
      'start',
    ]);
    const offHours = new Date(times.start);
    offHours.setUTCHours(19, 0, 0, 0);
    expect(
      (
        await buffered.availability(
          'neotek-consultation',
          offHours,
          new Date(offHours.getTime() + 3600000),
          60,
        )
      ).periods,
    ).toEqual([]);
  });

  it('concurrent finalizations with different keys create exactly one booking', async () => {
    const a = await customer(),
      hold = await booking.acquireHold(a, holdBody(slot()));
    const results = await Promise.allSettled([
      booking.finalize(a, finalBody(hold.id)),
      booking.finalize(a, finalBody(hold.id)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.booking.count({ where: { holdId: hold.id } })).toBe(1);
  });

  it('outbox persistence failure rolls back finalization and leaves the hold blocking', async () => {
    const a = await customer(),
      hold = await booking.acquireHold(a, holdBody(slot()));
    const failingNotifications = new NotificationService();
    jest
      .spyOn(failingNotifications, 'enqueue')
      .mockRejectedValue(new Error('fixture outbox write failure'));
    const service = new BookingService(
      db as PrismaService,
      failingNotifications,
      policy,
      'admin@example.test',
    );
    await expect(service.finalize(a, finalBody(hold.id))).rejects.toThrow(
      'fixture outbox write failure',
    );
    expect(await db.booking.count({ where: { holdId: hold.id } })).toBe(0);
    expect(
      (await db.bookingHold.findUniqueOrThrow({ where: { id: hold.id } }))
        .status,
    ).toBe('ACTIVE');
    expect(
      (
        await db.bookingReservation.findUniqueOrThrow({
          where: { id: hold.reservationId },
        })
      ).state,
    ).toBe('HOLD');
  });

  it('verification provider failure preserves registration; successful retry erases encrypted token and can verify', async () => {
    const email = `${randomUUID()}@example.test`;
    await customers.register(
      {
        email,
        name: 'Delivery',
        password: 'a secure delivery password',
        locale: 'vi',
      },
      'delivery',
    );
    const account = await db.customerAccount.findUniqueOrThrow({
      where: { email },
    });
    await db.notificationDelivery.updateMany({
      where: { status: 'PENDING' },
      data: { nextAttemptAt: new Date(Date.now() + 86400000) },
    });
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { customerId: account.id },
    });
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await notifications.dispatchOne(
      db,
      { send: jest.fn().mockRejectedValue(new Error('offline')) },
      secret,
    );
    expect(
      await db.customerAccount.findUnique({ where: { id: account.id } }),
    ).not.toBeNull();
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const provider = {
      send: jest.fn().mockResolvedValue({ messageId: 'captured-test-mail' }),
    };
    await notifications.dispatchOne(db, provider, secret);
    expect(
      await db.notificationDelivery.findUnique({ where: { id: delivery.id } }),
    ).toMatchObject({ status: 'SENT', encryptedSecret: null, attempts: 2 });
    const raw = provider.send.mock.calls[0][0].verificationToken;
    expect(typeof raw).toBe('string');
    await expect(
      customers.verify(raw, 'verification-delivery'),
    ).resolves.toEqual({ verified: true });
  });
});
