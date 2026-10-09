import { AppModule } from './app.module';
import { Test } from '@nestjs/testing';
import { CacheService } from './cache/cache.service';
import { PrismaService } from './prisma/prisma.service';
import { randomBytes } from 'node:crypto';

describe('AppModule', () => {
  it('resolves the complete application dependency graph without live infrastructure', async () => {
    const previousKey = process.env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY;
    process.env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY =
      randomBytes(32).toString('base64');
    try {
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CacheService)
        .useValue({})
        .overrideProvider(PrismaService)
        .useValue({})
        .compile();
      expect(module.get(AppModule)).toBeDefined();
      await module.close();
    } finally {
      if (previousKey === undefined)
        delete process.env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY;
      else process.env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY = previousKey;
    }
  });
});
