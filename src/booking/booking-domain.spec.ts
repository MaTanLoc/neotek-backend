import { BookingStatus } from '@prisma/client';
import {
  assertTransition,
  customerIdentity,
  finalizeInput,
  parseInput,
} from './booking-domain';
import { bookingPolicy, validateInterval } from './booking-policy';
import { BookingService } from './booking.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';

describe('Booking policy and trusted domain boundaries', () => {
  const now = new Date('2026-10-09T00:00:00Z');
  const start = new Date('2026-10-09T02:00:00Z');
  const end = new Date('2026-10-09T03:00:00Z');
  it('rejects unparseable timestamp offsets before beginning a transaction', async () => {
    const service = new BookingService(
      {} as PrismaService,
      new NotificationService(),
      bookingPolicy({}),
    );
    await expect(
      service.acquireHold(
        { realm: 'customer', customerId: 'customer' },
        {
          resourceKey: 'neotek-consultation',
          requestedStartAt: '2026-10-09T02:00:00+99:99',
          requestedEndAt: end.toISOString(),
          timezone: 'Asia/Ho_Chi_Minh',
          moduleKey: 'erp',
          idempotencyKey: 'unique-test-request',
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('uses configuration-driven hold length and rejects unsafe policy', () => {
    expect(bookingPolicy({}).holdMinutes).toBe(10);
    expect(bookingPolicy({ BOOKING_HOLD_MINUTES: '15' }).holdMinutes).toBe(15);
    for (const env of [
      { BOOKING_HOLD_MINUTES: '16' },
      { BOOKING_DURATIONS: '0' },
      { BOOKING_TIMEZONE: 'America/New_York' },
      { BOOKING_START_MINUTE: '1000', BOOKING_END_MINUTE: '500' },
    ])
      expect(() => bookingPolicy(env)).toThrow('Invalid input');
  });
  it('enforces approved durations, local work days/hours, lead time, horizon and timezone', () => {
    const policy = bookingPolicy({});
    expect(() =>
      validateInterval(start, end, policy.timezone, now, policy),
    ).not.toThrow();
    const invalid: [Date, Date, string][] = [
      [end, start, policy.timezone],
      [start, new Date(start.getTime() + 20 * 60000), policy.timezone],
      [
        new Date('2026-10-10T02:00:00Z'),
        new Date('2026-10-10T03:00:00Z'),
        policy.timezone,
      ],
      [
        new Date('2026-10-09T00:30:00Z'),
        new Date('2026-10-09T01:30:00Z'),
        policy.timezone,
      ],
      [
        new Date('2027-10-09T02:00:00Z'),
        new Date('2027-10-09T03:00:00Z'),
        policy.timezone,
      ],
      [start, end, 'UTC'],
      [new Date('invalid'), end, policy.timezone],
    ];
    for (const args of invalid)
      expect(() => validateInterval(...args, now, policy)).toThrow();
  });
  it('enumerates all valid status edges and rejects every other edge', () => {
    const allowed = new Set([
      'PENDING:CONFIRMED',
      'PENDING:CANCELLED',
      'CONFIRMED:COMPLETED',
      'CONFIRMED:CANCELLED',
      'CONFIRMED:NO_SHOW',
    ]);
    for (const from of Object.values(BookingStatus))
      for (const to of Object.values(BookingStatus)) {
        const time =
          to === 'CONFIRMED' ? now : new Date('2026-10-10T00:00:00Z');
        const work = () => assertTransition(from, to, time, start, end);
        if (allowed.has(`${from}:${to}`)) expect(work).not.toThrow();
        else expect(work).toThrow();
      }
    expect(() =>
      assertTransition('CONFIRMED', 'COMPLETED', now, start, end),
    ).toThrow('BOOKING_NOT_ENDED');
  });
  it('rejects client privileges, alternate email, anonymous/admin principal and missing mandatory contact fields', () => {
    expect(() =>
      customerIdentity({ realm: 'admin', customerId: '1' } as never),
    ).toThrow();
    expect(() => customerIdentity(undefined as never)).toThrow();
    const body = {
      holdId: 'hold',
      contactName: 'Name',
      contactPhone: '+84 900 000 000',
      contactCompany: 'Company',
      locale: 'vi',
      idempotencyKey: 'unique-client-request',
    };
    expect(parseInput(finalizeInput, body)).toEqual(body);
    for (const extra of [
      { contactEmail: 'other@example.test' },
      { status: 'CONFIRMED' },
      { customerId: 'other' },
      { meetingUrl: 'https://example.test' },
      { contactPhone: '' },
      { contactPhone: 'Phone' },
      { contactPhone: '-------' },
      { contactName: 'Invalid\u0000Name' },
      { contactCompany: 'Invalid\nCompany' },
      { contactCompany: '' },
    ])
      expect(() => parseInput(finalizeInput, { ...body, ...extra })).toThrow();
  });
});
