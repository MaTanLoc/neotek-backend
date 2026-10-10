/* global afterAll, beforeAll */
import { randomBytes, randomUUID } from 'node:crypto';
import { CacheService } from '../cache/cache.service';

const redis = process.env.AUTH_REDIS_TEST_URL ? describe : describe.skip;
redis('Calendar OAuth one-use state with real Redis', () => {
  let cache: CacheService;
  const previous = process.env.REDIS_URL;
  const key = `calendar:oauth:test:${randomUUID()}`;
  beforeAll(async () => {
    process.env.REDIS_URL = process.env.AUTH_REDIS_TEST_URL;
    cache = new CacheService();
    await cache.onModuleInit();
  });
  afterAll(async () => {
    if (cache) {
      await cache.del(key);
      await cache.onModuleDestroy();
    }
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  });
  it('consumes a state atomically under concurrent callbacks and respects expiry', async () => {
    const verifier = randomBytes(32).toString('base64url');
    await cache.set(key, verifier, 600);
    const results = await Promise.all([cache.consume(key), cache.consume(key)]);
    expect(results.filter((value) => value === verifier)).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    expect(await cache.consume(`${key}:expired`)).toBeNull();
  });
});
