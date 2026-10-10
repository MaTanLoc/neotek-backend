import { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { Resend } from 'resend';
import { z } from 'zod';
import { EmailProvider } from './notification.service';

type Message = Parameters<EmailProvider['send']>[0];
const mailbox = (value: string) =>
  z.email().safeParse(value.match(/^[^<>\r\n]+ <([^<>\r\n]+)>$/)?.[1] ?? value)
    .success;
export function validateEmailConfiguration(env = process.env) {
  const mode = env.EMAIL_PROVIDER || 'disabled';
  if (!['disabled', 'dev', 'resend'].includes(mode))
    throw new Error('Invalid EMAIL_PROVIDER');
  if (env.NODE_ENV === 'production' && mode !== 'resend')
    throw new Error('Production requires a real email transport');
  if (mode === 'dev' && !env.EMAIL_DEV_DIRECTORY)
    throw new Error(
      'Dev mail requires an explicit private EMAIL_DEV_DIRECTORY',
    );
  if (
    mode === 'resend' &&
    (!env.RESEND_API_KEY?.trim() ||
      !mailbox(env.EMAIL_FROM ?? '') ||
      !!(env.EMAIL_REPLY_TO && !mailbox(env.EMAIL_REPLY_TO)))
  )
    throw new Error(
      'Resend requires RESEND_API_KEY, valid EMAIL_FROM and valid optional EMAIL_REPLY_TO',
    );
}

export class ConfiguredEmailProvider implements EmailProvider {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
    validateEmailConfiguration();
  }
  async render(message: Message) {
    const en = message.locale === 'en';
    if (message.template === 'EMAIL_TRANSPORT_TEST')
      return {
        subject: 'NeoTek email delivery test',
        text: 'This is a manually requested NeoTek email transport test. No booking or account was changed.',
      };
    if (message.template === 'CUSTOMER_PASSWORD_RESET') {
      if (!message.passwordResetToken)
        throw new Error('Missing password reset token');
      const url = new URL(
        `${en ? '/en' : ''}/reset-password`,
        process.env.FRONTEND_URL!,
      );
      url.hash = `token=${message.passwordResetToken}`;
      return {
        subject: en ? 'Reset your NeoTek password' : 'Đặt lại mật khẩu NeoTek',
        text: `${en ? 'Use this link to choose a new password. The link expires shortly and works once. If you did not request this, ignore this email.' : 'Dùng liên kết này để đặt mật khẩu mới. Liên kết có thời hạn và chỉ dùng được một lần. Nếu không yêu cầu, bạn có thể bỏ qua email này.'}\n${url.href}`,
      };
    }
    if (message.template === 'CUSTOMER_EMAIL_VERIFICATION') {
      if (!message.verificationToken)
        throw new Error('Missing verification token');
      const origin = process.env.FRONTEND_URL!;
      const url = new URL(`${en ? '/en' : ''}/verify-email`, origin);
      // Fragment keeps the bearer token out of HTTP/access logs and referrers.
      url.hash = `token=${message.verificationToken}`;
      return {
        subject: en ? 'Verify your NeoTek email' : 'Xác minh email NeoTek',
        text: `${en ? 'Confirm your email using this link. It expires in one hour:' : 'Xác minh email qua liên kết sau. Liên kết có hiệu lực trong một giờ:'}\n${url.href}`,
      };
    }
    const payload = message.payload as {
      bookingId?: string;
      contactName?: string;
      solution?: string;
      requestedStartAt?: string;
      requestedEndAt?: string;
      timezone?: string;
      meetingUrl?: string | null;
    };
    const booking = await this.db.booking.findUnique({
      where: { id: payload.bookingId ?? '' },
      include: { reservation: true },
    });
    if (!booking) throw new Error('Booking missing');
    const subjects: Record<string, [string, string]> = {
      BOOKING_CREATED_CUSTOMER: [
        'Đã nhận yêu cầu đặt lịch NeoTek',
        'NeoTek booking request received',
      ],
      BOOKING_CREATED_ADMIN: [
        'Yêu cầu đặt lịch NeoTek mới',
        'New NeoTek booking request',
      ],
      BOOKING_CONFIRMED_CUSTOMER: [
        'Lịch hẹn NeoTek đã được xác nhận',
        'NeoTek booking confirmed',
      ],
      BOOKING_CANCELLED_CUSTOMER: [
        'Lịch hẹn NeoTek đã được hủy',
        'NeoTek booking cancelled',
      ],
    };
    const subject = subjects[message.template]?.[en ? 1 : 0];
    if (!subject) throw new Error('Unknown email template');
    // Status emails render their immutable event snapshot; older intents fall back to the booking.
    const startAt = payload.requestedStartAt
      ? new Date(payload.requestedStartAt)
      : booking.reservation.requestedStartAt;
    const endAt = payload.requestedEndAt
      ? new Date(payload.requestedEndAt)
      : booking.reservation.requestedEndAt;
    const timezone = payload.timezone ?? booking.reservation.timezone;
    const start = startAt.toLocaleString(en ? 'en-GB' : 'vi-VN', {
      timeZone: timezone,
    });
    const minutes = (endAt.getTime() - startAt.getTime()) / 60000;
    const end = endAt.toLocaleTimeString(en ? 'en-GB' : 'vi-VN', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    });
    const meetingUrl =
      payload.meetingUrl === undefined
        ? booking.meetingUrl
        : payload.meetingUrl;
    const path = message.template.endsWith('_ADMIN')
      ? '/admin/bookings'
      : `${en ? '/en' : ''}/account/bookings`;
    return {
      subject,
      text: `${subject}\n${payload.contactName ?? booking.contactName}\n${payload.solution ?? booking.solutionLabel}\n${start} – ${end} (${timezone})\n${minutes} ${en ? 'minutes' : 'phút'}${message.template === 'BOOKING_CONFIRMED_CUSTOMER' && meetingUrl ? `\nGoogle Meet: ${meetingUrl}` : ''}\n${new URL(path, process.env.FRONTEND_URL!).href}`,
    };
  }
  async send(message: Message) {
    const mode = process.env.EMAIL_PROVIDER || 'disabled';
    if (mode === 'disabled') throw new Error('Email transport disabled');
    const content = await this.render(message);
    if (mode === 'dev') {
      if (process.env.NODE_ENV === 'production')
        throw new Error('Dev transport forbidden');
      const directory = resolve(process.env.EMAIL_DEV_DIRECTORY!);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const id = createHash('sha256')
        .update(message.idempotencyKey)
        .digest('hex');
      await writeFile(
        join(directory, `${id}.json`),
        JSON.stringify({ to: message.recipient, ...content }),
        { mode: 0o600 },
      );
      return { messageId: `dev:${id}` };
    }
    const { data, error } = await new Resend(
      process.env.RESEND_API_KEY,
    ).emails.send(
      {
        from: process.env.EMAIL_FROM!,
        to: [message.recipient],
        subject: content.subject,
        text: content.text,
        ...(process.env.EMAIL_REPLY_TO
          ? { replyTo: process.env.EMAIL_REPLY_TO }
          : {}),
      },
      {
        idempotencyKey: message.idempotencyKey,
        signal: globalThis.AbortSignal.timeout(8000),
      },
    );
    // Do not propagate provider error objects into outbox records or application errors.
    if (error) throw new Error('Email provider rejected delivery');
    if (typeof data?.id !== 'string' || !data.id)
      throw new Error('Invalid provider response');
    return { messageId: data.id };
  }
}
