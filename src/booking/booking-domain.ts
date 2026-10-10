import { BookingStatus, Prisma } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export type CustomerPrincipal = { realm: 'customer'; customerId: string };
export function customerIdentity(principal: CustomerPrincipal): string {
  if (principal?.realm !== 'customer' || !principal.customerId)
    throw new ForbiddenException('Customer authentication required');
  return principal.customerId;
}

export class BookingConflict extends ConflictException {
  constructor(code: string) {
    super(code);
  }
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException('Invalid input');
  return result.data;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function databaseTime(
  tx: Prisma.TransactionClient,
): Promise<Date> {
  const [row] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  return row.now;
}

const transitions: Record<BookingStatus, BookingStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};
export function assertTransition(
  from: BookingStatus,
  to: BookingStatus,
  now: Date,
  start: Date,
  end: Date,
): void {
  if (!transitions[from].includes(to))
    throw new BookingConflict('INVALID_TRANSITION');
  if (to === 'CONFIRMED' && now >= start)
    throw new BookingConflict('BOOKING_ALREADY_STARTED');
  if (to === 'COMPLETED' && now < end)
    throw new BookingConflict('BOOKING_NOT_ENDED');
}

export const holdInput = z
  .object({
    resourceKey: z.string().min(1).max(80),
    requestedStartAt: z.iso.datetime({ offset: true }),
    requestedEndAt: z.iso.datetime({ offset: true }),
    timezone: z.string().max(80),
    moduleKey: z.string().min(1).max(120),
    idempotencyKey: z.string().min(16).max(80),
  })
  .strict();
export const finalizeInput = z
  .object({
    holdId: z.string().min(1).max(80),
    contactName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine(
        (value) =>
          !Array.from(value).some(
            (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
          ),
      ),
    contactPhone: z
      .string()
      .trim()
      .min(7)
      .max(32)
      .regex(/^\+?[0-9 () .-]+$/)
      .refine((value) => value.replace(/\D/g, '').length >= 7),
    contactCompany: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine(
        (value) =>
          !Array.from(value).some(
            (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
          ),
      ),
    customerMessage: z.string().trim().max(2000).optional(),
    locale: z.enum(['vi', 'en']),
    idempotencyKey: z.string().min(16).max(80),
  })
  .strict();
export const transitionInput = z
  .object({
    toStatus: z.enum(['CONFIRMED', 'COMPLETED', 'CANCELLED']),
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1000).optional(),
    meetingUrl: z
      .string()
      .trim()
      .max(200)
      .regex(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
      .optional(),
  })
  .strict()
  .refine((data) => data.toStatus !== 'CONFIRMED' || !!data.meetingUrl)
  .refine(
    (data) => data.toStatus === 'CONFIRMED' || data.meetingUrl === undefined,
  );
