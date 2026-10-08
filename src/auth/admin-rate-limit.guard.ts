import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CacheService } from '../cache/cache.service';
import { AuthenticatedRequest } from './auth.types';
import { Request } from 'express';

@Injectable()
export class AdminRateLimitGuard implements CanActivate {
  private readonly cache: CacheService;
  constructor(cache: CacheService) {
    this.cache = cache;
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & Request>();
    const path = request.path.toLowerCase().replace(/\/+$/, '');
    const media = path.endsWith('/upload-signature');
    const csrf = path.endsWith('/csrf');
    if (request.method === 'GET' && !csrf) return true;
    const bucket = media ? 'media' : csrf ? 'csrf' : 'mutation';
    const identity = createHash('sha256')
      .update(request.user!.id)
      .digest('hex');
    let count: number;
    try {
      count = await this.cache.incrementWithExpiry(
        `auth:ratelimit:${bucket}:${identity}`,
        60,
      );
    } catch {
      throw new ServiceUnavailableException(
        'Authentication service unavailable',
      );
    }
    if (count > (media ? 20 : 120))
      throw new HttpException('Too many requests', 429);
    return true;
  }
}
