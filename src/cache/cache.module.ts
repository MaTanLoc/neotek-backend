import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { PageCacheInvalidationService } from './page-cache-invalidation.service';

@Module({
  providers: [CacheService, PageCacheInvalidationService],
  exports: [CacheService, PageCacheInvalidationService],
})
export class CacheModule {}
