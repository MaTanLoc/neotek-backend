import { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { EmailProvider } from './notification.service';

type Message = Parameters<EmailProvider['send']>[0];
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
    (!env.RESEND_API_KEY ||
      !env.EMAIL_FROM ||
      /[\r\n]/.test(env.EMAIL_FROM + (env.EMAIL_REPLY_TO ?? '')))
  )
    throw new Error('Email provider configuration missing');
}

export class ConfiguredEmailProvider implements EmailProvider {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
    validateEmailConfiguration();
  }
  async render(message: Message) {
    const en = message.locale === 'en';
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
    const payload = message.payload as { bookingId?: string };
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
    const start = booking.reservation.requestedStartAt.toLocaleString(
      en ? 'en-GB' : 'vi-VN',
      { timeZone: booking.reservation.timezone },
    );
    const minutes =
      (booking.reservation.requestedEndAt.getTime() -
        booking.reservation.requestedStartAt.getTime()) /
      60000;
    const path = message.template.endsWith('_ADMIN')
      ? '/admin/bookings'
      : `${en ? '/en' : ''}/account/bookings`;
    return {
      subject,
      text: `${subject}\n${booking.solutionLabel}\n${start} (${booking.reservation.timezone})\n${minutes} ${en ? 'minutes' : 'phút'}\n${new URL(path, process.env.FRONTEND_URL!).href}`,
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
    const response = await globalThis.fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: globalThis.AbortSignal.timeout(8000),
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': message.idempotencyKey,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [message.recipient],
        subject: content.subject,
        text: content.text,
        ...(process.env.EMAIL_REPLY_TO
          ? { reply_to: process.env.EMAIL_REPLY_TO }
          : {}),
      }),
    });
    if (!response.ok) throw new Error('Email provider rejected delivery');
    const body = (await response.json()) as { id?: string };
    if (typeof body.id !== 'string')
      throw new Error('Invalid provider response');
    return { messageId: body.id };
  }
}
