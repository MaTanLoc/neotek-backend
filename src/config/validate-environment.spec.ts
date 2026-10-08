import { validateEnvironment } from './validate-environment';

describe('environment validation', () => {
  const env = {
    NODE_ENV: 'production',
    PORT: '3000',
    TRUST_PROXY: '127.0.0.1/32',
    DATABASE_URL: 'postgresql://user:secret@db/neotek',
    REDIS_URL: 'redis://redis:6379',
    FRONTEND_URL: 'https://neotek.vn',
  };
  it('accepts complete production configuration and optional disabled media', () =>
    expect(() => validateEnvironment(env)).not.toThrow());
  it('keeps optional development infrastructure optional', () =>
    expect(() =>
      validateEnvironment({ NODE_ENV: 'development' }),
    ).not.toThrow());
  it.each(['DATABASE_URL', 'REDIS_URL', 'FRONTEND_URL', 'PORT', 'TRUST_PROXY'])(
    'rejects missing %s without printing values',
    (key) =>
      expect(() => validateEnvironment({ ...env, [key]: undefined })).toThrow(
        key,
      ),
  );
  it.each([
    '*',
    'https://neotek.vn/path',
    'https://neotek.vn/',
    'https://user:password@neotek.vn',
  ])('rejects inexact origins', (FRONTEND_URL) =>
    expect(() => validateEnvironment({ ...env, FRONTEND_URL })).toThrow(
      'FRONTEND_URL',
    ),
  );
  it('rejects partial media configuration', () =>
    expect(() =>
      validateEnvironment({ ...env, CLOUDINARY_API_SECRET: 'hidden' }),
    ).toThrow('all CLOUDINARY'));
  it('rejects invalid mode', () =>
    expect(() => validateEnvironment({ NODE_ENV: 'prod' })).toThrow(
      'NODE_ENV',
    ));
  it.each([
    'true',
    '1',
    '*',
    '0.0.0.0/0',
    '::/0',
    '127.0.0.1/33',
    '127.0.0.1/32/extra',
  ])('rejects broad or malformed proxy trust %s', (TRUST_PROXY) =>
    expect(() => validateEnvironment({ ...env, TRUST_PROXY })).toThrow(
      'TRUST_PROXY',
    ),
  );
  it.each(['0', '65536', '3x', '-1'])(
    'rejects invalid production port %s',
    (PORT) =>
      expect(() => validateEnvironment({ ...env, PORT })).toThrow('PORT'),
  );
});
