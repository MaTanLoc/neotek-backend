import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { withDeadline } from '../config/deadline';

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly client: RedisClientType;

  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 100,
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: (retries) => Math.min(250 * (retries + 1), 3000),
      },
    });
    this.client.on('error', () => {
      this.logger.error('Redis connection unavailable');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await withDeadline(this.client.connect(), 3000);
    } catch {
      this.logger.error(
        'Redis startup unavailable; readiness is degraded and authentication fails closed',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) {
      try {
        await withDeadline(this.client.quit());
      } catch {
        if (this.client.isOpen) this.client.destroy();
      }
    }
  }

  private async command<T>(work: () => Promise<T>): Promise<T> {
    if (!this.client.isReady) throw new Error('Redis unavailable');
    try {
      return await withDeadline(work());
    } catch {
      // Discard pending commands on a stalled socket; never replay mutations after a timeout.
      if (this.client.isOpen) this.client.destroy();
      void this.client.connect().catch(() => undefined);
      throw new Error('Redis unavailable');
    }
  }

  async ping(): Promise<string> {
    return this.command(() => this.client.ping());
  }

  async get(key: string): Promise<string | null> {
    return this.command(() => this.client.get(key));
  }

  async consume(key: string): Promise<string | null> {
    return this.command(() => this.client.getDel(key));
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) {
      await this.command(() => this.client.set(key, value));
      return;
    }

    await this.command(() => this.client.set(key, value, { EX: ttlSeconds }));
  }

  async del(key: string): Promise<void> {
    await this.command(() => this.client.del(key));
  }

  async getOrCreateSessionToken(
    sessionKey: string,
    csrfKey: string,
    candidate: string,
  ): Promise<string | null> {
    // One atomic operation: concurrent requests share a token, and its initial
    // expiry cannot outlive the remaining session lifetime.
    const result = await this.command(() =>
      this.client.eval(
        'local ttl = redis.call("TTL", KEYS[1]); if ttl <= 0 then return nil end; local token = redis.call("GET", KEYS[2]); if token then return token end; redis.call("SET", KEYS[2], ARGV[1], "EX", ttl); return ARGV[1]',
        { keys: [sessionKey, csrfKey], arguments: [candidate] },
      ),
    );
    if (result === null || typeof result === 'string') return result;
    throw new Error('Unexpected Redis CSRF response');
  }

  async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const result = await this.command(() =>
      this.client.eval(
        'local count = redis.call("INCR", KEYS[1]); if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]); end; return count',
        { keys: [key], arguments: [String(ttlSeconds)] },
      ),
    );
    if (typeof result !== 'number') {
      throw new Error('Unexpected Redis counter response');
    }
    return result;
  }
}
