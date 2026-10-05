import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { buildPageCacheKey } from '../cache/cache-keys';
import { PrismaService } from '../prisma/prisma.service';
import { GetPageQueryDto } from './dto/get-page-query.dto';

const PAGE_CACHE_TTL_SECONDS = 300;

export type PublicPageResponse = {
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
          return JSON.parse(cachedPage) as PublicPageResponse;
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

    // Published-only filtering belongs to the publishing workflow phase.
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

    const translation = page.translations[0];
    if (!translation) {
      throw new NotFoundException(
        `Page translation not found: ${slug} (${locale})`,
      );
    }

    const response: PublicPageResponse = {
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
