import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { withDeadline } from '../config/deadline';
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
      withDeadline(this.prisma.$queryRaw`SELECT 1`),
      this.cache.ping(),
    ]);
    const database = databaseResult.status === 'fulfilled' ? 'up' : 'down';
    const cache = cacheResult.status === 'fulfilled' ? 'up' : 'down';

    const result = {
      status: database === 'up' && cache === 'up' ? 'ok' : 'error',
      database,
      cache,
    } as const;
    if (result.status !== 'ok') throw new ServiceUnavailableException(result);
    return result;
  }

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  ready() {
    return this.check();
  }
}
