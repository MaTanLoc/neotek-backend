import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthenticatedRequest } from './auth.types';

@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expectedOrigin = process.env.FRONTEND_URL;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const origin = request.headers?.origin;
    if (
      !expectedOrigin ||
      typeof origin !== 'string' ||
      origin !== expectedOrigin
    ) {
      throw new ForbiddenException('Unexpected request origin');
    }
    return true;
  }
}
