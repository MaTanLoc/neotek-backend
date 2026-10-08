import { URL } from 'node:url';

export function isSafeContentUrl(value: string, media = false): boolean {
  if (!value) return true;
  // Legacy attachment identifiers are inert relative references, never schemes.
  if (media && /^[A-Za-z0-9_-]+$/.test(value)) return true;
  if (
    value.includes('\\') ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (media
        ? url.protocol === 'https:'
        : ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol))
    );
  } catch {
    return false;
  }
}

/** Protect legacy persisted media at the public boundary without changing stored data. */
export function safePublicMedia(content: object, logo = false): object {
  const mediaKeys = new Set([
    'image',
    'desktopImage',
    'mobileImage',
    'visualSrc',
    'cover',
    'src',
  ]);
  const visit = (value: unknown, key = ''): unknown => {
    if (
      typeof value === 'string' &&
      key === 'icon' &&
      /^[A-Za-z0-9_-]+$/.test(value)
    )
      return value;
    if (
      typeof value === 'string' &&
      ['url', 'href', 'ctaUrl'].includes(key) &&
      !(logo && key === 'url')
    )
      return isSafeContentUrl(value) ? value : null;
    if (
      typeof value === 'string' &&
      (mediaKeys.has(key) || key === 'icon' || (logo && key === 'url'))
    )
      return isSafeContentUrl(value, true) ? value : null;
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([field, item]) => [
          field,
          visit(item, field),
        ]),
      );
    return value;
  };
  return visit(content) as object;
}
