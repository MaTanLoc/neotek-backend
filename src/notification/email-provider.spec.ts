/* global afterEach, Response */
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
    const mock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'provider-id' }),
    } as Response);
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
      expect(mock.mock.calls[0][1]?.headers).toMatchObject({
        'Idempotency-Key': 'unique-intent',
      });
      mock.mockResolvedValue({ ok: false } as Response);
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
    }
  });
});
