import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PageKind, Prisma } from '@prisma/client';
import {
  detailSlugSchema,
  emptyArticle,
  emptyDetailHero,
  articleText,
} from '../sections/validation/solution-detail.schemas';

export async function solutionModules(db: Prisma.TransactionClient) {
  const page = await db.page.findUnique({
    where: { slug: 'solutions' },
    include: {
      sections: {
        where: { type: 'solutionModules' },
        include: { translations: true },
      },
    },
  });
  const section = page?.sections[0];
  if (!section) throw new NotFoundException('Solution modules not found');
  const byLocale = Object.fromEntries(
    section.translations.map((t) => [
      t.locale,
      (t.content as { items?: ModuleItem[] }).items || [],
    ]),
  );
  return { section, byLocale };
}
type ModuleItem = {
  key: string;
  slug?: string;
  title?: string;
  visualSrc?: string | null;
  description?: string;
  icon?: string;
  bullets?: string[];
};
export async function createSolutionDetail(
  db: Prisma.TransactionClient,
  moduleKey: string,
) {
  const { byLocale } = await solutionModules(db);
  const modules = ['vi', 'en'].map((locale) =>
    byLocale[locale]?.find((item: ModuleItem) => item.key === moduleKey),
  );
  if (modules.some((item) => !item))
    throw new BadRequestException('Module must exist in VI and EN');
  const slug = detailSlugSchema.safeParse(modules[0]!.slug);
  if (!slug.success || modules[1]!.slug !== slug.data)
    throw new BadRequestException(
      'Set the same valid module slug in VI and EN before creating its detail page',
    );
  if (await db.page.findUnique({ where: { slug: slug.data } }))
    throw new ConflictException('Detail slug already exists');
  return db.page.create({
    data: {
      slug: slug.data,
      kind: PageKind.SOLUTION_DETAIL,
      translations: {
        create: ['vi', 'en'].map((locale, index) => ({
          locale,
          title: modules[index]!.title || '',
        })),
      },
      sections: {
        create: [
          {
            key: 'hero',
            type: 'solutionDetailHero',
            sortOrder: 0,
            translations: {
              create: ['vi', 'en'].map((locale, index) => ({
                locale,
                content: emptyDetailHero(modules[index]!.title),
              })),
            },
          },
          {
            key: 'article',
            type: 'solutionArticle',
            sortOrder: 1,
            translations: {
              create: ['vi', 'en'].map((locale) => ({
                locale,
                content: emptyArticle(),
              })),
            },
          },
          {
            key: 'related',
            type: 'relatedSolutions',
            sortOrder: 2,
            translations: {
              create: ['vi', 'en'].map((locale) => ({
                locale,
                content: { moduleKeys: [] },
              })),
            },
          },
        ],
      },
    },
    include: {
      translations: true,
      sections: {
        include: { translations: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });
}
export async function detailAvailability(
  db: Prisma.TransactionClient,
  publicOnly = false,
) {
  const pages = await db.page.findMany({
    where: {
      kind: PageKind.SOLUTION_DETAIL,
      ...(publicOnly ? { status: 'PUBLISHED' as const } : {}),
    },
    include: {
      translations: true,
      sections: {
        where: { key: { in: ['hero', 'article'] } },
        include: { translations: true },
      },
    },
    orderBy: { slug: 'asc' },
  });
  return pages.flatMap((page) => {
    const article = page.sections.find(
      (section) => section.type === 'solutionArticle',
    );
    const hero = page.sections.find(
      (section) => section.type === 'solutionDetailHero',
    );
    const locales = page.translations
      .filter(
        (translation) =>
          article?.enabled &&
          hero?.enabled &&
          translation.title.trim() &&
          articleText(
            (
              article.translations.find((t) => t.locale === translation.locale)
                ?.content as { doc?: Parameters<typeof articleText>[0] }
            )?.doc || { type: 'doc' },
          ),
      )
      .map((t) => t.locale);
    return publicOnly && !locales.length
      ? []
      : [{ id: page.id, slug: page.slug, status: page.status, locales }];
  });
}
