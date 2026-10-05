export const ADMIN_SESSION_COOKIE =
  process.env.NODE_ENV === 'production'
    ? '__Host-neotek_admin_session'
    : 'neotek_admin_session';
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const LOGIN_RATE_LIMIT = 5;
export const LOGIN_RATE_LIMIT_TTL_SECONDS = 60;
export const CSRF_COOKIE = 'neotek_admin_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const MAX_PASSWORD_LENGTH = 256;
export const MIN_PASSWORD_LENGTH = 12;
