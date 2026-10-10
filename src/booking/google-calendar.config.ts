import { URL } from 'node:url';
import { EnvironmentValidationError } from '../config/validate-environment';
import { VerificationSecret } from '../notification/verification-secret';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export function calendarConfig(env = process.env) {
  const enabled = env.GOOGLE_CALENDAR_ENABLED === 'true';
  if (
    env.GOOGLE_CALENDAR_ENABLED &&
    !['true', 'false'].includes(env.GOOGLE_CALENDAR_ENABLED)
  )
    throw new EnvironmentValidationError(
      'GOOGLE_CALENDAR_ENABLED must be true or false',
    );
  if (enabled) {
    for (const name of [
      'GOOGLE_CALENDAR_CLIENT_ID',
      'GOOGLE_CALENDAR_CLIENT_SECRET',
      'GOOGLE_CALENDAR_REDIRECT_URI',
      'GOOGLE_CALENDAR_ORGANIZER_EMAIL',
      'GOOGLE_CALENDAR_ENCRYPTION_KEY',
    ])
      if (!env[name])
        throw new EnvironmentValidationError(
          `${name} is required when Google Calendar is enabled`,
        );
    if (env.GOOGLE_CALENDAR_CLIENT_ID === env.GOOGLE_CUSTOMER_CLIENT_ID)
      throw new EnvironmentValidationError(
        'Calendar organizer requires a separate OAuth client',
      );
    let uri: URL;
    try {
      uri = new URL(env.GOOGLE_CALENDAR_REDIRECT_URI!);
    } catch {
      throw new EnvironmentValidationError(
        'Invalid GOOGLE_CALENDAR_REDIRECT_URI',
      );
    }
    if (
      uri.pathname !== '/api/integrations/google/calendar/callback' ||
      uri.search ||
      uri.hash ||
      uri.username ||
      uri.password ||
      (uri.protocol !== 'https:' &&
        !(
          env.NODE_ENV !== 'production' &&
          uri.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(uri.hostname)
        ))
    )
      throw new EnvironmentValidationError(
        'Google Calendar callback must use the exact backend callback path and HTTPS in production',
      );
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.GOOGLE_CALENDAR_ORGANIZER_EMAIL!)
    )
      throw new EnvironmentValidationError(
        'Invalid GOOGLE_CALENDAR_ORGANIZER_EMAIL',
      );
    try {
      new VerificationSecret(env.GOOGLE_CALENDAR_ENCRYPTION_KEY!);
    } catch {
      throw new EnvironmentValidationError(
        'GOOGLE_CALENDAR_ENCRYPTION_KEY must be canonical base64 for 32 bytes',
      );
    }
  }
  return {
    enabled,
    clientId: env.GOOGLE_CALENDAR_CLIENT_ID!,
    clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET!,
    redirectUri: env.GOOGLE_CALENDAR_REDIRECT_URI!,
    email: env.GOOGLE_CALENDAR_ORGANIZER_EMAIL?.toLowerCase(),
    encryptionKey: env.GOOGLE_CALENDAR_ENCRYPTION_KEY!,
  };
}
