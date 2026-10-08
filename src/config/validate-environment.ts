import { URL } from 'node:url';
import { isIP } from 'node:net';

export class EnvironmentValidationError extends Error {}

export function validateEnvironment(
  env: Record<string, string | undefined>,
): void {
  if (
    env.NODE_ENV &&
    !['development', 'test', 'production'].includes(env.NODE_ENV)
  )
    throw new EnvironmentValidationError(
      'NODE_ENV must be development, test or production',
    );
  if (env.NODE_ENV !== 'production') return;
  if (!env.PORT)
    throw new EnvironmentValidationError('PORT is required in production');
  if (!env.TRUST_PROXY)
    throw new EnvironmentValidationError(
      'TRUST_PROXY must contain explicit proxy IP addresses or CIDRs',
    );
  for (const entry of env.TRUST_PROXY.split(',')) {
    const [address, prefix, extra] = entry.trim().split('/');
    const version = isIP(address);
    if (
      !version ||
      extra ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw new EnvironmentValidationError(
        'TRUST_PROXY must contain explicit proxy IP addresses or bounded CIDRs',
      );
  }
  const requireUrl = (key: string, protocols: string[]) => {
    try {
      const url = new URL(env[key] || '');
      if (!protocols.includes(url.protocol))
        throw new EnvironmentValidationError();
      return url;
    } catch {
      throw new EnvironmentValidationError(
        `${key} must be a valid production URL`,
      );
    }
  };
  requireUrl('DATABASE_URL', ['postgres:', 'postgresql:']);
  requireUrl('REDIS_URL', ['redis:', 'rediss:']);
  const origin = requireUrl('FRONTEND_URL', ['https:']);
  if (
    origin.origin !== env.FRONTEND_URL ||
    origin.username ||
    origin.password ||
    origin.hostname.includes('*')
  )
    throw new EnvironmentValidationError(
      'FRONTEND_URL must be one exact origin',
    );
  if (
    env.PORT &&
    (!/^\d+$/.test(env.PORT) ||
      Number(env.PORT) < 1 ||
      Number(env.PORT) > 65535)
  )
    throw new EnvironmentValidationError('PORT must be between 1 and 65535');
  const mediaKeys = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'CLOUDINARY_UPLOAD_PRESET',
  ];
  if (
    mediaKeys.some((key) => env[key]) &&
    mediaKeys.some((key) => !env[key]?.trim())
  )
    throw new EnvironmentValidationError(
      'Configured media requires all CLOUDINARY fields',
    );
  // All absent keeps the existing upload endpoint safely unavailable (503).
}
