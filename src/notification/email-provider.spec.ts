/* global afterEach, Response, Headers, console */
import { PrismaService } from '../prisma/prisma.service';
import {
  ConfiguredEmailProvider,
  validateEmailConfiguration,
} from './email-provider';

describe('Configured email transport', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env = {
      ...previous,
      NODE_ENV: 'test',
      EMAIL_PROVIDER: 'disabled',
      FRONTEND_URL: 'http://localhost:5173',
    };
  });
  afterEach(() => {
    process.env = { ...previous };
  });
  it('never permits disabled/dev transport in production', () => {
    expect(() =>
      validateEmailConfiguration({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'disabled',
      }),
    ).toThrow();
    expect(() =>
      validateEmailConfiguration({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'dev',
      }),
    ).toThrow();
    expect(() =>
      validateEmailConfiguration({ EMAIL_PROVIDER: 'dev' }),
    ).toThrow();
    expect(() =>
      validateEmailConfiguration({ EMAIL_PROVIDER: 'resend' }),
    ).toThrow();
  });
  it('disabled transport fails instead of claiming delivery', async () => {
    const provider = new ConfiguredEmailProvider({} as PrismaService);
    await expect(
      provider.send({
        template: 'CUSTOMER_EMAIL_VERIFICATION',
        recipient: 'a@example.test',
        locale: 'en',
        payload: {},
        idempotencyKey: 'test',
        verificationToken: 'secret',
      }),
    ).rejects.toThrow('disabled');
  });
  it('renders a localized verification link with token only in fragment', async () => {
    const provider = new ConfiguredEmailProvider({} as PrismaService);
    const message = await provider.render({
      template: 'CUSTOMER_EMAIL_VERIFICATION',
      recipient: 'a@example.test',
      locale: 'en',
      payload: {},
      idempotencyKey: 'test',
      verificationToken: 'secret',
    });
    expect(message.text).toContain(
      'http://localhost:5173/en/verify-email#token=secret',
    );
    expect(message.text).not.toContain('?token=');
  });
  it('renders reset links in both locales with a separate fragment token', async () => {
    const provider = new ConfiguredEmailProvider({} as PrismaService);
    for (const locale of ['vi', 'en']) {
      const rendered = await provider.render({
        template: 'CUSTOMER_PASSWORD_RESET',
        recipient: 'a@example.test',
        locale,
        payload: {},
        idempotencyKey: 'reset',
        passwordResetToken: 'reset-secret',
      });
      expect(rendered.text).toContain(
        `http://localhost:5173${locale === 'en' ? '/en' : ''}/reset-password#token=reset-secret`,
      );
      expect(rendered.text).not.toContain('?token=');
    }
    await expect(
      provider.render({
        template: 'CUSTOMER_PASSWORD_RESET',
        recipient: 'a@example.test',
        locale: 'en',
        payload: {},
        idempotencyKey: 'reset',
      }),
    ).rejects.toThrow('Missing password reset token');
  });
  it('sends through the provider adapter with idempotency and a bounded request', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'test-only';
    process.env.EMAIL_FROM = 'NeoTek <mail@example.test>';
    process.env.EMAIL_REPLY_TO = 'help@example.test';
    const mock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 }),
      );
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const provider = new ConfiguredEmailProvider({} as PrismaService);
      expect(
        await provider.send({
          template: 'CUSTOMER_EMAIL_VERIFICATION',
          recipient: 'a@example.test',
          locale: 'vi',
          payload: {},
          idempotencyKey: 'unique-intent',
          verificationToken: 'secret',
        }),
      ).toEqual({ messageId: 'provider-id' });
      expect(mock.mock.calls[0][0]).toBe('https://api.resend.com/emails');
      expect(
        new Headers(mock.mock.calls[0][1]?.headers).get('Idempotency-Key'),
      ).toBe('unique-intent');
      expect(mock.mock.calls[0][1]?.signal).toBeDefined();
      expect(JSON.parse(mock.mock.calls[0][1]?.body as string)).toMatchObject({
        reply_to: 'help@example.test',
        from: 'NeoTek <mail@example.test>',
        to: ['a@example.test'],
      });
      mock.mockResolvedValue(
        new Response(
          JSON.stringify({ name: 'validation_error', message: 'Rejected' }),
          { status: 422 },
        ),
      );
      await expect(
        provider.send({
          template: 'CUSTOMER_EMAIL_VERIFICATION',
          recipient: 'a@example.test',
          locale: 'vi',
          payload: {},
          idempotencyKey: 'unique-intent',
          verificationToken: 'secret',
        }),
      ).rejects.toThrow('rejected');
    } finally {
      mock.mockRestore();
      log.mockRestore();
    }
  });
  it.each([
    '',
    'not-an-email',
    'Name <a@example.test',
    'a@example.test>',
    'a@example.test\r\nBcc: victim@example.test',
  ])(
    'rejects invalid Resend sender %s even outside production',
    (EMAIL_FROM) => {
      expect(() =>
        validateEmailConfiguration({
          EMAIL_PROVIDER: 'resend',
          RESEND_API_KEY: 'fixture',
          EMAIL_FROM,
        }),
      ).toThrow('Resend requires');
    },
  );
  it('rejects blank keys and invalid reply-to', () => {
    expect(() =>
      validateEmailConfiguration({
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: '  ',
        EMAIL_FROM: 'a@example.test',
      }),
    ).toThrow();
    expect(() =>
      validateEmailConfiguration({
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'fixture',
        EMAIL_FROM: 'a@example.test',
        EMAIL_REPLY_TO: 'invalid',
      }),
    ).toThrow();
  });
  it('renders immutable confirmed event data including identity, interval, duration, timezone and Meet; cancellation has no join link', async () => {
    const db = {
      booking: {
        findUnique: jest.fn().mockResolvedValue({
          contactName: 'Later name',
          solutionLabel: 'Later solution',
          meetingUrl: null,
          reservation: {
            requestedStartAt: new Date(),
            requestedEndAt: new Date(),
            timezone: 'Asia/Ho_Chi_Minh',
          },
        }),
      },
    };
    const provider = new ConfiguredEmailProvider(
      db as unknown as PrismaService,
    );
    const message = {
      template: 'BOOKING_CONFIRMED_CUSTOMER',
      recipient: 'a@example.test',
      locale: 'en',
      idempotencyKey: 'confirm',
      payload: {
        bookingId: 'booking',
        contactName: 'Snapshot customer',
        solution: 'CRM',
        requestedStartAt: '2026-10-12T02:30:00Z',
        requestedEndAt: '2026-10-12T03:00:00Z',
        timezone: 'Asia/Ho_Chi_Minh',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    };
    const rendered = await provider.render(message);
    for (const value of [
      'Snapshot customer',
      'CRM',
      '09:30',
      '10:00',
      '30 minutes',
      'Asia/Ho_Chi_Minh',
      'https://meet.google.com/abc-defg-hij',
    ])
      expect(rendered.text).toContain(value);
    expect(rendered.text).not.toContain('Later name');
    expect(
      (
        await provider.render({
          ...message,
          template: 'BOOKING_CANCELLED_CUSTOMER',
        })
      ).text,
    ).not.toContain('https://meet.google.com/');
  });
  it('rejects SDK network failure and malformed success instead of marking delivery sent', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'fixture';
    process.env.EMAIL_FROM = 'a@example.test';
    const provider = new ConfiguredEmailProvider({} as PrismaService);
    const message = {
      template: 'EMAIL_TRANSPORT_TEST',
      recipient: 'a@example.test',
      locale: 'en',
      payload: {},
      idempotencyKey: 'test',
    };
    const mock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(provider.send(message)).rejects.toThrow(
        'Invalid provider response',
      );
      mock.mockResolvedValue(new Response('{"id":123}', { status: 200 }));
      await expect(provider.send(message)).rejects.toThrow(
        'Invalid provider response',
      );
      mock.mockRejectedValue(new Error('Network failed'));
      await expect(provider.send(message)).rejects.toThrow('rejected');
    } finally {
      mock.mockRestore();
      log.mockRestore();
    }
  });
});
