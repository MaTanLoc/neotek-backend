import { URL } from 'node:url';

export function validateEnvironment(
  env: Record<string, string | undefined>,
): void {
  if (
    env.NODE_ENV &&
    !['development', 'test', 'production'].includes(env.NODE_ENV)
  )
    throw new Error('NODE_ENV must be development, test or production');
  if (env.NODE_ENV !== 'production') return;
  const requireUrl = (key: string, protocols: string[]) => {
    try {
      const url = new URL(env[key] || '');
      if (!protocols.includes(url.protocol)) throw new Error();
      return url;
    } catch {
      throw new Error(`${key} must be a valid production URL`);
    }
  };
  requireUrl('DATABASE_URL', ['postgres:', 'postgresql:']);
  requireUrl('REDIS_URL', ['redis:', 'rediss:']);
  const origin = requireUrl('FRONTEND_URL', ['http:', 'https:']);
  if (
    origin.origin !== env.FRONTEND_URL ||
    origin.username ||
    origin.password ||
    origin.hostname.includes('*')
  )
    throw new Error('FRONTEND_URL must be one exact origin');
  if (
    env.PORT &&
    (!/^\d+$/.test(env.PORT) ||
      Number(env.PORT) < 1 ||
      Number(env.PORT) > 65535)
  )
    throw new Error('PORT must be between 1 and 65535');
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
    throw new Error('Configured media requires all CLOUDINARY fields');
  // All absent keeps the existing upload endpoint safely unavailable (503).
}
