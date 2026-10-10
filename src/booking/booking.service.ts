import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { GoogleCalendarService } from './google-calendar.service';
import {
  BookingPolicy,
  bookingPolicy,
  validateInterval,
} from './booking-policy';
import {
  assertTransition,
  BookingConflict,
  CustomerPrincipal,
  customerIdentity,
  databaseTime,
  finalizeInput,
  fingerprint,
  holdInput,
  parseInput,
  transitionInput,
} from './booking-domain';

export class BookingService {
  private readonly db: PrismaService;
  private readonly notifications: NotificationService;
  readonly policy: BookingPolicy;
  private readonly adminEmail: string;
  private readonly calendar?: GoogleCalendarService;
  constructor(
    db: PrismaService,
    notifications: NotificationService,
    policy: BookingPolicy = bookingPolicy(),
    adminEmail: string = process.env.BOOKING_ADMIN_EMAIL ?? '',
    calendar?: GoogleCalendarService,
  ) {
    this.db = db;
    this.notifications = notifications;
    this.policy = policy;
    this.adminEmail = adminEmail;
    this.calendar = calendar;
  }

  private transaction<T>(
    // eslint-disable-next-line no-unused-vars -- Type-only callback signature.
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5000,
      timeout: 10000,
    });
  }

  private async customerLock(tx: Prisma.TransactionClient, customerId: string) {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${customerId} FOR UPDATE`;
    const customer = await tx.customerAccount.findUnique({
      where: { id: customerId },
    });
    if (!customer?.active)
      throw new ForbiddenException('Customer authentication required');
    if (!customer.emailVerifiedAt)
      throw new ForbiddenException('EMAIL_VERIFICATION_REQUIRED');
    return customer;
  }

  private async resourceLocks(tx: Prisma.TransactionClient, ids: string[]) {
    for (const id of [...new Set(ids)].sort()) {
      await tx.$queryRaw`SELECT "id" FROM "BookingResource" WHERE "id" = ${id} FOR UPDATE`;
    }
  }

  private async reclaimExpired(
    tx: Prisma.TransactionClient,
    resourceIds: string[],
    now: Date,
  ) {
    // Synchronous reclamation belongs to acquisition, not a cron dependency.
    // Availability already ignores expiresAt <= DB clock without mutating rows.
    await tx.bookingReservation.updateMany({
      where: {
        resourceId: { in: resourceIds },
        state: 'HOLD',
        expiresAt: { lte: now },
      },
      data: { state: 'RELEASED', releasedAt: now },
    });
    await tx.bookingHold.updateMany({
      where: {
        status: 'ACTIVE',
        reservation: {
          resourceId: { in: resourceIds },
          state: 'RELEASED',
          expiresAt: { lte: now },
        },
      },
      data: { status: 'EXPIRED' },
    });
  }

  async acquireHold(principal: CustomerPrincipal, input: unknown) {
    const customerId = customerIdentity(principal);
    const data = parseInput(holdInput, input);
    const start = new Date(data.requestedStartAt),
      end = new Date(data.requestedEndAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
      throw new BadRequestException('INVALID_INTERVAL');
    const hash = fingerprint({
      ...data,
      requestedStartAt: start.toISOString(),
      requestedEndAt: end.toISOString(),
    });
    return this.transaction(async (tx) => {
      await this.customerLock(tx, customerId);
      const prior = await tx.bookingHold.findUnique({
        where: {
          customerId_idempotencyKey: {
            customerId,
            idempotencyKey: data.idempotencyKey,
          },
        },
        include: { reservation: true },
      });
      if (prior) {
        if (prior.requestFingerprint !== hash)
          throw new BookingConflict('IDEMPOTENCY_CONFLICT');
        if (
          prior.status !== 'ACTIVE' ||
          prior.reservation.state !== 'HOLD' ||
          !prior.reservation.expiresAt ||
          prior.reservation.expiresAt <= (await databaseTime(tx))
        )
          throw new BookingConflict('HOLD_NOT_ACTIVE');
        return prior;
      }
      const resource = await tx.bookingResource.findUnique({
        where: { key: data.resourceKey },
      });
      if (!resource?.active) throw new BadRequestException('INVALID_RESOURCE');
      const previous = await tx.bookingReservation.findMany({
        where: { customerId, state: 'HOLD' },
      });
      const resourceIds = [resource.id, ...previous.map((r) => r.resourceId)];
      await this.resourceLocks(tx, resourceIds);
      if (
        !(
          await tx.bookingResource.findUniqueOrThrow({
            where: { id: resource.id },
          })
        ).active
      )
        throw new BookingConflict('RESOURCE_UNAVAILABLE');
      const now = await databaseTime(tx);
      validateInterval(start, end, data.timezone, now, this.policy);
      const module = await this.solution(tx, data.moduleKey);
      await this.reclaimExpired(tx, resourceIds, now);
      // Slot replacement is all-or-nothing: on new-slot conflict the old hold
      // and its ledger row remain blocking because this transaction rolls back.
      await tx.bookingReservation.updateMany({
        where: { customerId, state: 'HOLD' },
        data: { state: 'RELEASED', releasedAt: now },
      });
      await tx.bookingHold.updateMany({
        where: { customerId, status: 'ACTIVE' },
        data: { status: 'RELEASED' },
      });
      const busyStartAt = new Date(
        start.getTime() - this.policy.bufferBefore * 60000,
      );
      const busyEndAt = new Date(
        end.getTime() + this.policy.bufferAfter * 60000,
      );
      await this.assertFree(tx, resource.id, busyStartAt, busyEndAt, now);
      const reservation = await tx.bookingReservation.create({
        data: {
          customerId,
          resourceId: resource.id,
          requestedStartAt: start,
          requestedEndAt: end,
          busyStartAt,
          busyEndAt,
          timezone: data.timezone,
          expiresAt: new Date(now.getTime() + this.policy.holdMinutes * 60000),
        },
      });
      return tx.bookingHold.create({
        data: {
          customerId,
          reservationId: reservation.id,
          moduleKey: data.moduleKey,
          solutionLabel: module,
          idempotencyKey: data.idempotencyKey,
          requestFingerprint: hash,
        },
        include: { reservation: true },
      });
    });
  }

  private async solution(
    tx: Prisma.TransactionClient,
    key: string,
  ): Promise<string> {
    const page = await tx.page.findUnique({
      where: { slug: 'solutions' },
      include: {
        sections: {
          where: { type: 'solutionModules', enabled: true },
          include: { translations: true },
        },
      },
    });
    if (page?.status !== 'PUBLISHED')
      throw new BadRequestException('INVALID_SOLUTION');
    const content = page.sections[0]?.translations.find(
      (t) => t.locale === 'vi',
    )?.content as { items?: { key?: string; title?: string }[] } | undefined;
    const module = content?.items?.find((item) => item.key === key);
    if (!module?.title || module.title.length > 240)
      throw new BadRequestException('INVALID_SOLUTION');
    return module.title;
  }

  private async assertFree(
    tx: Prisma.TransactionClient,
    resourceId: string,
    start: Date,
    end: Date,
    now: Date,
  ) {
    const conflict = await tx.bookingReservation.findFirst({
      where: {
        resourceId,
        busyStartAt: { lt: end },
        busyEndAt: { gt: start },
        OR: [{ state: 'BOOKING' }, { state: 'HOLD', expiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    if (conflict) throw new BookingConflict('SLOT_UNAVAILABLE');
  }

  async releaseHold(principal: CustomerPrincipal, holdId: string) {
    const customerId = customerIdentity(principal);
    return this.transaction(async (tx) => {
      await this.customerLock(tx, customerId);
      const hold = await tx.bookingHold.findFirst({
        where: { id: holdId, customerId },
        include: { reservation: true },
      });
      if (!hold) throw new NotFoundException('Hold not found');
      await this.resourceLocks(tx, [hold.reservation.resourceId]);
      if (hold.status !== 'ACTIVE') return { released: true };
      const now = await databaseTime(tx);
      if (hold.reservation.state === 'HOLD')
        await tx.bookingReservation.update({
          where: { id: hold.reservationId },
          data: { state: 'RELEASED', releasedAt: now },
        });
      await tx.bookingHold.update({
        where: { id: hold.id },
        data: {
          status: hold.reservation.expiresAt! <= now ? 'EXPIRED' : 'RELEASED',
        },
      });
      return { released: true };
    });
  }

  async finalize(principal: CustomerPrincipal, input: unknown) {
    const customerId = customerIdentity(principal);
    const data = parseInput(finalizeInput, input),
      hash = fingerprint(data);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.adminEmail))
      throw new BadRequestException(
        'Booking notification configuration unavailable',
      );
    return this.transaction(async (tx) => {
      const customer = await this.customerLock(tx, customerId);
      const previous = await tx.booking.findUnique({
        where: {
          customerId_idempotencyKey: {
            customerId,
            idempotencyKey: data.idempotencyKey,
          },
        },
        include: { reservation: true },
      });
      if (previous) {
        if (previous.requestFingerprint !== hash)
          throw new BookingConflict('IDEMPOTENCY_CONFLICT');
        return previous;
      }
      const hold = await tx.bookingHold.findFirst({
        where: { id: data.holdId, customerId },
        include: { reservation: true, booking: true },
      });
      if (!hold) throw new NotFoundException('Hold not found');
      await this.resourceLocks(tx, [hold.reservation.resourceId]);
      const now = await databaseTime(tx);
      if (hold.reservation.expiresAt && hold.reservation.expiresAt <= now)
        throw new BookingConflict('HOLD_EXPIRED');
      if (
        hold.status !== 'ACTIVE' ||
        hold.reservation.state !== 'HOLD' ||
        hold.booking
      )
        throw new BookingConflict('HOLD_NOT_ACTIVE');
      const resource = await tx.bookingResource.findUniqueOrThrow({
        where: { id: hold.reservation.resourceId },
      });
      if (!resource.active) throw new BookingConflict('RESOURCE_UNAVAILABLE');
      validateInterval(
        hold.reservation.requestedStartAt,
        hold.reservation.requestedEndAt,
        hold.reservation.timezone,
        now,
        this.policy,
      );
      const booking = await tx.booking.create({
        data: {
          customerId,
          reservationId: hold.reservationId,
          holdId: hold.id,
          contactName: data.contactName,
          contactEmail: customer.email,
          contactPhone: data.contactPhone,
          contactCompany: data.contactCompany,
          customerMessage: data.customerMessage,
          moduleKey: hold.moduleKey,
          solutionLabel: hold.solutionLabel,
          locale: data.locale,
          idempotencyKey: data.idempotencyKey,
          requestFingerprint: hash,
        },
        include: { reservation: true },
      });
      // Promote the exact same row, preserving the exclusion constraint and
      // occupancy throughout conversion. Never delete/reinsert the reservation.
      await tx.bookingReservation.update({
        where: { id: hold.reservationId },
        data: { state: 'BOOKING', expiresAt: null },
      });
      await tx.bookingHold.update({
        where: { id: hold.id },
        data: { status: 'CONVERTED' },
      });
      const event = await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          sequence: 1,
          type: 'CREATED',
          toStatus: 'PENDING',
        },
      });
      for (const [audience, recipient] of [
        ['CUSTOMER', customer.email],
        ['ADMIN', this.adminEmail],
      ]) {
        await this.notifications.enqueue(tx, {
          deduplicationKey: `booking:${event.id}:${audience}`,
          customerId,
          bookingId: booking.id,
          eventId: event.id,
          template: `BOOKING_CREATED_${audience}`,
          recipient,
          locale: data.locale,
          payload: { bookingId: booking.id },
        });
      }
      return {
        ...booking,
        reservation: {
          ...booking.reservation,
          state: 'BOOKING' as const,
          expiresAt: null,
        },
      };
    });
  }

  async transition(adminUserId: string, bookingId: string, input: unknown) {
    const data = parseInput(transitionInput, input);
    const result = await this.transaction(async (tx) => {
      const admin = await tx.user.findUnique({ where: { id: adminUserId } });
      if (!admin?.active || admin.role !== UserRole.ADMIN)
        throw new ForbiddenException('Admin required');
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE`;
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { reservation: true },
      });
      if (!booking) throw new NotFoundException('Booking not found');
      await this.resourceLocks(tx, [booking.reservation.resourceId]);
      const now = await databaseTime(tx);
      if (booking.version !== data.expectedVersion)
        throw new BookingConflict('STALE_BOOKING');
      assertTransition(
        booking.status,
        data.toStatus,
        now,
        booking.reservation.requestedStartAt,
        booking.reservation.requestedEndAt,
      );
      if (data.toStatus === 'CANCELLED' && !data.reason)
        throw new BadRequestException('Cancellation reason required');
      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: data.toStatus,
          version: { increment: 1 },
          ...(data.toStatus === 'CONFIRMED'
            ? { confirmedAt: now, meetingUrl: data.meetingUrl }
            : {}),
          ...(data.toStatus === 'CANCELLED' ? { cancelledAt: now } : {}),
          ...(data.toStatus === 'COMPLETED' ? { completedAt: now } : {}),
        },
      });
      if (data.toStatus === 'CANCELLED')
        await tx.bookingReservation.update({
          where: { id: booking.reservationId },
          data: { state: 'RELEASED', releasedAt: now },
        });
      const event = await tx.bookingEvent.create({
        data: {
          bookingId,
          sequence: updated.version,
          type: 'STATUS_CHANGED',
          fromStatus: booking.status,
          toStatus: data.toStatus,
          actorUserId: adminUserId,
          reason: data.reason,
        },
      });
      if (['CONFIRMED', 'CANCELLED'].includes(data.toStatus))
        await this.notifications.enqueue(tx, {
          deduplicationKey: `booking:${event.id}:CUSTOMER`,
          customerId: booking.customerId,
          bookingId,
          eventId: event.id,
          template: `BOOKING_${data.toStatus}_CUSTOMER`,
          recipient: booking.contactEmail,
          locale: booking.locale,
          payload: {
            bookingId,
            contactName: booking.contactName,
            solution: booking.solutionLabel,
            requestedStartAt:
              booking.reservation.requestedStartAt.toISOString(),
            requestedEndAt: booking.reservation.requestedEndAt.toISOString(),
            timezone: booking.reservation.timezone,
            meetingUrl: updated.meetingUrl,
          },
        });
      return updated;
    });
    // Commit cancellation first: provider cleanup cannot roll back business state.
    if (data.toStatus === 'CANCELLED' && result.externalCalendarEventId)
      await this.calendar?.cancelEvent(result.externalCalendarEventId);
    return result;
  }

  createGoogleMeet(adminUserId: string, bookingId: string) {
    if (!this.calendar)
      throw new BadRequestException('Google Calendar unavailable');
    return this.calendar.createMeeting(adminUserId, bookingId);
  }

  async ownBooking(principal: CustomerPrincipal, bookingId: string) {
    const booking = await this.db.booking.findFirst({
      where: { id: bookingId, customerId: customerIdentity(principal) },
      include: { reservation: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return {
      id: booking.id,
      status: booking.status,
      solution: booking.solutionLabel,
      requestedStartAt: booking.reservation.requestedStartAt,
      requestedEndAt: booking.reservation.requestedEndAt,
      timezone: booking.reservation.timezone,
      meetingUrl: booking.meetingUrl,
      contactName: booking.contactName,
      contactCompany: booking.contactCompany,
    };
  }

  async ownBookings(
    principal: CustomerPrincipal,
    page = 1,
    period?: 'upcoming' | 'past',
    range: { from?: string; to?: string } = {},
  ) {
    const customerId = customerIdentity(principal);
    if (
      !!range.from !== !!range.to ||
      (range.from && range.to && new Date(range.to) <= new Date(range.from))
    )
      throw new BadRequestException('Invalid date range');
    const now = await this.transaction(databaseTime);
    const where: Prisma.BookingWhereInput = {
      customerId,
      ...(range.from && range.to
        ? {
            AND: [
              {
                reservation: {
                  requestedStartAt: { lt: new Date(range.to) },
                  requestedEndAt: { gt: new Date(range.from) },
                },
              },
            ],
          }
        : {}),
      ...(period === 'upcoming'
        ? {
            status: { in: ['PENDING', 'CONFIRMED'] },
            reservation: { requestedEndAt: { gt: now } },
          }
        : period === 'past'
          ? {
              OR: [
                { status: { in: ['CANCELLED', 'COMPLETED', 'NO_SHOW'] } },
                { reservation: { requestedEndAt: { lte: now } } },
              ],
            }
          : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.booking.findMany({
        where,
        include: { reservation: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * 25,
        take: 25,
      }),
      this.db.booking.count({ where }),
    ]);
    return {
      items: rows.map((b) => ({
        id: b.id,
        status: b.status,
        solution: b.solutionLabel,
        requestedStartAt: b.reservation.requestedStartAt,
        requestedEndAt: b.reservation.requestedEndAt,
        timezone: b.reservation.timezone,
        contactName: b.contactName,
        contactCompany: b.contactCompany,
        meetingUrl: b.meetingUrl,
      })),
      total,
      page,
    };
  }

  holdView(hold: {
    id: string;
    moduleKey: string;
    solutionLabel: string;
    reservation: {
      requestedStartAt: Date;
      requestedEndAt: Date;
      expiresAt: Date | null;
      timezone: string;
    };
  }) {
    return {
      id: hold.id,
      moduleKey: hold.moduleKey,
      solution: hold.solutionLabel,
      requestedStartAt: hold.reservation.requestedStartAt,
      requestedEndAt: hold.reservation.requestedEndAt,
      expiresAt: hold.reservation.expiresAt,
      timezone: hold.reservation.timezone,
    };
  }

  async currentHold(principal: CustomerPrincipal) {
    const customerId = customerIdentity(principal);
    return this.transaction(async (tx) => {
      const now = await databaseTime(tx);
      const hold = await tx.bookingHold.findFirst({
        where: {
          customerId,
          status: 'ACTIVE',
          reservation: { state: 'HOLD', expiresAt: { gt: now } },
        },
        include: { reservation: true },
      });
      return { hold: hold ? this.holdView(hold) : null, serverNow: now };
    });
  }

  async options() {
    const page = await this.db.page.findUnique({
      where: { slug: 'solutions' },
      include: {
        sections: {
          where: { type: 'solutionModules', enabled: true },
          include: { translations: true },
        },
      },
    });
    const content =
      page?.status === 'PUBLISHED'
        ? (page.sections[0]?.translations.find((t) => t.locale === 'vi')
            ?.content as { items?: { key?: string; title?: string }[] })
        : null;
    const en =
      page?.status === 'PUBLISHED'
        ? (page.sections[0]?.translations.find((t) => t.locale === 'en')
            ?.content as { items?: { key?: string; title?: string }[] })
        : null;
    return {
      policy: this.policy,
      modules: (content?.items ?? [])
        .filter((m) => m.key && m.title && m.title.length <= 240)
        .map((m) => ({
          key: m.key,
          vi: m.title,
          en: en?.items?.find((e) => e.key === m.key)?.title ?? m.title,
        })),
    };
  }

  async adminList(input: unknown) {
    const query = parseInput(
      z
        .object({
          search: z.string().trim().max(120).optional(),
          status: z
            .enum(['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'])
            .optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          page: z.coerce.number().int().min(1).max(10000).default(1),
        })
        .strict(),
      input,
    );
    if (query.from && query.to && new Date(query.to) <= new Date(query.from))
      throw new BadRequestException('Invalid date range');
    const where: Prisma.BookingWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            reservation: {
              requestedStartAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lt: new Date(query.to) } : {}),
              },
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              'contactName',
              'contactEmail',
              'contactPhone',
              'contactCompany',
              'solutionLabel',
            ].map((field) => ({
              [field]: { contains: query.search, mode: 'insensitive' },
            })),
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.booking.findMany({
        where,
        include: { reservation: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 25,
        skip: (query.page - 1) * 25,
      }),
      this.db.booking.count({ where }),
    ]);
    return {
      items: rows.map((b) => ({
        id: b.id,
        contactName: b.contactName,
        contactEmail: b.contactEmail,
        contactCompany: b.contactCompany,
        solution: b.solutionLabel,
        status: b.status,
        requestedStartAt: b.reservation.requestedStartAt,
        requestedEndAt: b.reservation.requestedEndAt,
      })),
      total,
      page: query.page,
    };
  }

  async adminDetail(id: string) {
    const b = await this.db.booking.findUnique({
      where: { id },
      include: {
        reservation: true,
        events: { orderBy: { sequence: 'asc' } },
        notes: { orderBy: { createdAt: 'asc' } },
        notifications: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            template: true,
            status: true,
            attempts: true,
            nextAttemptAt: true,
            sentAt: true,
            lastErrorCode: true,
          },
        },
      },
    });
    if (!b) throw new NotFoundException('Booking not found');
    return {
      id: b.id,
      status: b.status,
      version: b.version,
      solution: b.solutionLabel,
      contactName: b.contactName,
      contactEmail: b.contactEmail,
      contactPhone: b.contactPhone,
      contactCompany: b.contactCompany,
      customerMessage: b.customerMessage,
      requestedStartAt: b.reservation.requestedStartAt,
      requestedEndAt: b.reservation.requestedEndAt,
      timezone: b.reservation.timezone,
      events: b.events,
      notes: b.notes,
      notifications: b.notifications,
      meetingUrl: b.meetingUrl,
      externalCalendarEventId: b.externalCalendarEventId,
    };
  }

  async addNote(adminUserId: string, bookingId: string, input: unknown) {
    const { text } = parseInput(
      z.object({ text: z.string().trim().min(1).max(2000) }).strict(),
      input,
    );
    return this.transaction(async (tx) => {
      const admin = await tx.user.findUnique({ where: { id: adminUserId } });
      if (!admin?.active || admin.role !== UserRole.ADMIN)
        throw new ForbiddenException('Admin required');
      if (!(await tx.booking.findUnique({ where: { id: bookingId } })))
        throw new NotFoundException('Booking not found');
      return tx.bookingNote.create({
        data: { bookingId, authorUserId: adminUserId, text },
      });
    });
  }

  async unavailable(resourceKey: string, from: Date, to: Date) {
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      to <= from ||
      to.getTime() - from.getTime() > 43 * 86400000
    )
      throw new BadRequestException('Invalid range');
    return this.transaction(async (tx) => {
      const now = await databaseTime(tx);
      const rows = await tx.bookingReservation.findMany({
        where: {
          resource: { key: resourceKey, active: true },
          busyStartAt: { lt: to },
          busyEndAt: { gt: from },
          OR: [{ state: 'BOOKING' }, { state: 'HOLD', expiresAt: { gt: now } }],
        },
        orderBy: { busyStartAt: 'asc' },
        select: { busyStartAt: true, busyEndAt: true },
      });
      const periods: { start: Date; end: Date; available: false }[] = [];
      for (const row of rows) {
        const start = new Date(
          Math.max(from.getTime(), row.busyStartAt.getTime()),
        );
        const end = new Date(Math.min(to.getTime(), row.busyEndAt.getTime()));
        const last = periods.at(-1);
        if (last && start <= last.end)
          last.end = new Date(Math.max(last.end.getTime(), end.getTime()));
        else periods.push({ start, end, available: false });
      }
      return periods;
    });
  }

  async availability(
    resourceKey: string,
    from: Date,
    to: Date,
    durationMinutes: number,
  ) {
    if (!this.policy.durations.includes(durationMinutes))
      throw new BadRequestException('Invalid duration');
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      to <= from ||
      to.getTime() - from.getTime() > 42 * 86400000
    )
      throw new BadRequestException('Invalid range');
    const resource = await this.db.bookingResource.findUnique({
      where: { key: resourceKey },
    });
    if (!resource?.active) throw new NotFoundException('Resource not found');
    const busy = await this.unavailable(
      resourceKey,
      new Date(from.getTime() - this.policy.bufferBefore * 60000),
      new Date(to.getTime() + this.policy.bufferAfter * 60000),
    );
    const now = await this.transaction(databaseTime);
    const periods: { start: Date; end: Date; available: boolean }[] = [];
    // Fixed 15-minute candidate grid supports the approved 30/45/60 durations.
    for (
      let stamp = Math.ceil(from.getTime() / 900000) * 900000;
      stamp + durationMinutes * 60000 <= to.getTime();
      stamp += 900000
    ) {
      const start = new Date(stamp),
        end = new Date(stamp + durationMinutes * 60000);
      try {
        validateInterval(start, end, this.policy.timezone, now, this.policy);
      } catch (error) {
        if (error instanceof BadRequestException) continue;
        throw error;
      }
      const busyStart = new Date(stamp - this.policy.bufferBefore * 60000);
      const busyEnd = new Date(end.getTime() + this.policy.bufferAfter * 60000);
      periods.push({
        start,
        end,
        available: !busy.some((p) => busyStart < p.end && busyEnd > p.start),
      });
    }
    return { timezone: this.policy.timezone, periods, busy, serverNow: now };
  }
}
