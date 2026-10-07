import { resolveSharedTranslations } from '../sections/shared-content';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { buildPageCacheKey } from '../cache/cache-keys';
import { PrismaService } from '../prisma/prisma.service';
import { GetPageQueryDto } from './dto/get-page-query.dto';
import { detailAvailability } from './solution-detail';
import { articleText } from '../sections/validation/solution-detail.schemas';

const PAGE_CACHE_TTL_SECONDS = 300;

export type PublicPageResponse = {
  kind?: string;
  publishedAt?: string | null;
  updatedAt?: string;
  slug: string;
  locale: string;
  title: string;
  seo: {
    title: string | null;
    description: string | null;
  };
  sections: Array<{
    key: string;
    type: string;
    content: object;
  }>;
};

@Injectable()
export class PagesService {
  private readonly logger = new Logger(PagesService.name);
  private readonly prisma: PrismaService;
  private readonly cache: CacheService;

  constructor(prisma: PrismaService, cache: CacheService) {
    this.prisma = prisma;
    this.cache = cache;
  }

  listSolutionDetails() {
    return detailAvailability(this.prisma, true);
  }

  async findPublicPage(
    slug: string,
    query: GetPageQueryDto,
  ): Promise<PublicPageResponse> {
    const locale = query.locale ?? 'vi';
    const cacheKey = buildPageCacheKey(slug, locale);

    try {
      const cachedPage = await this.cache.get(cacheKey);
      if (cachedPage) {
        try {
          const cached = JSON.parse(cachedPage) as PublicPageResponse;
          if (cached.kind !== 'SOLUTION_DETAIL') return cached;
          // A stale Redis entry must never expose an unpublished detail.
          const current = await this.prisma.page.findUnique({
            where: { slug },
            select: {
              kind: true,
              status: true,
              updatedAt: true,
              sections: {
                where: { key: { in: ['hero', 'article'] } },
                select: { enabled: true, key: true },
              },
            },
          });
          if (
            !current ||
            current.kind !== 'SOLUTION_DETAIL' ||
            current.status !== 'PUBLISHED' ||
            current.sections.length !== 2 ||
            current.sections.some((section) => !section.enabled)
          )
            throw new NotFoundException('Solution detail not published');
          if (cached.updatedAt === current.updatedAt.toISOString())
            return cached;
        } catch (error) {
          this.logger.warn(
            `Invalid cached page response for ${cacheKey}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await this.cache.del(cacheKey).catch(() => undefined);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Redis cache read failed for ${cacheKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Standard-page delivery remains unchanged; solution details are published-only.
    const page = await this.prisma.page.findUnique({
      where: { slug },
      include: {
        translations: {
          where: { locale },
        },
        sections: {
          where: { enabled: true },
          orderBy: { sortOrder: 'asc' },
          include: {
            translations: {
              where: { locale },
            },
          },
        },
      },
    });

    if (!page) {
      throw new NotFoundException(`Page not found: ${slug}`);
    }

    if (
      page.kind === 'SOLUTION_DETAIL' &&
      (page.status !== 'PUBLISHED' ||
        !page.sections.some(
          (section) => section.type === 'solutionDetailHero',
        ) ||
        !page.sections.some((section) => section.type === 'solutionArticle'))
    )
      throw new NotFoundException('Solution detail not found');

    const translation = page.translations[0];
    if (!translation) {
      throw new NotFoundException(
        `Page translation not found: ${slug} (${locale})`,
      );
    }

    for (const section of page.sections)
      section.translations = (await resolveSharedTranslations(
        this.prisma,
        section.translations,
      )) as typeof section.translations;

    if (page.kind === 'SOLUTION_DETAIL') {
      const doc = (
        page.sections.find((section) => section.type === 'solutionArticle')
          ?.translations[0]?.content as {
          doc?: Parameters<typeof articleText>[0];
        }
      )?.doc;
      if (!translation.title.trim() || !doc || !articleText(doc))
        throw new NotFoundException(
          'Solution detail translation not published',
        );
    }

    const response: PublicPageResponse = {
      ...(page.kind === 'SOLUTION_DETAIL'
        ? {
            kind: page.kind,
            publishedAt: page.publishedAt?.toISOString() ?? null,
            updatedAt: page.updatedAt.toISOString(),
          }
        : {}),
      slug: page.slug,
      locale,
      title: translation.title,
      seo: {
        title: translation.seoTitle,
        description: translation.seoDescription,
      },
      sections: page.sections
        .filter((section) => section.translations[0])
        .map((section) => ({
          key: section.key,
          type: section.type,
          content: section.translations[0].content as object,
        })),
    };

    try {
      await this.cache.set(
        cacheKey,
        JSON.stringify(response),
        PAGE_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Redis cache write failed for ${cacheKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return response;
  }
}
