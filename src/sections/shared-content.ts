import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';

export function sharedSource(content: unknown): string | undefined {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return;
  const source = (content as { source?: unknown }).source;
  if (
    typeof source === 'string' &&
    /^shared\.(cta|footerCta|faq|trustedLogos)(\.[a-zA-Z0-9-]+)?$/.test(source)
  )
    return source;
}

export async function resolveSharedTranslations<
  T extends { locale: string; content: Prisma.JsonValue },
>(db: Prisma.TransactionClient, translations: T[]) {
  return Promise.all(
    translations.map(async (translation) => {
      const source = sharedSource(translation.content);
      if (!source) return translation;
      const setting = await db.siteSetting.findUnique({
        where: { key: source },
        include: { translations: { where: { locale: translation.locale } } },
      });
      const value = setting?.translations[0]?.value;
      if (!value || sharedSource(value))
        throw new NotFoundException(
          `Shared content missing: ${source} (${translation.locale})`,
        );
      return { ...translation, content: value };
    }),
  );
}

export async function sharedConsumers(
  db: Prisma.TransactionClient,
  source: string,
) {
  const refs = await db.pageSectionTranslation.findMany({
    where: { content: { path: ['source'], equals: source } },
    select: {
      locale: true,
      section: { select: { page: { select: { slug: true } } } },
    },
  });
  return refs.map((ref) => ({
    slug: ref.section.page.slug,
    locale: ref.locale,
  }));
}
