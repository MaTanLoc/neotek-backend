import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from './cache.service';
import { buildPageCacheKey } from './cache-keys';

@Injectable()
export class PageCacheInvalidationService {
  private readonly logger = new Logger(PageCacheInvalidationService.name);
  private readonly cache: CacheService;

  constructor(cache: CacheService) {
    this.cache = cache;
  }

  async invalidatePageLocale(slug: string, locale: string): Promise<void> {
    const key = buildPageCacheKey(slug, locale);
    try {
      await this.cache.del(key);
    } catch {
      this.logger.warn(
        `Redis page cache invalidation failed for ${key}: dependency failure`,
      );
    }
  }

  async invalidatePageLocales(slug: string, locales: string[]): Promise<void> {
    for (const locale of [...new Set(locales)]) {
      await this.invalidatePageLocale(slug, locale);
    }
  }
}
