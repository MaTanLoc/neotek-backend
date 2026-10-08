import { AppModule } from './app.module';
import { Test } from '@nestjs/testing';
import { CacheService } from './cache/cache.service';
import { PrismaService } from './prisma/prisma.service';

describe('AppModule', () => {
  it('resolves the complete application dependency graph without live infrastructure', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CacheService)
      .useValue({})
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    expect(module.get(AppModule)).toBeDefined();
    await module.close();
  });
});
