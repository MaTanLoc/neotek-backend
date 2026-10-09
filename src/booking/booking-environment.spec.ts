import { randomBytes } from 'node:crypto';
import { validateBookingEnvironment } from './booking-environment';

describe('Booking startup configuration', () => {
  const valid = {
    NODE_ENV: 'development',
    CUSTOMER_VERIFICATION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BOOKING_ADMIN_EMAIL: 'admin@example.test',
    EMAIL_PROVIDER: 'disabled',
  };
  it('supports explicit safe development transport choices', () => {
    expect(() => validateBookingEnvironment(valid)).not.toThrow();
    expect(() =>
      validateBookingEnvironment({
        ...valid,
        EMAIL_PROVIDER: 'dev',
        EMAIL_DEV_DIRECTORY: '.local/mail',
      }),
    ).not.toThrow();
  });
  it('rejects missing encryption key/recipient and unsafe scheduling with a redacted error', () => {
    for (const override of [
      { CUSTOMER_VERIFICATION_ENCRYPTION_KEY: '' },
      { BOOKING_ADMIN_EMAIL: '' },
      { BOOKING_HOLD_MINUTES: '30' },
      { BOOKING_TIMEZONE: 'UTC' },
    ]) {
      expect(() =>
        validateBookingEnvironment({ ...valid, ...override }),
      ).toThrow('Booking configuration invalid');
    }
  });
  it('never permits development or disabled mail in production', () => {
    expect(() =>
      validateBookingEnvironment({ ...valid, NODE_ENV: 'production' }),
    ).toThrow();
    expect(() =>
      validateBookingEnvironment({
        ...valid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'dev',
        EMAIL_DEV_DIRECTORY: '.local/mail',
      }),
    ).toThrow();
  });
  it('requires real-provider configuration in production', () => {
    expect(() =>
      validateBookingEnvironment({
        ...valid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
      }),
    ).toThrow();
    expect(() =>
      validateBookingEnvironment({
        ...valid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'fixture-only',
        EMAIL_FROM: 'mail@example.test',
      }),
    ).not.toThrow();
  });
});
