import { Controller, Get } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  private readonly prisma: PrismaService;
  private readonly cache: CacheService;

  constructor(prisma: PrismaService, cache: CacheService) {
    this.prisma = prisma;
    this.cache = cache;
  }

  @Get()
  async check(): Promise<{
    status: 'ok' | 'error';
    database: 'up' | 'down';
    cache: 'up' | 'down';
  }> {
    const [databaseResult, cacheResult] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.cache.ping(),
    ]);
    const database = databaseResult.status === 'fulfilled' ? 'up' : 'down';
    const cache = cacheResult.status === 'fulfilled' ? 'up' : 'down';

    return {
      status: database === 'up' && cache === 'up' ? 'ok' : 'error',
      database,
      cache,
    };
  }
}
