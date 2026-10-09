import { BadRequestException } from '@nestjs/common';
import { parseInput } from './booking-domain';
import { z } from 'zod';

const minute = z.coerce.number().int().min(0).max(1440);
const policySchema = z
  .object({
    timezone: z.literal('Asia/Ho_Chi_Minh'),
    workingDays: z.array(z.number().int().min(0).max(6)).min(1),
    startMinute: minute,
    endMinute: minute,
    durations: z.array(z.number().int().min(15).max(480)).min(1),
    leadMinutes: z.coerce.number().int().min(0).max(43200),
    horizonDays: z.coerce.number().int().min(1).max(365),
    bufferBefore: z.coerce.number().int().min(0).max(120),
    bufferAfter: z.coerce.number().int().min(0).max(120),
    holdMinutes: z.coerce.number().int().min(10).max(15),
  })
  .refine((p) => p.endMinute > p.startMinute);

export type BookingPolicy = z.infer<typeof policySchema>;
export function bookingPolicy(
  env: Record<string, string | undefined> = process.env,
): BookingPolicy {
  const numbers = (value: string | undefined, fallback: string) =>
    (value ?? fallback).split(',').map(Number);
  return parseInput(policySchema, {
    timezone: env.BOOKING_TIMEZONE ?? 'Asia/Ho_Chi_Minh',
    workingDays: numbers(env.BOOKING_WORKING_DAYS, '1,2,3,4,5'),
    startMinute: env.BOOKING_START_MINUTE ?? 480,
    endMinute: env.BOOKING_END_MINUTE ?? 1080,
    durations: numbers(env.BOOKING_DURATIONS, '30,45,60'),
    leadMinutes: env.BOOKING_LEAD_MINUTES ?? 60,
    horizonDays: env.BOOKING_HORIZON_DAYS ?? 90,
    bufferBefore: env.BOOKING_BUFFER_BEFORE ?? 0,
    bufferAfter: env.BOOKING_BUFFER_AFTER ?? 0,
    holdMinutes: env.BOOKING_HOLD_MINUTES ?? 10,
  });
}

// V1 deliberately supports the approved fixed UTC+07 zone only. Adding a DST
// zone requires a real timezone conversion implementation, not guessed offsets.
export function validateInterval(
  start: Date,
  end: Date,
  timezone: string,
  now: Date,
  policy: BookingPolicy,
): void {
  const duration = (end.getTime() - start.getTime()) / 60000;
  const localStart = new Date(start.getTime() + 7 * 3600000);
  const localEnd = new Date(end.getTime() + 7 * 3600000);
  const minuteOf = (date: Date) =>
    date.getUTCHours() * 60 + date.getUTCMinutes();
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    timezone !== policy.timezone ||
    !policy.durations.includes(duration) ||
    !policy.workingDays.includes(localStart.getUTCDay()) ||
    localStart.toISOString().slice(0, 10) !==
      localEnd.toISOString().slice(0, 10) ||
    minuteOf(localStart) < policy.startMinute ||
    minuteOf(localEnd) > policy.endMinute ||
    start.getUTCSeconds() !== 0 ||
    start.getUTCMilliseconds() !== 0 ||
    start.getTime() < now.getTime() + policy.leadMinutes * 60000 ||
    end.getTime() > now.getTime() + policy.horizonDays * 86400000
  )
    throw new BadRequestException('INVALID_INTERVAL');
}
