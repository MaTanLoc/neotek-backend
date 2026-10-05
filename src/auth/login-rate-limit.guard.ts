import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CacheService } from '../cache/cache.service';
import {
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_LIMIT_TTL_SECONDS,
} from './auth.constants';
import { AuthenticatedRequest } from './auth.types';

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly cache: CacheService;

  constructor(cache: CacheService) {
    this.cache = cache;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identifier = request.ip ?? 'unknown';
    const hash = createHash('sha256').update(identifier).digest('hex');
    try {
      const count = await this.cache.incrementWithExpiry(
        `auth:ratelimit:login:${hash}`,
        LOGIN_RATE_LIMIT_TTL_SECONDS,
      );
      if (count > LOGIN_RATE_LIMIT) {
        throw new HttpException(
          'Too many login attempts',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    } catch (error) {
      if (
        error instanceof HttpException &&
        error.getStatus() === HttpStatus.TOO_MANY_REQUESTS
      ) {
        throw error;
      }
      throw new ServiceUnavailableException(
        'Authentication service unavailable',
      );
    }
  }
}
