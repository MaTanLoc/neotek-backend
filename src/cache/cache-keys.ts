export function buildPageCacheKey(slug: string, locale: string): string {
  return `cms:page:${slug}:${locale}`;
}
