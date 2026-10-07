import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly client: RedisClientType;

  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL,
    });
    this.client.on('error', (error: Error) => {
      this.logger.error(`Redis client error: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      this.logger.error(
        `Redis connection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) {
      await this.client.set(key, value);
      return;
    }

    await this.client.set(key, value, { EX: ttlSeconds });
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async getOrCreateSessionToken(
    sessionKey: string,
    csrfKey: string,
    candidate: string,
  ): Promise<string | null> {
    // One atomic operation: concurrent requests share a token, and its initial
    // expiry cannot outlive the remaining session lifetime.
    const result = await this.client.eval(
      'local ttl = redis.call("TTL", KEYS[1]); if ttl <= 0 then return nil end; local token = redis.call("GET", KEYS[2]); if token then return token end; redis.call("SET", KEYS[2], ARGV[1], "EX", ttl); return ARGV[1]',
      { keys: [sessionKey, csrfKey], arguments: [candidate] },
    );
    if (result === null || typeof result === 'string') return result;
    throw new Error('Unexpected Redis CSRF response');
  }

  async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const result = await this.client.eval(
      'local count = redis.call("INCR", KEYS[1]); if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]); end; return count',
      { keys: [key], arguments: [String(ttlSeconds)] },
    );
    if (typeof result !== 'number') {
      throw new Error('Unexpected Redis counter response');
    }
    return result;
  }
}
