/* global afterEach */
import { generateKeyPairSync, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { OAuth2Client } from 'google-auth-library';
import { CertificateFormat } from 'google-auth-library/build/src/auth/oauth2client';
import {
  GoogleTokenVerifier,
  googleCustomerConfiguration,
} from './google-token-verifier';

describe('Google ID token cryptographic boundary (local keys; no Google network)', () => {
  const clientId = 'fixture.apps.googleusercontent.com';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const original = { ...process.env };
  const verifier = new GoogleTokenVerifier();
  const payload = () => ({
    iss: 'https://accounts.google.com',
    aud: clientId,
    sub: '123456',
    email: 'customer@gmail.com',
    email_verified: true,
    iat: Math.floor(Date.now() / 1000) - 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
    name: 'Customer',
  });
  function jwt(body: object, signingKey = keys.privateKey, kid = 'fixture') {
    const data = [JSON.stringify({ alg: 'RS256', kid }), JSON.stringify(body)]
      .map((x) => Buffer.from(x).toString('base64url'))
      .join('.');
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), signingKey).toString('base64url')}`;
  }
  beforeEach(() => {
    process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED = 'true';
    process.env.GOOGLE_CUSTOMER_CLIENT_ID = clientId;
    jest
      .spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync')
      .mockResolvedValue({
        certs: {
          fixture: keys.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        },
        format: CertificateFormat.PEM,
      });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...original };
  });
  it('verifies an actual RS256 signature with the official library and normalizes minimal identity data', async () => {
    expect(
      await verifier.verify(jwt({ ...payload(), email: 'CUSTOMER@gmail.com' })),
    ).toEqual({
      subject: '123456',
      email: 'customer@gmail.com',
      name: 'Customer',
      authoritativeEmail: true,
    });
    expect(
      await verifier.verify(
        jwt({ ...payload(), email: 'a@company.test', hd: 'company.test' }),
      ),
    ).toMatchObject({ authoritativeEmail: true });
    expect(
      await verifier.verify(
        jwt({ ...payload(), email: 'a@example.test', name: '\u0000bad' }),
      ),
    ).toMatchObject({ authoritativeEmail: false, name: 'Google customer' });
  });
  it.each([
    { aud: 'other.apps.googleusercontent.com' },
    { iss: 'https://evil.test' },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { email_verified: false },
    { email_verified: 'true' },
    { email: 'invalid' },
    { sub: undefined },
    { sub: '' },
    { sub: 'x'.repeat(256) },
  ])('rejects invalid claims %j', async (override) => {
    await expect(
      verifier.verify(jwt({ ...payload(), ...override })),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Google login could not be completed',
    });
  });
  it('rejects malformed tokens, unknown signing key, bad signature and key fetch failure without leaking errors', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const credential of [
      'bad',
      jwt(payload(), keys.privateKey, 'unknown'),
      jwt(payload(), other.privateKey),
    ])
      await expect(verifier.verify(credential)).rejects.toMatchObject({
        status: 401,
      });
    jest
      .spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync')
      .mockRejectedValue(new Error('private-google-detail'));
    await expect(verifier.verify(jwt(payload()))).rejects.toMatchObject({
      message: 'Google login could not be completed',
    });
  });
  it('fails disabled/missing/invalid configuration closed', async () => {
    expect(googleCustomerConfiguration({})).toEqual({
      enabled: false,
      clientId: '',
    });
    for (const env of [
      { GOOGLE_CUSTOMER_LOGIN_ENABLED: 'yes' },
      { GOOGLE_CUSTOMER_LOGIN_ENABLED: 'true' },
      {
        GOOGLE_CUSTOMER_LOGIN_ENABLED: 'true',
        GOOGLE_CUSTOMER_CLIENT_ID: 'bad',
      },
    ])
      expect(() => googleCustomerConfiguration(env)).toThrow();
    process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED = 'false';
    await expect(verifier.verify(jwt(payload()))).rejects.toMatchObject({
      status: 503,
    });
  });
});
