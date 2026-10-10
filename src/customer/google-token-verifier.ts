import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { customerEmail } from './customer-input';

export function googleCustomerConfiguration(env = process.env) {
  const flag = env.GOOGLE_CUSTOMER_LOGIN_ENABLED;
  if (flag !== undefined && !['true', 'false', ''].includes(flag))
    throw new Error('Invalid Google customer configuration');
  const enabled = flag === 'true';
  const clientId = env.GOOGLE_CUSTOMER_CLIENT_ID ?? '';
  if (
    enabled &&
    !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)
  )
    throw new Error('Invalid Google customer configuration');
  return { enabled, clientId };
}

const claims = z.object({
  sub: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9_-]+$/),
  email: customerEmail,
  email_verified: z.literal(true),
  iss: z.enum(['accounts.google.com', 'https://accounts.google.com']),
  aud: z.string(),
  exp: z.number().int().positive(),
  hd: z.string().max(254).optional(),
  name: z.string().optional(),
});

@Injectable()
export class GoogleTokenVerifier {
  private readonly client = new OAuth2Client({
    transporterOptions: { timeout: 5000, retry: false },
  });

  async verify(credential: string) {
    const config = googleCustomerConfiguration();
    if (!config.enabled)
      throw new ServiceUnavailableException('Google login unavailable');
    try {
      // Official library checks the Google signature, rotating signing keys,
      // issuer, audience and token lifetime. Never decode-and-trust a JWT.
      const ticket = await this.client.verifyIdToken({
        idToken: credential,
        audience: config.clientId,
      });
      const result = claims.safeParse(ticket.getPayload());
      if (
        !result.success ||
        result.data.aud !== config.clientId ||
        result.data.exp <= Date.now() / 1000
      )
        throw new Error('Invalid claims');
      const payload = result.data;
      const name = payload.name?.trim();
      return {
        subject: payload.sub,
        email: payload.email,
        authoritativeEmail:
          payload.email.endsWith('@gmail.com') || Boolean(payload.hd?.trim()),
        name:
          name &&
          name.length <= 120 &&
          !Array.from(name).some(
            (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
          )
            ? name
            : 'Google customer',
      };
    } catch {
      // Do not return/log credentials, payloads, library errors or key URLs.
      throw new UnauthorizedException('Google login could not be completed');
    }
  }
}
